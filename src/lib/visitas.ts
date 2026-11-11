import type postgres from "postgres";
import {
  DIAS_FOLIO_REPETIDO, leerAutorizacion, leerRecibido, leerReferencia, MAXIMO_PERSONAS, TARIFA_VISITA, totalVisitas,
  type FormaPago, type TipoReferencia,
} from "@/lib/datos-visita";
import { enmascararTelefono } from "@/lib/datos-visitante";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Bloque 4: cobro de visitas en efectivo, de una persona o de un grupo (solo datos ficticios).
 *
 * Una sola pantalla: las fichas elegidas (de 1 a 20, sin repetir), la sucursal, el total ($50 por persona),
 * lo recibido (opcional) y el cambio, con un solo botón «Confirmar cobro». La pantalla trae el turno abierto
 * que mostró y una clave del cobro que el navegador conserva, con el mismo grupo y el mismo recibido, hasta que
 * se guarda. Al confirmar, en una sola transacción, el servidor comprueba que sigue abierto ese MISMO turno,
 * que la persona sigue siendo la responsable vigente de la bolsa y que las fichas siguen activas; luego guarda
 * una operación, un cobro en efectivo, un pase por persona y una sola entrada a la bolsa por el total.
 * Si la misma clave llega dos veces (doble clic, o reintento tras perder la conexión) con los mismos datos, no
 * crea nada y responde con el cobro ya guardado; con otros datos, se rechaza.
 *
 * Reglas de esta prueba: registra quien tiene visita.registrar (hoy, Recepción) y además es la responsable
 * vigente de la bolsa. No se registra en una sucursal inactiva ni en producción. A la bolsa entra solo el
 * total, nunca lo recibido. Corrección, cancelación y devolución quedan para otro paso.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type ErrorVisita =
  | "pase_vigente"
  | "no_encontrada"
  | "sin_permiso"
  | "sucursal_inactiva"
  | "sin_turno"
  | "turno_cambio"
  | "no_responsable"
  | "entrega_en_curso"
  | "visitante_no_encontrado"
  | "visitante_unido"
  | "clave_ajena"
  | "datos_distintos"
  | "grupo_vacio"
  | "grupo_grande"
  | "persona_repetida"
  | "recibido_menor"
  | "autorizacion_invalida"
  | "autorizacion_repetida"
  | "referencia_invalida"
  | "referencia_repetida"
  | "forma_invalida"
  | "bloqueado_produccion";

type Contexto = { sucursalId: string; codigo: string; nombre: string; turnoId: string; bolsaId: string; responsable: string };

/** Comprobaciones comunes a la pantalla de cobro y a la confirmación. Con `bloquear`, deja el turno bloqueado hasta terminar. */
async function contexto(
  tx: Tx,
  usuarioId: string,
  codigo: string,
  { bloquear }: { bloquear: boolean },
): Promise<{ ok: true; c: Contexto } | { ok: false; error: ErrorVisita }> {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return { ok: false, error: "no_encontrada" };
  const [s] = await tx<{ id: string; nombre: string; inactiva: boolean; registra: boolean }[]>`
    select id, nombre, estado_operativo = 'inactiva' as inactiva,
           tiene_permiso(${usuarioId}, 'visita.registrar', id) and tiene_permiso(${usuarioId}, 'visitante.buscar', id) as registra
    from sucursal
    where codigo = ${codigo}
      and (tiene_permiso(${usuarioId}, 'visita.registrar', id) or tiene_permiso(${usuarioId}, 'turno.consultar', id))`;
  if (!s) return { ok: false, error: "no_encontrada" };
  if (!s.registra) return { ok: false, error: "sin_permiso" };
  if (s.inactiva) return { ok: false, error: "sucursal_inactiva" };

  const turnos = bloquear
    ? await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null for update`
    : await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null`;
  const t = turnos[0];
  if (!t) return { ok: false, error: "sin_turno" };

  const [r] = await tx<{ lugar_id: string; usuario_id: string; nombre: string }[]>`
    select r.lugar_id, r.usuario_id, u.nombre
    from responsable_lugar r
    join lugar_efectivo l on l.id = r.lugar_id and l.tipo = 'bolsa_visitas'
    join usuario u on u.id = r.usuario_id
    where r.turno_id = ${t.id} and r.hasta is null`;
  if (!r || r.usuario_id !== usuarioId) return { ok: false, error: "no_responsable" };
  // Bloque 5: mientras la bolsa se está entregando al siguiente turno, no entra efectivo nuevo (ya se contó).
  if ((await tx`select 1 from entrega_turno where turno_id = ${t.id} and estado in ('pendiente', 'recuento')`).length) {
    return { ok: false, error: "entrega_en_curso" };
  }
  return { ok: true, c: { sucursalId: s.id, codigo, nombre: s.nombre, turnoId: t.id, bolsaId: r.lugar_id, responsable: r.nombre } };
}

type Ficha = { id: string; nombre: string; telefono: string | null; sucursal_alta: string; unida: boolean };

export type CobroRegistrado = {
  operacionId: string;
  personas: number;
  visitantes: string[];
  total: string;
  formaPago: FormaPago;
  estado: EstadoCobro;
  recibido: string | null;
  cambio: string | null;
  autorizacion: string | null;
  conciliacion: "pendiente" | null;
  referencia: string | null;
  tipoReferencia: TipoReferencia | null;
};

export type EstadoCobro = "confirmado" | "confirmado_operativamente" | "pendiente_abono" | "abono_verificado" | "no_localizado" | "cancelado";

/**
 * Cobro previo con la misma autorización (tarjeta) o la misma referencia (transferencia), que se muestra antes de
 * confirmar que es otra venta u otra transferencia. Sus datos solo se muestran a quien puede ver los turnos o
 * registrar visitas en la sucursal de ese cobro; a los demás solo se les dice que existe.
 */
export type CobroPrevio =
  | { visible: true; id: string; registradaEn: Date; registradaPor: string; personas: number; total: string; sucursal: string; codigo: string; estado: EstadoCobro }
  | { visible: false };
/** @deprecated Nombre anterior, solo tarjeta. */
export type CobroConMismaAutorizacion = CobroPrevio;

export type ResultadoConfirmacion =
  | { ok: true; operacionId: string; repetida: boolean; cobro: CobroRegistrado }
  | { ok: false; error: ErrorVisita; detalle?: string; previos?: CobroPrevio[]; conPase?: PaseVigente[] };

/** Persona del grupo que ya tiene pase vigente hoy en la sucursal: se registra su entrada o reingreso, no otro cobro. */
export type PaseVigente = { visitanteId: string; nombre: string; operacionId: string; entro: boolean };

type Pedido = {
  clave: string;
  turnoId: string;
  visitanteIds: string[];
  formaPago: FormaPago;
  recibido: string | null;
  cambio: string | null;
  /** Solo con tarjeta: la autorización del comprobante, ya normalizada (leerAutorizacion). */
  autorizacion: string | null;
  /** Solo con transferencia: la clave de rastreo o el folio bancario, ya normalizado (leerReferencia), y su tipo. */
  referencia?: string | null;
  tipoReferencia?: TipoReferencia | null;
  /**
   * Tarjeta: confirmó que es otra venta aunque la autorización ya aparece ese día en la sucursal.
   * Transferencia: confirmó que es otra transferencia aunque la referencia ya estaba registrada.
   */
  otraVenta: boolean;
};

/**
 * El cobro ya guardado con esta clave. Solo se responde con él si el reintento trae los mismos datos (mismas
 * personas en el mismo orden, mismo medio de pago, mismo «Recibido» y misma autorización); si no, es
 * «datos_distintos» y no se guarda nada.
 */
async function operacionExistente(tx: Tx, pedido: Pedido, usuarioId: string, codigo: string, repetida = true): Promise<ResultadoConfirmacion | null> {
  const [o] = await tx<({ id: string; registrada_por: string; codigo: string } & Omit<CobroRegistrado, "personas" | "visitantes">)[]>`
    select o.id, o.registrada_por, s.codigo, c.importe::text as total, c.recibido::text as recibido, c.cambio::text as cambio,
           c.forma_pago as "formaPago", c.estado, c.autorizacion, c.conciliacion,
           c.referencia, c.tipo_referencia as "tipoReferencia"
    from operacion_visita o
    join sucursal s on s.id = o.sucursal_id
    join cobro_visita c on c.operacion_id = o.id
    where o.clave = ${pedido.clave}`;
  if (!o) return null;
  if (o.registrada_por !== usuarioId || o.codigo !== codigo) return { ok: false, error: "clave_ajena" };
  const pases = await tx<{ visitante_id: string; nombre: string }[]>`
    select p.visitante_id, v.nombre from pase_visita p join visitante v on v.id = p.visitante_id
    where p.operacion_id = ${o.id} order by p.orden`;
  const mismos =
    pases.length === pedido.visitanteIds.length &&
    pases.every((p, i) => p.visitante_id === pedido.visitanteIds[i]) &&
    o.recibido === pedido.recibido &&
    o.formaPago === pedido.formaPago &&
    o.autorizacion === pedido.autorizacion &&
    o.referencia === (pedido.referencia ?? null) &&
    o.tipoReferencia === (pedido.tipoReferencia ?? null);
  if (!mismos) return { ok: false, error: "datos_distintos" };
  return {
    ok: true, operacionId: o.id, repetida,
    cobro: {
      operacionId: o.id, personas: pases.length, visitantes: pases.map((p) => p.nombre), total: o.total, formaPago: o.formaPago, estado: o.estado,
      recibido: o.recibido, cambio: o.cambio, autorizacion: o.autorizacion, conciliacion: o.conciliacion,
      referencia: o.referencia, tipoReferencia: o.tipoReferencia,
    },
  };
}

/** Cobros que cumplen `filtro` (sobre `c` cobro, `o` operación, `s` sucursal), con sus datos solo si se pueden ver. */
async function cobrosPrevios(tx: Tx, usuarioId: string, filtro: postgres.PendingQuery<postgres.Row[]>): Promise<CobroPrevio[]> {
  const filas = await tx<(Omit<Extract<CobroPrevio, { visible: true }>, "visible"> & { visible: boolean })[]>`
    select o.id, o.registrada_en as "registradaEn", u.nombre as "registradaPor", c.importe::text as total, c.estado,
           s.nombre as sucursal, s.codigo,
           (select count(*)::int from pase_visita p where p.operacion_id = o.id) as personas,
           (tiene_permiso(${usuarioId}, 'turno.consultar', s.id) or tiene_permiso(${usuarioId}, 'visita.registrar', s.id)) as visible
    from cobro_visita c
    join operacion_visita o on o.id = c.operacion_id
    join sucursal s on s.id = o.sucursal_id
    join usuario u on u.id = o.registrada_por
    where ${filtro}
    order by o.registrada_en
    limit 20`;
  const visibles: CobroPrevio[] = filas.filter((f) => f.visible).map((f) => ({ ...f, visible: true as const }));
  return filas.some((f) => !f.visible) ? [...visibles, { visible: false }] : visibles;
}

/**
 * Confirma el cobro de una o varias personas (hasta 20, sin repetir), con un solo medio de pago. Idempotente
 * por `clave`. Efectivo: `recibido` y `cambio` validados contra el total del grupo; entra el total a la bolsa.
 * Tarjeta: Recepción ya vio «Aprobado» en la terminal; se registra con la autorización, «confirmado
 * operativamente» y con la liquidación pendiente de conciliar; no hay entrada de efectivo. Si la autorización
 * ya aparece ese día en la sucursal, se devuelve el cobro previo y hace falta confirmar que es otra venta.
 */
export async function confirmarVisita(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  pedido: Pedido,
  { entorno }: { entorno: Entorno },
): Promise<ResultadoConfirmacion> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(pedido.clave) || !esIdentificadorValido(pedido.turnoId)) return { ok: false, error: "no_encontrada" };
  const ids = pedido.visitanteIds;
  if (ids.length === 0) return { ok: false, error: "grupo_vacio" };
  if (ids.length > MAXIMO_PERSONAS) return { ok: false, error: "grupo_grande" };
  if (!ids.every(esIdentificadorValido)) return { ok: false, error: "visitante_no_encontrado" };
  if (new Set(ids).size !== ids.length) return { ok: false, error: "persona_repetida" };
  const total = totalVisitas(ids.length);
  const tarjeta = pedido.formaPago === "tarjeta";
  const transferencia = pedido.formaPago === "transferencia";
  const referencia = pedido.referencia ?? null;
  const tipoReferencia = pedido.tipoReferencia ?? null;
  if (pedido.formaPago !== "efectivo" && !tarjeta && !transferencia) return { ok: false, error: "forma_invalida" };
  if (!transferencia && (referencia !== null || tipoReferencia !== null)) return { ok: false, error: "forma_invalida" };
  if (transferencia) {
    // Con transferencia no hay recibido, cambio ni autorización; la referencia y su tipo son obligatorios.
    if (pedido.recibido !== null || pedido.cambio !== null || pedido.autorizacion !== null) return { ok: false, error: "forma_invalida" };
    const ref = leerReferencia(referencia);
    if (!ref.ok || ref.valor !== referencia || (tipoReferencia !== "clave_rastreo" && tipoReferencia !== "folio_bancario")) {
      return { ok: false, error: "referencia_invalida" };
    }
  } else if (tarjeta) {
    // Con tarjeta no hay recibido ni cambio; la autorización es obligatoria.
    if (pedido.recibido !== null || pedido.cambio !== null) return { ok: false, error: "forma_invalida" };
    const a = leerAutorizacion(pedido.autorizacion);
    if (!a.ok || a.valor !== pedido.autorizacion) return { ok: false, error: "autorizacion_invalida" };
  } else {
    if (pedido.autorizacion !== null || pedido.otraVenta) return { ok: false, error: "forma_invalida" };
    if (pedido.recibido !== null) {
      const r = leerRecibido(pedido.recibido, total);
      if (!r.ok || r.cambio !== pedido.cambio) return { ok: false, error: "recibido_menor" };
    } else if (pedido.cambio !== null) return { ok: false, error: "recibido_menor" };
  }

  return sql.begin(async (tx): Promise<ResultadoConfirmacion> => {
    // Un reintento de un cobro ya guardado responde lo mismo, aunque después haya cambiado el turno.
    const previa = await operacionExistente(tx, pedido, usuarioId, codigo);
    if (previa) return previa;

    // Bloquea el turno: dos confirmaciones a la vez esperan aquí, una detrás de la otra.
    const r = await contexto(tx, usuarioId, codigo, { bloquear: true });
    if (!r.ok) return r;
    // Ya con el turno bloqueado, la segunda de dos confirmaciones simultáneas ve la primera.
    const repetida = await operacionExistente(tx, pedido, usuarioId, codigo);
    if (repetida) return repetida;
    if (r.c.turnoId !== pedido.turnoId) return { ok: false, error: "turno_cambio" };

    const fichas = await tx<Ficha[]>`
      select v.id, v.nombre, v.telefono, s.nombre as sucursal_alta, v.fusionado_en_id is not null as unida
      from visitante v join sucursal s on s.id = v.sucursal_alta_id
      where v.id = any(${ids}::uuid[])`;
    if (fichas.length !== ids.length) return { ok: false, error: "visitante_no_encontrado" };
    const unida = fichas.find((f) => f.unida);
    if (unida) return { ok: false, error: "visitante_unido", detalle: unida.nombre };

    // El pase vale todo el día en la sucursal: quien ya tiene uno vigente no se cobra otra vez (entra o reingresa
    // con su pase). Con el turno bloqueado, de dos pestañas que confirman a la vez la segunda ya ve el pase de la
    // primera. Se rechaza antes de guardar nada: ni cobro, ni pases, ni movimiento de la bolsa.
    const conPase = await tx<{ visitante_id: string; nombre: string; operacion_id: string; entro: boolean }[]>`
      select distinct on (x.id) x.id as visitante_id, v.nombre, p.operacion_id,
             exists (select 1 from acceso a where a.pase_id = p.id and a.tipo = 'entrada') as entro
      from unnest(${ids}::uuid[]) as x(id)
      join visitante v on v.id = x.id
      join pase_visita p on p.visitante_id in (select visitante_grupo(x.id)) and p.sucursal_id = ${r.c.sucursalId}
                         and p.cancelado_en is null
                         and dia_en_sucursal(p.sucursal_id, p.creado_en) = dia_en_sucursal(p.sucursal_id, now())
      join cobro_visita c on c.operacion_id = p.operacion_id and c.estado not in ('cancelado', 'no_localizado')
      order by x.id, p.creado_en desc`;
    if (conPase.length) {
      const orden = (id: string) => ids.indexOf(id);
      return {
        ok: false, error: "pase_vigente",
        conPase: conPase.sort((a, b) => orden(a.visitante_id) - orden(b.visitante_id))
          .map((p) => ({ visitanteId: p.visitante_id, nombre: p.nombre, operacionId: p.operacion_id, entro: p.entro })),
      };
    }

    // Misma autorización ya registrada hoy en esta sucursal: puede ser la misma venta capturada dos veces.
    let repetidaConfirmada = false;
    if (tarjeta) {
      const previos = await cobrosPrevios(tx, usuarioId, tx`
        c.autorizacion = ${pedido.autorizacion} and o.sucursal_id = ${r.c.sucursalId}
        and o.registrada_en >= (date_trunc('day', now() at time zone s.zona_horaria)) at time zone s.zona_horaria`);
      if (previos.length && !pedido.otraVenta) return { ok: false, error: "autorizacion_repetida", previos };
      repetidaConfirmada = previos.length > 0;
    }
    // Misma referencia ya registrada (en cualquier sucursal): puede ser el mismo abono capturado dos veces.
    // Clave de rastreo: en cualquier fecha. Folio bancario: en los últimos días (los folios se repiten con el tiempo).
    let referenciaConfirmada = false;
    if (transferencia) {
      const previos = await cobrosPrevios(tx, usuarioId, tipoReferencia === "clave_rastreo"
        ? tx`c.tipo_referencia = 'clave_rastreo' and c.referencia = ${referencia}`
        : tx`c.tipo_referencia = 'folio_bancario' and c.referencia = ${referencia}
             and o.registrada_en >= now() - make_interval(days => ${DIAS_FOLIO_REPETIDO})`);
      if (previos.length && !pedido.otraVenta) return { ok: false, error: "referencia_repetida", previos };
      referenciaConfirmada = previos.length > 0;
    }

    const [o] = await tx<{ id: string }[]>`
      insert into operacion_visita (clave, sucursal_id, turno_id, registrada_por, total)
      values (${pedido.clave}, ${r.c.sucursalId}, ${r.c.turnoId}, ${usuarioId}, ${total})
      on conflict (clave) do nothing
      returning id`;
    if (!o) return (await operacionExistente(tx, pedido, usuarioId, codigo)) ?? { ok: false, error: "clave_ajena" };

    const [cobro] = await tx<{ id: string }[]>`
      insert into cobro_visita (operacion_id, forma_pago, estado, importe, recibido, cambio, autorizacion, conciliacion,
                                autorizacion_repetida_confirmada, referencia, tipo_referencia, referencia_repetida_confirmada)
      values (${o.id}, ${pedido.formaPago},
              ${tarjeta ? "confirmado_operativamente" : transferencia ? "pendiente_abono" : "confirmado"}, ${total},
              ${pedido.recibido}, ${pedido.cambio}, ${pedido.autorizacion}, ${tarjeta ? "pendiente" : null}, ${repetidaConfirmada},
              ${referencia}, ${tipoReferencia}, ${referenciaConfirmada})
      returning id`;
    // Un pase por persona, en el orden en que se agregaron; cada uno con la sucursal donde ocurre la visita.
    for (const [i, id] of ids.entries()) {
      await tx`
        insert into pase_visita (operacion_id, visitante_id, sucursal_id, tarifa, descuento, total, orden)
        values (${o.id}, ${id}, ${r.c.sucursalId}, ${TARIFA_VISITA}, 0, ${TARIFA_VISITA}, ${i + 1})`;
    }
    // Efectivo: a la bolsa entra el total del grupo, en un solo movimiento; el cambio no es un movimiento.
    // Tarjeta y transferencia: no hay entrada de efectivo.
    if (!tarjeta && !transferencia) {
      await tx`
        insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, cobro_id, responsable_id, registrado_por)
        values (${r.c.bolsaId}, ${r.c.turnoId}, 'entrada_cobro_visita', ${total}, ${cobro.id}, ${usuarioId}, ${usuarioId})`;
    }
    return (await operacionExistente(tx, pedido, usuarioId, codigo, false))!;
  });
}

export type CobroDelTurno = {
  id: string; registradaEn: Date; personas: number; total: string; formaPago: FormaPago;
  estado: EstadoCobro; conciliacion: "pendiente" | null;
  /** Hay una solicitud de cancelación pendiente de autorizar. */
  cancelacionSolicitada: boolean;
};

/** Cobros de visitas de un turno, una línea por cobro, el más reciente primero. Quien llama ya comprobó que puede ver el turno. */
export async function cobrosDelTurno(sql: Sql | Tx, turnoId: string): Promise<CobroDelTurno[]> {
  return sql<CobroDelTurno[]>`
    select o.id, o.registrada_en as "registradaEn", c.importe::text as total, c.forma_pago as "formaPago",
           c.estado, c.conciliacion,
           exists (select 1 from cancelacion_cobro x where x.cobro_id = c.id and x.estado = 'solicitada') as "cancelacionSolicitada",
           (select count(*)::int from pase_visita p where p.operacion_id = o.id) as personas
    from operacion_visita o
    join cobro_visita c on c.operacion_id = o.id
    where o.turno_id = ${turnoId}
    order by o.registrada_en desc, o.id`;
}

export type DetalleCobro = {
  id: string;
  cobroId: string;
  sucursal: { codigo: string; nombre: string };
  registradaEn: Date;
  registradaPor: string;
  formaPago: FormaPago;
  estado: EstadoCobro;
  autorizacion: string | null;
  conciliacion: "pendiente" | null;
  referencia: string | null;
  tipoReferencia: TipoReferencia | null;
  abonoFecha: string | null;
  verificadoPor: string | null;
  verificadoEn: Date | null;
  /** Cambios de estado de una transferencia (verificado, no localizado), del más antiguo al más reciente. */
  cambios: { de: EstadoCobro; a: EstadoCobro; abonoFecha: string | null; motivo: string | null; usuario: string; en: Date }[];
  total: string;
  recibido: string | null;
  cambio: string | null;
  entradaBolsa: string | null;
  responsableBolsa: string | null;
  pases: { id: string; orden: number; nombre: string; telefono: string | null; fichaDe: string; tarifa: string; descuento: string; total: string }[];
};

/**
 * Detalle de un cobro: visitantes y sus pases. Lo ve quien puede ver los turnos de la sucursal del cobro.
 * null si no existe o no hay permiso (misma respuesta). Teléfonos enmascarados.
 */
export async function detalleCobro(sql: Sql, usuarioId: string, codigo: string, operacionId: string): Promise<DetalleCobro | null> {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo) || !esIdentificadorValido(operacionId)) return null;
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const [o] = await tx<(Omit<DetalleCobro, "pases" | "sucursal" | "cambios" | "cobroId"> & { codigo: string; sucursal_nombre: string; cobro_id: string })[]>`
      select o.id, s.codigo, s.nombre as sucursal_nombre, o.registrada_en as "registradaEn", u.nombre as "registradaPor",
             c.forma_pago as "formaPago", c.estado, c.autorizacion, c.conciliacion, c.importe::text as total, c.recibido::text as recibido, c.cambio::text as cambio,
             c.referencia, c.tipo_referencia as "tipoReferencia", c.abono_fecha::text as "abonoFecha",
             uv.nombre as "verificadoPor", c.verificado_en as "verificadoEn", c.id as cobro_id,
             m.importe::text as "entradaBolsa", ur.nombre as "responsableBolsa"
      from operacion_visita o
      join sucursal s on s.id = o.sucursal_id
      join usuario u on u.id = o.registrada_por
      join cobro_visita c on c.operacion_id = o.id
      left join movimiento_efectivo m on m.cobro_id = c.id and m.tipo = 'entrada_cobro_visita'
      left join usuario ur on ur.id = m.responsable_id
      left join usuario uv on uv.id = c.verificado_por
      where o.id = ${operacionId} and s.codigo = ${codigo}
        and (tiene_permiso(${usuarioId}, 'turno.consultar', s.id) or tiene_permiso(${usuarioId}, 'visita.registrar', s.id)
             or tiene_permiso(${usuarioId}, 'cobro.verificar_abono', s.id))`;
    if (!o) return null;
    const pases = await tx<(DetalleCobro["pases"][number] & { tel: string | null })[]>`
      select p.id, p.orden, v.nombre, v.telefono as tel, sa.nombre as "fichaDe",
             p.tarifa::text as tarifa, p.descuento::text as descuento, p.total::text as total
      from pase_visita p
      join visitante v on v.id = p.visitante_id
      join sucursal sa on sa.id = v.sucursal_alta_id
      where p.operacion_id = ${o.id}
      order by p.orden`;
    const cambios = await tx<DetalleCobro["cambios"]>`
      select h.de, h.a, h.abono_fecha::text as "abonoFecha", h.motivo, u.nombre as usuario, h.en
      from cobro_cambio_estado h join usuario u on u.id = h.usuario_id
      where h.cobro_id = ${o.cobro_id} order by h.en, h.id`;
    const { codigo: cod, sucursal_nombre, cobro_id, ...resto } = o;
    return {
      ...resto,
      cobroId: cobro_id,
      cambios: [...cambios],
      sucursal: { codigo: cod, nombre: sucursal_nombre },
      pases: pases.map(({ tel, ...p }) => ({ ...p, telefono: enmascararTelefono(tel) })),
    };
  });
}

/**
 * `paseAqui`: pase de hoy en esta sucursal que todavía sirve para entrar (no cancelado ni con transferencia no
 * localizada). Con él no se cobra otra visita: se registra la entrada o el reingreso con el mismo pase.
 */
export type VisitaHoy = {
  id: string;
  visitasHoy: number;
  enEstaSucursal: boolean;
  paseAqui: { operacionId: string; entro: boolean } | null;
};

/**
 * Personas que ya tienen una visita registrada hoy (fecha de la sucursal), en cualquier sucursal y contando
 * sus fichas unidas. Solo para el aviso previo: la regla de reingreso está pendiente, así que no bloquea.
 * null si la persona no puede registrar visitas en esa sucursal.
 */
export async function visitasDeHoy(sql: Sql, usuarioId: string, codigo: string, visitanteIds: string[]): Promise<VisitaHoy[] | null> {
  const ids = visitanteIds.filter(esIdentificadorValido).slice(0, MAXIMO_PERSONAS);
  return sql.begin("read only", async (tx): Promise<VisitaHoy[] | null> => {
    const r = await contexto(tx, usuarioId, codigo, { bloquear: false });
    if (!r.ok) return null;
    if (!ids.length) return [];
    const filas = await tx<VisitaHoy[]>`
      with s as (select id, zona_horaria from sucursal where id = ${r.c.sucursalId}),
      hoy as (
        select (date_trunc('day', now() at time zone s.zona_horaria)) at time zone s.zona_horaria as desde, s.id from s
      )
      select x.id,
             count(p.id)::int as "visitasHoy",
             coalesce(bool_or(p.sucursal_id = hoy.id), false) as "enEstaSucursal",
             (select json_build_object('operacionId', pa.operacion_id,
                                       'entro', exists (select 1 from acceso a where a.pase_id = pa.id and a.tipo = 'entrada'))
              from pase_visita pa join cobro_visita ca on ca.operacion_id = pa.operacion_id
              where pa.visitante_id in (select visitante_grupo(x.id)) and pa.sucursal_id = hoy.id and pa.creado_en >= hoy.desde
                and pa.cancelado_en is null and ca.estado not in ('cancelado', 'no_localizado')
              order by pa.creado_en desc limit 1) as "paseAqui"
      from unnest(${ids}::uuid[]) as x(id)
      cross join hoy
      left join pase_visita p on p.visitante_id in (select visitante_grupo(x.id)) and p.creado_en >= hoy.desde and p.cancelado_en is null
      group by x.id, hoy.id, hoy.desde`;
    return [...filas];
  });
}

/** null si la persona puede registrar visitas ahora en la sucursal; si no, el motivo. */
export async function impedimentoRegistroVisita(sql: Sql, usuarioId: string, codigo: string, entorno: Entorno): Promise<ErrorVisita | null> {
  if (entorno === "produccion") return "bloqueado_produccion";
  return sql.begin("read only", async (tx) => {
    const r = await contexto(tx, usuarioId, codigo, { bloquear: false });
    return r.ok ? null : r.error;
  });
}

export type PantallaCobro =
  | { ok: true; turnoId: string; sucursal: string; responsableBolsa: string }
  | { ok: false; error: ErrorVisita };

/** Lo que necesita la pantalla de cobro: el turno abierto que se mostrará y quién es la responsable de la bolsa. */
export async function pantallaCobro(sql: Sql, usuarioId: string, codigo: string, entorno: Entorno): Promise<PantallaCobro> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  return sql.begin("read only", async (tx) => {
    const r = await contexto(tx, usuarioId, codigo, { bloquear: false });
    return r.ok ? { ok: true as const, turnoId: r.c.turnoId, sucursal: r.c.nombre, responsableBolsa: r.c.responsable } : r;
  });
}

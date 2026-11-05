import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { TARIFA_VISITA } from "@/lib/datos-visita";
import { enmascararTelefono } from "@/lib/datos-visitante";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Bloque 4, primer flujo: visita individual de $50 en efectivo (solo datos ficticios).
 *
 * Dos pasos, los dos comprobados en el servidor:
 * 1. Revisar: con la ficha elegida y lo recibido (opcional), arma el resumen del cobro. No guarda nada.
 *    Devuelve el turno que se mostró y una clave nueva para la confirmación.
 * 2. Confirmar: en una sola transacción comprueba que sigue abierto el MISMO turno que se mostró, que la
 *    persona sigue siendo la responsable vigente de la bolsa y que la ficha sigue activa; luego guarda una
 *    operación, un cobro en efectivo, un pase para el visitante y una entrada de efectivo a la bolsa.
 *    Si la misma clave llega dos veces (doble clic, reintento), la segunda no crea nada.
 *
 * Reglas de esta prueba: registra quien tiene visita.registrar (hoy, Recepción) y además es la responsable
 * vigente de la bolsa. No se registra en una sucursal inactiva ni en producción. A la bolsa entra solo el
 * total de la visita, nunca lo recibido. Corrección, cancelación y devolución quedan para otro paso.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type ErrorVisita =
  | "no_encontrada"
  | "sin_permiso"
  | "sucursal_inactiva"
  | "sin_turno"
  | "turno_cambio"
  | "no_responsable"
  | "visitante_no_encontrado"
  | "visitante_unido"
  | "clave_ajena"
  | "bloqueado_produccion";

export type ResumenVisita = {
  clave: string;
  turnoId: string;
  sucursal: { codigo: string; nombre: string };
  visitante: { id: string; nombre: string; telefono: string | null; sucursalAlta: string };
  tarifa: string;
  descuento: string;
  total: string;
  recibido: string | null;
  cambio: string | null;
  responsableBolsa: string;
};

type Contexto = { sucursalId: string; codigo: string; nombre: string; turnoId: string; bolsaId: string; responsable: string };

/** Comprobaciones comunes a revisar y confirmar. Con `bloquear`, deja el turno bloqueado hasta terminar. */
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
  return { ok: true, c: { sucursalId: s.id, codigo, nombre: s.nombre, turnoId: t.id, bolsaId: r.lugar_id, responsable: r.nombre } };
}

type Ficha = { id: string; nombre: string; telefono: string | null; sucursal_alta: string; unida: boolean };
async function fichaActiva(tx: Tx, visitanteId: string): Promise<{ ok: true; v: Ficha } | { ok: false; error: ErrorVisita }> {
  if (!esIdentificadorValido(visitanteId)) return { ok: false, error: "visitante_no_encontrado" };
  const [v] = await tx<Ficha[]>`
    select v.id, v.nombre, v.telefono, s.nombre as sucursal_alta, v.fusionado_en_id is not null as unida
    from visitante v join sucursal s on s.id = v.sucursal_alta_id
    where v.id = ${visitanteId}`;
  if (!v) return { ok: false, error: "visitante_no_encontrado" };
  if (v.unida) return { ok: false, error: "visitante_unido" };
  return { ok: true, v };
}

/** Paso 1: resumen del cobro. No guarda nada. `recibido` y `cambio` llegan ya validados (leerRecibido). */
export async function revisarVisita(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  pedido: { visitanteId: string; recibido: string | null; cambio: string | null },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; resumen: ResumenVisita } | { ok: false; error: ErrorVisita }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const r = await contexto(tx, usuarioId, codigo, { bloquear: false });
    if (!r.ok) return r;
    const f = await fichaActiva(tx, pedido.visitanteId);
    if (!f.ok) return f;
    return {
      ok: true as const,
      resumen: {
        clave: randomUUID(),
        turnoId: r.c.turnoId,
        sucursal: { codigo: r.c.codigo, nombre: r.c.nombre },
        visitante: { id: f.v.id, nombre: f.v.nombre, telefono: enmascararTelefono(f.v.telefono), sucursalAlta: f.v.sucursal_alta },
        tarifa: TARIFA_VISITA,
        descuento: "0.00",
        total: TARIFA_VISITA,
        recibido: pedido.recibido,
        cambio: pedido.cambio,
        responsableBolsa: r.c.responsable,
      },
    };
  });
}

export type ResultadoConfirmacion =
  | { ok: true; operacionId: string; repetida: boolean }
  | { ok: false; error: ErrorVisita };

async function operacionExistente(tx: Tx, clave: string, usuarioId: string, codigo: string): Promise<ResultadoConfirmacion | null> {
  const [o] = await tx<{ id: string; registrada_por: string; codigo: string }[]>`
    select o.id, o.registrada_por, s.codigo
    from operacion_visita o join sucursal s on s.id = o.sucursal_id
    where o.clave = ${clave}`;
  if (!o) return null;
  if (o.registrada_por !== usuarioId || o.codigo !== codigo) return { ok: false, error: "clave_ajena" };
  return { ok: true, operacionId: o.id, repetida: true };
}

/** Paso 2: confirma el cobro. Idempotente por `clave`. */
export async function confirmarVisita(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  pedido: { clave: string; turnoId: string; visitanteId: string; recibido: string | null; cambio: string | null },
  { entorno }: { entorno: Entorno },
): Promise<ResultadoConfirmacion> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(pedido.clave) || !esIdentificadorValido(pedido.turnoId)) return { ok: false, error: "no_encontrada" };

  return sql.begin(async (tx): Promise<ResultadoConfirmacion> => {
    // Un reintento de un cobro ya guardado responde lo mismo, aunque después haya cambiado el turno.
    const previa = await operacionExistente(tx, pedido.clave, usuarioId, codigo);
    if (previa) return previa;

    // Bloquea el turno: dos confirmaciones a la vez esperan aquí, una detrás de la otra.
    const r = await contexto(tx, usuarioId, codigo, { bloquear: true });
    if (!r.ok) return r;
    // Ya con el turno bloqueado, la segunda de dos confirmaciones simultáneas ve la primera.
    const repetida = await operacionExistente(tx, pedido.clave, usuarioId, codigo);
    if (repetida) return repetida;
    if (r.c.turnoId !== pedido.turnoId) return { ok: false, error: "turno_cambio" };

    const f = await fichaActiva(tx, pedido.visitanteId);
    if (!f.ok) return f;

    const [o] = await tx<{ id: string }[]>`
      insert into operacion_visita (clave, sucursal_id, turno_id, registrada_por, total)
      values (${pedido.clave}, ${r.c.sucursalId}, ${r.c.turnoId}, ${usuarioId}, ${TARIFA_VISITA})
      on conflict (clave) do nothing
      returning id`;
    if (!o) return (await operacionExistente(tx, pedido.clave, usuarioId, codigo)) ?? { ok: false, error: "clave_ajena" };

    const [cobro] = await tx<{ id: string }[]>`
      insert into cobro_visita (operacion_id, forma_pago, estado, importe, recibido, cambio)
      values (${o.id}, 'efectivo', 'confirmado', ${TARIFA_VISITA}, ${pedido.recibido}, ${pedido.cambio})
      returning id`;
    await tx`
      insert into pase_visita (operacion_id, visitante_id, sucursal_id, tarifa, descuento, total)
      values (${o.id}, ${f.v.id}, ${r.c.sucursalId}, ${TARIFA_VISITA}, 0, ${TARIFA_VISITA})`;
    // A la bolsa entra solo el total de la visita; el cambio no es un movimiento.
    await tx`
      insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, cobro_id, responsable_id, registrado_por)
      values (${r.c.bolsaId}, ${r.c.turnoId}, 'entrada_cobro_visita', ${TARIFA_VISITA}, ${cobro.id}, ${usuarioId}, ${usuarioId})`;
    return { ok: true, operacionId: o.id, repetida: false };
  });
}

export type VisitaDelTurno = { id: string; visitante: string; registradaEn: Date; total: string; formaPago: "efectivo" };

/** Visitas registradas en un turno, la más reciente primero. Quien llama ya comprobó que puede ver el turno. */
export async function visitasDelTurno(sql: Sql | Tx, turnoId: string): Promise<VisitaDelTurno[]> {
  return sql<VisitaDelTurno[]>`
    select o.id, v.nombre as visitante, o.registrada_en as "registradaEn", c.importe::text as total, c.forma_pago as "formaPago"
    from operacion_visita o
    join cobro_visita c on c.operacion_id = o.id
    join pase_visita p on p.operacion_id = o.id
    join visitante v on v.id = p.visitante_id
    where o.turno_id = ${turnoId}
    order by o.registrada_en desc, o.id`;
}

/** null si la persona puede registrar visitas ahora en la sucursal; si no, el motivo. */
export async function impedimentoRegistroVisita(sql: Sql, usuarioId: string, codigo: string, entorno: Entorno): Promise<ErrorVisita | null> {
  if (entorno === "produccion") return "bloqueado_produccion";
  return sql.begin("read only", async (tx) => {
    const r = await contexto(tx, usuarioId, codigo, { bloquear: false });
    return r.ok ? null : r.error;
  });
}

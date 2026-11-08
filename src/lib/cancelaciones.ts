import type postgres from "postgres";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Cancelación de un cobro duplicado en efectivo (bloque 4; solo datos ficticios). Indicado el 8 nov 2026.
 *
 * 1. Solicitar: quien tiene visita.solicitar_cancelacion en la sucursal (hoy, Recepción), para un cobro en
 *    efectivo del turno ABIERTO de la sucursal. Elige el cobro correcto que se conserva: del mismo turno, en
 *    efectivo, vigente, por el mismo total y con las mismas personas. Confirma que el dinero del duplicado no
 *    entró (el dinero físico es el del cobro que se conserva). Hasta que se apruebe, nada cambia.
 * 2. Aprobar o rechazar: quien tiene la facultad autorizacion.devolucion en la sucursal con un límite igual o
 *    mayor al importe, y no registró el cobro ni pidió la cancelación.
 * 3. Al aprobar, en una transacción: el cobro y sus pases quedan cancelados (no se borran), se registra UN ajuste
 *    de efectivo por menos el importe que entró (la base garantiza que es exactamente la entrada y solo uno), y el
 *    cambio queda en el historial del cobro. La bolsa descuenta el importe una sola vez; las ventas dejan de
 *    contar el duplicado.
 *
 * Para otro paso: turnos cerrados, correcciones de persona o medio de pago, devoluciones.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type CobroResumen = {
  operacionId: string;
  cobroId: string;
  registradaEn: Date;
  registradaPor: string;
  total: string;
  visitantes: string[];
  estado: string;
};

/** Quita del renglón las columnas internas (personas y quién registró) que RESUMEN trae para comparar. */
const resumen = ({ claves, registrada_por_id, ...f }: CobroResumen & { claves?: string; registrada_por_id?: string }): CobroResumen => {
  void claves; void registrada_por_id;
  return f;
};

const RESUMEN = (tx: Tx | Sql) => tx`
  select o.id as "operacionId", c.id as "cobroId", o.registrada_en as "registradaEn", u.nombre as "registradaPor",
         c.importe::text as total, c.estado,
         (select array_agg(v.nombre order by p.orden) from pase_visita p join visitante v on v.id = p.visitante_id
          where p.operacion_id = o.id) as visitantes,
         (select string_agg(p.visitante_id::text, ',' order by p.visitante_id) from pase_visita p where p.operacion_id = o.id) as claves,
         o.registrada_por as registrada_por_id
  from operacion_visita o join cobro_visita c on c.operacion_id = o.id join usuario u on u.id = o.registrada_por`;

/** Personas de un cobro, como conjunto ordenado, para comparar duplicados. */
const personas = (tx: Tx, operacionId: string) => tx<{ visitante_id: string }[]>`
  select visitante_id from pase_visita where operacion_id = ${operacionId} order by visitante_id`;

export type ErrorSolicitud =
  | "no_encontrada"
  | "sin_permiso"
  | "no_cancelable"
  | "turno_no_abierto"
  | "ya_solicitada"
  | "conserva_invalido"
  | "explicacion"
  | "sin_confirmar"
  | "bloqueado_produccion";

type Contexto = { sucursalId: string; turnoId: string };

/** El cobro, si la persona puede pedir su cancelación: efectivo, vigente, del turno abierto de la sucursal. */
async function cobroCancelable(tx: Tx, usuarioId: string, codigo: string, operacionId: string, bloquear: boolean):
  Promise<{ ok: true; c: Contexto & { cobroId: string; total: string; registradaPor: string } } | { ok: false; error: ErrorSolicitud }> {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo) || !esIdentificadorValido(operacionId)) return { ok: false, error: "no_encontrada" };
  const [s] = await tx<{ id: string; puede: boolean; ve: boolean }[]>`
    select id, tiene_permiso(${usuarioId}, 'visita.solicitar_cancelacion', id) as puede,
           tiene_permiso(${usuarioId}, 'turno.consultar', id) or tiene_permiso(${usuarioId}, 'visita.registrar', id) as ve
    from sucursal where codigo = ${codigo}`;
  if (!s || !(s.puede || s.ve)) return { ok: false, error: "no_encontrada" };
  if (!s.puede) return { ok: false, error: "sin_permiso" };
  const filas = bloquear
    ? await tx<{ cobro_id: string; forma_pago: string; estado: string; total: string; turno_id: string; abierto: boolean; registrada_por: string }[]>`
        select c.id as cobro_id, c.forma_pago, c.estado, c.importe::text as total, o.turno_id, t.cerrado_en is null as abierto, o.registrada_por
        from operacion_visita o join cobro_visita c on c.operacion_id = o.id join turno t on t.id = o.turno_id
        where o.id = ${operacionId} and o.sucursal_id = ${s.id}
        for update of c`
    : await tx<{ cobro_id: string; forma_pago: string; estado: string; total: string; turno_id: string; abierto: boolean; registrada_por: string }[]>`
        select c.id as cobro_id, c.forma_pago, c.estado, c.importe::text as total, o.turno_id, t.cerrado_en is null as abierto, o.registrada_por
        from operacion_visita o join cobro_visita c on c.operacion_id = o.id join turno t on t.id = o.turno_id
        where o.id = ${operacionId} and o.sucursal_id = ${s.id}`;
  const c = filas[0];
  if (!c) return { ok: false, error: "no_encontrada" };
  if (c.forma_pago !== "efectivo" || c.estado !== "confirmado") return { ok: false, error: "no_cancelable" };
  if (!c.abierto) return { ok: false, error: "turno_no_abierto" };
  return { ok: true, c: { sucursalId: s.id, turnoId: c.turno_id, cobroId: c.cobro_id, total: c.total, registradaPor: c.registrada_por } };
}

/** Cobros que pueden conservarse en lugar de `operacionId`: mismo turno, efectivo, vigentes, mismo total y mismas personas. */
async function candidatos(tx: Tx, operacionId: string, c: Contexto & { cobroId: string; total: string }): Promise<CobroResumen[]> {
  const mias = (await personas(tx, operacionId)).map((p) => p.visitante_id).join(",");
  const filas = await tx<(CobroResumen & { claves: string })[]>`
    ${RESUMEN(tx)}
    where o.turno_id = ${c.turnoId} and o.id <> ${operacionId} and c.forma_pago = 'efectivo' and c.estado = 'confirmado'
      and c.importe = ${c.total}::numeric
      and not exists (select 1 from cancelacion_cobro x where x.cobro_id = c.id and x.estado in ('solicitada', 'aprobada'))
    order by o.registrada_en`;
  return filas.filter((f) => f.claves === mias).map(resumen);
}

export type PantallaSolicitud =
  | { ok: true; candidatos: CobroResumen[] }
  | { ok: false; error: ErrorSolicitud };

/** Lo que necesita la pantalla del detalle para ofrecer «Solicitar cancelación por duplicado». */
export async function pantallaSolicitud(sql: Sql, usuarioId: string, codigo: string, operacionId: string, entorno: Entorno): Promise<PantallaSolicitud> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  return sql.begin("read only", async (tx): Promise<PantallaSolicitud> => {
    const r = await cobroCancelable(tx, usuarioId, codigo, operacionId, false);
    if (!r.ok) return r;
    const [activa] = await tx`select 1 from cancelacion_cobro where cobro_id = ${r.c.cobroId} and estado in ('solicitada', 'aprobada')`;
    if (activa) return { ok: false, error: "ya_solicitada" };
    return { ok: true, candidatos: await candidatos(tx, operacionId, r.c) };
  });
}

export async function solicitarCancelacion(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  operacionId: string,
  datos: { conservaOperacionId: string; explicacion: string; sinDinero: boolean },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; cancelacionId: string; repetida: boolean } | { ok: false; error: ErrorSolicitud }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const explicacion = datos.explicacion.trim().replace(/\s+/g, " ");
  if (explicacion.length < 5 || explicacion.length > 300) return { ok: false, error: "explicacion" };
  if (!datos.sinDinero) return { ok: false, error: "sin_confirmar" };
  if (!esIdentificadorValido(datos.conservaOperacionId)) return { ok: false, error: "conserva_invalido" };

  return sql.begin(async (tx) => {
    const r = await cobroCancelable(tx, usuarioId, codigo, operacionId, true);
    if (!r.ok) return r;
    // Doble envío de la misma solicitud: responde con la que ya existe.
    const [activa] = await tx<{ id: string; solicitada_por: string; conserva: string; estado: string }[]>`
      select x.id, x.solicitada_por, o.id as conserva, x.estado from cancelacion_cobro x
      join cobro_visita c on c.id = x.conserva_cobro_id join operacion_visita o on o.id = c.operacion_id
      where x.cobro_id = ${r.c.cobroId} and x.estado in ('solicitada', 'aprobada')`;
    if (activa) {
      return activa.estado === "solicitada" && activa.solicitada_por === usuarioId && activa.conserva === datos.conservaOperacionId
        ? { ok: true as const, cancelacionId: activa.id, repetida: true }
        : { ok: false as const, error: "ya_solicitada" as const };
    }
    const conserva = (await candidatos(tx, operacionId, r.c)).find((x) => x.operacionId === datos.conservaOperacionId);
    if (!conserva) return { ok: false as const, error: "conserva_invalido" as const };
    const [x] = await tx<{ id: string }[]>`
      insert into cancelacion_cobro (cobro_id, conserva_cobro_id, tipo, explicacion, sucursal_id, solicitada_por)
      values (${r.c.cobroId}, ${conserva.cobroId}, 'duplicado', ${explicacion}, ${r.c.sucursalId}, ${usuarioId})
      returning id`;
    return { ok: true as const, cancelacionId: x.id, repetida: false };
  });
}

// ---------------------------------------------------------------------------
// Autorización
// ---------------------------------------------------------------------------

/** Límite vigente de la facultad autorizacion.devolucion de la persona en la sucursal; null si no la tiene. */
async function limiteDeFacultad(tx: Tx | Sql, usuarioId: string, sucursalId: string): Promise<number | null> {
  const [f] = await tx<{ limite: string | null }[]>`
    select max(f.limite_monto)::text as limite from facultad_otorgada f join usuario u on u.id = f.usuario_id and u.activo
    where f.usuario_id = ${usuarioId} and f.permiso = 'autorizacion.devolucion'
      and (f.sucursal_id = ${sucursalId} or f.todas_las_sucursales)
      and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en)`;
  return f?.limite == null ? null : Number(f.limite);
}

export type CancelacionPorAutorizar = {
  id: string;
  version: number;
  explicacion: string;
  solicitadaPor: string;
  solicitadaEn: Date;
  duplicado: CobroResumen;
  conserva: CobroResumen;
  /** Por qué esta persona no puede aprobarla, si es el caso. */
  impedimento: "propia" | "registro_propio" | "excede_limite" | null;
};

async function sucursalAutorizable(tx: Tx | Sql, usuarioId: string, codigo: string) {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  const [s] = await tx<{ id: string; nombre: string }[]>`select id, nombre from sucursal where codigo = ${codigo}`;
  if (!s) return null;
  const limite = await limiteDeFacultad(tx, usuarioId, s.id);
  return limite === null ? null : { ...s, limite };
}

export async function puedeAutorizarCancelaciones(sql: Sql, usuarioId: string, codigo: string) {
  return (await sucursalAutorizable(sql, usuarioId, codigo)) !== null;
}

/** Solicitudes pendientes de la sucursal. null si la persona no tiene la facultad en ella. */
export async function cancelacionesPorAutorizar(sql: Sql, usuarioId: string, codigo: string):
  Promise<{ sucursal: string; limite: number; pendientes: CancelacionPorAutorizar[] } | null> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const s = await sucursalAutorizable(tx, usuarioId, codigo);
    if (!s) return null;
    const filas = await tx<{ id: string; version: number; explicacion: string; solicitada_por_id: string; solicitada_por: string;
      solicitada_en: Date; cobro_id: string; conserva_id: string }[]>`
      select x.id, x.version, x.explicacion, x.solicitada_por as solicitada_por_id, u.nombre as solicitada_por, x.solicitada_en,
             x.cobro_id, x.conserva_cobro_id as conserva_id
      from cancelacion_cobro x join usuario u on u.id = x.solicitada_por
      where x.sucursal_id = ${s.id} and x.estado = 'solicitada'
      order by x.solicitada_en`;
    const pendientes: CancelacionPorAutorizar[] = [];
    for (const f of filas) {
      const [dup] = await tx<(CobroResumen & { registrada_por_id: string })[]>`${RESUMEN(tx)} where c.id = ${f.cobro_id}`;
      const [con] = await tx<CobroResumen[]>`${RESUMEN(tx)} where c.id = ${f.conserva_id}`;
      const registrada_por_id = dup.registrada_por_id;
      const duplicado = resumen(dup);
      pendientes.push({
        id: f.id, version: f.version, explicacion: f.explicacion, solicitadaPor: f.solicitada_por, solicitadaEn: f.solicitada_en,
        duplicado, conserva: resumen(con),
        impedimento: f.solicitada_por_id === usuarioId ? "propia" : registrada_por_id === usuarioId ? "registro_propio"
          : Number(duplicado.total) > s.limite ? "excede_limite" : null,
      });
    }
    return { sucursal: s.nombre, limite: s.limite, pendientes };
  });
}

export type ErrorResolucion =
  | "no_encontrada"
  | "propia"
  | "registro_propio"
  | "excede_limite"
  | "cambio"
  | "conserva_invalido"
  | "turno_no_abierto"
  | "motivo"
  | "bloqueado_produccion";

/** Aprueba o rechaza una solicitud pendiente, si sigue en la versión que vio quien autoriza. */
export async function resolverCancelacion(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  cancelacionId: string,
  datos: { version: number; decision: "aprobar" | "rechazar"; motivo?: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorResolucion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(cancelacionId)) return { ok: false, error: "no_encontrada" };
  const motivo = (datos.motivo ?? "").trim().replace(/\s+/g, " ");
  if (datos.decision === "rechazar" && (motivo.length < 5 || motivo.length > 300)) return { ok: false, error: "motivo" };

  return sql.begin(async (tx) => {
    const s = await sucursalAutorizable(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    const [x] = await tx<{ id: string; version: number; estado: string; cobro_id: string; conserva_cobro_id: string; solicitada_por: string; explicacion: string }[]>`
      select id, version, estado, cobro_id, conserva_cobro_id, solicitada_por, explicacion from cancelacion_cobro
      where id = ${cancelacionId} and sucursal_id = ${s.id}
      for update`;
    if (!x) return { ok: false as const, error: "no_encontrada" as const };
    if (x.solicitada_por === usuarioId) return { ok: false as const, error: "propia" as const };
    // Ambos cobros, bloqueados en orden para que dos aprobaciones cruzadas no se adelanten una a otra.
    const cobros = await tx<{ id: string; estado: string; importe: string; version: number; operacion_id: string; registrada_por: string; turno_id: string; abierto: boolean }[]>`
      select c.id, c.estado, c.importe::text as importe, c.version, c.operacion_id, o.registrada_por, o.turno_id, t.cerrado_en is null as abierto
      from cobro_visita c join operacion_visita o on o.id = c.operacion_id join turno t on t.id = o.turno_id
      where c.id in (${x.cobro_id}, ${x.conserva_cobro_id})
      order by c.id
      for update of c`;
    const dup = cobros.find((c) => c.id === x.cobro_id)!;
    const con = cobros.find((c) => c.id === x.conserva_cobro_id)!;
    if (dup.registrada_por === usuarioId) return { ok: false as const, error: "registro_propio" as const };
    if (x.estado !== "solicitada" || x.version !== datos.version) return { ok: false as const, error: "cambio" as const };

    if (datos.decision === "rechazar") {
      await tx`update cancelacion_cobro set estado = 'rechazada', resuelta_por = ${usuarioId}, resuelta_en = now(),
               motivo_rechazo = ${motivo}, version = version + 1 where id = ${x.id}`;
      return { ok: true as const };
    }

    if (Number(dup.importe) > s.limite) return { ok: false as const, error: "excede_limite" as const };
    if (!dup.abierto) return { ok: false as const, error: "turno_no_abierto" as const };
    if (dup.estado !== "confirmado" || con.estado !== "confirmado") return { ok: false as const, error: "conserva_invalido" as const };
    const [conPendiente] = await tx`select 1 from cancelacion_cobro where cobro_id = ${con.id} and estado = 'aprobada'`;
    if (conPendiente) return { ok: false as const, error: "conserva_invalido" as const };

    // Un solo ajuste: exactamente menos la entrada de efectivo de ese cobro (la base lo comprueba y no deja dos).
    const [entrada] = await tx<{ lugar_id: string; turno_id: string; importe: string; responsable_id: string }[]>`
      select lugar_id, turno_id, importe::text as importe, responsable_id from movimiento_efectivo
      where cobro_id = ${dup.id} and tipo = 'entrada_cobro_visita'`;
    const [ajuste] = await tx<{ id: string }[]>`
      insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, cobro_id, responsable_id, registrado_por)
      values (${entrada.lugar_id}, ${entrada.turno_id}, 'ajuste_cancelacion_cobro', ${-Number(entrada.importe)}, ${dup.id},
              ${entrada.responsable_id}, ${usuarioId})
      returning id`;
    await tx`update cobro_visita set estado = 'cancelado', version = version + 1 where id = ${dup.id}`;
    await tx`update pase_visita set cancelado_en = now() where operacion_id = ${dup.operacion_id}`;
    await tx`
      insert into cobro_cambio_estado (cobro_id, de, a, motivo, usuario_id, sucursal_id)
      values (${dup.id}, 'confirmado', 'cancelado', ${`Duplicado: ${x.explicacion}`.slice(0, 300)}, ${usuarioId}, ${s.id})`;
    await tx`update cancelacion_cobro set estado = 'aprobada', resuelta_por = ${usuarioId}, resuelta_en = now(),
             ajuste_id = ${ajuste.id}, version = version + 1 where id = ${x.id}`;
    return { ok: true as const };
  });
}

export type CancelacionDeCobro = {
  id: string;
  estado: "solicitada" | "aprobada" | "rechazada";
  explicacion: string;
  solicitadaPor: string;
  solicitadaEn: Date;
  conservaOperacionId: string;
  resueltaPor: string | null;
  resueltaEn: Date | null;
  motivoRechazo: string | null;
  ajuste: string | null;
};

/** Solicitudes de cancelación de un cobro (o donde se conserva), para el detalle. Quien llama ya vio el cobro. */
export async function cancelacionesDeCobro(sql: Sql, cobroId: string): Promise<{ propias: CancelacionDeCobro[]; comoConservado: { operacionId: string; estado: string }[] }> {
  const propias = await sql<CancelacionDeCobro[]>`
    select x.id, x.estado, x.explicacion, us.nombre as "solicitadaPor", x.solicitada_en as "solicitadaEn",
           oc.id as "conservaOperacionId", ur.nombre as "resueltaPor", x.resuelta_en as "resueltaEn", x.motivo_rechazo as "motivoRechazo",
           m.importe::text as ajuste
    from cancelacion_cobro x
    join usuario us on us.id = x.solicitada_por
    join cobro_visita cc on cc.id = x.conserva_cobro_id join operacion_visita oc on oc.id = cc.operacion_id
    left join usuario ur on ur.id = x.resuelta_por
    left join movimiento_efectivo m on m.id = x.ajuste_id
    where x.cobro_id = ${cobroId}
    order by x.solicitada_en`;
  const comoConservado = await sql<{ operacionId: string; estado: string }[]>`
    select o.id as "operacionId", x.estado from cancelacion_cobro x
    join cobro_visita c on c.id = x.cobro_id join operacion_visita o on o.id = c.operacion_id
    where x.conserva_cobro_id = ${cobroId} and x.estado in ('solicitada', 'aprobada')`;
  return { propias: [...propias], comoConservado: [...comoConservado] };
}

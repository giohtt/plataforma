import type postgres from "postgres";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Dirección resuelve el faltante confirmado de un retiro o de un sobre recogido (25 nov 2026; solo datos ficticios).
 * Una sola decisión por ahora: «Lo absorbe la sucursal», con motivo. Cierra el caso; no cambia el efectivo contado, los
 * depósitos ni el monto habilitado, y no descuenta nada a ninguna persona. Resuelve Dirección que no participó, o quien
 * participó con su autorización personal vigente para resolver lo propio en esa sucursal (26 nov 2026), distinta de la de
 * revisar lo propio; esa resolución queda marcada para siempre «Resuelta por quien participó». La base vuelve a
 * comprobarlo todo.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type ErrorResolucionFaltante = "no_encontrado" | "sin_permiso" | "participaste" | "no_pendiente" | "ya_resuelta" | "motivo" | "bloqueado_produccion";
export type Resolucion = {
  decision: "absorbe_sucursal"; motivo: string; por: string; en: Date;
  /** Resuelta por quien participó, con su autorización personal (marca permanente). */
  propia: boolean;
  /** Hasta cuándo valía la autorización con que se resolvió (solo si es propia). */
  autorizadaHasta: Date | null;
};
/** Lo que necesita la pantalla del caso: su resolución, si esta cuenta puede resolver y, si no, por qué. */
export type EstadoResolucion = {
  resolucion: Resolucion | null;
  /** Faltante confirmado, sin resolver. */
  pendiente: boolean;
  puede: boolean;
  /** Es Dirección con el permiso y participó. */
  participo: boolean;
  /** Participó y tiene la autorización vigente en esa sucursal: puede resolver, con la marca. Hasta cuándo vale. */
  autorizacionHasta: Date | null;
};
export const MARCA_PROPIA = "Resuelta por quien participó";

export const TEXTO_DECISION = "Lo absorbe la sucursal";
const texto = (v: string) => v.trim().replace(/\s+/g, " ");

async function estado(tx: Tx | Sql, usuarioId: string, fila: { sucursal_id: string; resultado: string | null; participo: boolean } | undefined,
                      resolucion: Resolucion | undefined): Promise<(EstadoResolucion & { autorizacionId: string | null }) | null> {
  if (!fila) return null;
  const [{ direccion, autorizacion, hasta }] = await tx<{ direccion: boolean; autorizacion: string | null; hasta: Date | null }[]>`
    select tiene_permiso(${usuarioId}, 'diferencia.resolver', ${fila.sucursal_id})
           and exists (select 1 from perfiles_en_sucursal(${usuarioId}, ${fila.sucursal_id}) p where p = 'direccion') as direccion,
           a.id as autorizacion, a.vigente_hasta as hasta
    from (select autorresolucion_vigente(${usuarioId}, ${fila.sucursal_id}) as id) v left join autorresolucion a on a.id = v.id`;
  const pendiente = fila.resultado === "faltante_confirmado" && !resolucion;
  const participo = pendiente && direccion && fila.participo;
  const conAutorizacion = participo && autorizacion !== null;
  return {
    resolucion: resolucion ?? null, pendiente, puede: pendiente && direccion && (!fila.participo || conAutorizacion), participo,
    autorizacionHasta: conAutorizacion ? hasta : null, autorizacionId: conAutorizacion ? autorizacion : null,
  };
}
const RESOLUCION = (tabla: "resolucion_retiro" | "resolucion_diferencia_sobre") => `
  select x.decision, x.motivo, u.nombre as por, x.en, x.autorresolucion_id is not null as propia, a.vigente_hasta as "autorizadaHasta"
  from ${tabla} x join usuario u on u.id = x.resuelta_por left join autorresolucion a on a.id = x.autorresolucion_id`;

export async function estadoResolucionRetiro(tx: Tx | Sql, usuarioId: string, retiroId: string) {
  const [f] = await tx<{ sucursal_id: string; resultado: string | null; participo: boolean }[]>`
    select r.sucursal_id, v.resultado, ${usuarioId}::uuid in (select participantes_retiro(r.id)) as participo
    from retiro r left join retiro_revision v on v.retiro_id = r.id where r.id = ${retiroId}`;
  const [x] = await tx.unsafe<Resolucion[]>(`${RESOLUCION("resolucion_retiro")} where x.retiro_id = $1`, [retiroId]);
  return estado(tx, usuarioId, f, x);
}

export async function estadoResolucionSobre(tx: Tx | Sql, usuarioId: string, diferenciaId: string) {
  const [f] = await tx<{ sucursal_id: string; resultado: string | null; participo: boolean }[]>`
    select s.sucursal_id, v.resultado, ${usuarioId}::uuid in (select participantes_sobre(s.id)) as participo
    from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id left join revision_diferencia_sobre v on v.diferencia_id = d.id
    where d.id = ${diferenciaId}`;
  const [x] = await tx.unsafe<Resolucion[]>(`${RESOLUCION("resolucion_diferencia_sobre")} where x.diferencia_id = $1`, [diferenciaId]);
  return estado(tx, usuarioId, f, x);
}

async function resolver(
  sql: Sql, usuarioId: string, codigo: string, id: string, motivoBruto: string, entorno: Entorno, clase: "retiro" | "sobre",
): Promise<{ ok: true } | { ok: false; error: ErrorResolucionFaltante }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!/^[A-Z0-9]{2,5}$/.test(codigo) || !esIdentificadorValido(id)) return { ok: false, error: "no_encontrado" };
  const motivo = texto(motivoBruto);
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  try {
    return await sql.begin(async (tx) => {
      // El caso debe ser de esta sucursal; se bloquea para que dos personas no lo resuelvan a la vez.
      const [s] = clase === "retiro"
        ? await tx<{ consulta: boolean }[]>`
            select tiene_permiso(${usuarioId}, 'diferencia.consultar', r.sucursal_id) or tiene_permiso(${usuarioId}, 'retiro.consultar', r.sucursal_id) as consulta
            from retiro r join sucursal x on x.id = r.sucursal_id where r.id = ${id} and x.codigo = ${codigo} for update of r`
        : await tx<{ consulta: boolean }[]>`
            select tiene_permiso(${usuarioId}, 'diferencia.consultar', s.sucursal_id) as consulta
            from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id join sucursal x on x.id = s.sucursal_id
            where d.id = ${id} and x.codigo = ${codigo} for update of d`;
      if (!s || !s.consulta) return { ok: false as const, error: "no_encontrado" as const };
      const e = clase === "retiro" ? await estadoResolucionRetiro(tx, usuarioId, id) : await estadoResolucionSobre(tx, usuarioId, id);
      if (!e) return { ok: false as const, error: "no_encontrado" as const };
      if (e.resolucion) return { ok: false as const, error: "ya_resuelta" as const };
      if (!e.pendiente) return { ok: false as const, error: "no_pendiente" as const };
      if (e.participo && !e.autorizacionId) return { ok: false as const, error: "participaste" as const };
      if (!e.puede) return { ok: false as const, error: "sin_permiso" as const };
      if (clase === "retiro") {
        await tx`insert into resolucion_retiro (retiro_id, decision, motivo, resuelta_por, autorresolucion_id)
                 values (${id}, 'absorbe_sucursal', ${motivo}, ${usuarioId}, ${e.autorizacionId})`;
      } else {
        await tx`insert into resolucion_diferencia_sobre (diferencia_id, decision, motivo, resuelta_por, autorresolucion_id)
                 values (${id}, 'absorbe_sucursal', ${motivo}, ${usuarioId}, ${e.autorizacionId})`;
      }
      await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
               values (${clase === "retiro" ? "retiro" : "diferencia_sobre"}, ${id}, 'resolver_faltante',
                       ${tx.json({ decision: "absorbe_sucursal", propia: e.autorizacionId !== null, autorresolucion: e.autorizacionId })}, ${motivo}, ${usuarioId})`;
      return { ok: true as const };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return { ok: false, error: "ya_resuelta" };
    throw error;
  }
}

/** Dirección resuelve el faltante confirmado de un retiro: «Lo absorbe la sucursal», con motivo. */
export const resolverFaltanteRetiro = (sql: Sql, usuarioId: string, codigo: string, datos: { retiroId: string; motivo: string }, { entorno }: { entorno: Entorno }) =>
  resolver(sql, usuarioId, codigo, datos.retiroId, datos.motivo, entorno, "retiro");

/** Dirección resuelve el faltante confirmado de un sobre recogido: «Lo absorbe la sucursal», con motivo. */
export const resolverFaltanteSobre = (sql: Sql, usuarioId: string, codigo: string, datos: { diferenciaId: string; motivo: string }, { entorno }: { entorno: Entorno }) =>
  resolver(sql, usuarioId, codigo, datos.diferenciaId, datos.motivo, entorno, "sobre");

export const MENSAJES_RESOLUCION: Record<ErrorResolucionFaltante, string> = {
  no_encontrado: "No encontrado.",
  sin_permiso: "Este faltante lo resuelve Dirección de la sucursal.",
  participaste: "Participaste en este caso: lo resuelve otra cuenta de Dirección que no participó, o tú con una autorización vigente para resolver lo propio. La de revisar lo propio no aplica a resolver.",
  no_pendiente: "Solo se resuelve un faltante confirmado.",
  ya_resuelta: "Este faltante ya se resolvió.",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
  bloqueado_produccion: "Las resoluciones están desactivadas fuera del entorno de pruebas.",
};

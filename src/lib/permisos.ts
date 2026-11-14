import type postgres from "postgres";

/**
 * Permisos y alcance. Toda decisión usa las funciones de la base (tiene_permiso,
 * perfiles_en_sucursal), para que haya una sola definición de "vigente" y de "tiene permiso".
 * Recibe la conexión como parámetro para poder probarla contra una base real.
 */
type Sql = postgres.Sql;

export type Rol = "recepcion" | "encargado" | "administracion" | "direccion" | "encargada_retiros" | "contabilidad" | "mantenimiento" | "marketing" | "soporte";

export type SucursalAccesible = {
  id: string;
  codigo: string;
  nombre: string;
  color: string | null;
  estadoOperativo: "proxima" | "activa" | "inactiva";
  zonaHoraria: string;
  perfiles: Rol[];
};

/** Sucursales que el usuario puede consultar, con sus perfiles vigentes en cada una. */
export async function sucursalesAccesibles(sql: Sql, usuarioId: string): Promise<SucursalAccesible[]> {
  return sql<SucursalAccesible[]>`
    select s.id, s.codigo, s.nombre, s.color, s.estado_operativo as "estadoOperativo", s.zona_horaria as "zonaHoraria",
           coalesce(array(select r from perfiles_en_sucursal(${usuarioId}, s.id) r order by r), '{}') as perfiles
    from sucursal s
    where tiene_permiso(${usuarioId}, 'sucursal.consultar', s.id)
    order by case s.estado_operativo when 'activa' then 0 when 'proxima' then 1 else 2 end, s.nombre`;
}

/** Una sucursal por código, solo si el usuario puede consultarla. Si no, null (no se revela si existe). */
export async function sucursalAccesiblePorCodigo(sql: Sql, usuarioId: string, codigo: string): Promise<SucursalAccesible | null> {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  const lista = await sql<SucursalAccesible[]>`
    select s.id, s.codigo, s.nombre, s.color, s.estado_operativo as "estadoOperativo", s.zona_horaria as "zonaHoraria",
           coalesce(array(select r from perfiles_en_sucursal(${usuarioId}, s.id) r order by r), '{}') as perfiles
    from sucursal s
    where s.codigo = ${codigo} and tiene_permiso(${usuarioId}, 'sucursal.consultar', s.id)`;
  return lista[0] ?? null;
}

/**
 * Formato exacto de un identificador (UUID: 8-4-4-4-12 dígitos hexadecimales).
 * Se valida antes de consultar la base: un valor mal formado nunca llega a PostgreSQL.
 */
const FORMATO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function esIdentificadorValido(id: string): boolean {
  return FORMATO_ID.test(id);
}

/** Igual que la anterior, por identificador. Formato inválido: null, igual que sin permiso. */
export async function sucursalAccesiblePorId(sql: Sql, usuarioId: string, id: string): Promise<SucursalAccesible | null> {
  if (!esIdentificadorValido(id)) return null;
  const lista = await sql<SucursalAccesible[]>`
    select s.id, s.codigo, s.nombre, s.color, s.estado_operativo as "estadoOperativo", s.zona_horaria as "zonaHoraria",
           coalesce(array(select r from perfiles_en_sucursal(${usuarioId}, s.id) r order by r), '{}') as perfiles
    from sucursal s
    where s.id = ${id} and tiene_permiso(${usuarioId}, 'sucursal.consultar', s.id)`;
  return lista[0] ?? null;
}

/**
 * ¿Tiene el usuario el permiso en la sucursal? Para facultades de autorización solo dice si la tiene
 * vigente para esa sucursal; NO compara importes. Al aprobar un gasto (bloque 6) hay que comprobar
 * además, en el servidor y en la misma transacción, que el importe no supere limite_monto.
 */
export async function tienePermiso(sql: Sql, usuarioId: string, permiso: string, sucursalId: string | null = null): Promise<boolean> {
  const [{ ok }] = await sql<{ ok: boolean }[]>`select tiene_permiso(${usuarioId}, ${permiso}, ${sucursalId}) as ok`;
  return ok;
}

export type ResumenAccesos = {
  asignaciones: { rol: Rol; sucursal: string; codigo: string; hasta: Date | null }[];
  alcancesGenerales: { rol: Rol; hasta: Date | null }[];
  facultades: { permiso: string; descripcion: string; sucursal: string | null; todas: boolean; limite: string | null; hasta: Date | null }[];
};

/** Lo que el usuario tiene vigente hoy, para mostrárselo con claridad. */
export async function resumenAccesos(sql: Sql, usuarioId: string): Promise<ResumenAccesos> {
  const asignaciones = await sql<ResumenAccesos["asignaciones"]>`
    select a.rol, s.nombre as sucursal, s.codigo, a.vigente_hasta as hasta
    from asignacion a join sucursal s on s.id = a.sucursal_id
    where a.usuario_id = ${usuarioId} and vigente(a.vigente_desde, a.vigente_hasta, a.revocada_en)
    order by s.nombre, a.rol`;
  const alcancesGenerales = await sql<ResumenAccesos["alcancesGenerales"]>`
    select rol, vigente_hasta as hasta from alcance_general
    where usuario_id = ${usuarioId} and vigente(vigente_desde, vigente_hasta, revocado_en)
    order by rol`;
  const facultades = await sql<ResumenAccesos["facultades"]>`
    select f.permiso, p.descripcion, s.nombre as sucursal, f.todas_las_sucursales as todas,
           f.limite_monto::text as limite, f.vigente_hasta as hasta
    from facultad_otorgada f join permiso p on p.clave = f.permiso left join sucursal s on s.id = f.sucursal_id
    where f.usuario_id = ${usuarioId} and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en)
    order by f.permiso`;
  return { asignaciones, alcancesGenerales, facultades };
}

export const NOMBRE_PERFIL: Record<Rol, string> = {
  recepcion: "Recepción",
  encargado: "Encargado de sucursal",
  administracion: "Administración",
  direccion: "Dirección",
  encargada_retiros: "Encargada de retiros",
  contabilidad: "Contabilidad y fiscal",
  mantenimiento: "Mantenimiento",
  marketing: "Marketing y atención digital",
  soporte: "Soporte técnico",
};

import type postgres from "postgres";
import type { Rol } from "@/lib/permisos";

/**
 * Reporte básico del bloque 1: usuarios y sus accesos en una sucursal. Solo consulta.
 *
 * El permiso usuario.consultar se comprueba en el servidor para la sucursal pedida, dentro de la
 * misma transacción de solo lectura que arma el reporte, así que todo sale de una sola foto de la base.
 * Sin permiso, o si la sucursal no existe: null (la misma respuesta en los dos casos).
 *
 * Tres vías de acceso, mostradas por separado:
 *   - asignación local: perfil otorgado en esta sucursal;
 *   - acceso general: perfil otorgado en todas las sucursales, que también cubre esta;
 *   - facultades: solo las otorgadas para esta sucursal o para todas.
 */
type Sql = postgres.Sql;

export type EstadoAcceso = "vigente" | "programada" | "vencida" | "revocada" | "cuenta_desactivada";

type Comun = {
  id: string;
  usuarioId: string;
  nombre: string;
  desde: Date;
  hasta: Date | null;
  revocadaEn: Date | null;
  otorgadoPor: string | null;
  revocadoPor: string | null;
  estado: EstadoAcceso;
};

export type AccesoPerfil = Comun & { rol: Rol };
export type FacultadEnSucursal = Comun & {
  permiso: string;
  descripcion: string;
  esAutorizacion: boolean;
  todas: boolean;
  limite: string | null;
};

export type ReporteUsuarios = {
  sucursal: { id: string; codigo: string; nombre: string; estadoOperativo: string };
  incluyeAnteriores: boolean;
  locales: AccesoPerfil[];
  generales: AccesoPerfil[];
  facultades: FacultadEnSucursal[];
  /** Personas distintas con algún acceso vigente aquí. Quien tiene dos vías cuenta una sola vez. */
  totalPersonas: number;
  generadoEn: Date;
};

export type SucursalReporte = { id: string; codigo: string; nombre: string };

/** Sucursales en las que la persona puede consultar usuarios: las únicas que puede elegir. */
export async function sucursalesConReporte(sql: Sql, usuarioId: string): Promise<SucursalReporte[]> {
  return sql<SucursalReporte[]>`
    select id, codigo, nombre from sucursal
    where tiene_permiso(${usuarioId}, 'usuario.consultar', id)
    order by nombre`;
}

// El estado sigue la misma regla que vigente(): revocada gana, después programada y vencida.
// Una cuenta desactivada no ejerce ningún acceso aunque sus fechas sigan vigentes.
const ESTADO = (t: string, revocado: string) => `
  case when not u.activo then 'cuenta_desactivada'
       when ${t}.${revocado} is not null then 'revocada'
       when ${t}.vigente_desde > now() then 'programada'
       when ${t}.vigente_hasta is not null and ${t}.vigente_hasta <= now() then 'vencida'
       else 'vigente' end`;

export async function reporteUsuariosSucursal(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  { anteriores }: { anteriores: boolean },
): Promise<ReporteUsuarios | null> {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;

  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const [sucursal] = await tx<ReporteUsuarios["sucursal"][]>`
      select id, codigo, nombre, estado_operativo as "estadoOperativo" from sucursal
      where codigo = ${codigo} and tiene_permiso(${usuarioId}, 'usuario.consultar', id)`;
    if (!sucursal) return null;

    const filtro = (t: string, revocado: string) => tx.unsafe(anteriores ? "true" : `(${ESTADO(t, revocado)}) = 'vigente'`);

    const locales = await tx<AccesoPerfil[]>`
      select a.id::text, u.id as "usuarioId", u.nombre, a.rol, a.vigente_desde as desde, a.vigente_hasta as hasta,
             a.revocada_en as "revocadaEn", o.nombre as "otorgadoPor", r.nombre as "revocadoPor",
             ${tx.unsafe(ESTADO("a", "revocada_en"))} as estado
      from asignacion a
      join usuario u on u.id = a.usuario_id
      left join usuario o on o.id = a.otorgada_por
      left join usuario r on r.id = a.revocada_por
      where a.sucursal_id = ${sucursal.id} and ${filtro("a", "revocada_en")}
      order by u.nombre, a.rol, a.vigente_desde desc`;

    const generales = await tx<AccesoPerfil[]>`
      select g.id::text, u.id as "usuarioId", u.nombre, g.rol, g.vigente_desde as desde, g.vigente_hasta as hasta,
             g.revocado_en as "revocadaEn", o.nombre as "otorgadoPor", r.nombre as "revocadoPor",
             ${tx.unsafe(ESTADO("g", "revocado_en"))} as estado
      from alcance_general g
      join usuario u on u.id = g.usuario_id
      left join usuario o on o.id = g.otorgado_por
      left join usuario r on r.id = g.revocado_por
      where ${filtro("g", "revocado_en")}
      order by u.nombre, g.rol, g.vigente_desde desc`;

    const facultades = await tx<FacultadEnSucursal[]>`
      select f.id::text, u.id as "usuarioId", u.nombre, f.permiso, p.descripcion, p.es_autorizacion as "esAutorizacion",
             f.todas_las_sucursales as todas, f.limite_monto::text as limite,
             f.vigente_desde as desde, f.vigente_hasta as hasta, f.revocada_en as "revocadaEn",
             o.nombre as "otorgadoPor", r.nombre as "revocadoPor",
             ${tx.unsafe(ESTADO("f", "revocada_en"))} as estado
      from facultad_otorgada f
      join usuario u on u.id = f.usuario_id
      join permiso p on p.clave = f.permiso
      left join usuario o on o.id = f.otorgada_por
      left join usuario r on r.id = f.revocada_por
      where (f.sucursal_id = ${sucursal.id} or f.todas_las_sucursales) and ${filtro("f", "revocada_en")}
      order by u.nombre, f.permiso, f.vigente_desde desc`;

    const vigentes = new Set(
      [...locales, ...generales, ...facultades].filter((x) => x.estado === "vigente").map((x) => x.usuarioId),
    );
    const [{ ahora }] = await tx<{ ahora: Date }[]>`select now() as ahora`;

    return {
      sucursal,
      incluyeAnteriores: anteriores,
      locales: [...locales],
      generales: [...generales],
      facultades: [...facultades],
      totalPersonas: vigentes.size,
      generadoEn: ahora,
    };
  });
}

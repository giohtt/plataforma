import type postgres from "postgres";
import { enmascararTelefono } from "@/lib/datos-visitante";

/**
 * Reporte básico del bloque 2 (solo consulta, solo datos ficticios). Indicado el 4 nov 2026:
 *
 * - Lo ven Encargado, Administración y Dirección con el permiso reporte.expedientes, según sus sucursales.
 *   Recepción no. El permiso se comprueba en el servidor, dentro de la transacción que arma el reporte.
 * - «Expedientes creados»: fichas dadas de alta por sucursal donde se creó la ficha, en el periodo elegido
 *   (fechas de la zona horaria de cada sucursal). Las visitas por sucursal llegan en el bloque 4.
 * - «Posibles duplicados»: pares de fichas activas con el mismo teléfono registrado o un nombre muy parecido.
 *   Cada par una sola vez. Sin pares ya confirmados como personas distintas (también a través de fichas
 *   unidas) ni fichas unidas a otra. Un par con fichas de dos sucursales solo se muestra a quien tiene el
 *   reporte en ambas.
 */
type Sql = postgres.Sql;

/**
 * «Nombre muy parecido»: similitud de trigramas de al menos este valor (1 = idéntico; sin acentos ni mayúsculas).
 * Con 0.7 entran errores de escritura («Valeria Gómez/Gomes Pineda» 0.83, «José Ramírez/Ramires» 0.74) y
 * quedan fuera hermanos que solo comparten apellidos («Ana/Luis Martínez Ruiz» 0.61). Provisional.
 */
export const UMBRAL_NOMBRE_MUY_PARECIDO = 0.7;
const LIMITE_PARES = 200;

export type SucursalReporte = { id: string; codigo: string; nombre: string };
export type FilaCreados = { codigo: string; nombre: string; creados: number; unidosDespues: number };
export type FichaPar = { id: string; nombre: string; telefono: string | null; sucursal: string; codigo: string; creadoEn: Date };
export type ParDuplicado = { a: FichaPar; b: FichaPar; motivos: ("mismo_telefono" | "mismo_nombre" | "nombre_parecido")[] };

export type ReporteExpedientes = {
  sucursales: SucursalReporte[];
  filtro: { codigo: string | null; desde: string; hasta: string };
  creados: FilaCreados[];
  totalCreados: number;
  duplicados: ParDuplicado[];
  totalDuplicados: number;
  generadoEn: Date;
};

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
function fechaValida(f: unknown): f is string {
  if (typeof f !== "string" || !FECHA.test(f)) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(f);
}

/** Periodo por omisión: del primer día del mes hasta hoy, en la hora del centro de México. */
export function periodoPorOmision(ahora = new Date()): { desde: string; hasta: string } {
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(ahora); // AAAA-MM-DD
  return { desde: `${hoy.slice(0, 8)}01`, hasta: hoy };
}

export async function sucursalesConReporteExpedientes(sql: Sql, usuarioId: string): Promise<SucursalReporte[]> {
  return sql<SucursalReporte[]>`
    select id, codigo, nombre from sucursal
    where tiene_permiso(${usuarioId}, 'reporte.expedientes', id)
    order by nombre`;
}

/**
 * null si la persona no tiene el reporte en ninguna sucursal, o si pide una sucursal que no tiene
 * (misma respuesta que si no existiera). Fechas inválidas se reemplazan por el periodo por omisión.
 */
export async function reporteExpedientes(
  sql: Sql,
  usuarioId: string,
  pedido: { codigo?: string | null; desde?: string | null; hasta?: string | null },
): Promise<ReporteExpedientes | null> {
  const omision = periodoPorOmision();
  let desde = fechaValida(pedido.desde) ? pedido.desde : omision.desde;
  let hasta = fechaValida(pedido.hasta) ? pedido.hasta : omision.hasta;
  if (desde > hasta) [desde, hasta] = [hasta, desde];
  const codigo = pedido.codigo ? String(pedido.codigo) : null;
  if (codigo !== null && !/^[A-Z0-9]{2,5}$/.test(codigo)) return null;

  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const sucursales = await tx<SucursalReporte[]>`
      select id, codigo, nombre from sucursal
      where tiene_permiso(${usuarioId}, 'reporte.expedientes', id)
      order by nombre`;
    if (!sucursales.length) return null;
    if (codigo !== null && !sucursales.some((s) => s.codigo === codigo)) return null;
    const permitidas = sucursales.map((s) => s.id);
    const elegidas = codigo === null ? permitidas : sucursales.filter((s) => s.codigo === codigo).map((s) => s.id);

    // Expedientes creados en el periodo, por la sucursal donde se creó cada ficha.
    const creados = await tx<FilaCreados[]>`
      select s.codigo, s.nombre,
             count(v.id)::int as creados,
             count(v.id) filter (where v.fusionado_en_id is not null)::int as "unidosDespues"
      from sucursal s
      left join visitante v on v.sucursal_alta_id = s.id
        and v.creado_en >= (${desde}::date)::timestamp at time zone s.zona_horaria
        and v.creado_en <  (${hasta}::date + 1)::timestamp at time zone s.zona_horaria
      where s.id = any(${elegidas}::uuid[])
      group by s.codigo, s.nombre
      order by s.nombre`;

    // Posibles duplicados pendientes. Ambas fichas deben ser de sucursales con el reporte permitido.
    const filas = await tx<{
      a_id: string; a_nombre: string; a_tel: string | null; a_suc: string; a_cod: string; a_en: Date;
      b_id: string; b_nombre: string; b_tel: string | null; b_suc: string; b_cod: string; b_en: Date;
      mismo_tel: boolean; mismo_nombre: boolean; nombre_parecido: boolean; total: number;
    }[]>`
      with activos as (
        select v.id, v.nombre, v.nombre_clave, v.telefono, v.creado_en, v.sucursal_alta_id, s.nombre as suc, s.codigo as cod
        from visitante v join sucursal s on s.id = v.sucursal_alta_id
        where v.fusionado_en_id is null and v.sucursal_alta_id = any(${permitidas}::uuid[])
      ),
      pares as (
        select a.*, b.id as b_id, b.nombre as b_nombre, b.telefono as b_tel, b.creado_en as b_en,
               b.sucursal_alta_id as b_sucursal, b.suc as b_suc, b.cod as b_cod,
               (a.telefono is not null and a.telefono = b.telefono) as mismo_tel,
               a.nombre_clave = b.nombre_clave as mismo_nombre,
               similarity(a.nombre_clave, b.nombre_clave) >= ${UMBRAL_NOMBRE_MUY_PARECIDO} as nombre_parecido
        from activos a join activos b on a.id < b.id
        where (a.telefono is not null and a.telefono = b.telefono)
           or (a.nombre_clave % b.nombre_clave and similarity(a.nombre_clave, b.nombre_clave) >= ${UMBRAL_NOMBRE_MUY_PARECIDO})
      ),
      pendientes as (
        select p.* from pares p
        where (p.sucursal_alta_id = any(${elegidas}::uuid[]) or p.b_sucursal = any(${elegidas}::uuid[]))
          and not exists (
            select 1 from visitante_distinto d
            where (d.visitante_id in (select visitante_grupo(p.id)) and d.distinto_de_id in (select visitante_grupo(p.b_id)))
               or (d.visitante_id in (select visitante_grupo(p.b_id)) and d.distinto_de_id in (select visitante_grupo(p.id))))
      )
      select id as a_id, nombre as a_nombre, telefono as a_tel, suc as a_suc, cod as a_cod, creado_en as a_en,
             b_id, b_nombre, b_tel, b_suc, b_cod, b_en, mismo_tel, mismo_nombre, nombre_parecido,
             (count(*) over ())::int as total
      from pendientes
      order by mismo_tel desc, mismo_nombre desc, nombre, b_nombre
      limit ${LIMITE_PARES}`;

    const [{ ahora }] = await tx<{ ahora: Date }[]>`select now() as ahora`;
    const ficha = (id: string, nombre: string, tel: string | null, suc: string, cod: string, en: Date): FichaPar => ({
      id, nombre, telefono: enmascararTelefono(tel), sucursal: suc, codigo: cod, creadoEn: en,
    });
    return {
      sucursales: [...sucursales],
      filtro: { codigo, desde, hasta },
      creados: [...creados],
      totalCreados: creados.reduce((t, f) => t + f.creados, 0),
      duplicados: filas.map((f) => ({
        a: ficha(f.a_id, f.a_nombre, f.a_tel, f.a_suc, f.a_cod, f.a_en),
        b: ficha(f.b_id, f.b_nombre, f.b_tel, f.b_suc, f.b_cod, f.b_en),
        motivos: [
          ...(f.mismo_tel ? (["mismo_telefono"] as const) : []),
          ...(f.mismo_nombre ? (["mismo_nombre"] as const) : f.nombre_parecido ? (["nombre_parecido"] as const) : []),
        ],
      })),
      totalDuplicados: filas[0]?.total ?? 0,
      generadoEn: ahora,
    };
  });
}

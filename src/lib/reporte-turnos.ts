import type postgres from "postgres";

/**
 * Reporte básico del bloque 3 (solo consulta, solo datos ficticios). Indicado el 4 nov 2026:
 * turnos abiertos por sucursal, fecha y hora de apertura, quién abrió y quién es responsable de la bolsa
 * de visitas y del cajón de mensualidades, por separado. Lo ven Encargado, Administración y Dirección con
 * reporte.turnos en sus sucursales; Recepción no (sigue viendo su propio turno en la página del turno).
 * El permiso se comprueba en el servidor dentro de la transacción de solo lectura que arma el reporte.
 */
type Sql = postgres.Sql;

export type Responsable = { nombre: string; desde: Date };
export type FilaTurnos = {
  codigo: string;
  nombre: string;
  turno: { abiertoEn: Date; abiertoPor: string; bolsa: Responsable | null; cajon: Responsable | null } | null;
};
export type ReporteTurnos = {
  sucursales: { codigo: string; nombre: string }[];
  codigo: string | null;
  filas: FilaTurnos[];
  turnosAbiertos: number;
  generadoEn: Date;
};

/** null si no tiene el reporte en ninguna sucursal o pide una que no tiene (misma respuesta que si no existiera). */
export async function reporteTurnos(sql: Sql, usuarioId: string, codigo: string | null): Promise<ReporteTurnos | null> {
  if (codigo !== null && !/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const sucursales = await tx<{ id: string; codigo: string; nombre: string }[]>`
      select id, codigo, nombre from sucursal where tiene_permiso(${usuarioId}, 'reporte.turnos', id) order by nombre`;
    if (!sucursales.length) return null;
    if (codigo !== null && !sucursales.some((s) => s.codigo === codigo)) return null;
    const elegidas = sucursales.filter((s) => codigo === null || s.codigo === codigo).map((s) => s.id);

    const filas = await tx<{
      codigo: string; nombre: string; abierto_en: Date | null; abierto_por: string | null;
      bolsa: string | null; bolsa_desde: Date | null; cajon: string | null; cajon_desde: Date | null;
    }[]>`
      select s.codigo, s.nombre, t.abierto_en, ua.nombre as abierto_por,
             ub.nombre as bolsa, rb.desde as bolsa_desde, uc.nombre as cajon, rc.desde as cajon_desde
      from sucursal s
      left join turno t on t.sucursal_id = s.id and t.cerrado_en is null
      left join usuario ua on ua.id = t.abierto_por
      left join lugar_efectivo lb on lb.sucursal_id = s.id and lb.tipo = 'bolsa_visitas'
      left join responsable_lugar rb on rb.lugar_id = lb.id and rb.turno_id = t.id and rb.hasta is null
      left join usuario ub on ub.id = rb.usuario_id
      left join lugar_efectivo lc on lc.sucursal_id = s.id and lc.tipo = 'cajon_mensualidades'
      left join responsable_lugar rc on rc.lugar_id = lc.id and rc.turno_id = t.id and rc.hasta is null
      left join usuario uc on uc.id = rc.usuario_id
      where s.id = any(${elegidas}::uuid[])
      order by s.nombre`;
    const [{ ahora }] = await tx<{ ahora: Date }[]>`select now() as ahora`;
    const resultado = filas.map((f) => ({
      codigo: f.codigo,
      nombre: f.nombre,
      turno: f.abierto_en
        ? {
            abiertoEn: f.abierto_en,
            abiertoPor: f.abierto_por!,
            bolsa: f.bolsa ? { nombre: f.bolsa, desde: f.bolsa_desde! } : null,
            cajon: f.cajon ? { nombre: f.cajon, desde: f.cajon_desde! } : null,
          }
        : null,
    }));
    return {
      sucursales: sucursales.map(({ codigo, nombre }) => ({ codigo, nombre })),
      codigo,
      filas: resultado,
      turnosAbiertos: resultado.filter((f) => f.turno).length,
      generadoEn: ahora,
    };
  });
}

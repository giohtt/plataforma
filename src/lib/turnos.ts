import type postgres from "postgres";
import type { Entorno } from "@/lib/entorno";

/**
 * Apertura de turno de Recepción (bloque 3, primer paso; solo datos ficticios).
 *
 * - Un solo turno abierto a la vez por sucursal. Se comprueba en el servidor bloqueando la fila de la
 *   sucursal, y además la base lo garantiza con un índice único: dos aperturas simultáneas no pasan.
 * - Abre quien tiene turno.abrir en la sucursal (hoy, Recepción). No se abre en una sucursal inactiva.
 * - La bolsa de visitas y el cajón de mensualidades se registran por separado: el total contado de cada uno y
 *   quién se hace responsable. Abrir no registra cobros ni movimientos.
 * - El cajón se muestra siempre «No conciliado: faltan datos de Open Desk».
 * - En producción está bloqueado (solo datos ficticios).
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type TipoLugar = "bolsa_visitas" | "cajon_mensualidades";

export type LugarEnTurno = {
  tipo: TipoLugar;
  contadoAlAbrir: string; // importe con dos decimales
  responsable: string;
  responsableId: string;
  responsableDesde: Date;
  conciliado: boolean;
  /** Entradas de efectivo por visitas en este turno (suma y cuántas). En el cajón, siempre 0. */
  entradas: string;
  /** Cuántos cobros entraron y cuántas visitas (pases) cubren: un cobro grupal de 3 es 1 cobro y 3 visitas. */
  cantidadEntradas: number;
  visitasEntradas: number;
  /** Ajustes por cobros cancelados (negativo) y cuántos. El esperado los descuenta una sola vez. */
  ajustes: string;
  cantidadAjustes: number;
  /** Salidas por retiros entregados a Encargada de retiros (negativo) y cuántos. */
  retiros: string;
  cantidadRetiros: number;
  /**
   * Diferencias contra el esperado registradas al retirar (lo contado − el esperado) y cuántas. No cambian el esperado:
   * se vinculan a la diferencia contra el esperado del cambio de turno, sin duplicarse.
   */
  diferenciaRetiros: string;
  cantidadDiferenciasRetiro: number;
  /** Contado al abrir + entradas + ajustes − retiros. null en el cajón: no se calcula mientras falten los datos de Open Desk. */
  esperado: string | null;
};

export type TurnoAbierto = {
  id: string;
  abiertoPor: string;
  abiertoEn: Date;
  lugares: LugarEnTurno[];
};

export type EstadoTurno = {
  sucursal: { id: string; codigo: string; nombre: string; inactiva: boolean };
  turno: TurnoAbierto | null;
  puedeAbrir: boolean;
};

async function sucursalVisible(tx: Tx | Sql, usuarioId: string, codigo: string) {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  const [s] = await tx<{ id: string; codigo: string; nombre: string; inactiva: boolean; puede_abrir: boolean }[]>`
    select id, codigo, nombre, estado_operativo = 'inactiva' as inactiva,
           tiene_permiso(${usuarioId}, 'turno.abrir', id) as puede_abrir
    from sucursal
    where codigo = ${codigo}
      and (tiene_permiso(${usuarioId}, 'turno.consultar', id) or tiene_permiso(${usuarioId}, 'turno.abrir', id))`;
  return s ?? null;
}

export async function turnoAbiertoDe(tx: Tx | Sql, sucursalId: string): Promise<TurnoAbierto | null> {
  const [t] = await tx<{ id: string; abierto_por: string; abierto_en: Date }[]>`
    select t.id, u.nombre as abierto_por, t.abierto_en
    from turno t join usuario u on u.id = t.abierto_por
    where t.sucursal_id = ${sucursalId} and t.cerrado_en is null`;
  if (!t) return null;
  const lugares = await tx<LugarEnTurno[]>`
    select l.tipo, c.importe::text as "contadoAlAbrir", u.nombre as responsable, u.id as "responsableId",
           r.desde as "responsableDesde", false as conciliado,
           m.suma::text as entradas, m.cuantas as "cantidadEntradas", m.visitas as "visitasEntradas",
           m.ajustes::text as ajustes, m.cuantos_ajustes as "cantidadAjustes",
           m.salidas::text as retiros, m.cuantas_salidas as "cantidadRetiros",
           dr.suma::text as "diferenciaRetiros", dr.cuantas as "cantidadDiferenciasRetiro",
           case when l.tipo = 'bolsa_visitas' then (c.importe + m.suma + m.ajustes + m.salidas)::text end as esperado
    from lugar_efectivo l
    join conteo_efectivo c on c.lugar_id = l.id and c.turno_id = ${t.id} and c.momento = 'apertura'
    join responsable_lugar r on r.lugar_id = l.id and r.turno_id = ${t.id} and r.hasta is null
    join usuario u on u.id = r.usuario_id
    cross join lateral (
      select coalesce(sum(me.importe) filter (where me.tipo = 'entrada_cobro_visita'), 0)::numeric(12, 2) as suma,
             (count(*) filter (where me.tipo = 'entrada_cobro_visita'))::int as cuantas,
             coalesce(sum((select count(*) from pase_visita p join cobro_visita c on c.operacion_id = p.operacion_id
                           where c.id = me.cobro_id)) filter (where me.tipo = 'entrada_cobro_visita'), 0)::int as visitas,
             coalesce(sum(me.importe) filter (where me.tipo = 'ajuste_cancelacion_cobro'), 0)::numeric(12, 2) as ajustes,
             (count(*) filter (where me.tipo = 'ajuste_cancelacion_cobro'))::int as cuantos_ajustes,
             coalesce(sum(me.importe) filter (where me.tipo = 'salida_retiro'), 0)::numeric(12, 2) as salidas,
             (count(*) filter (where me.tipo = 'salida_retiro'))::int as cuantas_salidas
      from movimiento_efectivo me where me.turno_id = ${t.id} and me.lugar_id = l.id
    ) m
    cross join lateral (
      select coalesce(sum(x.importe), 0)::numeric(12, 2) as suma, count(*)::int as cuantas
      from diferencia_retiro x where x.turno_id = ${t.id} and x.lugar_id = l.id
    ) dr
    order by case l.tipo when 'bolsa_visitas' then 0 else 1 end`;
  return { id: t.id, abiertoPor: t.abierto_por, abiertoEn: t.abierto_en, lugares: [...lugares] };
}

/** Turno abierto de la sucursal, si lo hay. null si la persona no puede ver turnos ahí (misma respuesta que si no existe). */
export async function estadoTurno(sql: Sql, usuarioId: string, codigo: string): Promise<EstadoTurno | null> {
  const s = await sucursalVisible(sql, usuarioId, codigo);
  if (!s) return null;
  return {
    sucursal: { id: s.id, codigo: s.codigo, nombre: s.nombre, inactiva: s.inactiva },
    turno: await turnoAbiertoDe(sql, s.id),
    puedeAbrir: s.puede_abrir,
  };
}

export type ResultadoApertura =
  | { ok: true; turnoId: string }
  | { ok: false; error: "no_encontrada" | "sin_permiso" | "sucursal_inactiva" | "ya_abierto" | "bloqueado_produccion" };

/** `bolsa` y `cajon` llegan ya validados como importes con dos decimales (ver leerImporte). */
export async function abrirTurno(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  conteos: { bolsa: string; cajon: string },
  { entorno }: { entorno: Entorno },
): Promise<ResultadoApertura> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  try {
    return await sql.begin(async (tx): Promise<ResultadoApertura> => {
      const s = await sucursalVisible(tx, usuarioId, codigo);
      if (!s) return { ok: false, error: "no_encontrada" };
      if (!s.puede_abrir) return { ok: false, error: "sin_permiso" };
      // Una apertura a la vez por sucursal: la segunda espera aquí y después ve el turno ya abierto.
      const [fila] = await tx<{ estado: string }[]>`select estado_operativo as estado from sucursal where id = ${s.id} for update`;
      if (fila.estado === "inactiva") return { ok: false, error: "sucursal_inactiva" };
      if ((await tx`select 1 from turno where sucursal_id = ${s.id} and cerrado_en is null`).length) return { ok: false, error: "ya_abierto" };

      const [t] = await tx<{ id: string }[]>`insert into turno (sucursal_id, abierto_por) values (${s.id}, ${usuarioId}) returning id`;
      const lugares = await tx<{ id: string; tipo: TipoLugar }[]>`select id, tipo from lugar_efectivo where sucursal_id = ${s.id}`;
      for (const l of lugares) {
        // Un registro de responsable por lugar. Regla provisional: quien abre recibe ambos lugares
        // (REGLAS_PROVISIONALES_TURNO.mismoResponsableEnAmbos). Si se confirma otra regla, aquí se elige a otra persona.
        await tx`insert into responsable_lugar (lugar_id, turno_id, usuario_id) values (${l.id}, ${t.id}, ${usuarioId})`;
        await tx`
          insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por)
          values (${t.id}, ${l.id}, 'apertura', ${l.tipo === "bolsa_visitas" ? conteos.bolsa : conteos.cajon}, ${usuarioId})`;
      }
      await tx`
        insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
        values ('turno', ${t.id}, 'abrir',
                ${tx.json({ sucursal: codigo, bolsa_visitas: conteos.bolsa, cajon_mensualidades: conteos.cajon })}, ${usuarioId})`;
      return { ok: true, turnoId: t.id };
    });
  } catch (error) {
    // Respaldo: si dos aperturas llegaran a cruzarse, la base rechaza la segunda.
    if ((error as { code?: string; constraint_name?: string })?.code === "23505") return { ok: false, error: "ya_abierto" };
    throw error;
  }
}

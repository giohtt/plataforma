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
  responsableDesde: Date;
  conciliado: boolean;
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

async function turnoAbiertoDe(tx: Tx | Sql, sucursalId: string): Promise<TurnoAbierto | null> {
  const [t] = await tx<{ id: string; abierto_por: string; abierto_en: Date }[]>`
    select t.id, u.nombre as abierto_por, t.abierto_en
    from turno t join usuario u on u.id = t.abierto_por
    where t.sucursal_id = ${sucursalId} and t.cerrado_en is null`;
  if (!t) return null;
  const lugares = await tx<LugarEnTurno[]>`
    select l.tipo, c.importe::text as "contadoAlAbrir", u.nombre as responsable, r.desde as "responsableDesde",
           false as conciliado
    from lugar_efectivo l
    join conteo_efectivo c on c.lugar_id = l.id and c.turno_id = ${t.id} and c.momento = 'apertura'
    join responsable_lugar r on r.lugar_id = l.id and r.turno_id = ${t.id}
    join usuario u on u.id = r.usuario_id
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

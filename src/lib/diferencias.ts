import type postgres from "postgres";
import { esIdentificadorValido } from "@/lib/permisos";
import type { TipoLugar } from "@/lib/turnos";
import { ventasDelTurno, type VentasTurno } from "@/lib/ventas";
import { cobrosDelTurno } from "@/lib/visitas";

/**
 * Bloque 5, paso 2 (primera parte): diferencias de efectivo registradas en los cambios de turno.
 *
 * - Consultan quienes tienen diferencia.consultar en la sucursal (Encargado, Administración, Dirección). Sin permiso,
 *   la sucursal y sus casos no se encuentran.
 * - La lista agrupa por entrega y muestra primero las que tienen diferencias por revisar.
 * - El detalle separa el esperado, lo entregado, lo recibido y cada diferencia, y desglosa el saldo esperado con los
 *   movimientos del turno de origen hasta la entrega. No cambia ningún importe.
 * - Todavía no hay resultados de revisión: toda diferencia está «por revisar».
 */
type Sql = postgres.Sql;

export type TipoDiferencia = "contra_esperado" | "entre_personas";
export type EstadoDiferencia = "por_revisar";
export type Diferencia = { id: string; lugar: TipoLugar; tipo: TipoDiferencia; importe: string; estado: EstadoDiferencia };

export type CasoLista = {
  entregaId: string;
  entregadaEn: Date;
  confirmadaEn: Date;
  entregaPor: string;
  recibe: string;
  diferencias: Diferencia[];
  pendientes: number;
};

async function sucursalConsultable(sql: Sql, usuarioId: string, codigo: string) {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  const [s] = await sql<{ id: string; nombre: string }[]>`
    select id, nombre from sucursal where codigo = ${codigo} and tiene_permiso(${usuarioId}, 'diferencia.consultar', id)`;
  return s ?? null;
}

const DIFERENCIAS = (sql: Sql, entregaIds: string[]) => sql<(Diferencia & { entrega_id: string })[]>`
  select d.id, d.entrega_id, l.tipo as lugar, d.tipo, d.importe::text as importe, 'por_revisar' as estado
  from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id
  where d.entrega_id in ${sql(entregaIds)}
  order by case l.tipo when 'bolsa_visitas' then 0 else 1 end, d.tipo`;

const sinEntrega = (d: Diferencia & { entrega_id: string }): Diferencia => ({ id: d.id, lugar: d.lugar, tipo: d.tipo, importe: d.importe, estado: d.estado });

/** Entregas confirmadas de la sucursal: primero las que tienen diferencias por revisar; después, las más recientes. */
export async function listaDiferencias(sql: Sql, usuarioId: string, codigo: string): Promise<{ sucursal: string; casos: CasoLista[] } | null> {
  const s = await sucursalConsultable(sql, usuarioId, codigo);
  if (!s) return null;
  const entregas = await sql<{ id: string; creada_en: Date; resuelta_en: Date; entrega_por: string; recibe: string }[]>`
    select e.id, e.creada_en, e.resuelta_en, a.nombre as entrega_por, b.nombre as recibe
    from entrega_turno e join turno t on t.id = e.turno_id
    join usuario a on a.id = e.entrega_por join usuario b on b.id = e.recibe
    where t.sucursal_id = ${s.id} and e.estado = 'confirmada'
    order by e.resuelta_en desc
    limit 200`;
  const difs = entregas.length ? await DIFERENCIAS(sql, entregas.map((e) => e.id)) : [];
  const casos = entregas.map((e): CasoLista => {
    const diferencias = difs.filter((d) => d.entrega_id === e.id).map(sinEntrega);
    return {
      entregaId: e.id, entregadaEn: e.creada_en, confirmadaEn: e.resuelta_en, entregaPor: e.entrega_por, recibe: e.recibe,
      diferencias, pendientes: diferencias.filter((d) => d.estado === "por_revisar").length,
    };
  });
  casos.sort((a, b) => Number(b.pendientes > 0) - Number(a.pendientes > 0) || b.confirmadaEn.getTime() - a.confirmadaEn.getTime());
  return { sucursal: s.nombre, casos };
}

export type Cifras = { esperado: string | null; entregado: string; inicial: string; confirmado: string };

export type Desglose = {
  abiertoEn: Date;
  abiertoPor: string;
  contadoAlAbrir: string;
  cobros: { cuantos: number; visitas: number; importe: string };
  cancelaciones: { cuantas: number; importe: string };
  /** Calculado aquí con los movimientos hasta la entrega. Debe coincidir con el esperado guardado al entregar. */
  calculado: string;
};

export type DetalleDiferencias = {
  sucursal: string;
  entregaId: string;
  entregaPor: string;
  recibe: string;
  entregadaEn: Date;
  confirmadaEn: Date;
  nota: string | null;
  aclaracion: string | null;
  /** La cuenta que consulta contó, entregó o recibió en esta entrega. */
  participaste: boolean;
  lugares: Record<TipoLugar, Cifras>;
  diferencias: Diferencia[];
  desglose: Desglose;
  fueraDeLaBolsa: VentasTurno;
};

export async function detalleDiferencias(sql: Sql, usuarioId: string, codigo: string, entregaId: string): Promise<DetalleDiferencias | null> {
  if (!esIdentificadorValido(entregaId)) return null;
  const s = await sucursalConsultable(sql, usuarioId, codigo);
  if (!s) return null;
  const [e] = await sql<{ id: string; turno_id: string; creada_en: Date; resuelta_en: Date; nota: string | null; aclaracion: string | null;
                          entrega_por: string; entrega_por_id: string; recibe: string; recibe_id: string }[]>`
    select e.id, e.turno_id, e.creada_en, e.resuelta_en, e.nota, e.aclaracion,
           a.nombre as entrega_por, a.id as entrega_por_id, b.nombre as recibe, b.id as recibe_id
    from entrega_turno e join turno t on t.id = e.turno_id
    join usuario a on a.id = e.entrega_por join usuario b on b.id = e.recibe
    where e.id = ${entregaId} and t.sucursal_id = ${s.id} and e.estado = 'confirmada'`;
  if (!e) return null;

  const conteos = await sql<{ lugar: TipoLugar; tipo: string; importe: string; esperado: string | null }[]>`
    select l.tipo as lugar, c.tipo, c.importe::text as importe, c.esperado::text as esperado
    from entrega_conteo c join lugar_efectivo l on l.id = c.lugar_id where c.entrega_id = ${e.id}`;
  const de = (lugar: TipoLugar, tipo: string) => conteos.find((c) => c.lugar === lugar && c.tipo === tipo)!;
  const cifras = (lugar: TipoLugar): Cifras => ({
    esperado: de(lugar, "entregado").esperado, entregado: de(lugar, "entregado").importe,
    inicial: de(lugar, "recibido_inicial").importe, confirmado: de(lugar, "recibido_final").importe,
  });

  // Desglose de la bolsa: lo contado al abrir y los movimientos del turno registrados antes de la entrega.
  const [d] = await sql<{ abierto_en: Date; abierto_por: string; contado: string; cobros: number; visitas: number; importe_cobros: string;
                          cancelaciones: number; importe_cancelaciones: string }[]>`
    select t.abierto_en, u.nombre as abierto_por, c.importe::text as contado,
           (count(m.id) filter (where m.tipo = 'entrada_cobro_visita'))::int as cobros,
           coalesce(sum((select count(*) from pase_visita p join cobro_visita cv on cv.operacion_id = p.operacion_id where cv.id = m.cobro_id))
                    filter (where m.tipo = 'entrada_cobro_visita'), 0)::int as visitas,
           coalesce(sum(m.importe) filter (where m.tipo = 'entrada_cobro_visita'), 0)::numeric(12, 2)::text as importe_cobros,
           (count(m.id) filter (where m.tipo = 'ajuste_cancelacion_cobro'))::int as cancelaciones,
           coalesce(sum(m.importe) filter (where m.tipo = 'ajuste_cancelacion_cobro'), 0)::numeric(12, 2)::text as importe_cancelaciones
    from turno t join usuario u on u.id = t.abierto_por
    join lugar_efectivo l on l.sucursal_id = t.sucursal_id and l.tipo = 'bolsa_visitas'
    join conteo_efectivo c on c.turno_id = t.id and c.lugar_id = l.id and c.momento = 'apertura'
    left join movimiento_efectivo m on m.turno_id = t.id and m.lugar_id = l.id and m.en <= ${e.creada_en}
    where t.id = ${e.turno_id}
    group by t.abierto_en, u.nombre, c.importe`;
  const centavos = (v: string) => Math.round(Number(v) * 100);
  const calculado = ((centavos(d.contado) + centavos(d.importe_cobros) + centavos(d.importe_cancelaciones)) / 100).toFixed(2);

  const difs = await DIFERENCIAS(sql, [e.id]);
  return {
    sucursal: s.nombre, entregaId: e.id, entregaPor: e.entrega_por, recibe: e.recibe, entregadaEn: e.creada_en, confirmadaEn: e.resuelta_en,
    nota: e.nota, aclaracion: e.aclaracion, participaste: usuarioId === e.entrega_por_id || usuarioId === e.recibe_id,
    lugares: { bolsa_visitas: cifras("bolsa_visitas"), cajon_mensualidades: cifras("cajon_mensualidades") },
    diferencias: difs.map(sinEntrega),
    desglose: {
      abiertoEn: d.abierto_en, abiertoPor: d.abierto_por, contadoAlAbrir: d.contado,
      cobros: { cuantos: d.cobros, visitas: d.visitas, importe: d.importe_cobros },
      cancelaciones: { cuantas: d.cancelaciones, importe: d.importe_cancelaciones }, calculado,
    },
    fueraDeLaBolsa: ventasDelTurno(await cobrosDelTurno(sql, e.turno_id)),
  };
}

/** Cuántas diferencias por revisar hay en la sucursal (para el botón de la sucursal). null sin permiso. */
export async function pendientesDeRevision(sql: Sql, usuarioId: string, sucursalId: string): Promise<number | null> {
  const [r] = await sql<{ puede: boolean; n: number }[]>`
    select tiene_permiso(${usuarioId}, 'diferencia.consultar', ${sucursalId}) as puede,
           (select count(*)::int from diferencia_efectivo d join turno t on t.id = d.turno_id where t.sucursal_id = ${sucursalId}) as n`;
  return r.puede ? r.n : null;
}

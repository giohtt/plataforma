import type postgres from "postgres";
import {
  NOMBRE_AUTORIZACION_PREVIA, NOMBRE_COMPROBACION, NOMBRE_ORIGEN, NOMBRE_REEMBOLSO,
  type AutorizacionPrevia, type Comprobacion, type EstadoReembolso, type LugarAnticipo, type OrigenPago,
} from "@/lib/datos-gasto";
import { hastaElCorte, ventana } from "@/lib/reporte-caja";

/**
 * Reporte de gastos (bloque 6, PR 9; acordado el 27 y 28 nov 2026; solo datos ficticios).
 *
 * - Periodo por la fecha del pago al proveedor (en anticipos, la del pago al proveedor; la entrega y la comprobación se
 *   conservan aparte). También se muestra la fecha y hora del registro. Nada registrado después del corte aparece:
 *   pagos, autorizaciones, comprobantes, anticipos y reembolsos se toman como estaban al corte.
 * - Cada gasto se suma una sola vez, por lo pagado, aunque tenga varios pendientes. Anticipo y reembolso son pasos del
 *   mismo dinero, no gastos nuevos.
 * - Gastos sigue a la sucursal beneficiada (a la que se carga); Caja, a la que paga (en el reporte de caja).
 * - Por autorizar, autorizados sin pagar, anticipos por comprobar, cambio por devolver y rechazados van aparte: no se
 *   suman al total gastado.
 * - Visibilidad: quien consulta gastos en la sucursal beneficiada (Dirección, todas; Gestión administrativa, su
 *   alcance; Encargado y Administración, sus sucursales). Recepción no consulta gastos: ve los de su turno en el turno.
 * - Las fotos no van en los archivos: se indica cuántas hay y la clave para consultarlas en la plataforma.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

const cent = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Math.round(Number(v) * 100));
const pesos = (c: number) => (c / 100).toFixed(2);

/** Grupo del resumen por estado: un gasto en uno solo (el primero que le aplica), aunque tenga varios pendientes. */
export type GrupoEstado = "sin_autorizacion" | "reembolso" | "comprobante" | "comprobado";
export const NOMBRE_GRUPO: Record<GrupoEstado, string> = {
  sin_autorizacion: "Pagado sin autorización previa o no comprobada",
  reembolso: "Pagado · reembolso pendiente",
  comprobante: "Pagado · por comprobar o sin comprobante",
  comprobado: "Pagado y comprobado",
};
export type Vista = "estado" | "sucursal" | "lugar" | "autorizo" | "origen" | "categoria";
export const NOMBRE_VISTA: Record<Vista, string> = {
  estado: "Por estado", sucursal: "Por sucursal", lugar: "Por lugar de efectivo", autorizo: "Por quién autorizó", origen: "Por origen del dinero", categoria: "Por categoría",
};
export const VISTAS = Object.keys(NOMBRE_VISTA) as Vista[];

export type FilaGasto = {
  id: string; clave: string; codigo: string; concepto: string; categoria: string; beneficiada: string; paga: string; pagaOtra: boolean;
  compraDe: string | null;
  origen: OrigenPago;
  /** Lugar de efectivo del que salió (el del anticipo, si fue con anticipo). null: no fue efectivo. */
  lugar: LugarAnticipo | null;
  turnoCerrado: boolean;
  autorizo: string | null; autorizadoEn: Date | null;
  autorizacionPrevia: AutorizacionPrevia;
  /** Fecha del pago al proveedor (con hora solo si quien registró la declaró). */
  pagadoEl: string; horaDeclarada: string | null;
  /** Fecha y hora automática del registro del pago. */
  registradoEn: Date;
  anticipo: { entregadoEn: Date; comprobadoEn: Date } | null;
  importe: string;
  comprobacion: Comprobacion;
  reembolso: EstadoReembolso | null;
  grupo: GrupoEstado;
  /** Todo lo que le falta, aunque se sume una sola vez. */
  pendientes: string[];
  fotos: number;
};
export type Renglon = { etiqueta: string; n: number; importe: string };
export type Aparte = { n: number; importe: string };
export type FilaAnticipo = {
  clave: string; codigo: string; concepto: string; beneficiada: string; lugar: LugarAnticipo; entregado: string; entregadoEn: Date; entrego: string; recibe: string;
  confirmadoEn: Date | null;
  comprobado: { en: Date; gastado: string; pagadoEl: string; pagadoConAnticipo: string } | null;
  cambio: string; devuelto: string; porDevolver: string;
  excedente: { clave: string; importe: string; estado: string; cubiertoPersonal: string | null; reembolso: EstadoReembolso | null } | null;
  estado: string;
};
export type FilaReembolso = {
  clave: string; codigo: string; concepto: string; beneficiada: string; puso: string; importe: string; pagadoEl: string; registradoEn: Date;
  decision: { decision: "autorizado" | "rechazado"; por: string; en: Date; ronda: number } | null;
  pago: { origen: string; por: string; en: Date } | null;
  recibidoEn: Date | null;
  estado: EstadoReembolso;
};
export type EventoGasto = { clave: string; en: Date; evento: string; persona: string | null; importe: string | null };

export type ReporteGastos = {
  sucursales: { codigo: string; nombre: string }[];
  codigo: string | null;
  desde: string; hasta: string; periodoInvalido: boolean;
  corte: Date; inicio: Date; generadoEn: Date;
  filas: FilaGasto[];
  total: Aparte;
  vistas: Record<Vista, Renglon[]>;
  aparte: { porAutorizar: Aparte; autorizadosSinPagar: Aparte; anticiposPorComprobar: Aparte; cambioPorDevolver: Aparte; rechazados: Aparte };
  anticipos: FilaAnticipo[];
  reembolsos: FilaReembolso[];
};

const NOMBRE_LUGAR: Record<LugarAnticipo, string> = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" };

function grupoDe(f: Pick<FilaGasto, "autorizacionPrevia" | "reembolso" | "comprobacion">): GrupoEstado {
  if (f.autorizacionPrevia !== "comprobada") return "sin_autorizacion";
  if (f.reembolso !== null && f.reembolso !== "recibido") return "reembolso";
  if (f.comprobacion !== "comprobado") return "comprobante";
  return "comprobado";
}
function pendientesDe(f: Pick<FilaGasto, "autorizacionPrevia" | "reembolso" | "comprobacion">): string[] {
  const p: string[] = [];
  if (f.autorizacionPrevia !== "comprobada") p.push(NOMBRE_AUTORIZACION_PREVIA[f.autorizacionPrevia]);
  if (f.reembolso !== null && f.reembolso !== "recibido") p.push(NOMBRE_REEMBOLSO[f.reembolso]);
  if (f.comprobacion !== "comprobado") p.push(NOMBRE_COMPROBACION[f.comprobacion]);
  return p;
}

/** Agrupa las filas (cada una una vez) por una etiqueta; el total de la vista es el total gastado. */
function agrupar(filas: FilaGasto[], etiqueta: (f: FilaGasto) => string, orden?: string[]): Renglon[] {
  const m = new Map<string, { n: number; c: number }>();
  for (const f of filas) {
    const k = etiqueta(f);
    const x = m.get(k) ?? { n: 0, c: 0 };
    x.n += 1;
    x.c += cent(f.importe);
    m.set(k, x);
  }
  const lista = [...m.entries()].map(([k, x]) => ({ etiqueta: k, n: x.n, importe: pesos(x.c) }));
  return orden ? lista.sort((a, b) => orden.indexOf(a.etiqueta) - orden.indexOf(b.etiqueta)) : lista.sort((a, b) => cent(b.importe) - cent(a.importe) || a.etiqueta.localeCompare(b.etiqueta));
}

/** Sucursales donde consulta gastos. */
async function sucursalesGastos(tx: Tx | Sql, usuarioId: string) {
  return tx<{ id: string; codigo: string; nombre: string }[]>`
    select id, codigo, nombre from sucursal where tiene_permiso(${usuarioId}, 'gasto.consultar', id) order by nombre`;
}

async function calcular(tx: Tx, ids: string[], inicio: Date, corte: Date, desde: string, hasta: string): Promise<Omit<ReporteGastos, "sucursales" | "codigo" | "desde" | "hasta" | "periodoInvalido" | "corte" | "inicio" | "generadoEn">> {
  const c = hastaElCorte(corte);
  const filasBd = await tx<(Omit<FilaGasto, "grupo" | "pendientes" | "anticipo"> & { anticipoEntregado: Date | null; anticipoComprobado: Date | null })[]>`
    select g.id, g.clave, b.codigo, v.concepto, cat.nombre as categoria, b.nombre as beneficiada, pa.nombre as paga, g.sucursal_paga_id <> g.sucursal_id as "pagaOtra",
           o.clave as "compraDe", p.origen,
           case when p.origen in ('bolsa_visitas', 'cajon_mensualidades') then p.origen when p.origen = 'anticipo' then a.lugar end as lugar,
           p.turno_cerrado_id is not null as "turnoCerrado",
           du.nombre as autorizo, d.en as "autorizadoEn",
           autorizacion_previa_al(g.id, ${c}::text::timestamptz) as "autorizacionPrevia",
           to_char(p.pagado_el, 'YYYY-MM-DD') as "pagadoEl", to_char(p.hora_declarada, 'HH24:MI') as "horaDeclarada", p.en as "registradoEn",
           a.en as "anticipoEntregado", k.en as "anticipoComprobado",
           p.importe::text as importe,
           comprobacion_al(g.id, ${c}::text::timestamptz) as comprobacion,
           reembolso_estado_al(p.id, ${c}::text::timestamptz) as reembolso,
           0 as fotos
    from pago_gasto p join gasto g on g.id = p.gasto_id
    join sucursal b on b.id = g.sucursal_id join sucursal pa on pa.id = g.sucursal_paga_id
    left join gasto o on o.id = g.compra_de
    join lateral (select * from gasto_version x where x.gasto_id = g.id and x.version = p.version) v on true
    join categoria_gasto cat on cat.clave = v.categoria
    left join decision_gasto d on d.gasto_id = g.id and d.version = p.version and d.decision = 'autorizado' and d.en <= ${c}::text::timestamptz
    left join usuario du on du.id = d.por
    left join anticipo_gasto a on a.gasto_id = g.id
    left join anticipo_comprobado k on k.pago_id = p.id
    where g.sucursal_id = any(${ids}::uuid[]) and p.en <= ${c}::text::timestamptz and p.pagado_el between ${desde}::date and ${hasta}::date
    order by p.pagado_el, g.clave`;
  const filas: FilaGasto[] = filasBd.map(({ anticipoEntregado, anticipoComprobado, ...f }) => {
    const base = { ...f, anticipo: anticipoEntregado && anticipoComprobado ? { entregadoEn: anticipoEntregado, comprobadoEn: anticipoComprobado } : null };
    return { ...base, grupo: grupoDe(base), pendientes: pendientesDe(base) };
  });
  const total = { n: filas.length, importe: pesos(filas.reduce((n, f) => n + cent(f.importe), 0)) };
  const vistas: Record<Vista, Renglon[]> = {
    estado: agrupar(filas, (f) => NOMBRE_GRUPO[f.grupo], Object.values(NOMBRE_GRUPO)),
    sucursal: agrupar(filas, (f) => f.beneficiada),
    lugar: agrupar(filas, (f) => (f.lugar ? NOMBRE_LUGAR[f.lugar] : "No fue efectivo"), [...Object.values(NOMBRE_LUGAR), "No fue efectivo"]),
    autorizo: agrupar(filas, (f) => f.autorizo ?? "Sin autorización"),
    origen: agrupar(filas, (f) => NOMBRE_ORIGEN[f.origen], Object.values(NOMBRE_ORIGEN)),
    categoria: agrupar(filas, (f) => f.categoria),
  };

  // Aparte (al corte; no se suman al total gastado).
  const [ap] = await tx<{ por_n: number; por_i: string; aut_n: number; aut_i: string; ant_n: number; ant_i: string; cam_n: number; cam_i: string; rec_n: number; rec_i: string }[]>`
    with g as (
      select g.id, v.version, v.importe,
             (select d.decision from decision_gasto d where d.gasto_id = g.id and d.version = v.version and d.en <= ${c}::text::timestamptz) as decision,
             (select d.en from decision_gasto d where d.gasto_id = g.id and d.version = v.version and d.en <= ${c}::text::timestamptz) as decidido_en,
             exists (select 1 from pago_gasto p where p.gasto_id = g.id and p.en <= ${c}::text::timestamptz) as pagado,
             exists (select 1 from anticipo_gasto a where a.gasto_id = g.id and a.en <= ${c}::text::timestamptz) as con_anticipo,
             exists (select 1 from gasto_ya_pagado y where y.gasto_id = g.id and y.en <= ${c}::text::timestamptz) as ya_pagado
      from gasto g
      join lateral (select * from gasto_version x where x.gasto_id = g.id and x.en <= ${c}::text::timestamptz order by x.version desc limit 1) v on true
      where g.sucursal_id = any(${ids}::uuid[]) and g.solicitado_en <= ${c}::text::timestamptz),
    a as (
      select a.importe, k.anticipo_id is not null as comprobado, coalesce(k.cambio, 0) as cambio,
             (select coalesce(sum(x.importe), 0) from anticipo_cambio x where x.anticipo_id = a.id and x.en <= ${c}::text::timestamptz) as devuelto
      from anticipo_gasto a join gasto gg on gg.id = a.gasto_id
      left join anticipo_comprobado k on k.anticipo_id = a.id and k.en <= ${c}::text::timestamptz
      where gg.sucursal_id = any(${ids}::uuid[]) and a.en <= ${c}::text::timestamptz)
    select (count(*) filter (where decision is null and not pagado and not ya_pagado))::int as por_n,
           coalesce(sum(importe) filter (where decision is null and not pagado and not ya_pagado), 0)::numeric(12, 2)::text as por_i,
           (count(*) filter (where decision = 'autorizado' and not pagado and not con_anticipo))::int as aut_n,
           coalesce(sum(importe) filter (where decision = 'autorizado' and not pagado and not con_anticipo), 0)::numeric(12, 2)::text as aut_i,
           (select count(*) filter (where not comprobado) from a)::int as ant_n,
           (select coalesce(sum(importe) filter (where not comprobado), 0) from a)::numeric(12, 2)::text as ant_i,
           (select count(*) filter (where comprobado and cambio > devuelto) from a)::int as cam_n,
           (select coalesce(sum(cambio - devuelto) filter (where comprobado and cambio > devuelto), 0) from a)::numeric(12, 2)::text as cam_i,
           (count(*) filter (where decision = 'rechazado' and decidido_en >= ${inicio}))::int as rec_n,
           coalesce(sum(importe) filter (where decision = 'rechazado' and decidido_en >= ${inicio}), 0)::numeric(12, 2)::text as rec_i
    from g`;
  const aparte = {
    porAutorizar: { n: ap.por_n, importe: ap.por_i }, autorizadosSinPagar: { n: ap.aut_n, importe: ap.aut_i },
    anticiposPorComprobar: { n: ap.ant_n, importe: ap.ant_i }, cambioPorDevolver: { n: ap.cam_n, importe: ap.cam_i },
    rechazados: { n: ap.rec_n, importe: ap.rec_i },
  };

  // Anticipos: entregados en el periodo, comprobados en el periodo o abiertos al corte. Entrega y comprobación aparte.
  const anticiposBd = await tx<(Omit<FilaAnticipo, "comprobado" | "excedente" | "estado" | "porDevolver"> & {
    k_en: Date | null; gastado: string | null; pagado_el: string | null; con_anticipo: string | null;
    exc_clave: string | null; exc_importe: string | null; exc_decision: string | null; exc_pago: string | null; exc_pago_id: string | null;
  })[]>`
    select g.clave, b.codigo, v.concepto, b.nombre as beneficiada, a.lugar, a.importe::text as entregado, a.en as "entregadoEn", ue.nombre as entrego, ur.nombre as recibe,
           (select r.en from anticipo_recibido r where r.anticipo_id = a.id and r.en <= ${c}::text::timestamptz) as "confirmadoEn",
           k.en as k_en, k.gastado::text as gastado, to_char(p.pagado_el, 'YYYY-MM-DD') as pagado_el, p.importe::text as con_anticipo,
           coalesce(k.cambio, 0)::text as cambio,
           (select coalesce(sum(x.importe), 0) from anticipo_cambio x where x.anticipo_id = a.id and x.en <= ${c}::text::timestamptz)::numeric(12, 2)::text as devuelto,
           x.clave as exc_clave, k.excedente::text as exc_importe,
           (select d.decision from decision_gasto d where d.gasto_id = x.id and d.en <= ${c}::text::timestamptz order by d.version desc limit 1) as exc_decision,
           (select px.importe::text from pago_gasto px where px.gasto_id = x.id and px.en <= ${c}::text::timestamptz) as exc_pago,
           (select px.id from pago_gasto px where px.gasto_id = x.id and px.en <= ${c}::text::timestamptz) as exc_pago_id
    from anticipo_gasto a join gasto g on g.id = a.gasto_id join sucursal b on b.id = g.sucursal_id
    join gasto_version v on v.gasto_id = g.id and v.version = a.version
    join usuario ue on ue.id = a.entregado_por join usuario ur on ur.id = a.recibe
    left join anticipo_comprobado k on k.anticipo_id = a.id and k.en <= ${c}::text::timestamptz
    left join pago_gasto p on p.id = k.pago_id
    left join gasto x on x.id = k.excedente_gasto_id
    where g.sucursal_id = any(${ids}::uuid[]) and a.en <= ${c}::text::timestamptz
      and (a.en >= ${inicio} or k.en >= ${inicio} or k.anticipo_id is null
           or k.cambio > (select coalesce(sum(x.importe), 0) from anticipo_cambio x where x.anticipo_id = a.id and x.en <= ${c}::text::timestamptz))
    order by a.en`;
  const anticipos: FilaAnticipo[] = [];
  for (const r of anticiposBd) {
    const porDevolver = pesos(Math.max(cent(r.cambio) - cent(r.devuelto), 0));
    let excReembolso: EstadoReembolso | null = null;
    if (r.exc_pago_id) [{ e: excReembolso }] = await tx<{ e: EstadoReembolso | null }[]>`select reembolso_estado_al(${r.exc_pago_id}, ${c}::text::timestamptz) as e`;
    const estado = !r.confirmadoEn ? "Fuera de caja: entregado, falta que lo confirme quien lo recibe"
      : !r.k_en ? "Fuera de caja: anticipo por comprobar"
      : cent(porDevolver) > 0 ? `Fuera de caja: cambio por devolver ${porDevolver}`
      : "Comprobado";
    anticipos.push({
      clave: r.clave, codigo: r.codigo, concepto: r.concepto, beneficiada: r.beneficiada, lugar: r.lugar, entregado: r.entregado, entregadoEn: r.entregadoEn, entrego: r.entrego, recibe: r.recibe,
      confirmadoEn: r.confirmadoEn,
      comprobado: r.k_en ? { en: r.k_en, gastado: r.gastado!, pagadoEl: r.pagado_el!, pagadoConAnticipo: r.con_anticipo! } : null,
      cambio: r.cambio, devuelto: r.devuelto, porDevolver,
      excedente: r.exc_clave ? {
        clave: r.exc_clave, importe: r.exc_importe!,
        estado: r.exc_decision === "autorizado" ? "Autorizado" : r.exc_decision === "rechazado" ? "Rechazado" : "Por autorizar",
        cubiertoPersonal: r.exc_pago, reembolso: excReembolso,
      } : null,
      estado,
    });
  }

  // Reembolsos: del dinero personal pagado en el periodo, o con algún paso en el periodo, o pendientes al corte.
  const reembolsosBd = await tx<(Omit<FilaReembolso, "decision" | "pago" | "estado"> & {
    d_decision: "autorizado" | "rechazado" | null; d_por: string | null; d_en: Date | null; d_ronda: number | null;
    r_origen: string | null; r_por: string | null; r_en: Date | null; estado: EstadoReembolso;
  })[]>`
    select g.clave, b.codigo, v.concepto, b.nombre as beneficiada, u.nombre as puso, p.importe::text as importe, to_char(p.pagado_el, 'YYYY-MM-DD') as "pagadoEl", p.en as "registradoEn",
           dr.decision as d_decision, du.nombre as d_por, dr.en as d_en, dr.ronda as d_ronda,
           rg.origen as r_origen, ru.nombre as r_por, rg.en as r_en,
           (select rr.en from reembolso_recibido rr where rr.reembolso_id = rg.id and rr.en <= ${c}::text::timestamptz) as "recibidoEn",
           reembolso_estado_al(p.id, ${c}::text::timestamptz) as estado
    from pago_gasto p join gasto g on g.id = p.gasto_id join sucursal b on b.id = g.sucursal_id
    join gasto_version v on v.gasto_id = g.id and v.version = p.version
    join usuario u on u.id = p.pagado_por
    left join lateral (select * from decision_reembolso x where x.pago_id = p.id and x.en <= ${c}::text::timestamptz order by x.ronda desc limit 1) dr on true
    left join usuario du on du.id = dr.por
    left join reembolso_gasto rg on rg.pago_id = p.id and rg.en <= ${c}::text::timestamptz
    left join usuario ru on ru.id = rg.pagado_por
    where g.sucursal_id = any(${ids}::uuid[]) and p.origen = 'dinero_personal' and p.en <= ${c}::text::timestamptz
      and (p.pagado_el between ${desde}::date and ${hasta}::date
           or reembolso_estado_al(p.id, ${c}::text::timestamptz) <> 'recibido'
           or dr.en >= ${inicio} or rg.en >= ${inicio})
    order by p.pagado_el, g.clave`;
  const reembolsos: FilaReembolso[] = reembolsosBd.map((r) => ({
    clave: r.clave, codigo: r.codigo, concepto: r.concepto, beneficiada: r.beneficiada, puso: r.puso, importe: r.importe, pagadoEl: r.pagadoEl, registradoEn: r.registradoEn,
    decision: r.d_decision ? { decision: r.d_decision, por: r.d_por!, en: r.d_en!, ronda: r.d_ronda! } : null,
    pago: r.r_origen ? { origen: r.r_origen, por: r.r_por!, en: r.r_en! } : null,
    recibidoEn: r.recibidoEn, estado: r.estado,
  }));
  return { filas, total, vistas, aparte, anticipos, reembolsos };
}

/**
 * Reporte de gastos de una sucursal beneficiada (`codigo`) o de todas las que consulta (null). null si no consulta
 * gastos en ninguna o pide una que no puede (misma respuesta que si no existiera).
 */
export async function reporteGastos(
  sql: Sql, usuarioId: string, filtros: { codigo: string | null; desde?: string; hasta?: string; corte?: string },
): Promise<ReporteGastos | null> {
  const { codigo } = filtros;
  if (codigo !== null && !/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const sucursales = await sucursalesGastos(tx, usuarioId);
    if (!sucursales.length) return null;
    if (codigo !== null && !sucursales.some((s) => s.codigo === codigo)) return null;
    const v = await ventana(tx, filtros);
    const ids = sucursales.filter((s) => codigo === null || s.codigo === codigo).map((s) => s.id);
    const datos = await calcular(tx, ids, v.inicio, v.corte, v.p.desde, v.p.hasta);
    return {
      sucursales: sucursales.map(({ codigo, nombre }) => ({ codigo, nombre })), codigo, desde: v.p.desde, hasta: v.p.hasta, periodoInvalido: v.p.invalido,
      corte: v.corte, inicio: v.inicio, generadoEn: v.ahora, ...datos,
    };
  });
}

/** Historial de cada gasto del reporte hasta el corte (una fila por evento). Solo en la descarga con detalle. */
async function historial(tx: Tx, claves: string[], corte: Date): Promise<EventoGasto[]> {
  if (!claves.length) return [];
  const c = hastaElCorte(corte);
  return [...(await tx<(EventoGasto & { o: number })[]>`
    with g as (select id, clave from gasto where clave = any(${claves}::text[]))
    select * from (
      select g.clave, v.en, case when v.version = 1 then case when exists (select 1 from gasto_ya_pagado y where y.gasto_id = g.id) then 'Registro de gasto ya pagado' else 'Solicitud' end
                                 else 'Corrección · versión ' || v.version || coalesce(' · «' || v.motivo || '»', '') end || ' · ' || v.concepto as evento,
             u.nombre as persona, v.importe::text as importe, 0 as o
      from g join gasto_version v on v.gasto_id = g.id join usuario u on u.id = v.registrada_por
      union all
      select g.clave, d.en, case when d.decision = 'autorizado' then 'Autorizado' else 'Rechazado' end || ' · versión ' || d.version || coalesce(' · «' || d.motivo || '»', ''),
             u.nombre, d.importe::text, 1 as o
      from g join decision_gasto d on d.gasto_id = g.id join usuario u on u.id = d.por
      union all
      select g.clave, y.en, 'Motivo de no pedir autorización antes · «' || y.motivo || '»', u.nombre, null, 2 as o
      from g join gasto_ya_pagado y on y.gasto_id = g.id join usuario u on u.id = y.registrado_por
      union all
      select g.clave, a.en, 'Anticipo entregado · ' || case a.lugar when 'bolsa_visitas' then 'Bolsa de visitas' else 'Cajón de mensualidades' end || ' · a ' || ur.nombre, ue.nombre, a.importe::text, 3 as o
      from g join anticipo_gasto a on a.gasto_id = g.id join usuario ue on ue.id = a.entregado_por join usuario ur on ur.id = a.recibe
      union all
      select g.clave, r.en, 'Confirmó que recibió el anticipo', ur.nombre, null, 4 as o
      from g join anticipo_gasto a on a.gasto_id = g.id join anticipo_recibido r on r.anticipo_id = a.id join usuario ur on ur.id = a.recibe
      union all
      select g.clave, k.en, 'Anticipo comprobado · se pagó ' || k.gastado::text || ' al proveedor · cambio ' || k.cambio::text || ' · excedente ' || k.excedente::text, ur.nombre, k.gastado::text, 5 as o
      from g join anticipo_gasto a on a.gasto_id = g.id join anticipo_comprobado k on k.anticipo_id = a.id join usuario ur on ur.id = a.recibe
      union all
      select g.clave, x.en, 'Cambio del anticipo recibido en caja', u.nombre, x.importe::text, 6 as o
      from g join anticipo_gasto a on a.gasto_id = g.id join anticipo_cambio x on x.anticipo_id = a.id join usuario u on u.id = x.recibido_por
      union all
      select g.clave, p.en, 'Pago registrado · ' || case p.origen when 'bolsa_visitas' then 'Bolsa de visitas' when 'cajon_mensualidades' then 'Cajón de mensualidades'
                                                         when 'transferencia' then 'Transferencia' when 'tarjeta' then 'Tarjeta' when 'dinero_personal' then 'Dinero personal'
                                                         else 'Anticipo comprobado' end || ' · fecha del pago ' || to_char(p.pagado_el, 'YYYY-MM-DD')
                           || coalesce(' ' || to_char(p.hora_declarada, 'HH24:MI') || ' (hora declarada)', '')
                           || case when p.turno_cerrado_id is not null then ' · de un turno cerrado' else '' end
                           || ' · pagó ' || up.nombre, ur.nombre, p.importe::text, 7 as o
      from g join pago_gasto p on p.gasto_id = g.id join usuario up on up.id = p.pagado_por join usuario ur on ur.id = p.registrado_por
      union all
      select g.clave, cg.en, 'Comprobante · ' || cg.tipo || coalesce(' · folio ' || cg.folio, ''), u.nombre, null, 8 as o
      from g join comprobante_gasto cg on cg.gasto_id = g.id join usuario u on u.id = cg.registrado_por
      union all
      select g.clave, s.en, 'Sin comprobante · «' || s.motivo || '»', u.nombre, null, 9 as o
      from g join sin_comprobante_gasto s on s.gasto_id = g.id join usuario u on u.id = s.registrado_por
      union all
      select g.clave, d.en, 'Reembolso ' || case when d.decision = 'autorizado' then 'autorizado' else 'rechazado' end || ' · ronda ' || d.ronda || coalesce(' · «' || d.motivo || '»', ''), u.nombre, null, 10 as o
      from g join pago_gasto p on p.gasto_id = g.id join decision_reembolso d on d.pago_id = p.id join usuario u on u.id = d.por
      union all
      select g.clave, r.en, 'Reembolso presentado de nuevo · «' || r.nota || '»', u.nombre, null, 11 as o
      from g join pago_gasto p on p.gasto_id = g.id join reenvio_reembolso r on r.pago_id = p.id join usuario u on u.id = r.por
      union all
      select g.clave, r.en, 'Reembolso pagado · ' || case r.origen when 'bolsa_visitas' then 'Bolsa de visitas' when 'cajon_mensualidades' then 'Cajón de mensualidades'
                                                          else 'Transferencia' end, u.nombre, r.importe::text, 12 as o
      from g join pago_gasto p on p.gasto_id = g.id join reembolso_gasto r on r.pago_id = p.id join usuario u on u.id = r.pagado_por
      union all
      select g.clave, rr.en, 'Reembolso recibido', u.nombre, null, 13 as o
      from g join pago_gasto p on p.gasto_id = g.id join reembolso_gasto r on r.pago_id = p.id join reembolso_recibido rr on rr.reembolso_id = r.id
      join usuario u on u.id = rr.por
    ) e where e.en <= ${c}::text::timestamptz order by e.clave, e.en, e.o`)].map((x) => ({ clave: x.clave, en: x.en, evento: x.evento, persona: x.persona, importe: x.importe }));
}

export type ArchivoGastos = {
  reporte: ReporteGastos; historial: EventoGasto[] | null; formato: "xlsx" | "pdf"; contenido: "resumen" | "detalle"; por: string; en: Date;
};
export type ErrorDescargaGastos = "no_encontrada" | "formato" | "bloqueado_produccion";

/** Prepara la descarga con el mismo periodo y corte que la pantalla; queda registrada. */
export async function prepararDescargaGastos(
  sql: Sql, usuarioId: string,
  pedido: { codigo: string | null; desde?: string; hasta?: string; corte?: string; formato: string; contenido: string },
  { entorno }: { entorno: string },
): Promise<{ ok: true; archivo: ArchivoGastos } | { ok: false; error: ErrorDescargaGastos }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if ((pedido.formato !== "xlsx" && pedido.formato !== "pdf") || (pedido.contenido !== "resumen" && pedido.contenido !== "detalle")) return { ok: false, error: "formato" };
  const { codigo } = pedido;
  if (codigo !== null && !/^[A-Z0-9]{2,5}$/.test(codigo)) return { ok: false, error: "no_encontrada" };
  return sql.begin(async (tx) => {
    const sucursales = await sucursalesGastos(tx, usuarioId);
    const elegidas = sucursales.filter((s) => codigo === null || s.codigo === codigo);
    if (!elegidas.length) return { ok: false as const, error: "no_encontrada" as const };
    const v = await ventana(tx, pedido);
    const datos = await calcular(tx, elegidas.map((s) => s.id), v.inicio, v.corte, v.p.desde, v.p.hasta);
    const reporte: ReporteGastos = {
      sucursales: sucursales.map(({ codigo, nombre }) => ({ codigo, nombre })), codigo, desde: v.p.desde, hasta: v.p.hasta, periodoInvalido: v.p.invalido,
      corte: v.corte, inicio: v.inicio, generadoEn: v.ahora, ...datos,
    };
    const claves = [...new Set([...datos.filas.map((f) => f.clave), ...datos.anticipos.map((a) => a.clave), ...datos.reembolsos.map((r) => r.clave)])];
    const eventos = pedido.contenido === "detalle" ? await historial(tx, claves, v.corte) : null;
    const [{ en, por }] = await tx<{ en: Date; por: string }[]>`
      insert into descarga_reporte_gastos (usuario_id, sucursales, desde, hasta, corte, formato, contenido)
      values (${usuarioId}, ${elegidas.map((s) => s.id)}::uuid[], ${v.p.desde}, ${v.p.hasta}, ${v.corte}, ${pedido.formato}, ${pedido.contenido})
      returning en, (select nombre from usuario where id = ${usuarioId}) as por`;
    return { ok: true as const, archivo: { reporte, historial: eventos, formato: pedido.formato as "xlsx" | "pdf", contenido: pedido.contenido as "resumen" | "detalle", por, en } };
  });
}

/** Cuántas sucursales consulta (para el enlace del inicio). */
export async function puedeReporteGastos(sql: Sql, usuarioId: string): Promise<boolean> {
  return (await sucursalesGastos(sql, usuarioId)).length > 0;
}

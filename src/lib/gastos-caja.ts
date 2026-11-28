import type postgres from "postgres";
import type { LugarAnticipo } from "@/lib/datos-gasto";

/**
 * Gastos en el reporte de caja de una sucursal (bloque 6, PR 9; acordado el 28 nov 2026; solo datos ficticios). Caja
 * sigue a la sucursal que paga.
 * - Movimientos del periodo (hasta el corte): gastos pagados, anticipos entregados, cambio de anticipos recibido y
 *   reembolsos pagados de la bolsa o el cajón. Ya están dentro del efectivo de cada lugar: aquí solo se desglosan.
 * - Pagos de turnos cerrados: aparte. No cambian el esperado de ningún turno ni se vuelven a descontar.
 * - Fuera de caja al corte: anticipos por comprobar y cambio por devolver, a cargo de quien recibió el anticipo. No se
 *   suman al efectivo en la sucursal.
 * - Pendientes al corte, con enlace a cada gasto. Un gasto con varios pendientes se suma una sola vez en el total.
 */
type Tx = postgres.TransactionSql;
type Grupo = { n: number; importe: string };

export type GastoEnlace = { clave: string; codigo: string; concepto: string; importe: string; nota: string };
export type ClavePendienteGasto = "anticipos" | "comprobante" | "sin_autorizacion" | "reembolsos";
export const TEXTO_PENDIENTE_GASTO: Record<ClavePendienteGasto, string> = {
  anticipos: "Anticipos por comprobar",
  comprobante: "Gastos por comprobar o sin comprobante",
  sin_autorizacion: "Pagados sin autorización previa (o no comprobada, o con autorización pendiente)",
  reembolsos: "Reembolsos pendientes",
};
export type GastosCaja = {
  movimientos: { gastos: Grupo; anticipos: Grupo; cambios: Grupo; reembolsos: Grupo };
  turnosCerrados: Grupo & { lista: (GastoEnlace & { lugar: LugarAnticipo; registradoEn: Date })[] };
  fueraDeCaja: { anticipos: Grupo; cambio: Grupo; lista: GastoEnlace[] };
  pendientes: { clave: ClavePendienteGasto; n: number; importe: string; lista: GastoEnlace[] }[];
  /** Gastos distintos con algún pendiente, cada uno una sola vez. */
  totalPendientes: Grupo;
};

const pesos = (c: number) => (c / 100).toFixed(2);
const cent = (v: string) => Math.round(Number(v) * 100);

export async function gastosCaja(tx: Tx, sucursalId: string, inicio: Date, corteBd: string): Promise<GastosCaja> {
  const [m] = await tx<{ g: string; ng: number; a: string; na: number; c: string; nc: number; r: string; nr: number }[]>`
    select coalesce(sum(me.importe) filter (where me.tipo = 'salida_pago_gasto'), 0)::numeric(12, 2)::text as g,
           (count(*) filter (where me.tipo = 'salida_pago_gasto'))::int as ng,
           coalesce(sum(me.importe) filter (where me.tipo = 'salida_anticipo_gasto'), 0)::numeric(12, 2)::text as a,
           (count(*) filter (where me.tipo = 'salida_anticipo_gasto'))::int as na,
           coalesce(sum(me.importe) filter (where me.tipo = 'entrada_cambio_anticipo'), 0)::numeric(12, 2)::text as c,
           (count(*) filter (where me.tipo = 'entrada_cambio_anticipo'))::int as nc,
           coalesce(sum(me.importe) filter (where me.tipo = 'salida_reembolso_gasto'), 0)::numeric(12, 2)::text as r,
           (count(*) filter (where me.tipo = 'salida_reembolso_gasto'))::int as nr
    from movimiento_efectivo me join lugar_efectivo l on l.id = me.lugar_id
    where l.sucursal_id = ${sucursalId} and me.en >= ${inicio} and me.en <= ${corteBd}::text::timestamptz`;
  const cerrados = await tx<(GastoEnlace & { lugar: LugarAnticipo; registradoEn: Date })[]>`
    select g.clave, b.codigo, v.concepto, p.importe::text as importe, p.origen as lugar, p.en as "registradoEn",
           'Del turno del ' || to_char(t.abierto_en at time zone s.zona_horaria, 'DD/MM/YYYY HH24:MI') || ' (cerrado): no cambia su esperado ni el del turno actual' as nota
    from pago_gasto p join gasto g on g.id = p.gasto_id join sucursal b on b.id = g.sucursal_id join sucursal s on s.id = g.sucursal_paga_id
    join turno t on t.id = p.turno_cerrado_id join gasto_version v on v.gasto_id = g.id and v.version = p.version
    where g.sucursal_paga_id = ${sucursalId} and p.turno_cerrado_id is not null and p.en >= ${inicio} and p.en <= ${corteBd}::text::timestamptz
    order by p.en`;
  const fuera = await tx<(GastoEnlace & { tipo: "anticipo" | "cambio" })[]>`
    select * from (
      select 'anticipo' as tipo, g.clave, b.codigo, v.concepto, a.importe::text as importe,
             'A cargo de ' || u.nombre || ' desde el ' || to_char(a.en at time zone s.zona_horaria, 'DD/MM/YYYY') as nota
      from anticipo_gasto a join gasto g on g.id = a.gasto_id join sucursal b on b.id = g.sucursal_id join sucursal s on s.id = g.sucursal_paga_id
      join gasto_version v on v.gasto_id = g.id and v.version = a.version join usuario u on u.id = a.recibe
      where g.sucursal_paga_id = ${sucursalId} and a.en <= ${corteBd}::text::timestamptz
        and not exists (select 1 from anticipo_comprobado k where k.anticipo_id = a.id and k.en <= ${corteBd}::text::timestamptz)
      union all
      select 'cambio', g.clave, b.codigo, v.concepto,
             (k.cambio - (select coalesce(sum(x.importe), 0) from anticipo_cambio x where x.anticipo_id = a.id and x.en <= ${corteBd}::text::timestamptz))::numeric(12, 2)::text,
             'Cambio por devolver, a cargo de ' || u.nombre
      from anticipo_gasto a join anticipo_comprobado k on k.anticipo_id = a.id and k.en <= ${corteBd}::text::timestamptz
      join gasto g on g.id = a.gasto_id join sucursal b on b.id = g.sucursal_id
      join gasto_version v on v.gasto_id = g.id and v.version = a.version join usuario u on u.id = a.recibe
      where g.sucursal_paga_id = ${sucursalId}
        and k.cambio > (select coalesce(sum(x.importe), 0) from anticipo_cambio x where x.anticipo_id = a.id and x.en <= ${corteBd}::text::timestamptz)
    ) f order by clave`;
  const ant = fuera.filter((f) => f.tipo === "anticipo");
  const cam = fuera.filter((f) => f.tipo === "cambio");
  const suma = (l: { importe: string }[]) => ({ n: l.length, importe: pesos(l.reduce((n, x) => n + cent(x.importe), 0)) });

  // Estado al corte de cada gasto que paga esta sucursal (solo los que tienen algo al corte).
  const estados = await tx<{ clave: string; codigo: string; concepto: string; importe: string; previa: string | null; comprobacion: string | null; reembolso: string | null; anticipo: boolean }[]>`
    select g.clave, b.codigo, v.concepto,
           coalesce((select p.importe from pago_gasto p where p.gasto_id = g.id and p.en <= ${corteBd}::text::timestamptz), v.importe)::text as importe,
           autorizacion_previa_al(g.id, ${corteBd}::text::timestamptz) as previa,
           comprobacion_al(g.id, ${corteBd}::text::timestamptz) as comprobacion,
           (select reembolso_estado_al(p.id, ${corteBd}::text::timestamptz) from pago_gasto p where p.gasto_id = g.id) as reembolso,
           exists (select 1 from anticipo_gasto a where a.gasto_id = g.id and a.en <= ${corteBd}::text::timestamptz
                   and not exists (select 1 from anticipo_comprobado k where k.anticipo_id = a.id and k.en <= ${corteBd}::text::timestamptz)) as anticipo
    from gasto g join sucursal b on b.id = g.sucursal_id
    join lateral (select * from gasto_version x where x.gasto_id = g.id and x.en <= ${corteBd}::text::timestamptz order by x.version desc limit 1) v on true
    where g.sucursal_paga_id = ${sucursalId} and g.solicitado_en <= ${corteBd}::text::timestamptz
    order by g.clave`;
  const NOTA_PREVIA: Record<string, string> = {
    sin_autorizacion_previa: "Pagado sin autorización previa", no_comprobada: "Autorización previa no comprobada", pendiente: "Pagado · autorización pendiente",
  };
  const NOTA_REEMBOLSO: Record<string, string> = {
    por_decidir: "Por decidir", presentado_de_nuevo: "Presentado de nuevo · por decidir", rechazado: "Rechazado · puede presentarse de nuevo",
    por_pagar: "Autorizado · por pagar", pagado: "Pagado · falta que lo confirme quien lo recibe",
  };
  const lista = (f: (e: (typeof estados)[number]) => string | null) =>
    estados.flatMap((e) => { const nota = f(e); return nota === null ? [] : [{ clave: e.clave, codigo: e.codigo, concepto: e.concepto, importe: e.importe, nota }]; });
  const porClave: Record<ClavePendienteGasto, GastoEnlace[]> = {
    anticipos: lista((e) => (e.anticipo ? "Fuera de caja" : null)),
    comprobante: lista((e) => (e.comprobacion === "por_comprobar" ? "Por comprobar" : e.comprobacion === "sin_comprobante" ? "Sin comprobante · por revisar · Dirección" : null)),
    sin_autorizacion: lista((e) => (e.previa && e.previa !== "comprobada" ? NOTA_PREVIA[e.previa] : null)),
    reembolsos: lista((e) => (e.reembolso && e.reembolso !== "recibido" ? NOTA_REEMBOLSO[e.reembolso] : null)),
  };
  const pendientes = (Object.keys(porClave) as ClavePendienteGasto[]).map((clave) => ({ clave, ...suma(porClave[clave]), lista: porClave[clave] }));
  const distintos = new Map<string, string>();
  for (const p of pendientes) for (const x of p.lista) distintos.set(x.clave, x.importe);
  return {
    movimientos: {
      gastos: { n: m.ng, importe: m.g }, anticipos: { n: m.na, importe: m.a }, cambios: { n: m.nc, importe: m.c }, reembolsos: { n: m.nr, importe: m.r },
    },
    turnosCerrados: { ...suma(cerrados), lista: [...cerrados] },
    fueraDeCaja: { anticipos: suma(ant), cambio: suma(cam), lista: fuera.map((x) => ({ clave: x.clave, codigo: x.codigo, concepto: x.concepto, importe: x.importe, nota: x.nota })) },
    pendientes,
    totalPendientes: { n: distintos.size, importe: pesos([...distintos.values()].reduce((n, v) => n + cent(v), 0)) },
  };
}

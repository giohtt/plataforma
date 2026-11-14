import type postgres from "postgres";
import { ventasDelTurno, type VentasTurno } from "@/lib/ventas";
import type { CobroDelTurno } from "@/lib/visitas";

/**
 * Reporte «Visitas y cobros» del bloque 4 (solo consulta, solo datos ficticios). Indicado el 9 nov 2026:
 *   - filtros: sucursal (o todas las autorizadas) y periodo (desde / hasta);
 *   - el periodo cuenta por la FECHA EN QUE SE REGISTRÓ cada cobro, en hora de la Ciudad de México;
 *   - el estado de cada cobro es el ACTUAL al consultar (una transferencia verificada después pasa a confirmados);
 *   - cobros confirmados por forma de pago (efectivo, tarjeta, transferencias verificadas), transferencias sin
 *     verificar (pendientes y no localizadas) y cancelados por duplicado, cada uno aparte; total registrado;
 *   - solo aparecen los turnos que se cruzan con el periodo (un turno abierto se cruza hasta el momento de la consulta);
 *   - el saldo de la bolsa es POR TURNO, del turno completo (aunque empiece o termine fuera del periodo): ahora si
 *     está abierto, al cerrar si está cerrado. Los saldos de varios turnos NO se suman (el efectivo entregado al
 *     siguiente turno se contaría dos veces).
 * Lo ven Encargado, Administración y Dirección con reporte.visitas en sus sucursales; Recepción no. El permiso se
 * comprueba en el servidor dentro de la transacción de solo lectura que arma el reporte.
 */
type Sql = postgres.Sql;

export type SaldoTurno = {
  turnoId: string;
  abiertoEn: Date;
  cerradoEn: Date | null;
  abiertoPor: string;
  contadoAlAbrir: string;
  entradas: string;
  cantidadEntradas: number;
  ajustes: string;
  cantidadAjustes: number;
  /** Salidas por retiros a Encargada de retiros (negativo). */
  retiros: string;
  cantidadRetiros: number;
  esperado: string;
};
export type SucursalReporte = {
  codigo: string;
  nombre: string;
  ventas: VentasTurno;
  registrados: { cobros: number; visitas: number };
  turnos: SaldoTurno[];
};
export type ReporteVisitas = {
  sucursales: { codigo: string; nombre: string }[];
  codigo: string | null;
  desde: string;
  hasta: string;
  periodoInvalido: boolean;
  filas: SucursalReporte[];
  generadoEn: Date;
};

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const esFecha = (f: string) => FECHA.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`)) && new Date(`${f}T00:00:00Z`).toISOString().startsWith(f);
const MAX_DIAS = 366;

/** Hoy en la Ciudad de México (AAAA-MM-DD) y n días antes. */
export function hoyMexico(ahora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(ahora);
}
const restarDias = (f: string, n: number) => new Date(Date.parse(`${f}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Periodo pedido; si falta o no es válido, los últimos 7 días (hoy incluido). */
export function periodo(desde: string | undefined, hasta: string | undefined, hoy = hoyMexico()) {
  const porOmision = { desde: restarDias(hoy, 6), hasta: hoy };
  if (desde === undefined && hasta === undefined) return { ...porOmision, invalido: false };
  if (!desde || !hasta || !esFecha(desde) || !esFecha(hasta) || desde > hasta
      || (Date.parse(hasta) - Date.parse(desde)) / 86_400_000 > MAX_DIAS) return { ...porOmision, invalido: true };
  return { desde, hasta, invalido: false };
}

/** null si no tiene el reporte en ninguna sucursal o pide una que no tiene (misma respuesta que si no existiera). */
export async function reporteVisitas(
  sql: Sql,
  usuarioId: string,
  filtros: { codigo: string | null; desde?: string; hasta?: string },
): Promise<ReporteVisitas | null> {
  const { codigo } = filtros;
  if (codigo !== null && !/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const sucursales = await tx<{ id: string; codigo: string; nombre: string }[]>`
      select id, codigo, nombre from sucursal where tiene_permiso(${usuarioId}, 'reporte.visitas', id) order by nombre`;
    if (!sucursales.length) return null;
    if (codigo !== null && !sucursales.some((s) => s.codigo === codigo)) return null;
    const elegidas = sucursales.filter((s) => codigo === null || s.codigo === codigo);
    const ids = elegidas.map((s) => s.id);
    const [{ ahora, hoy }] = await tx<{ ahora: Date; hoy: string }[]>`
      select now() as ahora, (now() at time zone 'America/Mexico_City')::date::text as hoy`;
    const p = periodo(filtros.desde, filtros.hasta, hoy);

    const cobros = await tx<(CobroDelTurno & { sucursal_id: string })[]>`
      select o.sucursal_id, o.id, o.registrada_en as "registradaEn", c.importe::text as total, c.forma_pago as "formaPago",
             c.estado, c.conciliacion, false as "cancelacionSolicitada",
             (select count(*)::int from pase_visita pv where pv.operacion_id = o.id) as personas
      from operacion_visita o
      join cobro_visita c on c.operacion_id = o.id
      where o.sucursal_id = any(${ids}::uuid[])
        and (o.registrada_en at time zone 'America/Mexico_City')::date between ${p.desde}::date and ${p.hasta}::date`;

    const turnos = await tx<(SaldoTurno & { sucursal_id: string })[]>`
      select t.sucursal_id, t.id as "turnoId", t.abierto_en as "abiertoEn", t.cerrado_en as "cerradoEn", u.nombre as "abiertoPor",
             ca.importe::text as "contadoAlAbrir",
             m.entradas::text as entradas, m.cuantas as "cantidadEntradas", m.ajustes::text as ajustes, m.cuantos_ajustes as "cantidadAjustes",
             m.salidas::text as retiros, m.cuantas_salidas as "cantidadRetiros",
             (ca.importe + m.entradas + m.ajustes + m.salidas)::text as esperado
      from turno t
      join usuario u on u.id = t.abierto_por
      join lugar_efectivo l on l.sucursal_id = t.sucursal_id and l.tipo = 'bolsa_visitas'
      join conteo_efectivo ca on ca.turno_id = t.id and ca.lugar_id = l.id and ca.momento = 'apertura'
      cross join lateral (
        select coalesce(sum(me.importe) filter (where me.tipo = 'entrada_cobro_visita'), 0)::numeric(12, 2) as entradas,
               (count(*) filter (where me.tipo = 'entrada_cobro_visita'))::int as cuantas,
               coalesce(sum(me.importe) filter (where me.tipo = 'ajuste_cancelacion_cobro'), 0)::numeric(12, 2) as ajustes,
               (count(*) filter (where me.tipo = 'ajuste_cancelacion_cobro'))::int as cuantos_ajustes,
               coalesce(sum(me.importe) filter (where me.tipo = 'salida_retiro'), 0)::numeric(12, 2) as salidas,
               (count(*) filter (where me.tipo = 'salida_retiro'))::int as cuantas_salidas
        from movimiento_efectivo me where me.turno_id = t.id and me.lugar_id = l.id
      ) m
      where t.sucursal_id = any(${ids}::uuid[])
        -- Se cruza con el periodo [inicio del día «desde», fin del día «hasta») en hora de México. Un turno abierto
        -- termina, para este cruce, en el momento de la consulta: un periodo futuro no lo muestra.
        and t.abierto_en < ((${p.hasta}::date + 1)::timestamp at time zone 'America/Mexico_City')
        and coalesce(t.cerrado_en, now()) >= (${p.desde}::date::timestamp at time zone 'America/Mexico_City')
      order by t.abierto_en`;

    const filas = elegidas.map((s) => {
      const propios = cobros.filter((c) => c.sucursal_id === s.id).map(({ sucursal_id, ...c }) => { void sucursal_id; return c; });
      return {
        codigo: s.codigo,
        nombre: s.nombre,
        ventas: ventasDelTurno(propios),
        registrados: { cobros: propios.length, visitas: propios.reduce((n, c) => n + c.personas, 0) },
        turnos: turnos.filter((t) => t.sucursal_id === s.id).map(({ sucursal_id, ...t }) => { void sucursal_id; return t; }),
      };
    });
    return {
      sucursales: sucursales.map(({ codigo, nombre }) => ({ codigo, nombre })),
      codigo,
      desde: p.desde,
      hasta: p.hasta,
      periodoInvalido: p.invalido,
      filas,
      generadoEn: ahora,
    };
  });
}

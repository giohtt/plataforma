import type postgres from "postgres";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Historial del visitante entre sucursales (bloque 4, solo datos ficticios). Indicado el 10 nov 2026:
 *   - Detalle (visitas con su pago, cobro y pase; aperturas manuales) solo en las sucursales con `visita.consultar`.
 *   - Quien tiene `visita.resumen_otras` (Recepción y Encargado) ve además, de las DEMÁS sucursales, solo el conteo
 *     y la fecha y sucursal de la última visita registrada. Nunca la primera visita, importes, formas de pago,
 *     cobros ni accesos de esas sucursales.
 *   - Administración y Dirección: vista y totales solo de sus sucursales asignadas.
 *   - «Primera visita registrada»: la persona pudo venir antes. Si falta cobertura de alguna sucursal del alcance
 *     (o no cubre desde el inicio de operaciones), el historial es «incompleto»; la cobertura la registra Dirección.
 * Una ficha unida cuenta como la misma persona. Los pases cancelados (duplicados) no cuentan como visita.
 * Todo el alcance se calcula en el servidor, dentro de una transacción de solo lectura.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type ResumenHistorial = {
  visitas: number;
  ultima: { en: Date; sucursal: string } | null;
  incompleto: boolean;
};

type Alcance = { detalle: Set<string>; alcance: { id: string; codigo: string; nombre: string }[]; conResumen: boolean };

async function alcanceDe(tx: Tx, usuarioId: string): Promise<Alcance> {
  const filas = await tx<{ id: string; codigo: string; nombre: string; detalle: boolean; resumen: boolean }[]>`
    select s.id, s.codigo, s.nombre,
           tiene_permiso(${usuarioId}, 'visita.consultar', s.id) as detalle,
           tiene_permiso(${usuarioId}, 'visita.resumen_otras', s.id) as resumen
    from sucursal s order by s.nombre`;
  const conResumen = filas.some((f) => f.resumen);
  const detalle = new Set(filas.filter((f) => f.detalle).map((f) => f.id));
  return {
    detalle,
    conResumen,
    alcance: filas.filter((f) => conResumen || f.detalle).map(({ id, codigo, nombre }) => ({ id, codigo, nombre })),
  };
}

export type Cobertura = { sucursal: string; desde: string | null; desdeInicio: boolean; nota: string | null; registradaPor: string | null };

async function coberturas(tx: Tx, ids: string[]): Promise<Cobertura[]> {
  return tx<Cobertura[]>`
    select s.nombre as sucursal, c.desde::text as desde, coalesce(c.desde_inicio, false) as "desdeInicio", c.nota,
           u.nombre as "registradaPor"
    from sucursal s
    left join lateral (
      select * from cobertura_historial c where c.sucursal_id = s.id order by c.registrada_en desc limit 1
    ) c on true
    left join usuario u on u.id = c.registrada_por
    where s.id = any(${ids}::uuid[])
    order by s.nombre`;
}
const incompleta = (c: Cobertura[]) => c.length === 0 || c.some((x) => !x.desde || !x.desdeInicio);

/** Resumen para la búsqueda: visitas registradas y última visita dentro del alcance de la cuenta. */
export async function resumenesHistorial(tx: Tx, usuarioId: string, visitanteIds: string[]): Promise<Map<string, ResumenHistorial>> {
  const r = new Map<string, ResumenHistorial>();
  if (!visitanteIds.length) return r;
  const a = await alcanceDe(tx, usuarioId);
  const ids = a.alcance.map((s) => s.id);
  if (!ids.length) return r;
  const incompleto = incompleta(await coberturas(tx, ids));
  const filas = await tx<{ id: string; visitas: number; en: Date | null; sucursal: string | null }[]>`
    select x.id, count(p.id)::int as visitas, u.en, u.sucursal
    from unnest(${visitanteIds}::uuid[]) as x(id)
    left join pase_visita p on p.visitante_id in (select visitante_grupo(x.id)) and p.cancelado_en is null
                            and p.sucursal_id = any(${ids}::uuid[])
    left join lateral (
      select p2.creado_en as en, s.nombre as sucursal
      from pase_visita p2 join sucursal s on s.id = p2.sucursal_id
      where p2.visitante_id in (select visitante_grupo(x.id)) and p2.cancelado_en is null and p2.sucursal_id = any(${ids}::uuid[])
      order by p2.creado_en desc limit 1
    ) u on true
    group by x.id, u.en, u.sucursal`;
  for (const f of filas) r.set(f.id, { visitas: f.visitas, ultima: f.en ? { en: f.en, sucursal: f.sucursal! } : null, incompleto });
  return r;
}

export type EstadoPago = "pagado_efectivo" | "pagado_tarjeta" | "pendiente_abono" | "abono_verificado" | "no_localizado" | "cancelado";
export type VisitaDetalle = {
  paseId: string;
  en: Date;
  operacionId: string;
  estadoPago: EstadoPago;
  formaPago: "efectivo" | "tarjeta" | "transferencia";
  totalCobro: string;
  personasCobro: number;
  totalPase: string;
  estadoPase: "vigente_hoy" | "vencido" | "cancelado";
};
export type AperturaDetalle = { en: Date; tipo: "entrada" | "reingreso"; registro: string; autorizo: string | null; motivoAutorizacion: string | null };
export type SucursalDetalle = {
  codigo: string;
  nombre: string;
  visitas: number;
  primera: Date | null;
  ultima: Date | null;
  detalle: VisitaDetalle[];
  aperturas: AperturaDetalle[];
};
export type SucursalResumen = { nombre: string; visitas: number; ultima: Date };
export type Historial = {
  resumen: ResumenHistorial;
  conDetalle: SucursalDetalle[];
  otras: SucursalResumen[];
  cobertura: Cobertura[];
};

/**
 * Historial del visitante desde una sucursal donde la cuenta puede consultar el expediente. null si no puede
 * (misma respuesta que si no existiera).
 */
export async function historialVisitante(sql: Sql, usuarioId: string, codigo: string, visitanteId: string): Promise<Historial | null> {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo) || !esIdentificadorValido(visitanteId)) return null;
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const [puede] = await tx<{ ok: boolean }[]>`
      select tiene_permiso(${usuarioId}, 'visitante.consultar', s.id) as ok from sucursal s where s.codigo = ${codigo}`;
    if (!puede?.ok) return null;
    const [existe] = await tx<{ id: string }[]>`select id from visitante where id = ${visitanteId}`;
    if (!existe) return null;
    const a = await alcanceDe(tx, usuarioId);
    const ids = a.alcance.map((s) => s.id);
    const detalleIds = [...a.detalle];
    const resumen = (await resumenesHistorial(tx, usuarioId, [visitanteId])).get(visitanteId) ?? { visitas: 0, ultima: null, incompleto: true };

    const visitas = detalleIds.length ? await tx<(VisitaDetalle & { sucursal_id: string; cancelado: boolean; estado: string })[]>`
      select p.sucursal_id, p.id as "paseId", p.creado_en as en, p.operacion_id as "operacionId", c.estado, c.forma_pago as "formaPago",
             c.importe::text as "totalCobro", (select count(*)::int from pase_visita q where q.operacion_id = p.operacion_id) as "personasCobro",
             p.total::text as "totalPase", (p.cancelado_en is not null) as cancelado,
             case when p.cancelado_en is not null or c.estado = 'cancelado' then 'cancelado'
                  when dia_en_sucursal(p.sucursal_id, p.creado_en) = dia_en_sucursal(p.sucursal_id, now()) then 'vigente_hoy'
                  else 'vencido' end as "estadoPase"
      from pase_visita p join cobro_visita c on c.operacion_id = p.operacion_id
      where p.visitante_id in (select visitante_grupo(${visitanteId})) and p.sucursal_id = any(${detalleIds}::uuid[])
      order by p.creado_en desc` : [];
    const aperturas = detalleIds.length ? await tx<(AperturaDetalle & { sucursal_id: string })[]>`
      select a.sucursal_id, a.registrado_en as en, a.tipo, u.nombre as registro, ua.nombre as autorizo, x.motivo_resolucion as "motivoAutorizacion"
      from acceso a join pase_visita p on p.id = a.pase_id
      join usuario u on u.id = a.registrado_por
      left join autorizacion_acceso x on x.id = a.autorizacion_id
      left join usuario ua on ua.id = x.resuelta_por
      where p.visitante_id in (select visitante_grupo(${visitanteId})) and a.sucursal_id = any(${detalleIds}::uuid[])
      order by a.registrado_en desc` : [];
    const otrasFilas = a.conResumen ? await tx<{ nombre: string; visitas: number; ultima: Date }[]>`
      select s.nombre, count(*)::int as visitas, max(p.creado_en) as ultima
      from pase_visita p join sucursal s on s.id = p.sucursal_id
      where p.visitante_id in (select visitante_grupo(${visitanteId})) and p.cancelado_en is null
        and p.sucursal_id = any(${ids}::uuid[]) and not (p.sucursal_id = any(${detalleIds}::uuid[]))
      group by s.nombre order by max(p.creado_en) desc` : [];

    const pago = (estado: string, forma: string): EstadoPago =>
      estado === "confirmado" ? "pagado_efectivo"
      : estado === "confirmado_operativamente" ? "pagado_tarjeta"
      : estado === "pendiente_abono" ? "pendiente_abono"
      : estado === "abono_verificado" ? "abono_verificado"
      : estado === "no_localizado" ? "no_localizado"
      : (void forma, "cancelado");
    const conDetalle: SucursalDetalle[] = a.alcance.filter((s) => a.detalle.has(s.id)).map((s) => {
      const propias = visitas.filter((v) => v.sucursal_id === s.id);
      const validas = propias.filter((v) => !v.cancelado);
      return {
        codigo: s.codigo,
        nombre: s.nombre,
        visitas: validas.length,
        primera: validas.length ? validas[validas.length - 1].en : null,
        ultima: validas.length ? validas[0].en : null,
        detalle: propias.map(({ sucursal_id, cancelado, estado, ...v }) => { void sucursal_id; void cancelado; return { ...v, estadoPago: pago(estado, v.formaPago) }; }),
        aperturas: aperturas.filter((x) => x.sucursal_id === s.id).map(({ sucursal_id, ...x }) => { void sucursal_id; return x; }),
      };
    }).filter((s) => s.detalle.length || s.aperturas.length);
    return { resumen, conDetalle, otras: otrasFilas, cobertura: await coberturas(tx, ids) };
  });
}

// ---------------------------------------------------------------------------
// Cobertura: la registra Dirección por sucursal.
// ---------------------------------------------------------------------------
export type ErrorCobertura = "no_encontrada" | "fecha" | "nota" | "bloqueado_produccion";

export async function pantallaCobertura(sql: Sql, usuarioId: string, codigo: string) {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  return sql.begin("read only", async (tx) => {
    const [s] = await tx<{ id: string; nombre: string }[]>`
      select id, nombre from sucursal where codigo = ${codigo} and tiene_permiso(${usuarioId}, 'historial.cobertura', id)`;
    if (!s) return null;
    const registros = await tx<{ desde: string; desdeInicio: boolean; nota: string | null; registradaPor: string; registradaEn: Date }[]>`
      select c.desde::text as desde, c.desde_inicio as "desdeInicio", c.nota, u.nombre as "registradaPor", c.registrada_en as "registradaEn"
      from cobertura_historial c join usuario u on u.id = c.registrada_por
      where c.sucursal_id = ${s.id} order by c.registrada_en desc`;
    return { sucursal: s.nombre, registros };
  });
}

export async function registrarCobertura(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { desde: string; desdeInicio: boolean; nota: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorCobertura }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return { ok: false, error: "no_encontrada" };
  const desde = datos.desde;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || Number.isNaN(Date.parse(`${desde}T00:00:00Z`))
      || new Date(`${desde}T00:00:00Z`).toISOString().slice(0, 10) !== desde) return { ok: false, error: "fecha" };
  const nota = datos.nota.trim().replace(/\s+/g, " ");
  if (nota && (nota.length < 5 || nota.length > 300)) return { ok: false, error: "nota" };
  return sql.begin(async (tx) => {
    const [s] = await tx<{ id: string; futura: boolean }[]>`
      select id, ${desde}::date > (now() at time zone zona_horaria)::date as futura
      from sucursal where codigo = ${codigo} and tiene_permiso(${usuarioId}, 'historial.cobertura', id)`;
    if (!s) return { ok: false, error: "no_encontrada" } as const;
    if (s.futura) return { ok: false, error: "fecha" } as const;
    await tx`
      insert into cobertura_historial (sucursal_id, desde, desde_inicio, nota, registrada_por)
      values (${s.id}, ${desde}, ${datos.desdeInicio}, ${nota || null}, ${usuarioId})`;
    return { ok: true } as const;
  });
}

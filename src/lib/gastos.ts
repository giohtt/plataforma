import type postgres from "postgres";
import { leerImporte } from "@/lib/datos-turno";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";
import { NOMBRE_ORIGEN, type Comprobacion, type EstadoGasto, type Impedimento, type OrigenPago } from "@/lib/datos-gasto";

export { NOMBRE_COMPROBACION, NOMBRE_ESTADO_GASTO, NOMBRE_ORIGEN, TEXTO_IMPEDIMENTO } from "@/lib/datos-gasto";
export type { Comprobacion, EstadoGasto, Impedimento, OrigenPago } from "@/lib/datos-gasto";

/**
 * Solicitudes de gasto (bloque 6, PR 3; acordado el 27 nov 2026; solo datos ficticios).
 *
 * - Solicitan, dentro de sus sucursales, quienes tienen gasto.solicitar en la sucursal beneficiada y en la que paga
 *   (Recepción, Encargado, Administración, Gestión administrativa y Dirección, por su perfil).
 * - Consultan todos los gastos de una sucursal quienes tienen gasto.consultar ahí (beneficiada o que paga); quien solo
 *   solicita (Recepción) ve lo que ella pidió.
 * - Clave fija por sucursal beneficiada (TEN-G1), sucursal beneficiada y que paga por separado, «parte de una compra
 *   ya solicitada», y correcciones como versiones nuevas con motivo. Nada se edita ni se borra.
 * - Solicitar no mueve dinero ni autoriza nada.
 *
 * Autorizar o rechazar (PR 4; la base lo respalda en impedimento_decision_gasto y decision_gasto):
 * - Decide quien tiene la facultad de gasto vigente en la sucursal beneficiada y en la que paga, dentro de su límite por
 *   gasto (comparado con el total de la compra) y de su acumulado diario. Lo que pasa de ahí lo decide quien sí tenga
 *   facultad suficiente; si nadie la tiene, queda por autorizar.
 * - Quien solicitó no decide lo suyo, salvo Dirección; lo que solicita Dirección solo lo decide Dirección.
 * - La primera persona que decide lo resuelve. Una decisión por versión: si se corrige, se decide de nuevo.
 * - Rechazar exige motivo. Avisar no es autorizar: quien consulta ve todo, aunque no le toque decidir.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type ErrorGasto =
  | "sin_permiso" | "no_encontrada" | "concepto" | "categoria" | "importe" | "proveedor" | "nota" | "sucursal_paga"
  | "compra" | "motivo" | "version" | "sin_cambio" | "repetida" | "bloqueado_produccion"
  | "decision" | "ya_decidido" | "propio" | "de_direccion" | "sin_facultad" | "limite" | "diario"
  | "no_autorizado" | "ya_pagado" | "origen" | "excede" | "fecha" | "cuenta" | "referencia" | "a_quien" | "autorizo"
  | "sin_turno" | "no_responsable" | "entrega_en_curso" | "comprobante" | "folio" | "no_excede";





export type CamposGasto = { concepto: string; categoria: string; importe: string; proveedor: string; nota: string };
export type Categoria = { clave: string; nombre: string; dePrueba: boolean };
export type SucursalOpcion = { id: string; codigo: string; nombre: string };

export type GastoResumen = {
  id: string; clave: string; concepto: string; categoria: string; importe: string; version: number;
  beneficiada: string; paga: string; pagaOtra: boolean; compraDe: string | null;
  solicitadoPor: string; solicitadoEn: Date; propia: boolean;
  estado: EstadoGasto; decididoPor: string | null; decididoEn: Date | null; motivoDecision: string | null;
  /** null: esta persona puede decidirlo ahora. */
  impedimento: Impedimento | null;
  /** Pago registrado (null si no se ha pagado) y su comprobación. */
  origenPago: OrigenPago | null; importePagado: string | null; comprobacion: Comprobacion | null;
};

const CODIGO = /^[A-Z0-9]{2,5}$/;
const CLAVE = /^[A-Z0-9]{2,5}-G\d{1,7}$/;
const texto = (v: string) => v.trim().replace(/\s+/g, " ");

/** Valida los campos de una versión; devuelve el error o los valores limpios. */
async function validar(db: Sql | Tx, c: CamposGasto): Promise<{ ok: false; error: ErrorGasto } | { ok: true; v: { concepto: string; categoria: string; importe: string; proveedor: string | null; nota: string | null } }> {
  const concepto = texto(c.concepto);
  if (concepto.length < 3 || concepto.length > 120) return { ok: false, error: "concepto" };
  const [cat] = await db`select 1 from categoria_gasto where clave = ${c.categoria} and activa`;
  if (!cat) return { ok: false, error: "categoria" };
  const i = leerImporte(c.importe);
  if (!i.ok || Number(i.valor) <= 0) return { ok: false, error: "importe" };
  const proveedor = texto(c.proveedor);
  if (proveedor && (proveedor.length < 2 || proveedor.length > 120)) return { ok: false, error: "proveedor" };
  const nota = c.nota.trim();
  if (nota.length > 300) return { ok: false, error: "nota" };
  return { ok: true, v: { concepto, categoria: c.categoria, importe: i.valor, proveedor: proveedor || null, nota: nota || null } };
}

const RESUMEN = (db: Sql | Tx, usuarioId: string) => db`
  select g.id, g.clave, v.concepto, c.nombre as categoria, v.importe::text as importe, v.version,
         b.nombre as beneficiada, p.nombre as paga, g.sucursal_paga_id <> g.sucursal_id as "pagaOtra",
         o.clave as "compraDe", u.nombre as "solicitadoPor", g.solicitado_en as "solicitadoEn",
         g.solicitado_por = ${usuarioId} as propia,
         coalesce(d.decision, 'por_autorizar') as estado, du.nombre as "decididoPor", d.en as "decididoEn", d.motivo as "motivoDecision",
         impedimento_decision_gasto(${usuarioId}, g.id) as impedimento,
         pg.origen as "origenPago", pg.importe::text as "importePagado",
         case when pg.id is null then null
              when exists (select 1 from comprobante_gasto c where c.gasto_id = g.id) then 'comprobado'
              when exists (select 1 from sin_comprobante_gasto c where c.gasto_id = g.id) then 'sin_comprobante'
              else 'por_comprobar' end as comprobacion
  from gasto g
  left join pago_gasto pg on pg.gasto_id = g.id
  join lateral (select * from gasto_version x where x.gasto_id = g.id order by x.version desc limit 1) v on true
  left join decision_gasto d on d.gasto_id = g.id and d.version = v.version
  left join usuario du on du.id = d.por
  join categoria_gasto c on c.clave = v.categoria
  join sucursal b on b.id = g.sucursal_id
  join sucursal p on p.id = g.sucursal_paga_id
  join usuario u on u.id = g.solicitado_por
  left join gasto o on o.id = g.compra_de`;

/**
 * Quien paga (gasto.pagar en la sucursal que paga) ve los gastos autorizados por pagar ahí y los que él mismo pagó, aunque
 * no consulte todos los gastos (Recepción).
 */
const VE_PARA_PAGAR = (db: Sql | Tx, usuarioId: string) => db`(
  (tiene_permiso(${usuarioId}, 'gasto.pagar', g.sucursal_paga_id)
   and exists (select 1 from decision_gasto dd where dd.gasto_id = g.id and dd.decision = 'autorizado'
               and dd.version = (select max(x.version) from gasto_version x where x.gasto_id = g.id))
   and not exists (select 1 from pago_gasto pp where pp.gasto_id = g.id))
  or exists (select 1 from pago_gasto pp where pp.gasto_id = g.id and pp.registrado_por = ${usuarioId}))`;

/** Puede ver todos los gastos ligados a esa sucursal (beneficiada o que paga). */
const puedeConsultar = (db: Sql | Tx, usuarioId: string, sucursalId: string) =>
  db<{ ok: boolean }[]>`select tiene_permiso(${usuarioId}, 'gasto.consultar', ${sucursalId}) as ok`.then(([r]) => r.ok);

async function sucursalDe(db: Sql | Tx, usuarioId: string, codigo: string) {
  if (!CODIGO.test(codigo)) return null;
  const [s] = await db<{ id: string; codigo: string; nombre: string; solicitar: boolean; consultar: boolean }[]>`
    select s.id, s.codigo, s.nombre, tiene_permiso(${usuarioId}, 'gasto.solicitar', s.id) as solicitar,
           tiene_permiso(${usuarioId}, 'gasto.consultar', s.id) as consultar
    from sucursal s where s.codigo = ${codigo} and tiene_permiso(${usuarioId}, 'sucursal.consultar', s.id)`;
  return s && (s.solicitar || s.consultar) ? s : null;
}

export type PantallaGastos = {
  sucursal: { id: string; codigo: string; nombre: string };
  puedeSolicitar: boolean; consultaTodos: boolean;
  categorias: Categoria[]; sucursalesPaga: SucursalOpcion[];
  /** Solicitudes originales de esta sucursal (últimos 30 días) para ligar «parte de una compra ya solicitada». */
  compras: { id: string; clave: string; concepto: string }[];
  gastos: GastoResumen[];
};

export async function pantallaGastos(sql: Sql, usuarioId: string, codigo: string): Promise<PantallaGastos | null> {
  const s = await sucursalDe(sql, usuarioId, codigo);
  if (!s) return null;
  const categorias = await sql<Categoria[]>`
    select clave, nombre, de_prueba as "dePrueba" from categoria_gasto where activa order by orden, nombre`;
  const sucursalesPaga = s.solicitar ? await sql<SucursalOpcion[]>`
    select id, codigo, nombre from sucursal x
    where tiene_permiso(${usuarioId}, 'gasto.solicitar', x.id) and tiene_permiso(${usuarioId}, 'sucursal.consultar', x.id)
    order by x.id <> ${s.id}, nombre` : [];
  const compras = s.solicitar ? await sql<{ id: string; clave: string; concepto: string }[]>`
    select g.id, g.clave, v.concepto from gasto g
    join lateral (select concepto from gasto_version x where x.gasto_id = g.id order by x.version desc limit 1) v on true
    where g.sucursal_id = ${s.id} and g.compra_de is null and g.solicitado_en > now() - interval '30 days'
      and (${s.consultar} or g.solicitado_por = ${usuarioId})
    order by g.numero desc limit 50` : [];
  const gastos = await sql<GastoResumen[]>`
    ${RESUMEN(sql, usuarioId)}
    where (g.sucursal_id = ${s.id} or g.sucursal_paga_id = ${s.id})
      and (tiene_permiso(${usuarioId}, 'gasto.consultar', g.sucursal_id) or tiene_permiso(${usuarioId}, 'gasto.consultar', g.sucursal_paga_id)
           or g.solicitado_por = ${usuarioId} or ${VE_PARA_PAGAR(sql, usuarioId)})
    order by g.solicitado_en desc, g.numero desc limit 200`;
  return {
    sucursal: { id: s.id, codigo: s.codigo, nombre: s.nombre }, puedeSolicitar: s.solicitar, consultaTodos: s.consultar,
    categorias: [...categorias], sucursalesPaga: [...sucursalesPaga], compras: [...compras], gastos: [...gastos],
  };
}

export type VersionGasto = {
  version: number; concepto: string; categoria: string; importe: string; proveedor: string | null; nota: string | null;
  motivo: string | null; registradaPor: string; en: Date;
};
export type DecisionGasto = {
  version: number; decision: "autorizado" | "rechazado"; importe: string; por: string; en: Date; motivo: string | null;
  sinLimite: boolean; limite: string | null; diario: string | null;
};
export type DetalleGasto = {
  gasto: GastoResumen & { categoriaClave: string; proveedor: string | null; nota: string | null; partes: { clave: string; importe: string }[]; totalCompra: string };
  versiones: VersionGasto[];
  decisiones: DecisionGasto[];
  /** Quiénes pueden decidir la versión vigente ahora (solo si está por autorizar). */
  puedenDecidir: string[];
  puedeCorregir: boolean;
  categorias: Categoria[];
  pago: { origen: OrigenPago; importe: string; pagadoEl: string; pagadoPor: string; registradoPor: string; en: Date;
          aQuien: string | null; cuenta: string | null; referencia: string | null } | null;
  comprobantes: { tipo: "ticket" | "nota" | "factura"; folio: string | null; registradoPor: string; en: Date }[];
  sinComprobante: { motivo: string; registradoPor: string; en: Date } | null;
  /** Orígenes con los que esta persona puede registrar el pago ahora (vacío si no puede). */
  puedePagar: OrigenPago[];
  /** Lo autorizado en la versión vigente (tope del pago). */
  autorizado: string | null;
  puedeComprobar: boolean;
  puedePedirExcedente: boolean;
};

/** Con qué orígenes puede esta persona pagar el gasto ahora mismo (servidor; la base lo vuelve a comprobar). */
async function opcionesPago(db: Sql | Tx, usuarioId: string, gastoId: string): Promise<{ origenes: OrigenPago[]; autorizado: string | null }> {
  const [o] = await db<{ autorizado: string | null; pagado: boolean; puede: boolean; autorizo: boolean; direccion: boolean; admin: boolean;
                         bolsa: boolean; cajon: boolean; entrega: boolean }[]>`
    with g as (select * from gasto where id = ${gastoId}),
         v as (select version from gasto_version where gasto_id = ${gastoId} order by version desc limit 1),
         d as (select * from decision_gasto where gasto_id = ${gastoId} and version = (select version from v)),
         t as (select id from turno where sucursal_id = (select sucursal_paga_id from g) and cerrado_en is null)
    select (select importe::text from d where decision = 'autorizado') as autorizado,
           exists (select 1 from pago_gasto where gasto_id = ${gastoId}) as pagado,
           tiene_permiso(${usuarioId}, 'gasto.pagar', (select sucursal_paga_id from g)) as puede,
           coalesce((select por = ${usuarioId} from d), false) as autorizo,
           exists (select 1 from perfiles_en_sucursal(${usuarioId}, (select sucursal_paga_id from g)) r where r = 'direccion') as direccion,
           exists (select 1 from perfiles_en_sucursal(${usuarioId}, (select sucursal_paga_id from g)) r
                   where r in ('administracion', 'gestion_administrativa', 'direccion')) as admin,
           exists (select 1 from responsable_lugar r join lugar_efectivo l on l.id = r.lugar_id
                   where r.turno_id = (select id from t) and r.hasta is null and r.usuario_id = ${usuarioId} and l.tipo = 'bolsa_visitas') as bolsa,
           exists (select 1 from responsable_lugar r join lugar_efectivo l on l.id = r.lugar_id
                   where r.turno_id = (select id from t) and r.hasta is null and r.usuario_id = ${usuarioId} and l.tipo = 'cajon_mensualidades') as cajon,
           exists (select 1 from entrega_turno e where e.turno_id = (select id from t) and e.estado in ('pendiente', 'recuento')) as entrega`;
  if (!o.autorizado || o.pagado || !o.puede || (o.autorizo && !o.direccion)) return { origenes: [], autorizado: o.autorizado };
  const origenes: OrigenPago[] = [];
  if (o.bolsa && !o.entrega) origenes.push("bolsa_visitas");
  if (o.cajon && !o.entrega) origenes.push("cajon_mensualidades");
  if (o.admin) origenes.push("transferencia");
  origenes.push("tarjeta", "dinero_personal");
  return { origenes, autorizado: o.autorizado };
}

/** Detalle con todas sus versiones. Sin permiso, la misma respuesta que si no existiera. */
export async function detalleGasto(sql: Sql, usuarioId: string, codigo: string, clave: string): Promise<DetalleGasto | null> {
  if (!CODIGO.test(codigo) || !CLAVE.test(clave)) return null;
  const s = await sucursalDe(sql, usuarioId, codigo);
  if (!s) return null;
  const [g] = await sql<(GastoResumen & { categoriaClave: string; proveedor: string | null; nota: string | null; sucursalId: string; pagaId: string })[]>`
    select r.*, v.categoria as "categoriaClave", v.proveedor, v.nota, g2.sucursal_id as "sucursalId", g2.sucursal_paga_id as "pagaId"
    from (${RESUMEN(sql, usuarioId)} where g.clave = ${clave}) r
    join gasto g2 on g2.id = r.id
    join lateral (select * from gasto_version x where x.gasto_id = g2.id order by x.version desc limit 1) v on true
    where g2.sucursal_id = ${s.id} or g2.sucursal_paga_id = ${s.id}`;
  if (!g) return null;
  const [{ paraPagar }] = await sql<{ paraPagar: boolean }[]>`select ${VE_PARA_PAGAR(sql, usuarioId)} as "paraPagar" from gasto g where g.id = ${g.id}`;
  const ve = g.propia || paraPagar || (await puedeConsultar(sql, usuarioId, g.sucursalId)) || (await puedeConsultar(sql, usuarioId, g.pagaId));
  if (!ve) return null;
  const versiones = await sql<VersionGasto[]>`
    select v.version, v.concepto, c.nombre as categoria, v.importe::text as importe, v.proveedor, v.nota, v.motivo,
           u.nombre as "registradaPor", v.en
    from gasto_version v join categoria_gasto c on c.clave = v.categoria join usuario u on u.id = v.registrada_por
    where v.gasto_id = ${g.id} order by v.version`;
  const partes = await sql<{ clave: string; importe: string }[]>`
    select p.clave, v.importe::text as importe from gasto p
    join lateral (select importe from gasto_version x where x.gasto_id = p.id order by x.version desc limit 1) v on true
    where p.compra_de = ${g.id} order by p.numero`;
  const categorias = g.propia ? await sql<Categoria[]>`
    select clave, nombre, de_prueba as "dePrueba" from categoria_gasto where activa order by orden, nombre` : [];
  const decisiones = await sql<DecisionGasto[]>`
    select d.version, d.decision, d.importe::text as importe, u.nombre as por, d.en, d.motivo, d.sin_limite as "sinLimite",
           d.limite_monto::text as limite, d.limite_diario::text as diario
    from decision_gasto d join usuario u on u.id = d.por where d.gasto_id = ${g.id} order by d.version`;
  const puedenDecidir = g.estado === "por_autorizar" ? (await sql<{ nombre: string }[]>`
    select u.nombre from usuario u
    where exists (select 1 from facultad_otorgada f where f.usuario_id = u.id and f.permiso = 'autorizacion.gasto' and f.revocada_en is null)
      and impedimento_decision_gasto(u.id, ${g.id}) is null
    order by u.nombre`).map((x) => x.nombre) : [];
  const [{ total }] = await sql<{ total: string }[]>`select total_compra_gasto(${g.id})::text as total`;
  const [pago] = await sql<NonNullable<DetalleGasto["pago"]>[]>`
    select p.origen, p.importe::text as importe, to_char(p.pagado_el, 'YYYY-MM-DD') as "pagadoEl", a.nombre as "pagadoPor",
           r.nombre as "registradoPor", p.en, p.a_quien as "aQuien", p.cuenta, p.referencia
    from pago_gasto p join usuario a on a.id = p.pagado_por join usuario r on r.id = p.registrado_por where p.gasto_id = ${g.id}`;
  const comprobantes = await sql<DetalleGasto["comprobantes"]>`
    select c.tipo, c.folio, u.nombre as "registradoPor", c.en from comprobante_gasto c join usuario u on u.id = c.registrado_por
    where c.gasto_id = ${g.id} order by c.en`;
  const [sinComprobante] = await sql<NonNullable<DetalleGasto["sinComprobante"]>[]>`
    select c.motivo, u.nombre as "registradoPor", c.en from sin_comprobante_gasto c join usuario u on u.id = c.registrado_por where c.gasto_id = ${g.id}`;
  const op = await opcionesPago(sql, usuarioId, g.id);
  const [{ comprueba }] = await sql<{ comprueba: boolean }[]>`
    select exists (select 1 from pago_gasto p where p.gasto_id = ${g.id} and (p.registrado_por = ${usuarioId} or ${g.propia}))
           and not exists (select 1 from sin_comprobante_gasto c where c.gasto_id = ${g.id}) as comprueba`;
  const [{ solicita }] = await sql<{ solicita: boolean }[]>`select tiene_permiso(${usuarioId}, 'gasto.solicitar', ${g.sucursalId}) as solicita`;
  const { sucursalId, pagaId, ...resto } = g;
  void pagaId;
  void sucursalId;
  return {
    gasto: { ...resto, partes: [...partes], totalCompra: total }, versiones: [...versiones], decisiones: [...decisiones], puedenDecidir,
    puedeCorregir: g.propia && !pago, categorias: [...categorias],
    pago: pago ?? null, comprobantes: [...comprobantes], sinComprobante: sinComprobante ?? null,
    puedePagar: op.origenes, autorizado: op.autorizado, puedeComprobar: comprueba,
    puedePedirExcedente: Boolean(op.autorizado) && !pago && solicita && g.estado === "autorizado",
  };
}

/** Registra una solicitud con su versión 1 y su clave. Idempotente por la clave de envío del formulario. */
export async function solicitarGasto(
  sql: Sql, usuarioId: string, codigo: string,
  d: CamposGasto & { pagaId: string; compraDe: string; envio: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; clave: string } | { ok: false; error: ErrorGasto }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(d.envio)) return { ok: false, error: "repetida" };
  return sql.begin(async (tx) => {
    const s = await sucursalDe(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.solicitar) return { ok: false as const, error: "sin_permiso" as const };
    const [ya] = await tx<{ clave: string; solicitado_por: string }[]>`select clave, solicitado_por from gasto where clave_envio = ${d.envio}`;
    if (ya) return ya.solicitado_por === usuarioId ? { ok: true as const, clave: ya.clave } : { ok: false as const, error: "repetida" as const };
    const v = await validar(tx, d);
    if (!v.ok) return v;
    const pagaId = d.pagaId || s.id;
    if (!esIdentificadorValido(pagaId)) return { ok: false as const, error: "sucursal_paga" as const };
    const [paga] = await tx<{ ok: boolean }[]>`
      select tiene_permiso(${usuarioId}, 'gasto.solicitar', ${pagaId}) and tiene_permiso(${usuarioId}, 'sucursal.consultar', ${pagaId}) as ok`;
    if (!paga?.ok) return { ok: false as const, error: "sucursal_paga" as const };
    let compraDe: string | null = null;
    if (d.compraDe) {
      if (!esIdentificadorValido(d.compraDe)) return { ok: false as const, error: "compra" as const };
      const [o] = await tx`select 1 from gasto where id = ${d.compraDe} and sucursal_id = ${s.id} and compra_de is null
                           and (${s.consultar} or solicitado_por = ${usuarioId})`;
      if (!o) return { ok: false as const, error: "compra" as const };
      compraDe = d.compraDe;
    }
    const [g] = await tx<{ id: string; clave: string }[]>`
      insert into gasto (sucursal_id, sucursal_paga_id, compra_de, solicitado_por, clave_envio, numero, clave)
      values (${s.id}, ${pagaId}, ${compraDe}, ${usuarioId}, ${d.envio}, 0, '')
      returning id, clave`;
    await tx`insert into gasto_version (gasto_id, version, concepto, categoria, importe, proveedor, nota, registrada_por)
             values (${g.id}, 1, ${v.v.concepto}, ${v.v.categoria}, ${v.v.importe}, ${v.v.proveedor}, ${v.v.nota}, ${usuarioId})`;
    return { ok: true as const, clave: g.clave };
  });
}

/** Corrección de quien solicitó: una versión nueva con motivo; las anteriores se conservan. */
export async function corregirGasto(
  sql: Sql, usuarioId: string, codigo: string,
  d: CamposGasto & { clave: string; version: number; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorGasto }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!CODIGO.test(codigo) || !CLAVE.test(d.clave)) return { ok: false, error: "no_encontrada" };
  return sql.begin(async (tx) => {
    const s = await sucursalDe(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    const [g] = await tx<{ id: string; solicitado_por: string }[]>`
      select id, solicitado_por from gasto where clave = ${d.clave} and (sucursal_id = ${s.id} or sucursal_paga_id = ${s.id}) for update`;
    if (!g) return { ok: false as const, error: "no_encontrada" as const };
    if (g.solicitado_por !== usuarioId) return { ok: false as const, error: "sin_permiso" as const };
    if ((await tx`select 1 from pago_gasto where gasto_id = ${g.id}`).length) return { ok: false as const, error: "ya_pagado" as const };
    const [u] = await tx<{ version: number; concepto: string; categoria: string; importe: string; proveedor: string | null; nota: string | null }[]>`
      select version, concepto, categoria, importe::text as importe, proveedor, nota from gasto_version where gasto_id = ${g.id} order by version desc limit 1`;
    if (u.version !== d.version) return { ok: false as const, error: "version" as const };
    const v = await validar(tx, d);
    if (!v.ok) return v;
    const motivo = d.motivo.trim();
    if (motivo.length < 5 || motivo.length > 300) return { ok: false as const, error: "motivo" as const };
    if (v.v.concepto === u.concepto && v.v.categoria === u.categoria && v.v.importe === u.importe && v.v.proveedor === u.proveedor && v.v.nota === u.nota) {
      return { ok: false as const, error: "sin_cambio" as const };
    }
    await tx`insert into gasto_version (gasto_id, version, concepto, categoria, importe, proveedor, nota, motivo, registrada_por)
             values (${g.id}, ${u.version + 1}, ${v.v.concepto}, ${v.v.categoria}, ${v.v.importe}, ${v.v.proveedor}, ${v.v.nota}, ${motivo}, ${usuarioId})`;
    return { ok: true as const };
  });
}

/**
 * Autorizar o rechazar la versión vigente. Se comprueba en el servidor (y la base lo respalda): facultad vigente en la
 * beneficiada y en la que paga, límites, separación, y que nadie haya decidido antes.
 */
export async function decidirGasto(
  sql: Sql, usuarioId: string, codigo: string,
  d: { clave: string; version: number; decision: string; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorGasto }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!CODIGO.test(codigo) || !CLAVE.test(d.clave)) return { ok: false, error: "no_encontrada" };
  if (d.decision !== "autorizado" && d.decision !== "rechazado") return { ok: false, error: "decision" };
  const motivo = d.motivo.trim();
  if ((d.decision === "rechazado" || motivo) && (motivo.length < 5 || motivo.length > 300)) return { ok: false, error: "motivo" };
  try {
    return await sql.begin(async (tx) => {
      const s = await sucursalDe(tx, usuarioId, codigo);
      if (!s) return { ok: false as const, error: "no_encontrada" as const };
      const [g] = await tx<{ id: string; sucursal_id: string; sucursal_paga_id: string; solicitado_por: string }[]>`
        select id, sucursal_id, sucursal_paga_id, solicitado_por from gasto
        where clave = ${d.clave} and (sucursal_id = ${s.id} or sucursal_paga_id = ${s.id}) for update`;
      if (!g) return { ok: false as const, error: "no_encontrada" as const };
      const [v] = await tx<{ version: number; importe: string }[]>`
        select version, importe::text as importe from gasto_version where gasto_id = ${g.id} order by version desc limit 1`;
      if (v.version !== d.version) return { ok: false as const, error: "version" as const };
      const [{ impedimento }] = await tx<{ impedimento: Impedimento | "no_encontrado" | null }[]>`
        select impedimento_decision_gasto(${usuarioId}, ${g.id}) as impedimento`;
      if (impedimento === "no_encontrado") return { ok: false as const, error: "no_encontrada" as const };
      if (impedimento) return { ok: false as const, error: impedimento };
      const [f] = await tx<{ facultad_id: string; sin_limite: boolean; limite_monto: string | null; limite_diario: string | null }[]>`
        select facultad_id, sin_limite, limite_monto, limite_diario from facultad_gasto(${usuarioId}, ${g.sucursal_id})`;
      await tx`insert into decision_gasto (gasto_id, version, decision, importe, por, motivo, facultad_id, sin_limite, limite_monto, limite_diario)
               values (${g.id}, ${v.version}, ${d.decision}, ${v.importe}, ${usuarioId}, ${motivo || null}, ${f.facultad_id}, ${f.sin_limite},
                       ${f.limite_monto}, ${f.limite_diario})`;
      return { ok: true as const };
    });
  } catch (e) {
    // Dos personas decidieron al mismo tiempo: la base deja solo una decisión por versión.
    if (e instanceof Error && "code" in e && e.code === "23505") return { ok: false, error: "ya_decidido" };
    throw e;
  }
}

export type VistaBandeja = "por_autorizar" | "tuyos" | "autorizados" | "rechazados" | "todos";
export type Bandeja = {
  vista: VistaBandeja;
  cuentas: Record<VistaBandeja, number>;
  gastos: (GastoResumen & { codigo: string })[];
};

/**
 * Bandeja de seguimiento: todos los gastos de las sucursales donde la persona consulta gastos (Dirección: todas;
 * Gestión administrativa: las que se le asignen). «Tuyos por decidir» son los que esta persona puede decidir ahora.
 * Sin gasto.consultar en ninguna sucursal: null.
 */
export async function bandejaGastos(sql: Sql, usuarioId: string, vista: string): Promise<Bandeja | null> {
  const [{ alguna }] = await sql<{ alguna: boolean }[]>`
    select exists (select 1 from sucursal s where tiene_permiso(${usuarioId}, 'gasto.consultar', s.id)) as alguna`;
  if (!alguna) return null;
  const v: VistaBandeja = (["por_autorizar", "tuyos", "autorizados", "rechazados", "todos"] as const).find((x) => x === vista) ?? "tuyos";
  const todos = await sql<(GastoResumen & { codigo: string })[]>`
    select r.*, s.codigo from (${RESUMEN(sql, usuarioId)}
      where tiene_permiso(${usuarioId}, 'gasto.consultar', g.sucursal_id) or tiene_permiso(${usuarioId}, 'gasto.consultar', g.sucursal_paga_id)) r
    join gasto g2 on g2.id = r.id join sucursal s on s.id = g2.sucursal_id
    order by r."solicitadoEn" desc limit 500`;
  const filtro: Record<VistaBandeja, (g: GastoResumen) => boolean> = {
    por_autorizar: (g) => g.estado === "por_autorizar",
    tuyos: (g) => g.estado === "por_autorizar" && g.impedimento === null,
    autorizados: (g) => g.estado === "autorizado",
    rechazados: (g) => g.estado === "rechazado",
    todos: () => true,
  };
  const cuentas = Object.fromEntries(Object.entries(filtro).map(([k, f]) => [k, todos.filter(f).length])) as Record<VistaBandeja, number>;
  return { vista: v, cuentas, gastos: todos.filter(filtro[v]) };
}

/** Cuántos gastos de esa sucursal puede decidir ahora esta persona (para «Requiere tu acción»). */
export async function gastosPorDecidir(sql: Sql, usuarioId: string, sucursalId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from gasto g
    where (g.sucursal_id = ${sucursalId} or g.sucursal_paga_id = ${sucursalId})
      and exists (select 1 from facultad_otorgada f where f.usuario_id = ${usuarioId} and f.permiso = 'autorizacion.gasto' and f.revocada_en is null)
      and impedimento_decision_gasto(${usuarioId}, g.id) is null`;
  return n;
}



const TIPOS_COMPROBANTE = ["ticket", "nota", "factura"] as const;
export type DatosComprobante = { tipo: string; folio: string; motivoSin: string };

/** Valida el comprobante: ticket, nota o factura (folio opcional), o «sin comprobante» con motivo. Vacío: se agrega después. */
function leerComprobante(c: DatosComprobante): { ok: true; v: { tipo: "ticket" | "nota" | "factura"; folio: string | null } | { sin: string } | null } | { ok: false; error: ErrorGasto } {
  if (!c.tipo) return { ok: true, v: null };
  if (c.tipo === "sin") {
    const m = texto(c.motivoSin);
    if (m.length < 5 || m.length > 300) return { ok: false, error: "motivo" };
    return { ok: true, v: { sin: m } };
  }
  const tipo = TIPOS_COMPROBANTE.find((t) => t === c.tipo);
  if (!tipo) return { ok: false, error: "comprobante" };
  const folio = texto(c.folio);
  if (folio.length > 60) return { ok: false, error: "folio" };
  return { ok: true, v: { tipo, folio: folio || null } };
}

async function guardarComprobante(tx: Tx, usuarioId: string, gastoId: string, v: { tipo: "ticket" | "nota" | "factura"; folio: string | null } | { sin: string }) {
  if ("sin" in v) await tx`insert into sin_comprobante_gasto (gasto_id, motivo, registrado_por) values (${gastoId}, ${v.sin}, ${usuarioId})`;
  else await tx`insert into comprobante_gasto (gasto_id, tipo, folio, registrado_por) values (${gastoId}, ${v.tipo}, ${v.folio}, ${usuarioId})`;
}

/**
 * Registra el pago de un gasto autorizado (y, si se da, su comprobante). Efectivo: la salida de la bolsa o el cajón del
 * turno abierto, una sola vez. Dinero personal: queda pendiente de reembolso (no sale de caja).
 */
export async function registrarPago(
  sql: Sql, usuarioId: string, codigo: string,
  d: { clave: string; version: number; origen: string; importe: string; aQuien: string; pagadoEl: string; cuenta: string; referencia: string } & DatosComprobante,
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorGasto }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!CODIGO.test(codigo) || !CLAVE.test(d.clave)) return { ok: false, error: "no_encontrada" };
  const origen = (Object.keys(NOMBRE_ORIGEN) as OrigenPago[]).find((o) => o === d.origen);
  if (!origen) return { ok: false, error: "origen" };
  const i = leerImporte(d.importe);
  if (!i.ok || Number(i.valor) <= 0) return { ok: false, error: "importe" };
  const aQuien = texto(d.aQuien);
  if (aQuien && (aQuien.length < 2 || aQuien.length > 120)) return { ok: false, error: "a_quien" };
  const efectivo = origen === "bolsa_visitas" || origen === "cajon_mensualidades";
  const cuenta = texto(d.cuenta);
  const referencia = texto(d.referencia);
  if (origen === "transferencia" || origen === "tarjeta") {
    if (cuenta.length < 2 || cuenta.length > 40 || /\d{4}/.test(cuenta)) return { ok: false, error: "cuenta" };
    if (referencia.length > 60 || (origen === "transferencia" && referencia.length < 3) || (referencia && referencia.length < 3)) return { ok: false, error: "referencia" };
  }
  if (!efectivo && !/^\d{4}-\d{2}-\d{2}$/.test(d.pagadoEl)) return { ok: false, error: "fecha" };
  const c = leerComprobante(d);
  if (!c.ok) return c;
  try {
    return await sql.begin(async (tx) => {
      const s = await sucursalDe(tx, usuarioId, codigo);
      if (!s) return { ok: false as const, error: "no_encontrada" as const };
      const [g] = await tx<{ id: string; sucursal_paga_id: string; ve: boolean }[]>`
        select id, sucursal_paga_id,
               solicitado_por = ${usuarioId} or tiene_permiso(${usuarioId}, 'gasto.consultar', sucursal_id)
                 or tiene_permiso(${usuarioId}, 'gasto.consultar', sucursal_paga_id) or tiene_permiso(${usuarioId}, 'gasto.pagar', sucursal_paga_id) as ve
        from gasto where clave = ${d.clave} and (sucursal_id = ${s.id} or sucursal_paga_id = ${s.id}) for update`;
      if (!g || !g.ve) return { ok: false as const, error: "no_encontrada" as const };
      const [v] = await tx<{ version: number }[]>`select version from gasto_version where gasto_id = ${g.id} order by version desc limit 1`;
      if (v.version !== d.version) return { ok: false as const, error: "version" as const };
      if ((await tx`select 1 from pago_gasto where gasto_id = ${g.id}`).length) return { ok: false as const, error: "ya_pagado" as const };
      const op = await opcionesPago(tx, usuarioId, g.id);
      if (!op.autorizado) return { ok: false as const, error: "no_autorizado" as const };
      if (Number(i.valor) > Number(op.autorizado)) return { ok: false as const, error: "excede" as const };
      if (!op.origenes.includes(origen)) {
        const [x] = await tx<{ autorizo: boolean; puede: boolean }[]>`
          select exists (select 1 from decision_gasto dd where dd.gasto_id = ${g.id} and dd.version = ${v.version} and dd.por = ${usuarioId}) as autorizo,
                 tiene_permiso(${usuarioId}, 'gasto.pagar', ${g.sucursal_paga_id}) as puede`;
        if (!x.puede) return { ok: false as const, error: "sin_permiso" as const };
        if (x.autorizo && !op.origenes.length) return { ok: false as const, error: "autorizo" as const };
        if (efectivo) {
          const [t] = await tx<{ id: string }[]>`select id from turno where sucursal_id = ${g.sucursal_paga_id} and cerrado_en is null`;
          if (!t) return { ok: false as const, error: "sin_turno" as const };
          if ((await tx`select 1 from entrega_turno where turno_id = ${t.id} and estado in ('pendiente', 'recuento')`).length) {
            return { ok: false as const, error: "entrega_en_curso" as const };
          }
          return { ok: false as const, error: "no_responsable" as const };
        }
        return { ok: false as const, error: "origen" as const };
      }
      let pagadoEl = d.pagadoEl;
      if (efectivo) {
        const [h] = await tx<{ hoy: string }[]>`select to_char(dia_en_sucursal(${g.sucursal_paga_id}, now()), 'YYYY-MM-DD') as hoy`;
        pagadoEl = h.hoy;
      } else {
        const [f] = await tx<{ ok: boolean }[]>`
          select ${pagadoEl}::date between dia_en_sucursal(${g.sucursal_paga_id}, (select en from decision_gasto where gasto_id = ${g.id} and version = ${v.version}))
                                       and dia_en_sucursal(${g.sucursal_paga_id}, now()) as ok`;
        if (!f.ok) return { ok: false as const, error: "fecha" as const };
      }
      const [p] = await tx<{ id: string }[]>`
        insert into pago_gasto (gasto_id, version, origen, importe, pagado_el, pagado_por, registrado_por, a_quien, cuenta, referencia)
        values (${g.id}, ${v.version}, ${origen}, ${i.valor}, ${pagadoEl}, ${usuarioId}, ${usuarioId}, ${aQuien || null},
                ${origen === "transferencia" || origen === "tarjeta" ? cuenta : null}, ${referencia || null})
        returning id`;
      if (efectivo) {
        const [t] = await tx<{ id: string }[]>`select id from turno where sucursal_id = ${g.sucursal_paga_id} and cerrado_en is null for update`;
        const [r] = await tx<{ lugar_id: string }[]>`
          select r.lugar_id from responsable_lugar r join lugar_efectivo l on l.id = r.lugar_id
          where r.turno_id = ${t.id} and r.hasta is null and l.tipo = ${origen} and r.usuario_id = ${usuarioId}`;
        await tx`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, pago_gasto_id, responsable_id, registrado_por)
                 values (${r.lugar_id}, ${t.id}, 'salida_pago_gasto', ${(-Number(i.valor)).toFixed(2)}, ${p.id}, ${usuarioId}, ${usuarioId})`;
      }
      if (c.v) await guardarComprobante(tx, usuarioId, g.id, c.v);
      return { ok: true as const };
    });
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "23505") return { ok: false, error: "ya_pagado" };
    throw e;
  }
}

/** Agrega un comprobante después del pago (o registra «sin comprobante» con motivo, para revisión de Dirección). */
export async function registrarComprobante(
  sql: Sql, usuarioId: string, codigo: string, d: { clave: string } & DatosComprobante, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorGasto }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!CODIGO.test(codigo) || !CLAVE.test(d.clave)) return { ok: false, error: "no_encontrada" };
  const c = leerComprobante(d);
  if (!c.ok) return c;
  if (!c.v) return { ok: false, error: "comprobante" };
  return sql.begin(async (tx) => {
    const s = await sucursalDe(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    const [g] = await tx<{ id: string; registrado_por: string | null; solicitado_por: string; sin: boolean }[]>`
      select g.id, p.registrado_por, g.solicitado_por, exists (select 1 from sin_comprobante_gasto x where x.gasto_id = g.id) as sin
      from gasto g left join pago_gasto p on p.gasto_id = g.id
      where g.clave = ${d.clave} and (g.sucursal_id = ${s.id} or g.sucursal_paga_id = ${s.id}) for update of g`;
    if (!g) return { ok: false as const, error: "no_encontrada" as const };
    if (!g.registrado_por) return { ok: false as const, error: "no_autorizado" as const };
    if (usuarioId !== g.registrado_por && usuarioId !== g.solicitado_por) return { ok: false as const, error: "sin_permiso" as const };
    if (g.sin) return { ok: false as const, error: "comprobante" as const };
    if (c.v && "sin" in c.v && (await tx`select 1 from comprobante_gasto where gasto_id = ${g.id}`).length) return { ok: false as const, error: "comprobante" as const };
    await guardarComprobante(tx, usuarioId, g.id, c.v!);
    return { ok: true as const };
  });
}

/**
 * Costó más de lo autorizado: se pide autorización por el excedente como parte de la misma compra (otra solicitud
 * ligada a la original, con su propia clave). Lo autorizado se paga aparte.
 */
export async function pedirExcedente(
  sql: Sql, usuarioId: string, codigo: string, d: { clave: string; importeReal: string; envio: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; clave: string } | { ok: false; error: ErrorGasto }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!CODIGO.test(codigo) || !CLAVE.test(d.clave)) return { ok: false, error: "no_encontrada" };
  const i = leerImporte(d.importeReal);
  if (!i.ok || Number(i.valor) <= 0) return { ok: false, error: "importe" };
  const [g] = await sql<{ id: string; raiz: string; codigo: string; paga: string; concepto: string; categoria: string; proveedor: string | null; autorizado: string | null; pagado: boolean }[]>`
    select g.id, coalesce(g.compra_de, g.id) as raiz, b.codigo, g.sucursal_paga_id as paga, v.concepto, v.categoria, v.proveedor,
           (select d.importe::text from decision_gasto d where d.gasto_id = g.id and d.version = v.version and d.decision = 'autorizado') as autorizado,
           exists (select 1 from pago_gasto p where p.gasto_id = g.id) as pagado
    from gasto g join sucursal b on b.id = g.sucursal_id
    join lateral (select * from gasto_version x where x.gasto_id = g.id order by x.version desc limit 1) v on true
    where g.clave = ${d.clave}`;
  if (!g) return { ok: false, error: "no_encontrada" };
  if (!g.autorizado || g.pagado) return { ok: false, error: "no_autorizado" };
  const excedente = Math.round((Number(i.valor) - Number(g.autorizado)) * 100) / 100;
  if (excedente <= 0) return { ok: false, error: "no_excede" };
  const r = await solicitarGasto(sql, usuarioId, g.codigo, {
    concepto: `Excedente de ${d.clave}: ${g.concepto}`.slice(0, 120), categoria: g.categoria, importe: excedente.toFixed(2),
    proveedor: g.proveedor ?? "", nota: `Costó ${i.valor}; autorizado ${g.autorizado}.`, pagaId: g.paga, compraDe: g.raiz, envio: d.envio,
  }, { entorno });
  return r;
}

/** Gastos autorizados sin pagar que esta persona puede pagar en efectivo ahora (responsable vigente con turno abierto). */
export async function gastosPorPagar(sql: Sql, usuarioId: string, sucursalId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from gasto g
    join lateral (select version from gasto_version x where x.gasto_id = g.id order by x.version desc limit 1) v on true
    join decision_gasto d on d.gasto_id = g.id and d.version = v.version and d.decision = 'autorizado'
    where g.sucursal_paga_id = ${sucursalId} and d.por <> ${usuarioId}
      and not exists (select 1 from pago_gasto p where p.gasto_id = g.id)
      and tiene_permiso(${usuarioId}, 'gasto.pagar', ${sucursalId})
      and exists (select 1 from turno t join responsable_lugar r on r.turno_id = t.id and r.hasta is null
                  where t.sucursal_id = ${sucursalId} and t.cerrado_en is null and r.usuario_id = ${usuarioId})`;
  return n;
}

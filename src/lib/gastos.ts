import type postgres from "postgres";
import { leerImporte } from "@/lib/datos-turno";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";

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
  | "decision" | "ya_decidido" | "propio" | "de_direccion" | "sin_facultad" | "limite" | "diario";

/** Por qué una persona no puede decidir un gasto (impedimento_decision_gasto). */
export type Impedimento = "ya_decidido" | "propio" | "de_direccion" | "sin_facultad" | "limite" | "diario";
export type EstadoGasto = "por_autorizar" | "autorizado" | "rechazado";
export const NOMBRE_ESTADO_GASTO: Record<EstadoGasto, string> = {
  por_autorizar: "Por autorizar", autorizado: "Autorizado", rechazado: "Rechazado",
};

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
         impedimento_decision_gasto(${usuarioId}, g.id) as impedimento
  from gasto g
  join lateral (select * from gasto_version x where x.gasto_id = g.id order by x.version desc limit 1) v on true
  left join decision_gasto d on d.gasto_id = g.id and d.version = v.version
  left join usuario du on du.id = d.por
  join categoria_gasto c on c.clave = v.categoria
  join sucursal b on b.id = g.sucursal_id
  join sucursal p on p.id = g.sucursal_paga_id
  join usuario u on u.id = g.solicitado_por
  left join gasto o on o.id = g.compra_de`;

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
           or g.solicitado_por = ${usuarioId})
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
};

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
  const ve = g.propia || (await puedeConsultar(sql, usuarioId, g.sucursalId)) || (await puedeConsultar(sql, usuarioId, g.pagaId));
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
  const { sucursalId, pagaId, ...resto } = g;
  void sucursalId; void pagaId;
  return {
    gasto: { ...resto, partes: [...partes], totalCompra: total }, versiones: [...versiones], decisiones: [...decisiones], puedenDecidir,
    puedeCorregir: g.propia, categorias: [...categorias],
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

/** Texto para quien no puede decidir un gasto, y a quién le llega. */
export const TEXTO_IMPEDIMENTO: Record<Impedimento, string> = {
  ya_decidido: "Esta versión ya se decidió.",
  propio: "Tú solicitaste este gasto: lo decide otra persona con facultad suficiente.",
  de_direccion: "Lo solicitó Dirección: solo lo decide Dirección.",
  sin_facultad: "No tienes facultad vigente para autorizar gastos aquí (en la sucursal beneficiada y, si es otra, en la que paga).",
  limite: "La compra pasa tu límite por gasto: la decide quien tenga facultad suficiente (Gestión administrativa o Dirección).",
  diario: "Con este gasto pasarías tu acumulado de hoy: lo decide quien tenga facultad suficiente (Gestión administrativa o Dirección).",
};

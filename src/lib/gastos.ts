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
 * - Solicitar no mueve dinero ni autoriza nada: la ruta de autorización y el rechazo llegan en el PR 4.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type ErrorGasto =
  | "sin_permiso" | "no_encontrada" | "concepto" | "categoria" | "importe" | "proveedor" | "nota" | "sucursal_paga"
  | "compra" | "motivo" | "version" | "sin_cambio" | "repetida" | "bloqueado_produccion";

export type CamposGasto = { concepto: string; categoria: string; importe: string; proveedor: string; nota: string };
export type Categoria = { clave: string; nombre: string; dePrueba: boolean };
export type SucursalOpcion = { id: string; codigo: string; nombre: string };

export type GastoResumen = {
  id: string; clave: string; concepto: string; categoria: string; importe: string; version: number;
  beneficiada: string; paga: string; pagaOtra: boolean; compraDe: string | null;
  solicitadoPor: string; solicitadoEn: Date; propia: boolean;
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
         g.solicitado_por = ${usuarioId} as propia
  from gasto g
  join lateral (select * from gasto_version x where x.gasto_id = g.id order by x.version desc limit 1) v on true
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
export type DetalleGasto = {
  gasto: GastoResumen & { categoriaClave: string; proveedor: string | null; nota: string | null; partes: { clave: string; importe: string }[] };
  versiones: VersionGasto[];
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
  const { sucursalId, pagaId, ...resto } = g;
  void sucursalId; void pagaId;
  return { gasto: { ...resto, partes: [...partes] }, versiones: [...versiones], puedeCorregir: g.propia, categorias: [...categorias] };
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

import type postgres from "postgres";
import { leerFolio } from "@/lib/retiros";
import type { Entorno } from "@/lib/entorno";
import {
  ApoyoInvalido, apoyoValido, candidatosApoyo, conApoyo, confirmarEntregaTx, CONTEOS, declararApoyo, porLugar,
  type ConteoLugares, type DeclaracionApoyo, type Receptor,
} from "@/lib/entregas";
import { esIdentificadorValido } from "@/lib/permisos";
import { turnoAbiertoDe, type TipoLugar } from "@/lib/turnos";

/**
 * Bloque 5, regla 7: cierre del día y custodia nocturna (aprobado el 16 nov 2026; solo datos ficticios).
 *
 * 1. Dirección (custodia.configurar) define por sucursal dónde se guardan los sobres y quién tiene acceso; cada
 *    cierre guarda la configuración vigente. El custodio (Encargado, custodia.confirmar) confirma desde su cuenta
 *    dónde los guardó y verifica sello y folio de cada sobre; si falta, llega abierto o trae otro folio, registra la
 *    incidencia con motivo.
 * 2. Cierre (turno.cerrar, la responsable vigente de ambos lugares): «Generar folios» reserva los folios de los dos
 *    sobres (por ejemplo TEN-20261116-C1 y -C2) y los muestra antes de cerrar. Se registran quién contó y quién ayudó.
 *    Con un cambio de turno en curso, un retiro en preparación o cancelaciones pendientes, primero se resuelven. Lo
 *    pendiente sigue visible. La bolsa queda con su esperado: la diferencia contra el esperado queda en el cierre y,
 *    al confirmarse el caso en la apertura, se vinculan las diferencias registradas al retirar (sin duplicarlas).
 *    Cerrar termina el turno.
 * 3. Durante la noche no hay retiros: sin turno abierto no se puede retirar.
 * 4. Apertura (turno.abrir): quien abre verifica sellos y folios y cuenta a ciegas. Si coincide, abre. Si no, recuento
 *    con el custodio; si no pueden recontar, abre con lo contado, con motivo obligatorio. Se conservan los conteos.
 * 5. Puede abrir la misma persona que cerró. Revisa quien no participó (cerró, custodió, abrió o ayudó).
 *
 * El cierre es una entrega_turno de tipo «cierre», así las diferencias, su revisión y la resolución de Dirección son
 * las del cambio de turno.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

const valido = (codigo: string) => /^[A-Z0-9]{2,5}$/.test(codigo);
const limpiar = (t: string) => t.trim().replace(/\s+/g, " ");
const cent = (v: string) => Math.round(Number(v) * 100);

// ---------------------------------------------------------------------------------------------------------------
// Configuración de custodia (Dirección)
// ---------------------------------------------------------------------------------------------------------------

export type ConfiguracionCustodia = {
  id: string; lugar: string; acceso: Receptor[]; configuradaPor: string; en: Date;
  /** Dónde quedan los fondos fijos y quién tiene acceso al cajón (null en configuraciones anteriores al fondo fijo). */
  lugarFondos: string | null; accesoCajon: Receptor[] | null;
  /** Custodias nombradas por Dirección (las recepcionistas que guardan la llave de la caja); null en configuraciones
   *  anteriores, donde el custodio es un Encargado. */
  custodias: Receptor[] | null;
};
type FilaConfiguracion = {
  id: string; lugar: string; acceso: string[]; por: string; en: Date; lugar_fondos: string | null; acceso_cajon: string[] | null;
  custodias: string[] | null;
};
const CONFIGURACIONES = (tx: Tx | Sql, sucursalId: string) => tx<FilaConfiguracion[]>`
  select c.id, c.lugar, c.acceso::text[] as acceso, u.nombre as por, c.en, c.lugar_fondos, c.acceso_cajon::text[] as acceso_cajon,
         c.custodias::text[] as custodias
  from custodia_configuracion c join usuario u on u.id = c.configurada_por
  where c.sucursal_id = ${sucursalId} order by c.en desc, c.id`;
async function aConfiguracion(tx: Tx | Sql, c: FilaConfiguracion): Promise<ConfiguracionCustodia> {
  return {
    id: c.id, lugar: c.lugar, acceso: await nombres(tx, c.acceso), configuradaPor: c.por, en: c.en,
    lugarFondos: c.lugar_fondos, accesoCajon: c.acceso_cajon ? await nombres(tx, c.acceso_cajon) : null,
    custodias: c.custodias ? await nombres(tx, c.custodias) : null,
  };
}

export async function configuracionVigente(tx: Tx | Sql, sucursalId: string): Promise<ConfiguracionCustodia | null> {
  const [c] = await CONFIGURACIONES(tx, sucursalId);
  return c ? aConfiguracion(tx, c) : null;
}
async function nombres(tx: Tx | Sql, ids: string[]): Promise<Receptor[]> {
  if (!ids.length) return [];
  return [...(await tx<Receptor[]>`select id, nombre from usuario where id in ${tx(ids)} order by nombre`)];
}
/** Personas con asignación vigente en la sucursal. */
async function personasSucursal(tx: Tx | Sql, sucursalId: string): Promise<Receptor[]> {
  return [...(await tx<Receptor[]>`
    select id, nombre from usuario u where activo and exists (select 1 from perfiles_en_sucursal(u.id, ${sucursalId})) order by nombre`)];
}

export type PantallaCustodia = {
  sucursal: string;
  vigente: ConfiguracionCustodia | null;
  historial: ConfiguracionCustodia[];
  personas: Receptor[];
};

/** Configuración de custodia de la sucursal, para Dirección (custodia.configurar). null sin permiso. */
export async function pantallaConfiguracionCustodia(sql: Sql, usuarioId: string, codigo: string): Promise<PantallaCustodia | null> {
  if (!valido(codigo)) return null;
  const [s] = await sql<{ id: string; nombre: string }[]>`
    select id, nombre from sucursal where codigo = ${codigo} and tiene_permiso(${usuarioId}, 'custodia.configurar', id)`;
  if (!s) return null;
  const historial: ConfiguracionCustodia[] = [];
  for (const c of await CONFIGURACIONES(sql, s.id)) historial.push(await aConfiguracion(sql, c));
  return { sucursal: s.nombre, vigente: historial[0] ?? null, historial, personas: await personasSucursal(sql, s.id) };
}

export async function configurarCustodia(
  sql: Sql, usuarioId: string, codigo: string,
  datos: { lugar: string; acceso: string[]; lugarFondos: string; accesoCajon: string[]; custodias: string[] }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: "no_encontrada" | "sin_permiso" | "lugar" | "acceso" | "lugar_fondos" | "acceso_cajon" | "custodias" | "bloqueado_produccion" }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!valido(codigo)) return { ok: false, error: "no_encontrada" };
  const lugar = limpiar(datos.lugar);
  if (lugar.length < 5 || lugar.length > 120) return { ok: false, error: "lugar" };
  const acceso = [...new Set(datos.acceso)];
  if (!acceso.length || acceso.length > 10 || !acceso.every(esIdentificadorValido)) return { ok: false, error: "acceso" };
  const lugarFondos = limpiar(datos.lugarFondos);
  if (lugarFondos.length < 5 || lugarFondos.length > 120) return { ok: false, error: "lugar_fondos" };
  const accesoCajon = [...new Set(datos.accesoCajon)];
  if (!accesoCajon.length || accesoCajon.length > 10 || !accesoCajon.every(esIdentificadorValido)) return { ok: false, error: "acceso_cajon" };
  // Dirección nombra explícitamente a las custodias; nadie queda como custodia por omisión.
  const custodiasIds = [...new Set(datos.custodias)];
  if (!custodiasIds.length || custodiasIds.length > 10 || !custodiasIds.every(esIdentificadorValido)) return { ok: false, error: "custodias" };
  return sql.begin(async (tx) => {
    const [s] = await tx<{ id: string; puede: boolean; direccion: boolean }[]>`
      select id, tiene_permiso(${usuarioId}, 'custodia.configurar', id) as puede,
             exists (select 1 from perfiles_en_sucursal(${usuarioId}, id) r where r = 'direccion') as direccion
      from sucursal where codigo = ${codigo}`;
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.puede || !s.direccion) return { ok: false as const, error: "sin_permiso" as const };
    const validos = new Set((await personasSucursal(tx, s.id)).map((p) => p.id));
    if (!acceso.every((a) => validos.has(a))) return { ok: false as const, error: "acceso" as const };
    if (!accesoCajon.every((a) => validos.has(a))) return { ok: false as const, error: "acceso_cajon" as const };
    if (!custodiasIds.every((a) => validos.has(a))) return { ok: false as const, error: "custodias" as const };
    const [c] = await tx<{ id: string }[]>`
      insert into custodia_configuracion (sucursal_id, lugar, acceso, configurada_por, lugar_fondos, acceso_cajon, custodias)
      values (${s.id}, ${lugar}, ${acceso}::uuid[], ${usuarioId}, ${lugarFondos}, ${accesoCajon}::uuid[], ${custodiasIds}::uuid[]) returning id`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('custodia_configuracion', ${c.id}, 'configurar',
                     ${tx.json({ sucursal: codigo, lugar, acceso, lugar_fondos: lugarFondos, acceso_cajon: accesoCajon, custodias: custodiasIds })}, ${usuarioId})`;
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Cierre (Recepción)
// ---------------------------------------------------------------------------------------------------------------

export type ErrorCierre =
  | "no_encontrada" | "sin_permiso" | "sucursal_inactiva" | "sin_turno" | "no_responsable" | "entrega_en_curso"
  | "retiro_en_preparacion" | "cancelaciones_pendientes" | "sin_configuracion" | "sin_preparacion" | "custodio" | "nota"
  | "apoyo" | "cambio" | "fondo" | "fondo_primero" | "ubicacion" | "motivo_llave" | "motivo_llave_caja" | ErrorVerificacion | "bloqueado_produccion";

export type Sobre = { id: string; lugar: TipoLugar; folio: string };

/** Monto vigente del fondo fijo de cada lugar ("0.00" si Dirección no lo ha definido). */
export async function fondosVigentes(tx: Tx | Sql, sucursalId: string): Promise<{ lugarId: string; tipo: TipoLugar; monto: string }[]> {
  return [...(await tx<{ lugarId: string; tipo: TipoLugar; monto: string }[]>`
    select l.id as "lugarId", l.tipo,
           coalesce((select f.monto from fondo_caja f where f.lugar_id = l.id order by f.en desc, f.id limit 1), 0)::numeric(12, 2)::text as monto
    from lugar_efectivo l where l.sucursal_id = ${sucursalId} order by case l.tipo when 'bolsa_visitas' then 0 else 1 end`)];
}

export type LlaveDatos = { estado: string; motivo: string };
/** Cajón cerrado y llave recibida, o una incidencia con motivo. */
export function leerLlave(d: LlaveDatos | undefined): { ok: true; llave: "correcta" | "incidencia"; motivo: string | null } | { ok: false } {
  if (!d || d.estado === "correcta") return { ok: true, llave: "correcta", motivo: null };
  const motivo = limpiar(d.motivo);
  if (d.estado !== "incidencia" || motivo.length < 5 || motivo.length > 300) return { ok: false };
  return { ok: true, llave: "incidencia", motivo };
}
/** Igual, pero sin suponer que está correcta: la persona tiene que indicarlo (caja con sobres guardados). */
export function leerLlaveRequerida(d: LlaveDatos | undefined) {
  if (!d || (d.estado !== "correcta" && d.estado !== "incidencia")) return { ok: false as const };
  return leerLlave(d);
}

// ---------------------------------------------------------------------------------------------------------------
// Caja con llave: sobres guardados hasta que Dirección los recoge (18 nov 2026)
// ---------------------------------------------------------------------------------------------------------------

export type SobreEnCaja = Sobre & { entregaId: string; guardadoEn: Date; cerro: string; dias: number };
/** Sobres guardados en la caja de la sucursal (sin recoger), del más antiguo al más reciente. */
export async function sobresEnCaja(tx: Tx | Sql, sucursalId: string, excluirEntrega: string | null = null): Promise<SobreEnCaja[]> {
  return [...(await tx<SobreEnCaja[]>`
    select s.id, l.tipo as lugar, s.folio, s.entrega_id as "entregaId", s.resuelto_en as "guardadoEn", u.nombre as cerro,
           floor(extract(epoch from now() - s.resuelto_en) / 86400)::int as dias
    from sobre_cierre s join lugar_efectivo l on l.id = s.lugar_id join entrega_turno e on e.id = s.entrega_id join usuario u on u.id = e.entrega_por
    where s.sucursal_id = ${sucursalId} and s.estado = 'usado' and s.importe is not null and sobre_en_caja(s.id)
      and s.entrega_id is distinct from ${excluirEntrega}
    order by s.resuelto_en, s.folio`)];
}

/**
 * Sobres guardados que no están físicamente en la caja: entregados a Dirección sin confirmar todavía, o de una entrega
 * cancelada cuya devolución física aún no se registra. Se muestran en cada cambio de custodia.
 */
export type SobreFueraDeCaja = Sobre & {
  estado: "por_confirmar" | "por_devolver"; recoleccionId: string; entrego: string; recibe: string; desde: Date;
};
export async function sobresFueraDeCaja(tx: Tx | Sql, sucursalId: string): Promise<SobreFueraDeCaja[]> {
  return [...(await tx<SobreFueraDeCaja[]>`
    select s.id, l.tipo as lugar, s.folio, case r.estado when 'pendiente' then 'por_confirmar' else 'por_devolver' end as estado,
           r.id as "recoleccionId", a.nombre as entrego, b.nombre as recibe, coalesce(r.resuelta_en, r.creada_en) as desde
    from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id join sobre_cierre s on s.id = x.sobre_id
    join lugar_efectivo l on l.id = s.lugar_id join usuario a on a.id = r.entrega_por join usuario b on b.id = r.recibe
    where r.sucursal_id = ${sucursalId}
      and (r.estado = 'pendiente'
           or (r.estado = 'cancelada' and not exists (select 1 from devolucion_sobre d where d.recoleccion_id = r.id and d.sobre_id = s.id)))
    order by r.creada_en, s.resuelto_en, s.folio`)];
}
/** Días desde que se guardó un sobre a partir de los cuales hay aviso (aprobado el 18 nov 2026). */
export const DIAS_AVISO_SOBRE = 8;

/** Registra una revisión de la caja: quien recibe la llave verifica cada sobre guardado. */
async function registrarRevisionCaja(tx: Tx, d: {
  sucursalId: string; momento: "cierre" | "apertura" | "cambio_turno" | "recoleccion" | "devolucion"; entregaId?: string; recoleccionId?: string;
  por: string; custodio: string;
  /** Llave de la caja de sobres. */
  llave: { llave: "correcta" | "incidencia"; motivo: string | null };
  /** Llave del cajón de los fondos, por separado (cierre, apertura y cambio de turno). */
  llaveCajon: { llave: "correcta" | "incidencia"; motivo: string | null } | null;
  filas: { sobreId: string; estado: string; folioVisto: string | null; motivo: string | null }[];
}) {
  const [r] = await tx<{ id: string }[]>`
    insert into revision_caja (sucursal_id, momento, entrega_id, recoleccion_id, por, custodio_id, llave, motivo_llave, llave_cajon, motivo_llave_cajon)
    values (${d.sucursalId}, ${d.momento}, ${d.entregaId ?? null}, ${d.recoleccionId ?? null}, ${d.por}, ${d.custodio}, ${d.llave.llave}, ${d.llave.motivo},
            ${d.llaveCajon?.llave ?? null}, ${d.llaveCajon?.motivo ?? null})
    returning id`;
  for (const f of d.filas) {
    await tx`insert into verificacion_sobre (sobre_id, momento, estado, folio_visto, motivo, verificado_por, revision_id)
             values (${f.sobreId}, 'caja', ${f.estado}, ${f.folioVisto}, ${f.motivo}, ${d.por}, ${r.id})`;
  }
  return r.id;
}
export { registrarRevisionCaja };

/** Valida la verificación de los sobres de la caja (todos los guardados, sin faltar ninguno). */
export function leerCaja(caja: Sobre[], datos: VerificacionDatos[] | undefined) {
  return leerVerificaciones(caja, (datos ?? []).filter((x) => caja.some((c) => c.id === x.sobreId)));
}

async function sucursalCierre(tx: Tx | Sql, usuarioId: string, codigo: string) {
  if (!valido(codigo)) return null;
  const [s] = await tx<{ id: string; nombre: string; inactiva: boolean; cierra: boolean }[]>`
    select id, nombre, estado_operativo = 'inactiva' as inactiva, tiene_permiso(${usuarioId}, 'turno.cerrar', id) as cierra
    from sucursal where codigo = ${codigo}
      and (tiene_permiso(${usuarioId}, 'turno.consultar', id) or tiene_permiso(${usuarioId}, 'turno.cerrar', id))`;
  return s ?? null;
}

/** Turno abierto (bloqueado si se pide) y responsable vigente de ambos lugares (variante A). */
async function contextoCierre(tx: Tx, usuarioId: string, codigo: string, bloquear: boolean) {
  const s = await sucursalCierre(tx, usuarioId, codigo);
  if (!s) return { ok: false as const, error: "no_encontrada" as const };
  if (!s.cierra) return { ok: false as const, error: "sin_permiso" as const };
  if (s.inactiva) return { ok: false as const, error: "sucursal_inactiva" as const };
  const [t] = bloquear
    ? await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null for update`
    : await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null`;
  if (!t) return { ok: false as const, error: "sin_turno" as const };
  const responsables = await tx<{ usuario_id: string }[]>`select usuario_id from responsable_lugar where turno_id = ${t.id} and hasta is null`;
  if (responsables.length !== 2 || responsables.some((r) => r.usuario_id !== usuarioId)) return { ok: false as const, error: "no_responsable" as const };
  return { ok: true as const, s, turnoId: t.id };
}

/** Lo que impide cerrar en este momento (se resuelve primero). */
async function bloqueos(tx: Tx | Sql, turnoId: string) {
  const [b] = await tx<{ entrega: boolean; retiro: boolean; cancelaciones: number }[]>`
    select exists (select 1 from entrega_turno where turno_id = ${turnoId} and estado in ('pendiente', 'recuento')) as entrega,
           exists (select 1 from folio_retiro where turno_id = ${turnoId} and estado = 'reservado') as retiro,
           (select count(*)::int from cancelacion_cobro k join cobro_visita cv on cv.id = k.cobro_id
            join operacion_visita o on o.id = cv.operacion_id where o.turno_id = ${turnoId} and k.estado = 'solicitada') as cancelaciones`;
  return b;
}

/**
 * Quiénes pueden quedar como custodio: las custodias que nombró Dirección (activas y con asignación en la sucursal) o, en
 * configuraciones anteriores, los Encargados. Incluye a quien cierra si está entre ellos (opción «Yo»).
 */
async function custodios(tx: Tx | Sql, sucursalId: string, config: ConfiguracionCustodia | null): Promise<Receptor[]> {
  if (config?.custodias) {
    const ids = config.custodias.map((c) => c.id);
    return [...(await tx<Receptor[]>`
      select id, nombre from usuario u where activo and id in ${tx(ids)}
        and exists (select 1 from perfiles_en_sucursal(u.id, ${sucursalId}))
      order by nombre`)];
  }
  return [...(await tx<Receptor[]>`
    select id, nombre from usuario u where activo
      and exists (select 1 from perfiles_en_sucursal(u.id, ${sucursalId}) r where r = 'encargado')
      and tiene_permiso(u.id, 'custodia.confirmar', ${sucursalId})
    order by nombre`)];
}

const SOBRES_RESERVADOS = (tx: Tx | Sql, turnoId: string) => tx<Sobre[]>`
  select s.id, l.tipo as lugar, s.folio from sobre_cierre s join lugar_efectivo l on l.id = s.lugar_id
  where s.turno_id = ${turnoId} and s.estado = 'reservado' order by case l.tipo when 'bolsa_visitas' then 0 else 1 end`;

export type PantallaCierre =
  | {
      ok: true; sucursal: string; turnoId: string;
      lugares: { tipo: TipoLugar; contadoAlAbrir: string; entradas: string; ajustes: string; retiros: string; fondos: string; esperado: string | null; diferenciaRetiros: string }[];
      bloqueos: { entrega: boolean; retiro: boolean; cancelaciones: number };
      pendientesVisibles: { retirosPorConfirmar: number; diferenciasPorRevisar: number };
      configuracion: ConfiguracionCustodia | null;
      /** Incluye a quien cierra si también es Encargado de la sucursal (opción «Yo»). */
      custodios: Receptor[];
      /** Sobres ya guardados en la caja: si quien cierra se queda la llave, los verifica. */
      caja: SobreEnCaja[];
      /** Entregados a Dirección sin confirmar o por devolver: no están en la caja. */
      fuera: SobreFueraDeCaja[];
      fondos: { tipo: TipoLugar; monto: string }[];
      apoyos: Receptor[];
      sobres: Sobre[];
    }
  | { ok: false; error: ErrorCierre };

export async function pantallaCierre(sql: Sql, usuarioId: string, codigo: string, entorno: Entorno): Promise<PantallaCierre> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  return sql.begin("read only", async (tx): Promise<PantallaCierre> => {
    const c = await contextoCierre(tx, usuarioId, codigo, false);
    if (!c.ok) return c;
    const t = (await turnoAbiertoDe(tx, c.s.id))!;
    const config = await configuracionVigente(tx, c.s.id);
    const [p] = await tx<{ retiros: number; diferencias: number }[]>`
      select (select count(*)::int from retiro where sucursal_id = ${c.s.id} and estado in ('pendiente', 'recuento', 'por_revisar')) as retiros,
             (select count(*)::int from diferencia_efectivo d join turno x on x.id = d.turno_id
              left join revision_diferencia r on r.diferencia_id = d.id where x.sucursal_id = ${c.s.id} and r.id is null)
             + (select count(*)::int from incidencia_cierre i join entrega_turno e on e.id = i.entrega_id join turno x on x.id = e.turno_id
                where x.sucursal_id = ${c.s.id} and not exists (select 1 from revision_incidencia r where r.incidencia_id = i.id)) as diferencias`;
    return {
      ok: true, sucursal: c.s.nombre, turnoId: c.turnoId,
      lugares: t.lugares.map((l) => ({
        tipo: l.tipo, contadoAlAbrir: l.contadoAlAbrir, entradas: l.entradas, ajustes: l.ajustes, retiros: l.retiros, fondos: l.fondos, esperado: l.esperado,
        diferenciaRetiros: l.diferenciaRetiros,
      })),
      bloqueos: await bloqueos(tx, c.turnoId),
      pendientesVisibles: { retirosPorConfirmar: p.retiros, diferenciasPorRevisar: p.diferencias },
      configuracion: config,
      custodios: await custodios(tx, c.s.id, config),
      caja: await sobresEnCaja(tx, c.s.id),
      fuera: await sobresFueraDeCaja(tx, c.s.id),
      fondos: (await fondosVigentes(tx, c.s.id)).map((f) => ({ tipo: f.tipo, monto: f.monto })),
      apoyos: await candidatosApoyo(tx, c.s.id, [usuarioId]),
      sobres: [...(await SOBRES_RESERVADOS(tx, c.turnoId))],
    };
  });
}

/**
 * «Generar folios»: reserva el folio de cada sobre (bolsa y cajón) para anotarlo antes de cerrar: sucursal, fecha
 * local con año y C + consecutivo del día. No mueve efectivo. Un doble clic devuelve los mismos folios.
 */
export async function prepararCierre(
  sql: Sql, usuarioId: string, codigo: string, datos: { turnoId: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; sobres: Sobre[] } | { ok: false; error: ErrorCierre }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.turnoId)) return { ok: false, error: "cambio" };
  return sql.begin(async (tx) => {
    const c = await contextoCierre(tx, usuarioId, codigo, true);
    if (!c.ok) return c;
    if (c.turnoId !== datos.turnoId) return { ok: false as const, error: "cambio" as const };
    const b = await bloqueos(tx, c.turnoId);
    if (b.entrega) return { ok: false as const, error: "entrega_en_curso" as const };
    if (b.retiro) return { ok: false as const, error: "retiro_en_preparacion" as const };
    const ya = await SOBRES_RESERVADOS(tx, c.turnoId);
    if (ya.length === 2) return { ok: true as const, sobres: [...ya] };
    const lugares = await tx<{ id: string; tipo: TipoLugar }[]>`
      select id, tipo from lugar_efectivo where sucursal_id = ${c.s.id} order by case tipo when 'bolsa_visitas' then 0 else 1 end`;
    for (const l of lugares.filter((x) => !ya.some((y) => y.lugar === x.tipo))) {
      const [n] = await tx<{ fecha: string; iso: string; ultimo: number }[]>`
        insert into folio_cierre_contador (sucursal_id, fecha, ultimo)
        values (${c.s.id}, (now() at time zone 'America/Mexico_City')::date, 1)
        on conflict (sucursal_id, fecha) do update set ultimo = folio_cierre_contador.ultimo + 1
        returning to_char(fecha, 'YYYYMMDD') as fecha, fecha::text as iso, ultimo`;
      const folio = `${codigo}-${n.fecha}-C${n.ultimo}`;
      const [s] = await tx<{ id: string }[]>`
        insert into sobre_cierre (sucursal_id, turno_id, lugar_id, fecha, consecutivo, folio, reservado_por)
        values (${c.s.id}, ${c.turnoId}, ${l.id}, ${n.iso}::text::date, ${n.ultimo}, ${folio}, ${usuarioId}) returning id`;
      await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
               values ('sobre_cierre', ${s.id}, 'generar', ${tx.json({ sucursal: codigo, lugar: l.tipo, folio })}, ${usuarioId})`;
    }
    return { ok: true as const, sobres: [...(await SOBRES_RESERVADOS(tx, c.turnoId))] };
  });
}

/** «Cancelar preparación»: los folios reservados quedan cancelados, sin reutilizarse. El turno sigue abierto. */
export async function cancelarPreparacionCierre(
  sql: Sql, usuarioId: string, codigo: string, datos: { turnoId: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; folios: string[] } | { ok: false; error: ErrorCierre }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.turnoId)) return { ok: false, error: "cambio" };
  return sql.begin(async (tx) => {
    const c = await contextoCierre(tx, usuarioId, codigo, true);
    if (!c.ok) return c;
    if (c.turnoId !== datos.turnoId) return { ok: false as const, error: "cambio" as const };
    const sobres = await SOBRES_RESERVADOS(tx, c.turnoId);
    for (const s of sobres) {
      await tx`update sobre_cierre set estado = 'cancelado', resuelto_en = now() where id = ${s.id}`;
      await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
               values ('sobre_cierre', ${s.id}, 'cancelar', ${tx.json({ sucursal: codigo, folio: s.folio })}, ${usuarioId})`;
    }
    return { ok: true as const, folios: sobres.map((s) => s.folio) };
  });
}

/**
 * «Cerrar el turno»: registra lo contado en cada lugar (la bolsa con su esperado), quién ayudó, el custodio y la
 * configuración de custodia vigente; usa los sobres reservados y termina el turno. El cierre queda pendiente de la
 * siguiente apertura; el custodio confirma desde su cuenta.
 */
export async function cerrarDia(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: {
    turnoId: string; conteo: ConteoLugares; custodio: string; nota: string; apoyo: DeclaracionApoyo;
    /** Fondo apartado y contado en cada lugar (si no hay fondo vigente, 0). El sobre lleva el excedente. */
    fondos?: ConteoLugares;
    /** Solo si quien cierra queda como custodio: la custodia se confirma en el mismo cierre. */
    custodia?: { ubicacion: string; sobres: VerificacionDatos[]; llave: LlaveDatos; llaveCaja?: LlaveDatos };
  },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; entregaId: string; diferenciaEsperado: string | null } | { ok: false; error: ErrorCierre; lugar?: TipoLugar; sobreId?: string }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const nota = limpiar(datos.nota);
  if (nota && (nota.length < 5 || nota.length > 300)) return { ok: false, error: "nota" };
  if (!esIdentificadorValido(datos.custodio)) return { ok: false, error: "custodio" };
  if (!esIdentificadorValido(datos.turnoId)) return { ok: false, error: "cambio" };
  if (!apoyoValido(datos.apoyo)) return { ok: false, error: "apoyo" };
  return conApoyo(() => sql.begin(async (tx) => {
    // Mismo orden de bloqueo que cobros, retiros y cambio de turno: primero el turno.
    const c = await contextoCierre(tx, usuarioId, codigo, true);
    if (!c.ok) return c;
    if (c.turnoId !== datos.turnoId) return { ok: false as const, error: "cambio" as const };
    const b = await bloqueos(tx, c.turnoId);
    if (b.entrega) return { ok: false as const, error: "entrega_en_curso" as const };
    if (b.retiro) return { ok: false as const, error: "retiro_en_preparacion" as const };
    if (b.cancelaciones) return { ok: false as const, error: "cancelaciones_pendientes" as const };
    const config = await configuracionVigente(tx, c.s.id);
    if (!config || !config.accesoCajon) return { ok: false as const, error: "sin_configuracion" as const };
    if (!(await custodios(tx, c.s.id, config)).some((x) => x.id === datos.custodio)) return { ok: false as const, error: "custodio" as const };
    const sobres = await SOBRES_RESERVADOS(tx, c.turnoId);
    if (sobres.length !== 2) return { ok: false as const, error: "sin_preparacion" as const };

    // Fondo fijo: primero se completa el fondo; solo el excedente va al sobre. Fondo + sobre = lo contado.
    const vigentes = await fondosVigentes(tx, c.s.id);
    const reparto = [];
    for (const f of vigentes) {
      const clave = f.tipo === "bolsa_visitas" ? "bolsa" : "cajon";
      const total = cent(datos.conteo[clave]);
      const fondo = cent(datos.fondos?.[clave] ?? "0");
      const monto = cent(f.monto);
      if (fondo < 0 || fondo > total || fondo > monto) return { ok: false as const, error: "fondo" as const, lugar: f.tipo };
      if (fondo < Math.min(total, monto)) return { ok: false as const, error: "fondo_primero" as const, lugar: f.tipo };
      reparto.push({ ...f, fondo, sobre: total - fondo, sobreReservado: sobres.find((s) => s.lugar === f.tipo)! });
    }
    const usados = reparto.filter((r) => r.sobre > 0).map((r) => r.sobreReservado);

    // Si quien cierra queda como custodio, confirma la custodia aquí mismo: los sobres nuevos y los que ya estaban en la
    // caja (todo se valida antes de escribir).
    const mismaPersona = datos.custodio === usuarioId;
    // Con custodias nombradas por Dirección (desde el 18 nov 2026) los sobres se guardan en la caja hasta la recolección;
    // con una configuración anterior se abren al día siguiente, como antes.
    const guardados = config.custodias !== null;
    const caja = guardados ? await sobresEnCaja(tx, c.s.id) : [];
    let custodia = null;
    if (mismaPersona) {
      if (!datos.custodia) return { ok: false as const, error: "custodio" as const };
      const ubicacion = limpiar(datos.custodia.ubicacion);
      if (ubicacion.length < 5 || ubicacion.length > 120) return { ok: false as const, error: "ubicacion" as const };
      const v = leerVerificaciones(usados, datos.custodia.sobres.filter((x) => usados.some((u) => u.id === x.sobreId)));
      if (!v.ok) return v;
      const vc = leerCaja(caja, datos.custodia.sobres);
      if (!vc.ok) return vc;
      const llave = guardados ? leerLlaveRequerida(datos.custodia.llave) : leerLlave(datos.custodia.llave);
      if (!llave.ok) return { ok: false as const, error: "motivo_llave" as const };
      // Con sobres guardados, la llave de la caja de sobres se registra aparte de la del cajón de los fondos.
      const llaveCaja = guardados ? leerLlaveRequerida(datos.custodia.llaveCaja) : null;
      if (llaveCaja && !llaveCaja.ok) return { ok: false as const, error: "motivo_llave_caja" as const };
      custodia = { ubicacion, filas: v.filas, caja: vc.filas, llave, llaveCaja: llaveCaja?.ok ? llaveCaja : null };
    }

    const t = (await turnoAbiertoDe(tx, c.s.id))!;
    const [e] = await tx<{ id: string }[]>`
      insert into entrega_turno (turno_id, entrega_por, recibe, nota, tipo, custodio_id, custodia_config_id, sobres_guardados)
      values (${c.turnoId}, ${usuarioId}, null, ${nota || null}, 'cierre', ${datos.custodio}, ${config.id}, ${guardados}) returning id`;
    let diferenciaEsperado: string | null = null;
    // Al siguiente turno pasa solo el fondo; el excedente sale al sobre. El esperado de la bolsa descuenta su sobre, así la
    // diferencia contra el esperado sigue siendo lo contado menos lo esperado.
    for (const r of reparto) {
      const esperadoTotal = r.tipo === "bolsa_visitas" ? t.lugares.find((x) => x.tipo === "bolsa_visitas")!.esperado : null;
      const total = r.fondo + r.sobre;
      if (esperadoTotal !== null && total !== cent(esperadoTotal)) diferenciaEsperado = ((total - cent(esperadoTotal)) / 100).toFixed(2);
      const sale = guardados ? r.sobre : 0;
      await tx`insert into entrega_conteo (entrega_id, lugar_id, tipo, importe, esperado, contado_por)
               values (${e.id}, ${r.lugarId}, 'entregado', ${((total - sale) / 100).toFixed(2)},
                       ${esperadoTotal === null ? null : ((cent(esperadoTotal) - sale) / 100).toFixed(2)}, ${usuarioId})`;
    }
    if (!(await declararApoyo(tx, c.s.id, e.id, "conteo_entrega", usuarioId, [usuarioId, datos.custodio], datos.apoyo))) {
      throw new ApoyoInvalido();
    }
    for (const r of reparto) {
      await tx`insert into conteo_fondo (entrega_id, lugar_id, momento, fondo_monto, fondo, sobre, contado_por)
               values (${e.id}, ${r.lugarId}, 'cierre', ${r.monto}, ${(r.fondo / 100).toFixed(2)}, ${(r.sobre / 100).toFixed(2)}, ${usuarioId})`;
    }
    // Un lugar sin excedente no lleva sobre: su folio queda cancelado, sin reutilizarse.
    for (const s of sobres) {
      const r = reparto.find((x) => x.sobreReservado.id === s.id)!;
      if (usados.some((u) => u.id === s.id) && !guardados) {
        await tx`update sobre_cierre set estado = 'usado', entrega_id = ${e.id}, resuelto_en = now() where id = ${s.id}`;
      } else if (usados.some((u) => u.id === s.id)) {
        await tx`update sobre_cierre set estado = 'usado', entrega_id = ${e.id}, resuelto_en = now(), importe = ${(r.sobre / 100).toFixed(2)}
                 where id = ${s.id}`;
        await tx`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, sobre_id, responsable_id, registrado_por)
                 values (${r.lugarId}, ${c.turnoId}, 'salida_sobre', ${(-r.sobre / 100).toFixed(2)}, ${s.id}, ${usuarioId}, ${usuarioId})`;
      } else {
        await tx`update sobre_cierre set estado = 'cancelado', resuelto_en = now() where id = ${s.id}`;
      }
    }
    if (custodia) {
      for (const f of custodia.filas) {
        await tx`insert into verificacion_sobre (sobre_id, momento, estado, folio_visto, motivo, verificado_por)
                 values (${f.sobreId}, 'custodia', ${f.estado}, ${f.folioVisto}, ${f.motivo}, ${usuarioId})`;
      }
      await tx`insert into custodia_cierre (entrega_id, custodio_id, ubicacion, llave, motivo_llave)
               values (${e.id}, ${usuarioId}, ${custodia.ubicacion}, ${custodia.llave.llave}, ${custodia.llave.motivo})`;
      if (guardados) {
        await registrarRevisionCaja(tx, {
          sucursalId: c.s.id, momento: "cierre", entregaId: e.id, por: usuarioId, custodio: usuarioId,
          llave: custodia.llaveCaja!, llaveCajon: custodia.llave, filas: custodia.caja,
        });
      }
      await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
               values ('entrega_turno', ${e.id}, 'confirmar_custodia',
                       ${tx.json({ ubicacion: custodia.ubicacion, sobres: custodia.filas, caja: custodia.caja, llave_cajon: custodia.llave.llave, motivo_llave_cajon: custodia.llave.motivo,
                                 llave_caja: custodia.llaveCaja?.llave ?? null, motivo_llave_caja: custodia.llaveCaja?.motivo ?? null, misma_persona: true })},
                       ${usuarioId})`;
    }
    await tx`update responsable_lugar set hasta = now() where turno_id = ${c.turnoId} and hasta is null`;
    await tx`update turno set cerrado_en = now() where id = ${c.turnoId}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrega_turno', ${e.id}, 'cerrar',
                     ${tx.json({ sucursal: codigo, turno: c.turnoId, custodio: datos.custodio, custodia: config.id,
                                 bolsa_visitas: datos.conteo.bolsa, cajon_mensualidades: datos.conteo.cajon,
                                 fondos: reparto.map((r) => ({ lugar: r.tipo, monto: r.monto, fondo: (r.fondo / 100).toFixed(2), sobre: (r.sobre / 100).toFixed(2) })),
                                 sobres: usados.map((s) => s.folio), diferencia_contra_esperado: diferenciaEsperado,
                                 cerro_y_custodio: mismaPersona, sobres_guardados: guardados })},
                     ${usuarioId})`;
    return { ok: true as const, entregaId: e.id, diferenciaEsperado };
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Cierre pendiente de apertura (para la pantalla del turno y del custodio)
// ---------------------------------------------------------------------------------------------------------------

export type CierrePendiente = {
  entregaId: string; version: number; estado: "pendiente" | "recuento";
  cerradoPor: string; cerradoPorId: string; cerradoEn: Date;
  custodio: string; custodioId: string;
  custodia: { ubicacion: string; confirmadaEn: Date } | null;
  configuracion: { lugar: string; acceso: Receptor[]; lugarFondos: string | null; accesoCajon: Receptor[] };
  /** Llave del cajón al confirmar la custodia. */
  llave: { estado: "correcta" | "incidencia"; motivo: string | null } | null;
  sobres: (Sobre & { custodia: Verificacion | null })[];
  /** Fondo fijo de cada lugar al cerrar (monto vigente) y si lleva sobre. */
  fondos: { lugar: TipoLugar; monto: string; tieneSobre: boolean }[];
  /** Quien empezó a abrir (en recuento). */
  abre: string | null; abreId: string | null;
  /** Motivo de abrir sin la confirmación del custodio, si así se abrió. */
  sinCustodia: string | null;
  /** Cierre con sobres guardados: al abrir se cuenta solo el fondo y se verifica la caja (cierres anteriores: false). */
  sobresGuardados: boolean;
};
export type Verificacion = { estado: "correcto" | "falta" | "abierto" | "otro_folio"; folioVisto: string | null; motivo: string | null; por: string; en: Date };

/** Cierre de la sucursal pendiente de apertura, si lo hay. */
export async function cierrePendiente(tx: Tx | Sql, sucursalId: string): Promise<CierrePendiente | null> {
  const [e] = await tx<{ id: string; version: number; estado: "pendiente" | "recuento"; cerro: string; cerro_id: string; en: Date;
                          custodio: string; custodio_id: string; lugar: string; acceso: string[]; abre: string | null; abre_id: string | null;
                          ubicacion: string | null; confirmada_en: Date | null; sin_custodia: string | null;
                          lugar_fondos: string | null; acceso_cajon: string[] | null; llave: "correcta" | "incidencia" | null; motivo_llave: string | null;
                          sobres_guardados: boolean }[]>`
    select e.id, e.version, e.sobres_guardados, e.estado, a.nombre as cerro, a.id as cerro_id, e.creada_en as en, c.nombre as custodio, c.id as custodio_id,
           k.lugar, k.acceso::text[] as acceso, b.nombre as abre, b.id as abre_id, x.ubicacion, x.confirmada_en,
           k.lugar_fondos, k.acceso_cajon::text[] as acceso_cajon, x.llave, x.motivo_llave,
           (select a.motivo from apertura_sin_custodia a where a.entrega_id = e.id) as sin_custodia
    from entrega_turno e join turno t on t.id = e.turno_id
    join usuario a on a.id = e.entrega_por join usuario c on c.id = e.custodio_id
    join custodia_configuracion k on k.id = e.custodia_config_id
    left join usuario b on b.id = e.recibe
    left join custodia_cierre x on x.entrega_id = e.id
    where t.sucursal_id = ${sucursalId} and e.tipo = 'cierre' and e.estado in ('pendiente', 'recuento')`;
  if (!e) return null;
  return {
    entregaId: e.id, version: e.version, estado: e.estado, cerradoPor: e.cerro, cerradoPorId: e.cerro_id, cerradoEn: e.en,
    custodio: e.custodio, custodioId: e.custodio_id,
    custodia: e.ubicacion ? { ubicacion: e.ubicacion, confirmadaEn: e.confirmada_en! } : null,
    configuracion: { lugar: e.lugar, acceso: await nombres(tx, e.acceso), lugarFondos: e.lugar_fondos, accesoCajon: await nombres(tx, e.acceso_cajon ?? []) },
    llave: e.llave ? { estado: e.llave, motivo: e.motivo_llave } : null,
    sobres: await sobresDe(tx, e.id, "custodia"),
    fondos: [...(await tx<{ lugar: TipoLugar; monto: string; tieneSobre: boolean }[]>`
      select l.tipo as lugar, coalesce(f.fondo_monto, 0)::numeric(12, 2)::text as monto,
             exists (select 1 from sobre_cierre s where s.entrega_id = ${e.id} and s.lugar_id = l.id) as "tieneSobre"
      from lugar_efectivo l join entrega_turno x on x.id = ${e.id} join turno t on t.id = x.turno_id and t.sucursal_id = l.sucursal_id
      left join conteo_fondo f on f.entrega_id = ${e.id} and f.lugar_id = l.id and f.momento = 'cierre'
      order by case l.tipo when 'bolsa_visitas' then 0 else 1 end`)],
    abre: e.abre, abreId: e.abre_id, sinCustodia: e.sin_custodia, sobresGuardados: e.sobres_guardados,
  };
}

async function sobresDe(tx: Tx | Sql, entregaId: string, momento: "custodia" | "apertura") {
  const filas = await tx<{ id: string; lugar: TipoLugar; folio: string; estado: Verificacion["estado"] | null; folio_visto: string | null;
                           motivo: string | null; por: string | null; en: Date | null }[]>`
    select s.id, l.tipo as lugar, s.folio, v.estado, v.folio_visto, v.motivo, u.nombre as por, v.en
    from sobre_cierre s join lugar_efectivo l on l.id = s.lugar_id
    left join verificacion_sobre v on v.sobre_id = s.id and v.momento = ${momento}
    left join usuario u on u.id = v.verificado_por
    where s.entrega_id = ${entregaId} order by case l.tipo when 'bolsa_visitas' then 0 else 1 end`;
  return filas.map((f) => ({
    id: f.id, lugar: f.lugar, folio: f.folio,
    custodia: f.estado ? { estado: f.estado, folioVisto: f.folio_visto, motivo: f.motivo, por: f.por!, en: f.en! } : null,
  }));
}

/**
 * Cierre de la sucursal cuyo custodio es esta cuenta y aún no confirma la custodia, con los sobres que ya estaban en la
 * caja. null si la cuenta no puede ser custodio ahí (Encargado con custodia.confirmar o custodia nombrada por Dirección).
 */
export async function custodiasPorConfirmar(sql: Sql, usuarioId: string, codigo: string): Promise<{ sucursal: string; sucursalId: string; cierre: CierrePendiente | null; caja: SobreEnCaja[]; fuera: SobreFueraDeCaja[] } | null> {
  if (!valido(codigo)) return null;
  const [s] = await sql<{ id: string; nombre: string }[]>`
    select id, nombre from sucursal x where codigo = ${codigo}
      and exists (select 1 from perfiles_en_sucursal(${usuarioId}, x.id))
      and (tiene_permiso(${usuarioId}, 'custodia.confirmar', x.id)
           or exists (select 1 from entrega_turno e join turno t on t.id = e.turno_id
                      where t.sucursal_id = x.id and e.tipo = 'cierre' and e.custodio_id = ${usuarioId}))`;
  if (!s) return null;
  const c = await cierrePendiente(sql, s.id);
  const cierre = c && c.custodioId === usuarioId && !c.custodia ? c : null;
  return {
    sucursal: s.nombre, sucursalId: s.id, cierre, caja: cierre ? await sobresEnCaja(sql, s.id, cierre.entregaId) : [],
    fuera: cierre ? await sobresFueraDeCaja(sql, s.id) : [],
  };
}

export type VerificacionDatos = { sobreId: string; estado: string; folioVisto: string; motivo: string };
export type ErrorVerificacion = "sobres" | "estado" | "folio_visto" | "motivo";

/** Valida la verificación de cada sobre (sello y folio): «correcto» o una incidencia con motivo. */
export function leerVerificaciones(sobres: Sobre[], datos: VerificacionDatos[]):
  { ok: true; filas: { sobreId: string; estado: Verificacion["estado"]; folioVisto: string | null; motivo: string | null }[] } | { ok: false; error: ErrorVerificacion; sobreId?: string } {
  if (datos.length !== sobres.length || !sobres.every((s) => datos.some((d) => d.sobreId === s.id))) return { ok: false, error: "sobres" };
  const filas = [];
  for (const d of datos) {
    if (!["correcto", "falta", "abierto", "otro_folio"].includes(d.estado)) return { ok: false, error: "estado", sobreId: d.sobreId };
    const estado = d.estado as Verificacion["estado"];
    const motivo = limpiar(d.motivo);
    const folioVisto = estado === "otro_folio" ? leerFolio(d.folioVisto) : null;
    if (estado === "otro_folio" && !folioVisto) return { ok: false, error: "folio_visto", sobreId: d.sobreId };
    if (estado !== "correcto" && (motivo.length < 5 || motivo.length > 300)) return { ok: false, error: "motivo", sobreId: d.sobreId };
    filas.push({ sobreId: d.sobreId, estado, folioVisto, motivo: estado === "correcto" ? null : motivo });
  }
  return { ok: true, filas };
}

/**
 * El custodio confirma desde su cuenta dónde guardó los sobres y verifica sello y folio de cada uno. Una incidencia
 * (falta, abierto u otro folio) lleva motivo. Una sola vez, antes de la apertura.
 */
export async function confirmarCustodia(
  sql: Sql, usuarioId: string, codigo: string,
  datos: {
    entregaId: string; ubicacion: string; sobres: VerificacionDatos[];
    /** Llave del cajón de los fondos. */
    llave?: LlaveDatos;
    /** Con sobres guardados: llave de la caja de sobres, por separado. */
    llaveCaja?: LlaveDatos;
  },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; incidencias: number } | { ok: false; error: "no_encontrada" | "ya_confirmada" | "ya_abierto" | "ubicacion" | "motivo_llave" | "motivo_llave_caja" | ErrorVerificacion | "bloqueado_produccion"; sobreId?: string }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!valido(codigo) || !esIdentificadorValido(datos.entregaId)) return { ok: false, error: "no_encontrada" };
  const ubicacion = limpiar(datos.ubicacion);
  if (ubicacion.length < 5 || ubicacion.length > 120) return { ok: false, error: "ubicacion" };
  const llave = leerLlave(datos.llave);
  if (!llave.ok) return { ok: false, error: "motivo_llave" };
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: string; estado: string; custodio_id: string; sucursal_id: string; recibe: string | null }[]>`
      select e.id, e.estado, e.custodio_id, t.sucursal_id, e.recibe
      from entrega_turno e join turno t on t.id = e.turno_id join sucursal s on s.id = t.sucursal_id
      where e.id = ${datos.entregaId} and e.tipo = 'cierre' and s.codigo = ${codigo} for update of e`;
    // El custodio es quien quedó registrado en el cierre (la base de datos ya comprobó que podía serlo).
    if (!e || e.custodio_id !== usuarioId) return { ok: false as const, error: "no_encontrada" as const };
    if ((await tx`select 1 from custodia_cierre where entrega_id = ${e.id}`).length) return { ok: false as const, error: "ya_confirmada" as const };
    if (e.estado !== "pendiente" || e.recibe) return { ok: false as const, error: "ya_abierto" as const };
    const sobres = (await sobresDe(tx, e.id, "custodia")).map((s) => ({ id: s.id, lugar: s.lugar, folio: s.folio }));
    const v = leerVerificaciones(sobres, datos.sobres.filter((x) => sobres.some((y) => y.id === x.sobreId)));
    if (!v.ok) return v;
    // Con sobres guardados, el custodio recibe la llave de la caja y verifica también los sobres que ya estaban ahí.
    const [{ guardados }] = await tx<{ guardados: boolean }[]>`select sobres_guardados as guardados from entrega_turno where id = ${e.id}`;
    const caja = guardados ? await sobresEnCaja(tx, e.sucursal_id, e.id) : [];
    const vc = leerCaja(caja, datos.sobres);
    if (!vc.ok) return vc;
    if (guardados && !leerLlaveRequerida(datos.llave).ok) return { ok: false as const, error: "motivo_llave" as const };
    const llaveCaja = guardados ? leerLlaveRequerida(datos.llaveCaja) : null;
    if (llaveCaja && !llaveCaja.ok) return { ok: false as const, error: "motivo_llave_caja" as const };
    for (const f of v.filas) {
      await tx`insert into verificacion_sobre (sobre_id, momento, estado, folio_visto, motivo, verificado_por)
               values (${f.sobreId}, 'custodia', ${f.estado}, ${f.folioVisto}, ${f.motivo}, ${usuarioId})`;
    }
    await tx`insert into custodia_cierre (entrega_id, custodio_id, ubicacion, llave, motivo_llave)
             values (${e.id}, ${usuarioId}, ${ubicacion}, ${llave.llave}, ${llave.motivo})`;
    if (llaveCaja?.ok) {
      await registrarRevisionCaja(tx, {
        sucursalId: e.sucursal_id, momento: "cierre", entregaId: e.id, por: usuarioId, custodio: usuarioId, llave: llaveCaja, llaveCajon: llave, filas: vc.filas,
      });
    }
    const incidencias = [...v.filas, ...vc.filas].filter((f) => f.estado !== "correcto").length + (llave.llave === "incidencia" ? 1 : 0)
      + (llaveCaja?.ok && llaveCaja.llave === "incidencia" ? 1 : 0);
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrega_turno', ${e.id}, 'confirmar_custodia',
                     ${tx.json({ ubicacion, sobres: v.filas, caja: vc.filas, llave: llave.llave, motivo_llave: llave.motivo,
                                 llave_caja: llaveCaja?.ok ? llaveCaja.llave : null, motivo_llave_caja: llaveCaja?.ok ? llaveCaja.motivo : null, incidencias })}, ${usuarioId})`;
    return { ok: true as const, incidencias };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Apertura desde el cierre
// ---------------------------------------------------------------------------------------------------------------

export type ErrorApertura =
  | "no_encontrada" | "sin_permiso" | "sucursal_inactiva" | "sin_cierre" | "otra_persona" | "cambio" | "motivo" | "apoyo"
  | "custodia_pendiente" | "motivo_custodia" | "fondo" | "motivo_llave" | "motivo_llave_caja" | ErrorVerificacion | "bloqueado_produccion";

/** Fondo y sobre contados por separado en cada lugar (el total de cada lugar es la suma). */
export type FondoYSobre = { fondo: string; sobre: string };
export type ConteoSeparado = { lugar: TipoLugar; cerrado: FondoYSobre | null; inicial: FondoYSobre | null; final: FondoYSobre | null }[];

async function conteoSeparado(tx: Tx | Sql, entregaId: string): Promise<ConteoSeparado> {
  const filas = await tx<{ lugar: TipoLugar; momento: string; fondo: string; sobre: string }[]>`
    select l.tipo as lugar, c.momento, c.fondo::text as fondo, c.sobre::text as sobre
    from conteo_fondo c join lugar_efectivo l on l.id = c.lugar_id where c.entrega_id = ${entregaId}`;
  const de = (lugar: TipoLugar, momento: string) => {
    const f = filas.find((x) => x.lugar === lugar && x.momento === momento);
    return f ? { fondo: f.fondo, sobre: f.sobre } : null;
  };
  return (["bolsa_visitas", "cajon_mensualidades"] as const).map((l) => ({
    lugar: l, cerrado: de(l, "cierre"), inicial: de(l, "apertura_inicial"), final: de(l, "apertura_final"),
  }));
}

/** Registra fondo y sobre contados al abrir (solo si el cierre los separó). El total ya está en entrega_conteo. */
async function registrarConteoSeparado(tx: Tx, entregaId: string, sucursalId: string, usuarioId: string,
                                       momento: "apertura_inicial" | "apertura_final", conteo: ConteoLugares, fondos: ConteoLugares) {
  const cierre = await tx<{ lugar_id: string; tipo: TipoLugar; fondo_monto: string }[]>`
    select c.lugar_id, l.tipo, c.fondo_monto::text as fondo_monto from conteo_fondo c join lugar_efectivo l on l.id = c.lugar_id
    where c.entrega_id = ${entregaId} and c.momento = 'cierre' and l.sucursal_id = ${sucursalId}`;
  for (const f of cierre) {
    const clave = f.tipo === "bolsa_visitas" ? "bolsa" : "cajon";
    const fondo = cent(fondos[clave]);
    await tx`insert into conteo_fondo (entrega_id, lugar_id, momento, fondo_monto, fondo, sobre, contado_por)
             values (${entregaId}, ${f.lugar_id}, ${momento}, ${f.fondo_monto}, ${(fondo / 100).toFixed(2)},
                     ${((cent(conteo[clave]) - fondo) / 100).toFixed(2)}, ${usuarioId})`;
  }
}
const fondoValido = (conteo: ConteoLugares, fondos: ConteoLugares) =>
  (["bolsa", "cajon"] as const).every((k) => cent(fondos[k]) >= 0 && cent(fondos[k]) <= cent(conteo[k]));

async function sucursalApertura(tx: Tx | Sql, usuarioId: string, codigo: string) {
  if (!valido(codigo)) return null;
  const [s] = await tx<{ id: string; nombre: string; inactiva: boolean; abre: boolean }[]>`
    select id, nombre, estado_operativo = 'inactiva' as inactiva, tiene_permiso(${usuarioId}, 'turno.abrir', id) as abre
    from sucursal where codigo = ${codigo}
      and (tiene_permiso(${usuarioId}, 'turno.consultar', id) or tiene_permiso(${usuarioId}, 'turno.abrir', id))`;
  return s ?? null;
}

export type PantallaApertura =
  | {
      ok: true; sucursal: string; cierre: CierrePendiente;
      /** Solo en recuento: lo cerrado y el primer conteo de quien abre (antes, conteo a ciegas). */
      recuento: { cerrado: ConteoLugares; inicial: ConteoLugares; separado: ConteoSeparado; verificacion: (Sobre & { apertura: Verificacion | null })[] } | null;
      apoyos: Receptor[];
      /** Con sobres guardados: todos los sobres de la caja (incluidos los de este cierre), que quien abre verifica. */
      caja: SobreEnCaja[];
      /** Sobres que no están en la caja: entregados a Dirección sin confirmar o por devolver. No se verifican. */
      fuera: SobreFueraDeCaja[];
    }
  | { ok: false; error: ErrorApertura };

export async function pantallaApertura(sql: Sql, usuarioId: string, codigo: string, entorno: Entorno): Promise<PantallaApertura> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  return sql.begin("read only", async (tx): Promise<PantallaApertura> => {
    const s = await sucursalApertura(tx, usuarioId, codigo);
    if (!s) return { ok: false, error: "no_encontrada" };
    if (!s.abre) return { ok: false, error: "sin_permiso" };
    if (s.inactiva) return { ok: false, error: "sucursal_inactiva" };
    const c = await cierrePendiente(tx, s.id);
    if (!c) return { ok: false, error: "sin_cierre" };
    if (c.estado === "recuento" && c.abreId !== usuarioId) return { ok: false, error: "otra_persona" };
    let recuento = null;
    if (c.estado === "recuento") {
      const filas = await CONTEOS(tx, c.entregaId);
      const ap = c.sobresGuardados ? await verificacionCaja(tx, c.entregaId, "apertura") : await sobresDe(tx, c.entregaId, "apertura");
      recuento = {
        cerrado: porLugar(filas, "entregado"), inicial: porLugar(filas, "recibido_inicial"), separado: await conteoSeparado(tx, c.entregaId),
        verificacion: ap.map((x) => ({ id: x.id, lugar: x.lugar, folio: x.folio, apertura: x.custodia })),
      };
    }
    return {
      ok: true, sucursal: s.nombre, cierre: c, recuento, apoyos: await candidatosApoyo(tx, s.id, [usuarioId, c.custodioId]),
      caja: c.sobresGuardados ? await sobresEnCaja(tx, s.id) : [],
      fuera: c.sobresGuardados ? await sobresFueraDeCaja(tx, s.id) : [],
    };
  });
}

/**
 * Primer paso de la apertura: quien abre verifica sello y folio de cada sobre y captura su conteo a ciegas. Si
 * coincide con lo cerrado en ambos lugares, el turno abre con eso. Si no, queda en recuento.
 */
export async function abrirDesdeCierre(
  sql: Sql, usuarioId: string, codigo: string,
  datos: {
    entregaId: string; version: number; sobres: VerificacionDatos[]; conteo: ConteoLugares; apoyo: DeclaracionApoyo;
    /** Fondo contado aparte en cada lugar (conteo es el total: fondo + sobre). */
    fondos?: ConteoLugares;
    /** Solo si el custodio no confirmó y no está disponible: por qué se abre sin su confirmación. */
    sinCustodia?: { motivo: string } | null;
    /** Con sobres guardados: quien abre recibe la llave del cajón de los fondos… */
    llave?: LlaveDatos;
    /** …y, por separado, la de la caja de sobres. */
    llaveCaja?: LlaveDatos;
  },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; resultado: "abierto"; turnoId: string } | { ok: true; resultado: "recuento" } | { ok: false; error: ErrorApertura; sobreId?: string }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.entregaId)) return { ok: false, error: "sin_cierre" };
  if (!apoyoValido(datos.apoyo)) return { ok: false, error: "apoyo" };
  return conApoyo(() => sql.begin(async (tx) => {
    const c = await contextoApertura(tx, usuarioId, codigo, datos.entregaId, datos.version);
    if (!c.ok) return c;
    if (c.cierre.estado !== "pendiente") return { ok: false as const, error: "cambio" as const };
    // Con sobres guardados los sobres no se abren ni se cuentan: pasa solo el fondo, y quien abre verifica la caja y
    // recibe las dos llaves (cada una se registra aparte).
    const guardados = c.cierre.sobresGuardados;
    const llave = guardados ? leerLlaveRequerida(datos.llave) : leerLlave(datos.llave);
    if (!llave.ok) return { ok: false as const, error: "motivo_llave" as const };
    const llaveCaja = guardados ? leerLlaveRequerida(datos.llaveCaja) : leerLlave(undefined);
    if (!llaveCaja.ok) return { ok: false as const, error: "motivo_llave_caja" as const };
    const fondos = guardados ? datos.conteo : datos.fondos ?? { bolsa: "0", cajon: "0" };
    if (!fondoValido(datos.conteo, fondos)) return { ok: false as const, error: "fondo" as const };
    const sobres = guardados ? [...(await sobresEnCaja(tx, c.sucursalId))] : c.cierre.sobres.map((s) => ({ id: s.id, lugar: s.lugar, folio: s.folio }));
    const v = leerVerificaciones(sobres, datos.sobres);
    if (!v.ok) return v;
    // Custodia sin confirmar: si el custodio está disponible, confirma primero; si no, se abre con motivo obligatorio.
    const motivoSinCustodia = limpiar(datos.sinCustodia?.motivo ?? "");
    if (!c.cierre.custodia) {
      if (!datos.sinCustodia) return { ok: false as const, error: "custodia_pendiente" as const };
      if (motivoSinCustodia.length < 5 || motivoSinCustodia.length > 300) return { ok: false as const, error: "motivo_custodia" as const };
    }
    // Quien abre queda registrada como quien recibe el cierre (puede ser la misma persona que cerró).
    await tx`update entrega_turno set recibe = ${usuarioId}, version = version + 1 where id = ${c.cierre.entregaId}`;
    if (!c.cierre.custodia) {
      await tx`insert into apertura_sin_custodia (entrega_id, motivo, registrada_por) values (${c.cierre.entregaId}, ${motivoSinCustodia}, ${usuarioId})`;
      await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
               values ('entrega_turno', ${c.cierre.entregaId}, 'abrir_sin_custodia', ${tx.json({ custodio: c.cierre.custodioId })}, ${motivoSinCustodia}, ${usuarioId})`;
    }
    if (guardados) {
      await registrarRevisionCaja(tx, {
        sucursalId: c.sucursalId, momento: "apertura", entregaId: c.cierre.entregaId, por: usuarioId, custodio: usuarioId,
        llave: llaveCaja, llaveCajon: llave, filas: v.filas,
      });
    } else {
      for (const f of v.filas) {
        await tx`insert into verificacion_sobre (sobre_id, momento, estado, folio_visto, motivo, verificado_por)
                 values (${f.sobreId}, 'apertura', ${f.estado}, ${f.folioVisto}, ${f.motivo}, ${usuarioId})`;
      }
    }
    const lugares = await tx<{ id: string; tipo: TipoLugar }[]>`select id, tipo from lugar_efectivo where sucursal_id = ${c.sucursalId}`;
    for (const l of lugares) {
      await tx`insert into entrega_conteo (entrega_id, lugar_id, tipo, importe, contado_por)
               values (${c.cierre.entregaId}, ${l.id}, 'recibido_inicial', ${l.tipo === "bolsa_visitas" ? datos.conteo.bolsa : datos.conteo.cajon}, ${usuarioId})`;
    }
    await registrarConteoSeparado(tx, c.cierre.entregaId, c.sucursalId, usuarioId, "apertura_inicial", datos.conteo, fondos);
    if (!(await declararApoyo(tx, c.sucursalId, c.cierre.entregaId, "conteo_recepcion", usuarioId, [usuarioId, c.cierre.custodioId], datos.apoyo))) {
      throw new ApoyoInvalido();
    }
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrega_turno', ${c.cierre.entregaId}, 'abrir_conteo',
                     ${tx.json({ sobres: v.filas, bolsa_visitas: datos.conteo.bolsa, cajon_mensualidades: datos.conteo.cajon, fondos,
                                 sobres_guardados: guardados, llave_cajon: guardados ? llave.llave : null, motivo_llave_cajon: guardados ? llave.motivo : null,
                                 llave_caja: guardados ? llaveCaja.llave : null, motivo_llave_caja: guardados ? llaveCaja.motivo : null,
                                 misma_persona: usuarioId === c.cierre.cerradoPorId, custodio_abre: usuarioId === c.cierre.custodioId })},
                     ${usuarioId})`;
    const cerrado = porLugar(await CONTEOS(tx, c.cierre.entregaId), "entregado");
    if (cent(cerrado.bolsa) === cent(datos.conteo.bolsa) && cent(cerrado.cajon) === cent(datos.conteo.cajon)) {
      const turnoId = await confirmarEntregaTx(tx, {
        entregaId: c.cierre.entregaId, turnoId: c.turnoCerrado, sucursalId: c.sucursalId, usuarioId, final: datos.conteo,
        aclaracion: null, cerrarTurno: false,
      });
      await registrarIncidencias(tx, c.cierre.entregaId);
      return { ok: true as const, resultado: "abierto" as const, turnoId };
    }
    await tx`update entrega_turno set estado = 'recuento', version = version + 1 where id = ${c.cierre.entregaId}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrega_turno', ${c.cierre.entregaId}, 'conteo_no_coincide',
                     ${tx.json({ bolsa_visitas: datos.conteo.bolsa, cajon_mensualidades: datos.conteo.cajon })}, ${usuarioId})`;
    return { ok: true as const, resultado: "recuento" as const };
  }));
}

/**
 * Segundo paso, si no coincidió: recuento con el custodio (se conserva el primer conteo) o, si no pueden recontar
 * juntos, abrir con lo contado, con motivo obligatorio. La diferencia queda por revisar.
 */
export async function terminarApertura(
  sql: Sql, usuarioId: string, codigo: string,
  datos: { entregaId: string; version: number; recontaron: boolean; conteo: ConteoLugares | null; motivo: string; fondos?: ConteoLugares | null },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; turnoId: string } | { ok: false; error: ErrorApertura }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.entregaId)) return { ok: false, error: "sin_cierre" };
  const motivo = limpiar(datos.motivo);
  if (!datos.recontaron && (motivo.length < 5 || motivo.length > 300)) return { ok: false, error: "motivo" };
  if (datos.recontaron && motivo && (motivo.length < 5 || motivo.length > 300)) return { ok: false, error: "motivo" };
  if (datos.recontaron && !datos.conteo) return { ok: false, error: "cambio" };
  if (datos.recontaron && datos.fondos && !fondoValido(datos.conteo!, datos.fondos)) return { ok: false, error: "fondo" };
  return sql.begin(async (tx) => {
    const c = await contextoApertura(tx, usuarioId, codigo, datos.entregaId, datos.version);
    if (!c.ok) return c;
    if (c.cierre.estado !== "recuento") return { ok: false as const, error: "cambio" as const };
    const inicial = porLugar(await CONTEOS(tx, c.cierre.entregaId), "recibido_inicial");
    const final = datos.recontaron ? datos.conteo! : inicial;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('entrega_turno', ${c.cierre.entregaId}, ${datos.recontaron ? "recuento_con_custodio" : "abrir_sin_recuento"},
                     ${tx.json({ bolsa_visitas: final.bolsa, cajon_mensualidades: final.cajon })}, ${motivo || null}, ${usuarioId})`;
    const turnoId = await confirmarEntregaTx(tx, {
      entregaId: c.cierre.entregaId, turnoId: c.turnoCerrado, sucursalId: c.sucursalId, usuarioId, final,
      aclaracion: motivo || null, cerrarTurno: false, recontadoCon: datos.recontaron ? c.cierre.custodioId : null,
    });
    if (datos.recontaron) {
      await registrarConteoSeparado(tx, c.cierre.entregaId, c.sucursalId, usuarioId, "apertura_final", final,
                                    c.cierre.sobresGuardados ? final : datos.fondos ?? { bolsa: "0", cajon: "0" });
    }
    await registrarIncidencias(tx, c.cierre.entregaId);
    return { ok: true as const, turnoId };
  });
}

/**
 * Al confirmarse la apertura, cada incidencia queda por revisar aunque el efectivo cuadre: la apertura sin custodia
 * confirmada y cada sobre que el custodio o quien abre no encontró cerrado y con su folio.
 */
async function registrarIncidencias(tx: Tx, entregaId: string) {
  await tx`insert into incidencia_cierre (entrega_id, tipo)
           select entrega_id, 'custodia_sin_confirmar' from apertura_sin_custodia where entrega_id = ${entregaId}`;
  await tx`insert into incidencia_cierre (entrega_id, tipo, verificacion_id)
           select ${entregaId}, case v.momento when 'custodia' then 'sobre_en_custodia' else 'sobre_al_abrir' end, v.id
           from verificacion_sobre v join sobre_cierre s on s.id = v.sobre_id
           where s.entrega_id = ${entregaId} and v.estado <> 'correcto' and v.momento in ('custodia', 'apertura') order by v.id`;
  // Fondo incompleto al cerrar y llave o cajón con problema en la custodia.
  await tx`insert into incidencia_cierre (entrega_id, tipo, lugar_id)
           select entrega_id, 'fondo_incompleto', lugar_id from conteo_fondo
           where entrega_id = ${entregaId} and momento = 'cierre' and fondo < fondo_monto`;
  await tx`insert into incidencia_cierre (entrega_id, tipo)
           select entrega_id, 'llave_custodia' from custodia_cierre where entrega_id = ${entregaId} and llave = 'incidencia'`;
}

/** Verificación de la caja hecha en una entrega (apertura o cambio de turno), con el formato de sobresDe. */
export async function verificacionCaja(tx: Tx | Sql, entregaId: string, momento: "cierre" | "apertura" | "cambio_turno") {
  const filas = await tx<{ id: string; lugar: TipoLugar; folio: string; estado: Verificacion["estado"]; folio_visto: string | null;
                           motivo: string | null; por: string; en: Date }[]>`
    select s.id, l.tipo as lugar, s.folio, v.estado, v.folio_visto, v.motivo, u.nombre as por, v.en
    from revision_caja r join verificacion_sobre v on v.revision_id = r.id join sobre_cierre s on s.id = v.sobre_id
    join lugar_efectivo l on l.id = s.lugar_id join usuario u on u.id = v.verificado_por
    where r.entrega_id = ${entregaId} and r.momento = ${momento} order by s.resuelto_en, s.folio`;
  return filas.map((f) => ({
    id: f.id, lugar: f.lugar, folio: f.folio,
    custodia: { estado: f.estado, folioVisto: f.folio_visto, motivo: f.motivo, por: f.por, en: f.en } as Verificacion,
  }));
}

/** Incidencias de la caja de una entrega ya confirmada: sobres guardados con problema y llave con incidencia. */
export async function registrarIncidenciasCaja(tx: Tx, entregaId: string) {
  await tx`insert into incidencia_cierre (entrega_id, tipo, verificacion_id)
           select ${entregaId}, 'sobre_caja', v.id from revision_caja r join verificacion_sobre v on v.revision_id = r.id
           where r.entrega_id = ${entregaId} and v.estado <> 'correcto' order by r.en, v.id`;
  await tx`insert into incidencia_cierre (entrega_id, tipo, revision_id)
           select ${entregaId}, 'llave_caja', r.id from revision_caja r where r.entrega_id = ${entregaId} and r.llave = 'incidencia' order by r.en`;
  // Llave del cajón de los fondos al recibir la custodia (al cerrar ya queda como «llave_custodia»).
  await tx`insert into incidencia_cierre (entrega_id, tipo, revision_id)
           select ${entregaId}, 'llave_cajon', r.id from revision_caja r
           where r.entrega_id = ${entregaId} and r.momento in ('apertura', 'cambio_turno') and r.llave_cajon = 'incidencia' order by r.en`;
}

/** Bloquea el cierre (primero la fila de la entrega) y comprueba quién abre. */
async function contextoApertura(tx: Tx, usuarioId: string, codigo: string, entregaId: string, version: number) {
  const s = await sucursalApertura(tx, usuarioId, codigo);
  if (!s) return { ok: false as const, error: "no_encontrada" as const };
  if (!s.abre) return { ok: false as const, error: "sin_permiso" as const };
  if (s.inactiva) return { ok: false as const, error: "sucursal_inactiva" as const };
  const [e] = await tx<{ id: string; turno_id: string; version: number }[]>`
    select e.id, e.turno_id, e.version from entrega_turno e join turno t on t.id = e.turno_id
    where e.id = ${entregaId} and t.sucursal_id = ${s.id} and e.tipo = 'cierre' and e.estado in ('pendiente', 'recuento')
    for update of e`;
  if (!e) return { ok: false as const, error: "sin_cierre" as const };
  if (e.version !== version) return { ok: false as const, error: "cambio" as const };
  const cierre = (await cierrePendiente(tx, s.id))!;
  if (cierre.estado === "recuento" && cierre.abreId !== usuarioId) return { ok: false as const, error: "otra_persona" as const };
  return { ok: true as const, sucursalId: s.id, turnoCerrado: e.turno_id, cierre };
}

/** Verificaciones de sobres de un cierre (custodia y apertura), para el caso en «Diferencias de efectivo». */
export { conteoSeparado };
export async function sobresDelCierre(sql: Sql, entregaId: string) {
  const custodia = await sobresDe(sql, entregaId, "custodia");
  const apertura = await sobresDe(sql, entregaId, "apertura");
  return custodia.map((s) => ({ id: s.id, lugar: s.lugar, folio: s.folio, custodia: s.custodia, apertura: apertura.find((a) => a.id === s.id)?.custodia ?? null }));
}

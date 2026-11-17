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

export type ConfiguracionCustodia = { id: string; lugar: string; acceso: Receptor[]; configuradaPor: string; en: Date };

async function configuracionVigente(tx: Tx | Sql, sucursalId: string): Promise<ConfiguracionCustodia | null> {
  const [c] = await tx<{ id: string; lugar: string; acceso: string[]; por: string; en: Date }[]>`
    select c.id, c.lugar, c.acceso::text[] as acceso, u.nombre as por, c.en
    from custodia_configuracion c join usuario u on u.id = c.configurada_por
    where c.sucursal_id = ${sucursalId} order by c.en desc, c.id limit 1`;
  if (!c) return null;
  return { id: c.id, lugar: c.lugar, acceso: await nombres(tx, c.acceso), configuradaPor: c.por, en: c.en };
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
  const filas = await sql<{ id: string; lugar: string; acceso: string[]; por: string; en: Date }[]>`
    select c.id, c.lugar, c.acceso::text[] as acceso, u.nombre as por, c.en
    from custodia_configuracion c join usuario u on u.id = c.configurada_por
    where c.sucursal_id = ${s.id} order by c.en desc, c.id`;
  const historial: ConfiguracionCustodia[] = [];
  for (const c of filas) historial.push({ id: c.id, lugar: c.lugar, acceso: await nombres(sql, c.acceso), configuradaPor: c.por, en: c.en });
  return { sucursal: s.nombre, vigente: historial[0] ?? null, historial, personas: await personasSucursal(sql, s.id) };
}

export async function configurarCustodia(
  sql: Sql, usuarioId: string, codigo: string, datos: { lugar: string; acceso: string[] }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: "no_encontrada" | "sin_permiso" | "lugar" | "acceso" | "bloqueado_produccion" }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!valido(codigo)) return { ok: false, error: "no_encontrada" };
  const lugar = limpiar(datos.lugar);
  if (lugar.length < 5 || lugar.length > 120) return { ok: false, error: "lugar" };
  const acceso = [...new Set(datos.acceso)];
  if (!acceso.length || acceso.length > 10 || !acceso.every(esIdentificadorValido)) return { ok: false, error: "acceso" };
  return sql.begin(async (tx) => {
    const [s] = await tx<{ id: string; puede: boolean; direccion: boolean }[]>`
      select id, tiene_permiso(${usuarioId}, 'custodia.configurar', id) as puede,
             exists (select 1 from perfiles_en_sucursal(${usuarioId}, id) r where r = 'direccion') as direccion
      from sucursal where codigo = ${codigo}`;
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.puede || !s.direccion) return { ok: false as const, error: "sin_permiso" as const };
    const validos = new Set((await personasSucursal(tx, s.id)).map((p) => p.id));
    if (!acceso.every((a) => validos.has(a))) return { ok: false as const, error: "acceso" as const };
    const [c] = await tx<{ id: string }[]>`
      insert into custodia_configuracion (sucursal_id, lugar, acceso, configurada_por)
      values (${s.id}, ${lugar}, ${acceso}::uuid[], ${usuarioId}) returning id`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('custodia_configuracion', ${c.id}, 'configurar', ${tx.json({ sucursal: codigo, lugar, acceso })}, ${usuarioId})`;
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Cierre (Recepción)
// ---------------------------------------------------------------------------------------------------------------

export type ErrorCierre =
  | "no_encontrada" | "sin_permiso" | "sucursal_inactiva" | "sin_turno" | "no_responsable" | "entrega_en_curso"
  | "retiro_en_preparacion" | "cancelaciones_pendientes" | "sin_configuracion" | "sin_preparacion" | "custodio" | "nota"
  | "apoyo" | "cambio" | "bloqueado_produccion";

export type Sobre = { id: string; lugar: TipoLugar; folio: string };

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

async function custodios(tx: Tx | Sql, sucursalId: string, excluir: string): Promise<Receptor[]> {
  return [...(await tx<Receptor[]>`
    select id, nombre from usuario u where activo and id <> ${excluir}
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
      lugares: { tipo: TipoLugar; contadoAlAbrir: string; entradas: string; ajustes: string; retiros: string; esperado: string | null; diferenciaRetiros: string }[];
      bloqueos: { entrega: boolean; retiro: boolean; cancelaciones: number };
      pendientesVisibles: { retirosPorConfirmar: number; diferenciasPorRevisar: number };
      configuracion: ConfiguracionCustodia | null;
      custodios: Receptor[];
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
    const [p] = await tx<{ retiros: number; diferencias: number }[]>`
      select (select count(*)::int from retiro where sucursal_id = ${c.s.id} and estado in ('pendiente', 'recuento', 'por_revisar')) as retiros,
             (select count(*)::int from diferencia_efectivo d join turno x on x.id = d.turno_id
              left join revision_diferencia r on r.diferencia_id = d.id where x.sucursal_id = ${c.s.id} and r.id is null) as diferencias`;
    return {
      ok: true, sucursal: c.s.nombre, turnoId: c.turnoId,
      lugares: t.lugares.map((l) => ({
        tipo: l.tipo, contadoAlAbrir: l.contadoAlAbrir, entradas: l.entradas, ajustes: l.ajustes, retiros: l.retiros, esperado: l.esperado,
        diferenciaRetiros: l.diferenciaRetiros,
      })),
      bloqueos: await bloqueos(tx, c.turnoId),
      pendientesVisibles: { retirosPorConfirmar: p.retiros, diferenciasPorRevisar: p.diferencias },
      configuracion: await configuracionVigente(tx, c.s.id),
      custodios: await custodios(tx, c.s.id, usuarioId),
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
  datos: { turnoId: string; conteo: ConteoLugares; custodio: string; nota: string; apoyo: DeclaracionApoyo },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; entregaId: string; diferenciaEsperado: string | null } | { ok: false; error: ErrorCierre }> {
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
    if (!config) return { ok: false as const, error: "sin_configuracion" as const };
    if (!(await custodios(tx, c.s.id, usuarioId)).some((x) => x.id === datos.custodio)) return { ok: false as const, error: "custodio" as const };
    const sobres = await SOBRES_RESERVADOS(tx, c.turnoId);
    if (sobres.length !== 2) return { ok: false as const, error: "sin_preparacion" as const };

    const t = (await turnoAbiertoDe(tx, c.s.id))!;
    const [e] = await tx<{ id: string }[]>`
      insert into entrega_turno (turno_id, entrega_por, recibe, nota, tipo, custodio_id, custodia_config_id)
      values (${c.turnoId}, ${usuarioId}, null, ${nota || null}, 'cierre', ${datos.custodio}, ${config.id}) returning id`;
    const lugares = await tx<{ id: string; tipo: TipoLugar }[]>`select id, tipo from lugar_efectivo where sucursal_id = ${c.s.id}`;
    let diferenciaEsperado: string | null = null;
    for (const l of lugares) {
      const esperado = l.tipo === "bolsa_visitas" ? t.lugares.find((x) => x.tipo === "bolsa_visitas")!.esperado : null;
      const importe = l.tipo === "bolsa_visitas" ? datos.conteo.bolsa : datos.conteo.cajon;
      if (esperado !== null && cent(importe) !== cent(esperado)) diferenciaEsperado = ((cent(importe) - cent(esperado)) / 100).toFixed(2);
      await tx`insert into entrega_conteo (entrega_id, lugar_id, tipo, importe, esperado, contado_por)
               values (${e.id}, ${l.id}, 'entregado', ${importe}, ${esperado}, ${usuarioId})`;
    }
    if (!(await declararApoyo(tx, c.s.id, e.id, "conteo_entrega", usuarioId, [usuarioId, datos.custodio], datos.apoyo))) {
      throw new ApoyoInvalido();
    }
    for (const s of sobres) {
      await tx`update sobre_cierre set estado = 'usado', entrega_id = ${e.id}, resuelto_en = now() where id = ${s.id}`;
    }
    await tx`update responsable_lugar set hasta = now() where turno_id = ${c.turnoId} and hasta is null`;
    await tx`update turno set cerrado_en = now() where id = ${c.turnoId}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrega_turno', ${e.id}, 'cerrar',
                     ${tx.json({ sucursal: codigo, turno: c.turnoId, custodio: datos.custodio, custodia: config.id,
                                 bolsa_visitas: datos.conteo.bolsa, cajon_mensualidades: datos.conteo.cajon,
                                 sobres: sobres.map((s) => s.folio), diferencia_contra_esperado: diferenciaEsperado })},
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
  configuracion: { lugar: string; acceso: Receptor[] };
  sobres: (Sobre & { custodia: Verificacion | null })[];
  /** Quien empezó a abrir (en recuento). */
  abre: string | null; abreId: string | null;
};
export type Verificacion = { estado: "correcto" | "falta" | "abierto" | "otro_folio"; folioVisto: string | null; motivo: string | null; por: string; en: Date };

/** Cierre de la sucursal pendiente de apertura, si lo hay. */
export async function cierrePendiente(tx: Tx | Sql, sucursalId: string): Promise<CierrePendiente | null> {
  const [e] = await tx<{ id: string; version: number; estado: "pendiente" | "recuento"; cerro: string; cerro_id: string; en: Date;
                          custodio: string; custodio_id: string; lugar: string; acceso: string[]; abre: string | null; abre_id: string | null;
                          ubicacion: string | null; confirmada_en: Date | null }[]>`
    select e.id, e.version, e.estado, a.nombre as cerro, a.id as cerro_id, e.creada_en as en, c.nombre as custodio, c.id as custodio_id,
           k.lugar, k.acceso::text[] as acceso, b.nombre as abre, b.id as abre_id, x.ubicacion, x.confirmada_en
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
    configuracion: { lugar: e.lugar, acceso: await nombres(tx, e.acceso) },
    sobres: await sobresDe(tx, e.id, "custodia"),
    abre: e.abre, abreId: e.abre_id,
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

/** Cierres de la sucursal cuyo custodio es esta cuenta y aún no confirma la custodia. null si no confirma custodias ahí. */
export async function custodiasPorConfirmar(sql: Sql, usuarioId: string, codigo: string): Promise<{ sucursal: string; sucursalId: string; cierre: CierrePendiente | null } | null> {
  if (!valido(codigo)) return null;
  const [s] = await sql<{ id: string; nombre: string }[]>`
    select id, nombre from sucursal where codigo = ${codigo} and tiene_permiso(${usuarioId}, 'custodia.confirmar', id)`;
  if (!s) return null;
  const c = await cierrePendiente(sql, s.id);
  return { sucursal: s.nombre, sucursalId: s.id, cierre: c && c.custodioId === usuarioId && !c.custodia ? c : null };
}

export type VerificacionDatos = { sobreId: string; estado: string; folioVisto: string; motivo: string };
export type ErrorVerificacion = "sobres" | "estado" | "folio_visto" | "motivo";

/** Valida la verificación de cada sobre (sello y folio): «correcto» o una incidencia con motivo. */
function leerVerificaciones(sobres: Sobre[], datos: VerificacionDatos[]):
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
  datos: { entregaId: string; ubicacion: string; sobres: VerificacionDatos[] },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; incidencias: number } | { ok: false; error: "no_encontrada" | "ya_confirmada" | "ya_abierto" | "ubicacion" | ErrorVerificacion | "bloqueado_produccion"; sobreId?: string }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!valido(codigo) || !esIdentificadorValido(datos.entregaId)) return { ok: false, error: "no_encontrada" };
  const ubicacion = limpiar(datos.ubicacion);
  if (ubicacion.length < 5 || ubicacion.length > 120) return { ok: false, error: "ubicacion" };
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: string; estado: string; custodio_id: string; sucursal_id: string; recibe: string | null }[]>`
      select e.id, e.estado, e.custodio_id, t.sucursal_id, e.recibe
      from entrega_turno e join turno t on t.id = e.turno_id join sucursal s on s.id = t.sucursal_id
      where e.id = ${datos.entregaId} and e.tipo = 'cierre' and s.codigo = ${codigo} for update of e`;
    if (!e || e.custodio_id !== usuarioId) return { ok: false as const, error: "no_encontrada" as const };
    const [{ puede }] = await tx<{ puede: boolean }[]>`select tiene_permiso(${usuarioId}, 'custodia.confirmar', ${e.sucursal_id}) as puede`;
    if (!puede) return { ok: false as const, error: "no_encontrada" as const };
    if ((await tx`select 1 from custodia_cierre where entrega_id = ${e.id}`).length) return { ok: false as const, error: "ya_confirmada" as const };
    if (e.estado !== "pendiente" || e.recibe) return { ok: false as const, error: "ya_abierto" as const };
    const sobres = (await sobresDe(tx, e.id, "custodia")).map((s) => ({ id: s.id, lugar: s.lugar, folio: s.folio }));
    const v = leerVerificaciones(sobres, datos.sobres);
    if (!v.ok) return v;
    for (const f of v.filas) {
      await tx`insert into verificacion_sobre (sobre_id, momento, estado, folio_visto, motivo, verificado_por)
               values (${f.sobreId}, 'custodia', ${f.estado}, ${f.folioVisto}, ${f.motivo}, ${usuarioId})`;
    }
    await tx`insert into custodia_cierre (entrega_id, custodio_id, ubicacion) values (${e.id}, ${usuarioId}, ${ubicacion})`;
    const incidencias = v.filas.filter((f) => f.estado !== "correcto").length;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrega_turno', ${e.id}, 'confirmar_custodia', ${tx.json({ ubicacion, sobres: v.filas, incidencias })}, ${usuarioId})`;
    return { ok: true as const, incidencias };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Apertura desde el cierre
// ---------------------------------------------------------------------------------------------------------------

export type ErrorApertura =
  | "no_encontrada" | "sin_permiso" | "sucursal_inactiva" | "sin_cierre" | "otra_persona" | "cambio" | "motivo" | "apoyo"
  | ErrorVerificacion | "bloqueado_produccion";

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
      recuento: { cerrado: ConteoLugares; inicial: ConteoLugares; verificacion: (Sobre & { apertura: Verificacion | null })[] } | null;
      apoyos: Receptor[];
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
      const ap = await sobresDe(tx, c.entregaId, "apertura");
      recuento = {
        cerrado: porLugar(filas, "entregado"), inicial: porLugar(filas, "recibido_inicial"),
        verificacion: ap.map((x) => ({ id: x.id, lugar: x.lugar, folio: x.folio, apertura: x.custodia })),
      };
    }
    return { ok: true, sucursal: s.nombre, cierre: c, recuento, apoyos: await candidatosApoyo(tx, s.id, [usuarioId, c.custodioId]) };
  });
}

/**
 * Primer paso de la apertura: quien abre verifica sello y folio de cada sobre y captura su conteo a ciegas. Si
 * coincide con lo cerrado en ambos lugares, el turno abre con eso. Si no, queda en recuento.
 */
export async function abrirDesdeCierre(
  sql: Sql, usuarioId: string, codigo: string,
  datos: { entregaId: string; version: number; sobres: VerificacionDatos[]; conteo: ConteoLugares; apoyo: DeclaracionApoyo },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; resultado: "abierto"; turnoId: string } | { ok: true; resultado: "recuento" } | { ok: false; error: ErrorApertura; sobreId?: string }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.entregaId)) return { ok: false, error: "sin_cierre" };
  if (!apoyoValido(datos.apoyo)) return { ok: false, error: "apoyo" };
  return conApoyo(() => sql.begin(async (tx) => {
    const c = await contextoApertura(tx, usuarioId, codigo, datos.entregaId, datos.version);
    if (!c.ok) return c;
    if (c.cierre.estado !== "pendiente") return { ok: false as const, error: "cambio" as const };
    const sobres = c.cierre.sobres.map((s) => ({ id: s.id, lugar: s.lugar, folio: s.folio }));
    const v = leerVerificaciones(sobres, datos.sobres);
    if (!v.ok) return v;
    // Quien abre queda registrada como quien recibe el cierre (puede ser la misma persona que cerró).
    await tx`update entrega_turno set recibe = ${usuarioId}, version = version + 1 where id = ${c.cierre.entregaId}`;
    for (const f of v.filas) {
      await tx`insert into verificacion_sobre (sobre_id, momento, estado, folio_visto, motivo, verificado_por)
               values (${f.sobreId}, 'apertura', ${f.estado}, ${f.folioVisto}, ${f.motivo}, ${usuarioId})`;
    }
    const lugares = await tx<{ id: string; tipo: TipoLugar }[]>`select id, tipo from lugar_efectivo where sucursal_id = ${c.sucursalId}`;
    for (const l of lugares) {
      await tx`insert into entrega_conteo (entrega_id, lugar_id, tipo, importe, contado_por)
               values (${c.cierre.entregaId}, ${l.id}, 'recibido_inicial', ${l.tipo === "bolsa_visitas" ? datos.conteo.bolsa : datos.conteo.cajon}, ${usuarioId})`;
    }
    if (!(await declararApoyo(tx, c.sucursalId, c.cierre.entregaId, "conteo_recepcion", usuarioId, [usuarioId, c.cierre.custodioId], datos.apoyo))) {
      throw new ApoyoInvalido();
    }
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrega_turno', ${c.cierre.entregaId}, 'abrir_conteo',
                     ${tx.json({ sobres: v.filas, bolsa_visitas: datos.conteo.bolsa, cajon_mensualidades: datos.conteo.cajon, misma_persona: usuarioId === c.cierre.cerradoPorId })},
                     ${usuarioId})`;
    const cerrado = porLugar(await CONTEOS(tx, c.cierre.entregaId), "entregado");
    if (cent(cerrado.bolsa) === cent(datos.conteo.bolsa) && cent(cerrado.cajon) === cent(datos.conteo.cajon)) {
      const turnoId = await confirmarEntregaTx(tx, {
        entregaId: c.cierre.entregaId, turnoId: c.turnoCerrado, sucursalId: c.sucursalId, usuarioId, final: datos.conteo,
        aclaracion: null, cerrarTurno: false,
      });
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
  datos: { entregaId: string; version: number; recontaron: boolean; conteo: ConteoLugares | null; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; turnoId: string } | { ok: false; error: ErrorApertura }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.entregaId)) return { ok: false, error: "sin_cierre" };
  const motivo = limpiar(datos.motivo);
  if (!datos.recontaron && (motivo.length < 5 || motivo.length > 300)) return { ok: false, error: "motivo" };
  if (datos.recontaron && motivo && (motivo.length < 5 || motivo.length > 300)) return { ok: false, error: "motivo" };
  if (datos.recontaron && !datos.conteo) return { ok: false, error: "cambio" };
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
    return { ok: true as const, turnoId };
  });
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
export async function sobresDelCierre(sql: Sql, entregaId: string) {
  const custodia = await sobresDe(sql, entregaId, "custodia");
  const apertura = await sobresDe(sql, entregaId, "apertura");
  return custodia.map((s) => ({ id: s.id, lugar: s.lugar, folio: s.folio, custodia: s.custodia, apertura: apertura.find((a) => a.id === s.id)?.custodia ?? null }));
}

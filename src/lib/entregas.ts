import type postgres from "postgres";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";
import { turnoAbiertoDe, type TipoLugar } from "@/lib/turnos";

/**
 * Bloque 5, primer paso: cambio de turno con confirmación de quien recibe (solo datos ficticios).
 * Reglas aprobadas el 11 nov 2026 para el piloto de Tenango:
 *
 * - Variante A: la misma recepcionista responde por la bolsa y el cajón, con conteos separados. Entrega la
 *   responsable vigente de ambos lugares (turno.entregar) a otra recepcionista con turno.recibir en la sucursal.
 * - La entrante captura su conteo SIN ver el de la saliente (el servidor no se lo envía mientras esté pendiente).
 *   Si coincide en ambos lugares, la entrega se confirma. Si no, queda «recuento»: ya ve ambos conteos, recuentan
 *   juntas y confirma un importe con una aclaración. Se conservan los conteos originales y la aclaración.
 * - Al confirmar se registran por separado la diferencia contra el esperado (bolsa: entregado − esperado) y la
 *   diferencia entre ambas personas (confirmado − entregado). Quedan «por revisar» (la revisión es el paso 2).
 * - Al confirmar, en una transacción: se cierra el turno de la saliente y se abre el de la entrante, que empieza
 *   con el importe que ella confirmó en cada lugar.
 * - Mientras la entrega está en curso no se registran cobros ni solicitudes de cancelación en el turno. No se
 *   entrega con solicitudes de cancelación pendientes (se resuelven solo con el turno abierto).
 * - La saliente puede cancelar la entrega antes de la confirmación, con motivo. Nada se borra.
 * - No se entrega ni se recibe en una sucursal inactiva ni en producción.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type ConteoLugares = { bolsa: string; cajon: string };
/** Apoyo en un conteo: «nadie más participó» o las personas de la sucursal que ayudaron (cada una confirma después). */
export type DeclaracionApoyo = { hubo: false } | { hubo: true; personas: string[] };
export type EtapaApoyo = "conteo_entrega" | "conteo_recepcion" | "recuento";
export type Receptor = { id: string; nombre: string };

export type EntregaEnCurso = {
  id: string;
  estado: "pendiente" | "recuento";
  version: number;
  entregaPor: string;
  entregaPorId: string;
  recibe: string;
  recibeId: string;
  creadaEn: Date;
};

export type ErrorEntrega =
  | "no_encontrada"
  | "sin_permiso"
  | "sucursal_inactiva"
  | "sin_turno"
  | "no_responsable"
  | "entrega_en_curso"
  | "cancelaciones_pendientes"
  | "receptor"
  | "nota"
  | "motivo"
  | "aclaracion"
  | "apoyo"
  | "cambio"
  | "bloqueado_produccion";

const valido = (codigo: string) => /^[A-Z0-9]{2,5}$/.test(codigo);

async function sucursalDe(tx: Tx | Sql, usuarioId: string, codigo: string) {
  if (!valido(codigo)) return null;
  const [s] = await tx<{ id: string; nombre: string; inactiva: boolean; entrega: boolean; recibe: boolean }[]>`
    select id, nombre, estado_operativo = 'inactiva' as inactiva,
           tiene_permiso(${usuarioId}, 'turno.entregar', id) as entrega,
           tiene_permiso(${usuarioId}, 'turno.recibir', id) as recibe
    from sucursal
    where codigo = ${codigo}
      and (tiene_permiso(${usuarioId}, 'turno.consultar', id) or tiene_permiso(${usuarioId}, 'turno.entregar', id)
           or tiene_permiso(${usuarioId}, 'turno.recibir', id))`;
  return s ?? null;
}

const ENTREGA_EN_CURSO = (tx: Tx | Sql, turnoId: string) => tx<EntregaEnCurso[]>`
  select e.id, e.estado, e.version, e.creada_en as "creadaEn",
         a.nombre as "entregaPor", a.id as "entregaPorId", b.nombre as recibe, b.id as "recibeId"
  from entrega_turno e join usuario a on a.id = e.entrega_por join usuario b on b.id = e.recibe
  where e.turno_id = ${turnoId} and e.estado in ('pendiente', 'recuento')`;

/** Entrega en curso del turno, si la hay (para mostrar su estado en la pantalla del turno). */
export async function entregaEnCurso(sql: Sql, turnoId: string): Promise<EntregaEnCurso | null> {
  const [e] = await ENTREGA_EN_CURSO(sql, turnoId);
  return e ?? null;
}

/** Recepcionistas que pueden recibir en la sucursal (turno.recibir), sin contar a quien entrega. */
async function receptores(tx: Tx | Sql, sucursalId: string, usuarioId: string): Promise<Receptor[]> {
  return [...(await tx<Receptor[]>`
    select id, nombre from usuario
    where activo and id <> ${usuarioId} and tiene_permiso(id, 'turno.recibir', ${sucursalId})
    order by nombre`)];
}

/**
 * Personas de la sucursal que pueden declararse como apoyo en un conteo: cuentas activas con algún perfil en la
 * sucursal, sin quien entrega ni quien recibe (ellas ya participan).
 */
async function candidatosApoyo(tx: Tx | Sql, sucursalId: string, excluir: string[]): Promise<Receptor[]> {
  return [...(await tx<Receptor[]>`
    select id, nombre from usuario u
    where activo and not (id = any(${excluir}::uuid[]))
      and exists (select 1 from perfiles_en_sucursal(u.id, ${sucursalId}))
    order by nombre`)];
}

/** Valida y guarda la declaración de apoyo de una etapa. La base respalda que cada apoyo sea de la sucursal. */
async function declararApoyo(
  tx: Tx, sucursalId: string, entregaId: string, etapa: EtapaApoyo, declaradoPor: string, excluir: string[], apoyo: DeclaracionApoyo,
): Promise<boolean> {
  const personas = apoyo.hubo ? [...new Set(apoyo.personas)] : [];
  if (apoyo.hubo) {
    if (!personas.length || personas.length > 10 || !personas.every(esIdentificadorValido)) return false;
    const validos = new Set((await candidatosApoyo(tx, sucursalId, excluir)).map((c) => c.id));
    if (!personas.every((p) => validos.has(p))) return false;
  }
  const [d] = await tx<{ id: string }[]>`
    insert into declaracion_apoyo (entrega_id, etapa, hubo_apoyo, declarado_por)
    values (${entregaId}, ${etapa}, ${apoyo.hubo}, ${declaradoPor}) returning id`;
  for (const p of personas) {
    await tx`insert into apoyo_conteo (declaracion_id, entrega_id, etapa, usuario_id, declarado_por)
             values (${d.id}, ${entregaId}, ${etapa}, ${p}, ${declaradoPor})`;
  }
  await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
           values ('entrega_turno', ${entregaId}, 'declarar_apoyo', ${tx.json({ etapa, hubo_apoyo: apoyo.hubo, personas })}, ${declaradoPor})`;
  return true;
}
const apoyoValido = (a: DeclaracionApoyo | undefined): a is DeclaracionApoyo =>
  !!a && (a.hubo === false || (a.hubo === true && Array.isArray(a.personas)));

/** Turno abierto y comprobación de que quien entrega es la responsable vigente de ambos lugares (variante A). */
async function contextoEntrega(tx: Tx, usuarioId: string, codigo: string, bloquear: boolean) {
  const s = await sucursalDe(tx, usuarioId, codigo);
  if (!s) return { ok: false as const, error: "no_encontrada" as const };
  if (!s.entrega) return { ok: false as const, error: "sin_permiso" as const };
  if (s.inactiva) return { ok: false as const, error: "sucursal_inactiva" as const };
  const [t] = bloquear
    ? await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null for update`
    : await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null`;
  if (!t) return { ok: false as const, error: "sin_turno" as const };
  const responsables = await tx<{ usuario_id: string }[]>`
    select usuario_id from responsable_lugar where turno_id = ${t.id} and hasta is null`;
  if (responsables.length !== 2 || responsables.some((r) => r.usuario_id !== usuarioId)) {
    return { ok: false as const, error: "no_responsable" as const };
  }
  return { ok: true as const, s, turnoId: t.id };
}

export type PantallaEntrega =
  | {
      ok: true;
      sucursal: string;
      turnoId: string;
      esperadoBolsa: string;
      contadoAlAbrir: ConteoLugares;
      receptores: Receptor[];
      /** Personas de la sucursal que pueden declararse como apoyo (sin quien entrega; quien recibe se excluye al guardar). */
      apoyos: Receptor[];
      enCurso: EntregaEnCurso | null;
      cancelacionesPendientes: number;
    }
  | { ok: false; error: ErrorEntrega };

export async function pantallaEntrega(sql: Sql, usuarioId: string, codigo: string, entorno: Entorno): Promise<PantallaEntrega> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  return sql.begin("read only", async (tx): Promise<PantallaEntrega> => {
    const c = await contextoEntrega(tx, usuarioId, codigo, false);
    if (!c.ok) return c;
    const t = (await turnoAbiertoDe(tx, c.s.id))!;
    const bolsa = t.lugares.find((l) => l.tipo === "bolsa_visitas")!;
    const cajon = t.lugares.find((l) => l.tipo === "cajon_mensualidades")!;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from cancelacion_cobro k join cobro_visita cv on cv.id = k.cobro_id
      join operacion_visita o on o.id = cv.operacion_id where o.turno_id = ${c.turnoId} and k.estado = 'solicitada'`;
    const [enCurso] = await ENTREGA_EN_CURSO(tx, c.turnoId);
    return {
      ok: true, sucursal: c.s.nombre, turnoId: c.turnoId, esperadoBolsa: bolsa.esperado!,
      contadoAlAbrir: { bolsa: bolsa.contadoAlAbrir, cajon: cajon.contadoAlAbrir },
      receptores: await receptores(tx, c.s.id, usuarioId), apoyos: await candidatosApoyo(tx, c.s.id, [usuarioId]),
      enCurso: enCurso ?? null, cancelacionesPendientes: n,
    };
  });
}

/** La saliente registra lo que cuenta y entrega en cada lugar, y a quién. La entrega queda pendiente. */
export async function registrarEntrega(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { turnoId: string; conteo: ConteoLugares; recibe: string; nota: string; apoyo: DeclaracionApoyo },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; entregaId: string } | { ok: false; error: ErrorEntrega }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const nota = datos.nota.trim();
  if (nota && (nota.length < 5 || nota.length > 300)) return { ok: false, error: "nota" };
  if (!esIdentificadorValido(datos.recibe) || !esIdentificadorValido(datos.turnoId)) return { ok: false, error: "receptor" };
  if (!apoyoValido(datos.apoyo)) return { ok: false, error: "apoyo" };
  return conApoyo(() => sql.begin(async (tx) => {
    // El turno se bloquea igual que al cobrar: un cobro y una entrega no se cruzan.
    const c = await contextoEntrega(tx, usuarioId, codigo, true);
    if (!c.ok) return c;
    if (c.turnoId !== datos.turnoId) return { ok: false as const, error: "cambio" as const };
    if ((await ENTREGA_EN_CURSO(tx, c.turnoId)).length) return { ok: false as const, error: "entrega_en_curso" as const };
    const pendientes = await tx`
      select 1 from cancelacion_cobro k join cobro_visita cv on cv.id = k.cobro_id
      join operacion_visita o on o.id = cv.operacion_id where o.turno_id = ${c.turnoId} and k.estado = 'solicitada'`;
    if (pendientes.length) return { ok: false as const, error: "cancelaciones_pendientes" as const };
    if (!(await receptores(tx, c.s.id, usuarioId)).some((r) => r.id === datos.recibe)) {
      return { ok: false as const, error: "receptor" as const };
    }

    const t = (await turnoAbiertoDe(tx, c.s.id))!;
    const [e] = await tx<{ id: string }[]>`
      insert into entrega_turno (turno_id, entrega_por, recibe, nota)
      values (${c.turnoId}, ${usuarioId}, ${datos.recibe}, ${nota || null}) returning id`;
    const lugares = await tx<{ id: string; tipo: TipoLugar }[]>`select id, tipo from lugar_efectivo where sucursal_id = ${c.s.id}`;
    for (const l of lugares) {
      const esperado = l.tipo === "bolsa_visitas" ? t.lugares.find((x) => x.tipo === "bolsa_visitas")!.esperado : null;
      await tx`
        insert into entrega_conteo (entrega_id, lugar_id, tipo, importe, esperado, contado_por)
        values (${e.id}, ${l.id}, 'entregado', ${l.tipo === "bolsa_visitas" ? datos.conteo.bolsa : datos.conteo.cajon}, ${esperado}, ${usuarioId})`;
    }
    if (!(await declararApoyo(tx, c.s.id, e.id, "conteo_entrega", usuarioId, [usuarioId, datos.recibe], datos.apoyo))) {
      throw new ApoyoInvalido();
    }
    await tx`
      insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
      values ('entrega_turno', ${e.id}, 'entregar',
              ${tx.json({ sucursal: codigo, turno: c.turnoId, recibe: datos.recibe, bolsa_visitas: datos.conteo.bolsa, cajon_mensualidades: datos.conteo.cajon })},
              ${usuarioId})`;
    return { ok: true as const, entregaId: e.id };
  }));
}

/** Una declaración de apoyo inválida deshace toda la operación (no queda la entrega ni el conteo a medias). */
class ApoyoInvalido extends Error {}
async function conApoyo<T>(f: () => Promise<T>): Promise<T | { ok: false; error: "apoyo" }> {
  try {
    return await f();
  } catch (error) {
    if (error instanceof ApoyoInvalido) return { ok: false, error: "apoyo" };
    throw error;
  }
}

/** La saliente cancela una entrega en curso (por ejemplo, eligió a otra persona). Queda en el historial. */
export async function cancelarEntrega(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { entregaId: string; version: number; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorEntrega }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const motivo = datos.motivo.trim();
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  if (!esIdentificadorValido(datos.entregaId)) return { ok: false, error: "no_encontrada" };
  return sql.begin(async (tx) => {
    const c = await contextoEntrega(tx, usuarioId, codigo, true);
    if (!c.ok) return c;
    const [e] = await tx<{ id: string; version: number; estado: string; entrega_por: string }[]>`
      select id, version, estado, entrega_por from entrega_turno where id = ${datos.entregaId} and turno_id = ${c.turnoId} for update`;
    if (!e || e.entrega_por !== usuarioId) return { ok: false as const, error: "no_encontrada" as const };
    if (!["pendiente", "recuento"].includes(e.estado) || e.version !== datos.version) return { ok: false as const, error: "cambio" as const };
    await tx`update entrega_turno set estado = 'cancelada', motivo_cancelacion = ${motivo}, resuelta_en = now(), version = version + 1
             where id = ${e.id}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, motivo, usuario_id)
             values ('entrega_turno', ${e.id}, 'cancelar', ${motivo}, ${usuarioId})`;
    return { ok: true as const };
  });
}

type FilaConteo = { lugar: TipoLugar; tipo: "entregado" | "recibido_inicial" | "recibido_final"; importe: string; esperado: string | null };

const CONTEOS = (tx: Tx | Sql, entregaId: string) => tx<FilaConteo[]>`
  select l.tipo as lugar, c.tipo, c.importe::text as importe, c.esperado::text as esperado
  from entrega_conteo c join lugar_efectivo l on l.id = c.lugar_id where c.entrega_id = ${entregaId}`;

export type PantallaRecepcion =
  | {
      ok: true;
      sucursal: string;
      entrega: EntregaEnCurso;
      /** Solo en «recuento»: lo que entregó la saliente y tu primer conteo. En «pendiente» no se envían. */
      recuento: { entregado: ConteoLugares; inicial: ConteoLugares } | null;
      /** Personas de la sucursal que pueden declararse como apoyo (sin quien entrega ni quien recibe). */
      apoyos: Receptor[];
    }
  | { ok: false; error: ErrorEntrega | "sin_entrega" };

const porLugar = (filas: FilaConteo[], tipo: FilaConteo["tipo"]): ConteoLugares => ({
  bolsa: filas.find((f) => f.tipo === tipo && f.lugar === "bolsa_visitas")!.importe,
  cajon: filas.find((f) => f.tipo === tipo && f.lugar === "cajon_mensualidades")!.importe,
});

async function contextoRecepcion(tx: Tx, usuarioId: string, codigo: string, bloquear: boolean) {
  const s = await sucursalDe(tx, usuarioId, codigo);
  if (!s) return { ok: false as const, error: "no_encontrada" as const };
  if (!s.recibe) return { ok: false as const, error: "sin_permiso" as const };
  if (s.inactiva) return { ok: false as const, error: "sucursal_inactiva" as const };
  const [t] = bloquear
    ? await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null for update`
    : await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null`;
  if (!t) return { ok: false as const, error: "sin_turno" as const };
  const [e] = await ENTREGA_EN_CURSO(tx, t.id);
  if (!e || e.recibeId !== usuarioId) return { ok: false as const, error: "sin_entrega" as const };
  return { ok: true as const, s, turnoId: t.id, e };
}

export async function pantallaRecepcion(sql: Sql, usuarioId: string, codigo: string, entorno: Entorno): Promise<PantallaRecepcion> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  return sql.begin("read only", async (tx): Promise<PantallaRecepcion> => {
    const c = await contextoRecepcion(tx, usuarioId, codigo, false);
    if (!c.ok) return c;
    let recuento = null;
    if (c.e.estado === "recuento") {
      const filas = await CONTEOS(tx, c.e.id);
      recuento = { entregado: porLugar(filas, "entregado"), inicial: porLugar(filas, "recibido_inicial") };
    }
    return { ok: true, sucursal: c.s.nombre, entrega: c.e, recuento, apoyos: await candidatosApoyo(tx, c.s.id, [c.e.entregaPorId, c.e.recibeId]) };
  });
}

export type ResultadoRecepcion =
  | { ok: true; resultado: "confirmada"; turnoId: string }
  | { ok: true; resultado: "recuento" }
  | { ok: false; error: ErrorEntrega | "sin_entrega" };

/**
 * La entrante confirma lo que recibe. Primer envío (pendiente): su conteo inicial; si coincide en ambos lugares,
 * se confirma. Si no, queda en recuento. Segundo envío (recuento): el importe que confirma tras recontar, con
 * aclaración obligatoria; se confirma aunque persista el desacuerdo (queda por revisar).
 */
export async function recibirTurno(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { entregaId: string; version: number; conteo: ConteoLugares; aclaracion: string; apoyo: DeclaracionApoyo },
  { entorno }: { entorno: Entorno },
): Promise<ResultadoRecepcion> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.entregaId)) return { ok: false, error: "sin_entrega" };
  const aclaracion = datos.aclaracion.trim();
  if (!apoyoValido(datos.apoyo)) return { ok: false, error: "apoyo" };
  return conApoyo(() => sql.begin(async (tx): Promise<ResultadoRecepcion> => {
    const c = await contextoRecepcion(tx, usuarioId, codigo, true);
    if (!c.ok) return c;
    if (c.e.id !== datos.entregaId || c.e.version !== datos.version) return { ok: false, error: "cambio" };
    const lugares = await tx<{ id: string; tipo: TipoLugar }[]>`select id, tipo from lugar_efectivo where sucursal_id = ${c.s.id}`;
    const importe = (tipo: TipoLugar) => (tipo === "bolsa_visitas" ? datos.conteo.bolsa : datos.conteo.cajon);
    const filas = await CONTEOS(tx, c.e.id);
    const entregado = porLugar(filas, "entregado");

    // La declaración de apoyo de esta etapa: el primer conteo de la entrante o el recuento.
    const etapa: EtapaApoyo = c.e.estado === "pendiente" ? "conteo_recepcion" : "recuento";
    if (etapa === "recuento" && (aclaracion.length < 5 || aclaracion.length > 300)) return { ok: false, error: "aclaracion" };
    if (!(await declararApoyo(tx, c.s.id, c.e.id, etapa, usuarioId, [c.e.entregaPorId, c.e.recibeId], datos.apoyo))) {
      throw new ApoyoInvalido();
    }

    if (c.e.estado === "pendiente") {
      for (const l of lugares) {
        await tx`insert into entrega_conteo (entrega_id, lugar_id, tipo, importe, contado_por)
                 values (${c.e.id}, ${l.id}, 'recibido_inicial', ${importe(l.tipo)}, ${usuarioId})`;
      }
      const coincide = Number(entregado.bolsa) === Number(datos.conteo.bolsa) && Number(entregado.cajon) === Number(datos.conteo.cajon);
      if (!coincide) {
        await tx`update entrega_turno set estado = 'recuento', version = version + 1 where id = ${c.e.id}`;
        await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
                 values ('entrega_turno', ${c.e.id}, 'conteo_no_coincide',
                         ${tx.json({ bolsa_visitas: datos.conteo.bolsa, cajon_mensualidades: datos.conteo.cajon })}, ${usuarioId})`;
        return { ok: true, resultado: "recuento" };
      }
    }

    // Confirmación: conteo final, diferencias, cierre del turno de origen y apertura del de la entrante.
    for (const l of lugares) {
      await tx`insert into entrega_conteo (entrega_id, lugar_id, tipo, importe, contado_por)
               values (${c.e.id}, ${l.id}, 'recibido_final', ${importe(l.tipo)}, ${usuarioId})`;
    }
    const cent = (v: string) => Math.round(Number(v) * 100);
    const bolsaEntregada = filas.find((f) => f.tipo === "entregado" && f.lugar === "bolsa_visitas")!;
    for (const l of lugares) {
      const dEsperado = l.tipo === "bolsa_visitas" ? cent(bolsaEntregada.importe) - cent(bolsaEntregada.esperado!) : 0;
      const dPersonas = cent(importe(l.tipo)) - cent(l.tipo === "bolsa_visitas" ? entregado.bolsa : entregado.cajon);
      if (dEsperado) {
        await tx`insert into diferencia_efectivo (entrega_id, turno_id, lugar_id, tipo, importe)
                 values (${c.e.id}, ${c.turnoId}, ${l.id}, 'contra_esperado', ${(dEsperado / 100).toFixed(2)})`;
      }
      if (dPersonas) {
        await tx`insert into diferencia_efectivo (entrega_id, turno_id, lugar_id, tipo, importe)
                 values (${c.e.id}, ${c.turnoId}, ${l.id}, 'entre_personas', ${(dPersonas / 100).toFixed(2)})`;
      }
    }
    await tx`update responsable_lugar set hasta = now() where turno_id = ${c.turnoId} and hasta is null`;
    await tx`update turno set cerrado_en = now() where id = ${c.turnoId}`;
    const [nuevo] = await tx<{ id: string }[]>`
      insert into turno (sucursal_id, abierto_por, recibido_de) values (${c.s.id}, ${usuarioId}, ${c.e.id}) returning id`;
    for (const l of lugares) {
      await tx`insert into responsable_lugar (lugar_id, turno_id, usuario_id) values (${l.id}, ${nuevo.id}, ${usuarioId})`;
      await tx`insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por)
               values (${nuevo.id}, ${l.id}, 'apertura', ${importe(l.tipo)}, ${usuarioId})`;
    }
    await tx`update entrega_turno set estado = 'confirmada', turno_nuevo_id = ${nuevo.id}, resuelta_en = now(),
             aclaracion = ${c.e.estado === "recuento" ? aclaracion : null}, version = version + 1 where id = ${c.e.id}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrega_turno', ${c.e.id}, 'confirmar',
                     ${tx.json({ turno_nuevo: nuevo.id, bolsa_visitas: datos.conteo.bolsa, cajon_mensualidades: datos.conteo.cajon })}, ${usuarioId})`;
    return { ok: true, resultado: "confirmada", turnoId: nuevo.id };
  }));
}

export type DiferenciaEntrega = {
  lugar: TipoLugar; tipo: "contra_esperado" | "entre_personas"; importe: string;
  /** «por_revisar» o el resultado de su revisión (bloque 5, paso 2). */
  estado: "por_revisar" | "aclarada" | "faltante_confirmado" | "sobrante_confirmado" | "correccion_pendiente" | "resuelta";
};

export type EntregaRecibida = {
  entregaPor: string;
  recibe: string;
  creadaEn: Date;
  confirmadaEn: Date;
  nota: string | null;
  aclaracion: string | null;
  esperadoBolsa: string;
  entregado: ConteoLugares;
  inicial: ConteoLugares;
  confirmado: ConteoLugares;
  diferencias: DiferenciaEntrega[];
};

/** Cómo quedó registrada la entrega de la que salió un turno (para mostrarla en el turno de la entrante). */
export async function entregaRecibida(sql: Sql, turnoId: string): Promise<EntregaRecibida | null> {
  const [e] = await sql<{ id: string; entrega_por: string; recibe: string; creada_en: Date; resuelta_en: Date; nota: string | null; aclaracion: string | null }[]>`
    select e.id, a.nombre as entrega_por, b.nombre as recibe, e.creada_en, e.resuelta_en, e.nota, e.aclaracion
    from turno t join entrega_turno e on e.id = t.recibido_de
    join usuario a on a.id = e.entrega_por join usuario b on b.id = e.recibe
    where t.id = ${turnoId}`;
  if (!e) return null;
  const filas = await CONTEOS(sql, e.id);
  const diferencias = await sql<DiferenciaEntrega[]>`
    select l.tipo as lugar, d.tipo, d.importe::text as importe, case when r.id is null then 'por_revisar'
                when x.id is null then r.resultado
                when x.requiere_correccion and x.correccion is null then 'correccion_pendiente'
                else 'resuelta' end as estado
    from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id
    left join revision_diferencia r on r.diferencia_id = d.id
    left join resolucion_diferencia x on x.diferencia_id = d.id where d.entrega_id = ${e.id}
    order by case l.tipo when 'bolsa_visitas' then 0 else 1 end, d.tipo`;
  return {
    entregaPor: e.entrega_por, recibe: e.recibe, creadaEn: e.creada_en, confirmadaEn: e.resuelta_en, nota: e.nota,
    aclaracion: e.aclaracion,
    esperadoBolsa: filas.find((f) => f.tipo === "entregado" && f.lugar === "bolsa_visitas")!.esperado!,
    entregado: porLugar(filas, "entregado"), inicial: porLugar(filas, "recibido_inicial"), confirmado: porLugar(filas, "recibido_final"),
    diferencias: [...diferencias],
  };
}

export type ApoyoPendiente = {
  id: string; etapa: EtapaApoyo; declaradoPor: string; declaradoEn: Date; entregaPor: string; recibe: string; entregadaEn: Date;
};

/** Apoyos en los que la cuenta fue declarada en esta sucursal y que todavía no confirma. */
export async function apoyosPorConfirmar(sql: Sql, usuarioId: string, codigo: string): Promise<{ sucursal: string; pendientes: ApoyoPendiente[] } | null> {
  if (!valido(codigo)) return null;
  const [s] = await sql<{ id: string; nombre: string }[]>`
    select id, nombre from sucursal s where codigo = ${codigo} and exists (select 1 from perfiles_en_sucursal(${usuarioId}, s.id))`;
  if (!s) return null;
  const pendientes = await sql<ApoyoPendiente[]>`
    select a.id, a.etapa, d.nombre as "declaradoPor", a.declarado_en as "declaradoEn", x.nombre as "entregaPor", y.nombre as recibe,
           e.creada_en as "entregadaEn"
    from apoyo_conteo a join entrega_turno e on e.id = a.entrega_id join turno t on t.id = e.turno_id
    join usuario d on d.id = a.declarado_por join usuario x on x.id = e.entrega_por join usuario y on y.id = e.recibe
    where a.usuario_id = ${usuarioId} and a.confirmado_en is null and t.sucursal_id = ${s.id}
    order by a.declarado_en`;
  return { sucursal: s.nombre, pendientes: [...pendientes] };
}

/** La persona declarada como apoyo confirma su participación desde su propia cuenta. */
export async function confirmarApoyo(
  sql: Sql, usuarioId: string, codigo: string, apoyoId: string, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: "no_encontrada" | "ya_confirmado" | "bloqueado_produccion" }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!valido(codigo) || !esIdentificadorValido(apoyoId)) return { ok: false, error: "no_encontrada" };
  return sql.begin(async (tx) => {
    const [a] = await tx<{ id: string; confirmado: boolean; entrega_id: string; etapa: string }[]>`
      select a.id, a.confirmado_en is not null as confirmado, a.entrega_id, a.etapa
      from apoyo_conteo a join entrega_turno e on e.id = a.entrega_id join turno t on t.id = e.turno_id
      join sucursal s on s.id = t.sucursal_id
      where a.id = ${apoyoId} and a.usuario_id = ${usuarioId} and s.codigo = ${codigo}
      for update of a`;
    if (!a) return { ok: false as const, error: "no_encontrada" as const };
    if (a.confirmado) return { ok: false as const, error: "ya_confirmado" as const };
    await tx`update apoyo_conteo set confirmado_en = now() where id = ${a.id}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrega_turno', ${a.entrega_id}, 'confirmar_apoyo', ${tx.json({ apoyo: a.id, etapa: a.etapa })}, ${usuarioId})`;
    return { ok: true as const };
  });
}

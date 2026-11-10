import type postgres from "postgres";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Registro de accesos (apertura manual) del piloto de Tenango. Solo datos ficticios. Indicado el 9 y 10 nov 2026:
 *   - el pase vale el día del cobro y en esa sucursal; volver el mismo día a la misma sucursal es un reingreso con
 *     el mismo pase, sin cobrar; en otra sucursal se necesita un pase nuevo;
 *   - una entrada por persona, también en cobros grupales; cobro y apertura se consultan por separado;
 *   - cualquier cuenta de Recepción con permiso en la sucursal registra aperturas durante el turno abierto; se
 *     guarda quién, la hora y el turno;
 *   - transferencia con abono pendiente: el acceso requiere autorización de Encargado (o de Dirección con permiso
 *     explícito en la sucursal), que responde desde su sesión con motivo; no la aprueba quien registró el cobro ni
 *     quien la pidió; el cobro sigue pendiente;
 *   - apertura sin pase con motivo, aparte para revisión; «visita que normalmente se cobra» pide autorización;
 *     en una emergencia se registra la apertura y el motivo se completa después (el incidente queda ligado al
 *     turno original, aunque se cierre).
 * La plataforma registra la apertura: no controla la puerta. La base valida de nuevo cada regla (0018).
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type MotivoSinPase = "socio_open_desk" | "proveedor_mantenimiento" | "visita_cobrable" | "emergencia" | "otro";
export const MOTIVOS: Record<MotivoSinPase, string> = {
  socio_open_desk: "Socio con problema en Open Desk",
  proveedor_mantenimiento: "Proveedor o mantenimiento",
  visita_cobrable: "Visita que normalmente se cobra (requiere autorización)",
  emergencia: "Emergencia",
  otro: "Otro",
};
export type TipoAcceso = "entrada" | "reingreso" | "sin_pase";
export type EstadoAutorizacion = "solicitada" | "aprobada" | "rechazada";

export type ErrorAcceso =
  | "no_encontrada"
  | "sin_permiso"
  | "sin_turno"
  | "pase_invalido"
  | "otra_sucursal"
  | "otro_dia"
  | "no_vigente"
  | "ya_entro"
  | "sin_entrada"
  | "requiere_autorizacion"
  | "autorizacion_invalida"
  | "ya_solicitada"
  | "no_pendiente"
  | "nota"
  | "motivo"
  | "detalle"
  | "clave"
  | "propia"
  | "registro_propio"
  | "cambio"
  | "ya_completado"
  | "bloqueado_produccion";

const limpiar = (t: string) => t.trim().replace(/\s+/g, " ");
const largoValido = (t: string) => t.length >= 5 && t.length <= 300;

type Contexto = {
  sucursalId: string;
  turnoId: string | null;
  registrar: boolean;
  autorizar: boolean;
  consultar: boolean;
};

async function contexto(tx: Tx, usuarioId: string, codigo: string): Promise<Contexto | null> {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  const [c] = await tx<Contexto[]>`
    select s.id as "sucursalId",
           (select t.id from turno t where t.sucursal_id = s.id and t.cerrado_en is null) as "turnoId",
           tiene_permiso(${usuarioId}, 'acceso.registrar_apertura', s.id) as registrar,
           tiene_permiso(${usuarioId}, 'acceso.autorizar', s.id) as autorizar,
           tiene_permiso(${usuarioId}, 'acceso.consultar', s.id) as consultar
    from sucursal s where s.codigo = ${codigo}`;
  return c ?? null;
}

/** Traduce los errores de la base (triggers e índices de 0018) a errores de la pantalla. */
function errorDeBase(e: unknown): ErrorAcceso | null {
  const m = e instanceof Error ? e.message : "";
  if (/acceso_una_entrada_por_pase/.test(m)) return "ya_entro";
  if (/autorizacion_activa_por_pase/.test(m)) return "ya_solicitada";
  if (/acceso_clave_key/.test(m)) return "clave";
  if (/otra sucursal/.test(m)) return "otra_sucursal";
  if (/día del cobro/.test(m)) return "otro_dia";
  if (/no está vigente/.test(m)) return "no_vigente";
  if (/necesita autorización/.test(m)) return "requiere_autorizacion";
  if (/entrada previa/.test(m)) return "sin_entrada";
  if (/turno abierto/.test(m)) return "sin_turno";
  if (/autorización no corresponde/.test(m)) return "autorizacion_invalida";
  if (/Quien registró el cobro/.test(m)) return "registro_propio";
  if (/autorizacion_otra_persona/.test(m)) return "propia";
  return null;
}

// ---------------------------------------------------------------------------
// Pases de un cobro: qué puede hacer Recepción con cada persona.
// ---------------------------------------------------------------------------
export type AccionPase = "entrada" | "reingreso" | "pedir_autorizacion" | "esperando_autorizacion" | "no_vigente" | "otro_dia";
export type AutorizacionResumen = {
  id: string;
  estado: EstadoAutorizacion;
  nota: string;
  solicitadaPor: string;
  solicitadaEn: Date;
  resueltaPor: string | null;
  resueltaEn: Date | null;
  motivo: string | null;
  usada: boolean;
};
export type AccesoResumen = { tipo: TipoAcceso; en: Date; por: string; autorizadaPor: string | null };
export type PaseConAcceso = {
  paseId: string;
  orden: number;
  nombre: string;
  accion: AccionPase;
  accesos: AccesoResumen[];
  autorizacion: AutorizacionResumen | null;
};
export type AccesosCobro = { puedeRegistrar: boolean; turnoAbierto: boolean; estadoCobro: string; pases: PaseConAcceso[] };

async function pasesConAcceso(tx: Tx, sucursalId: string, filtro: { operacionId?: string; paseId?: string }) {
  const filas = await tx<{
    pase_id: string; orden: number; nombre: string; cancelado: boolean; es_hoy: boolean; estado: string; operacion_id: string;
  }[]>`
    select p.id as pase_id, p.orden, v.nombre, (p.cancelado_en is not null) as cancelado,
           dia_en_sucursal(p.sucursal_id, p.creado_en) = dia_en_sucursal(p.sucursal_id, now()) as es_hoy,
           c.estado, p.operacion_id
    from pase_visita p
    join visitante v on v.id = p.visitante_id
    join cobro_visita c on c.operacion_id = p.operacion_id
    where p.sucursal_id = ${sucursalId}
      and ${filtro.operacionId ? tx`p.operacion_id = ${filtro.operacionId}` : tx`p.id = ${filtro.paseId!}`}
    order by p.orden`;
  if (!filas.length) return [];
  const ids = filas.map((f) => f.pase_id);
  const accesos = await tx<(AccesoResumen & { pase_id: string })[]>`
    select a.pase_id, a.tipo, a.registrado_en as en, u.nombre as por, ua.nombre as "autorizadaPor"
    from acceso a join usuario u on u.id = a.registrado_por
    left join autorizacion_acceso x on x.id = a.autorizacion_id
    left join usuario ua on ua.id = x.resuelta_por
    where a.pase_id = any(${ids}::uuid[]) order by a.registrado_en`;
  const autorizaciones = await tx<(AutorizacionResumen & { pase_id: string })[]>`
    select distinct on (x.pase_id) x.pase_id, x.id, x.estado, x.nota, us.nombre as "solicitadaPor", x.solicitada_en as "solicitadaEn",
           ur.nombre as "resueltaPor", x.resuelta_en as "resueltaEn", x.motivo_resolucion as motivo,
           exists (select 1 from acceso a where a.autorizacion_id = x.id) as usada
    from autorizacion_acceso x join usuario us on us.id = x.solicitada_por left join usuario ur on ur.id = x.resuelta_por
    where x.pase_id = any(${ids}::uuid[]) order by x.pase_id, x.solicitada_en desc`;
  return filas.map((f): PaseConAcceso & { estadoCobro: string; operacionId: string } => {
    const propios = accesos.filter((a) => a.pase_id === f.pase_id).map(({ pase_id, ...a }) => { void pase_id; return a; });
    const aut = autorizaciones.find((a) => a.pase_id === f.pase_id);
    const autorizacion = aut ? (({ pase_id, ...a }) => { void pase_id; return a; })(aut) : null;
    let accion: AccionPase;
    if (f.cancelado || f.estado === "cancelado" || f.estado === "no_localizado") accion = "no_vigente";
    else if (!f.es_hoy) accion = "otro_dia";
    else if (propios.some((a) => a.tipo === "entrada")) accion = "reingreso";
    else if (f.estado === "pendiente_abono") {
      accion = autorizacion?.estado === "aprobada" && !autorizacion.usada ? "entrada"
        : autorizacion?.estado === "solicitada" ? "esperando_autorizacion" : "pedir_autorizacion";
    } else accion = "entrada";
    return { paseId: f.pase_id, orden: f.orden, nombre: f.nombre, accion, accesos: propios, autorizacion, estadoCobro: f.estado, operacionId: f.operacion_id };
  });
}

/** Personas de un cobro y su acceso. null sin permiso de registrar ni de revisar accesos en la sucursal. */
export async function accesosDelCobro(sql: Sql, usuarioId: string, codigo: string, operacionId: string): Promise<AccesosCobro | null> {
  if (!esIdentificadorValido(operacionId)) return null;
  return sql.begin("read only", async (tx) => {
    const c = await contexto(tx, usuarioId, codigo);
    if (!c || !(c.registrar || c.consultar || c.autorizar)) return null;
    const pases = await pasesConAcceso(tx, c.sucursalId, { operacionId });
    if (!pases.length) return null;
    return {
      puedeRegistrar: c.registrar && c.turnoId !== null,
      turnoAbierto: c.turnoId !== null,
      estadoCobro: pases[0].estadoCobro,
      pases: pases.map(({ estadoCobro, operacionId: o, ...p }) => { void estadoCobro; void o; return p; }),
    };
  });
}

// ---------------------------------------------------------------------------
// Registrar entrada o reingreso con pase.
// ---------------------------------------------------------------------------
export async function registrarAcceso(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { clave: string; paseId: string; tipo: "entrada" | "reingreso" },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; accesoId: string; repetido: boolean } | { ok: false; error: ErrorAcceso }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.clave)) return { ok: false, error: "clave" };
  if (!esIdentificadorValido(datos.paseId)) return { ok: false, error: "pase_invalido" };
  try {
    return await sql.begin(async (tx) => {
      const c = await contexto(tx, usuarioId, codigo);
      if (!c) return { ok: false, error: "no_encontrada" } as const;
      if (!c.registrar) return { ok: false, error: c.consultar || c.autorizar ? "sin_permiso" : "no_encontrada" } as const;
      // Doble envío: la misma clave responde con el mismo acceso.
      const [previo] = await tx<{ id: string; pase_id: string | null; tipo: string; registrado_por: string }[]>`
        select id, pase_id, tipo, registrado_por from acceso where clave = ${datos.clave}`;
      if (previo) {
        return previo.pase_id === datos.paseId && previo.tipo === datos.tipo && previo.registrado_por === usuarioId
          ? ({ ok: true, accesoId: previo.id, repetido: true } as const)
          : ({ ok: false, error: "clave" } as const);
      }
      if (!c.turnoId) return { ok: false, error: "sin_turno" } as const;
      // El pase se bloquea para que dos entradas simultáneas no pasen la revisión a la vez.
      const [existe] = await tx<{ sucursal_id: string }[]>`select sucursal_id from pase_visita where id = ${datos.paseId} for update`;
      if (!existe) return { ok: false, error: "pase_invalido" } as const;
      if (existe.sucursal_id !== c.sucursalId) return { ok: false, error: "otra_sucursal" } as const;
      const [p] = await pasesConAcceso(tx, c.sucursalId, { paseId: datos.paseId });
      if (p.accion === "no_vigente") return { ok: false, error: "no_vigente" } as const;
      if (p.accion === "otro_dia") return { ok: false, error: "otro_dia" } as const;
      if (datos.tipo === "entrada") {
        if (p.accion === "reingreso") return { ok: false, error: "ya_entro" } as const;
        if (p.accion !== "entrada") return { ok: false, error: "requiere_autorizacion" } as const;
      } else if (p.accion !== "reingreso") return { ok: false, error: "sin_entrada" } as const;
      const autorizacionId = datos.tipo === "entrada" && p.estadoCobro === "pendiente_abono" ? p.autorizacion!.id : null;
      const [a] = await tx<{ id: string }[]>`
        insert into acceso (clave, sucursal_id, turno_id, tipo, pase_id, autorizacion_id, registrado_por)
        values (${datos.clave}, ${c.sucursalId}, ${c.turnoId}, ${datos.tipo}, ${datos.paseId}, ${autorizacionId}, ${usuarioId})
        returning id`;
      return { ok: true, accesoId: a.id, repetido: false } as const;
    });
  } catch (e) {
    const error = errorDeBase(e);
    if (error) return { ok: false, error };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Autorizaciones: Recepción pide; Encargado (o quien tenga el permiso) responde desde su sesión.
// ---------------------------------------------------------------------------
export async function pedirAutorizacion(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { tipo: "transferencia_pendiente" | "visita_sin_cobro"; paseId?: string; nota: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; autorizacionId: string; repetida: boolean } | { ok: false; error: ErrorAcceso }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const nota = limpiar(datos.nota);
  if (!largoValido(nota)) return { ok: false, error: "nota" };
  if (datos.tipo === "transferencia_pendiente" && !esIdentificadorValido(datos.paseId ?? "")) return { ok: false, error: "pase_invalido" };
  try {
    return await sql.begin(async (tx) => {
      const c = await contexto(tx, usuarioId, codigo);
      if (!c) return { ok: false, error: "no_encontrada" } as const;
      if (!c.registrar) return { ok: false, error: c.consultar || c.autorizar ? "sin_permiso" : "no_encontrada" } as const;
      if (!c.turnoId) return { ok: false, error: "sin_turno" } as const;
      if (datos.tipo === "transferencia_pendiente") {
        const [existe] = await tx<{ sucursal_id: string }[]>`select sucursal_id from pase_visita where id = ${datos.paseId!} for update`;
        if (!existe) return { ok: false, error: "pase_invalido" } as const;
        if (existe.sucursal_id !== c.sucursalId) return { ok: false, error: "otra_sucursal" } as const;
        const [p] = await pasesConAcceso(tx, c.sucursalId, { paseId: datos.paseId });
        if (p.accion === "esperando_autorizacion" || (p.accion === "entrada" && p.autorizacion?.estado === "aprobada")) {
          // Doble envío o ya resuelta: responde con la que existe.
          return { ok: true, autorizacionId: p.autorizacion!.id, repetida: true } as const;
        }
        if (p.accion === "no_vigente") return { ok: false, error: "no_vigente" } as const;
        if (p.accion === "otro_dia") return { ok: false, error: "otro_dia" } as const;
        if (p.accion !== "pedir_autorizacion") return { ok: false, error: "no_pendiente" } as const;
      } else {
        // Doble envío de la misma nota por la misma persona en el mismo turno, aún pendiente.
        const [igual] = await tx<{ id: string }[]>`
          select id from autorizacion_acceso
          where turno_id = ${c.turnoId} and tipo = 'visita_sin_cobro' and solicitada_por = ${usuarioId}
            and estado = 'solicitada' and nota = ${nota}`;
        if (igual) return { ok: true, autorizacionId: igual.id, repetida: true } as const;
      }
      const [a] = await tx<{ id: string }[]>`
        insert into autorizacion_acceso (sucursal_id, turno_id, tipo, pase_id, nota, solicitada_por)
        values (${c.sucursalId}, ${c.turnoId}, ${datos.tipo}, ${datos.tipo === "transferencia_pendiente" ? datos.paseId! : null}, ${nota}, ${usuarioId})
        returning id`;
      return { ok: true, autorizacionId: a.id, repetida: false } as const;
    });
  } catch (e) {
    const error = errorDeBase(e);
    if (error) return { ok: false, error };
    throw e;
  }
}

export async function resolverAutorizacion(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  autorizacionId: string,
  datos: { version: number; decision: "aprobar" | "rechazar"; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorAcceso }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(autorizacionId)) return { ok: false, error: "no_encontrada" };
  const motivo = limpiar(datos.motivo);
  if (!largoValido(motivo)) return { ok: false, error: "motivo" };
  try {
    return await sql.begin(async (tx) => {
      const c = await contexto(tx, usuarioId, codigo);
      if (!c || !c.autorizar) return { ok: false, error: "no_encontrada" } as const;
      const [x] = await tx<{ estado: string; version: number; solicitada_por: string; registro: string | null }[]>`
        select x.estado, x.version, x.solicitada_por,
               (select o.registrada_por from pase_visita p join operacion_visita o on o.id = p.operacion_id where p.id = x.pase_id) as registro
        from autorizacion_acceso x where x.id = ${autorizacionId} and x.sucursal_id = ${c.sucursalId} for update`;
      if (!x) return { ok: false, error: "no_encontrada" } as const;
      if (x.solicitada_por === usuarioId) return { ok: false, error: "propia" } as const;
      if (x.registro === usuarioId) return { ok: false, error: "registro_propio" } as const;
      if (x.estado !== "solicitada" || x.version !== datos.version) return { ok: false, error: "cambio" } as const;
      await tx`
        update autorizacion_acceso
        set estado = ${datos.decision === "aprobar" ? "aprobada" : "rechazada"}, resuelta_por = ${usuarioId}, resuelta_en = now(),
            motivo_resolucion = ${motivo}, version = version + 1
        where id = ${autorizacionId}`;
      return { ok: true } as const;
    });
  } catch (e) {
    const error = errorDeBase(e);
    if (error) return { ok: false, error };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Apertura sin pase y emergencias.
// ---------------------------------------------------------------------------
export async function registrarSinPase(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { clave: string; motivo: string; detalle: string; autorizacionId?: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; accesoId: string; repetido: boolean } | { ok: false; error: ErrorAcceso }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.clave)) return { ok: false, error: "clave" };
  if (!(datos.motivo in MOTIVOS)) return { ok: false, error: "motivo" };
  const motivo = datos.motivo as MotivoSinPase;
  const detalle = limpiar(datos.detalle);
  if (detalle && !largoValido(detalle)) return { ok: false, error: "detalle" };
  if (!detalle && (motivo === "otro" || motivo === "visita_cobrable")) return { ok: false, error: "detalle" };
  const autorizacionId = motivo === "visita_cobrable" ? datos.autorizacionId ?? "" : null;
  if (autorizacionId !== null && !esIdentificadorValido(autorizacionId)) return { ok: false, error: "requiere_autorizacion" };
  try {
    return await sql.begin(async (tx) => {
      const c = await contexto(tx, usuarioId, codigo);
      if (!c) return { ok: false, error: "no_encontrada" } as const;
      if (!c.registrar) return { ok: false, error: c.consultar || c.autorizar ? "sin_permiso" : "no_encontrada" } as const;
      const [previo] = await tx<{ id: string; motivo: string | null; registrado_por: string }[]>`
        select id, motivo, registrado_por from acceso where clave = ${datos.clave}`;
      if (previo) {
        return previo.motivo === motivo && previo.registrado_por === usuarioId
          ? ({ ok: true, accesoId: previo.id, repetido: true } as const)
          : ({ ok: false, error: "clave" } as const);
      }
      if (!c.turnoId) return { ok: false, error: "sin_turno" } as const;
      if (autorizacionId) {
        const [a] = await tx<{ estado: string; usada: boolean }[]>`
          select x.estado, exists (select 1 from acceso a where a.autorizacion_id = x.id) as usada
          from autorizacion_acceso x
          where x.id = ${autorizacionId} and x.sucursal_id = ${c.sucursalId} and x.tipo = 'visita_sin_cobro' for update`;
        if (!a || a.estado !== "aprobada" || a.usada) return { ok: false, error: "requiere_autorizacion" } as const;
      }
      const [a] = await tx<{ id: string }[]>`
        insert into acceso (clave, sucursal_id, turno_id, tipo, motivo, detalle, autorizacion_id, registrado_por)
        values (${datos.clave}, ${c.sucursalId}, ${c.turnoId}, 'sin_pase', ${motivo}, ${detalle || null}, ${autorizacionId}, ${usuarioId})
        returning id`;
      return { ok: true, accesoId: a.id, repetido: false } as const;
    });
  } catch (e) {
    const error = errorDeBase(e);
    if (error) return { ok: false, error };
    throw e;
  }
}

/** Completa el motivo de una apertura de emergencia (una sola vez), aunque su turno ya haya cerrado. */
export async function completarMotivo(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  accesoId: string,
  datos: { detalle: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorAcceso }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(accesoId)) return { ok: false, error: "no_encontrada" };
  const detalle = limpiar(datos.detalle);
  if (!largoValido(detalle)) return { ok: false, error: "detalle" };
  return sql.begin(async (tx) => {
    const c = await contexto(tx, usuarioId, codigo);
    if (!c || !(c.registrar || c.autorizar)) return { ok: false, error: "no_encontrada" } as const;
    const [a] = await tx<{ detalle: string | null }[]>`
      select detalle from acceso where id = ${accesoId} and sucursal_id = ${c.sucursalId} and motivo = 'emergencia' for update`;
    if (!a) return { ok: false, error: "no_encontrada" } as const;
    if (a.detalle !== null) return { ok: false, error: "ya_completado" } as const;
    await tx`update acceso set detalle = ${detalle}, detalle_por = ${usuarioId}, detalle_en = now() where id = ${accesoId}`;
    return { ok: true } as const;
  });
}

// ---------------------------------------------------------------------------
// Consultas.
// ---------------------------------------------------------------------------
export type AccesoRegistro = {
  id: string;
  tipo: TipoAcceso;
  en: Date;
  por: string;
  turnoId: string;
  turnoAbiertoEn: Date;
  persona: string | null;
  operacionId: string | null;
  motivo: MotivoSinPase | null;
  detalle: string | null;
  detallePor: string | null;
  detalleEn: Date | null;
  autorizadaPor: string | null;
  motivoAutorizacion: string | null;
  transferenciaPendiente: boolean;
};
export type AutorizacionPendiente = AutorizacionResumen & {
  tipo: "transferencia_pendiente" | "visita_sin_cobro";
  version: number;
  persona: string | null;
  operacionId: string | null;
  importe: string | null;
  referencia: string | null;
  impedimento: "propia" | "registro_propio" | null;
};

async function registro(tx: Tx, sucursalId: string, filtro: postgres.PendingQuery<postgres.Row[]>) {
  return tx<AccesoRegistro[]>`
    select a.id, a.tipo, a.registrado_en as en, u.nombre as por, a.turno_id as "turnoId", t.abierto_en as "turnoAbiertoEn",
           v.nombre as persona, p.operacion_id as "operacionId", a.motivo, a.detalle, ud.nombre as "detallePor", a.detalle_en as "detalleEn",
           ua.nombre as "autorizadaPor", x.motivo_resolucion as "motivoAutorizacion",
           (x.tipo = 'transferencia_pendiente') is true as "transferenciaPendiente"
    from acceso a
    join usuario u on u.id = a.registrado_por
    join turno t on t.id = a.turno_id
    left join pase_visita p on p.id = a.pase_id
    left join visitante v on v.id = p.visitante_id
    left join usuario ud on ud.id = a.detalle_por
    left join autorizacion_acceso x on x.id = a.autorizacion_id
    left join usuario ua on ua.id = x.resuelta_por
    where a.sucursal_id = ${sucursalId} and ${filtro}
    order by a.registrado_en desc`;
}

async function autorizaciones(tx: Tx, usuarioId: string, filtro: postgres.PendingQuery<postgres.Row[]>) {
  return tx<AutorizacionPendiente[]>`
    select x.id, x.tipo, x.estado, x.nota, x.version, us.nombre as "solicitadaPor", x.solicitada_en as "solicitadaEn",
           ur.nombre as "resueltaPor", x.resuelta_en as "resueltaEn", x.motivo_resolucion as motivo,
           exists (select 1 from acceso a where a.autorizacion_id = x.id) as usada,
           v.nombre as persona, p.operacion_id as "operacionId", c.importe::text as importe, c.referencia,
           case when x.solicitada_por = ${usuarioId} then 'propia'
                when o.registrada_por = ${usuarioId} then 'registro_propio' end as impedimento
    from autorizacion_acceso x
    join usuario us on us.id = x.solicitada_por
    left join usuario ur on ur.id = x.resuelta_por
    left join pase_visita p on p.id = x.pase_id
    left join visitante v on v.id = p.visitante_id
    left join operacion_visita o on o.id = p.operacion_id
    left join cobro_visita c on c.operacion_id = p.operacion_id
    where ${filtro}
    order by x.solicitada_en desc`;
}

export type PantallaAccesos = {
  turnoAbierto: boolean;
  delTurno: AccesoRegistro[];
  visitasSinCobro: AutorizacionPendiente[];
  emergenciasSinMotivo: AccesoRegistro[];
};

/** Pantalla de Recepción «Accesos del turno». null sin permiso de registrar aperturas en la sucursal. */
export async function pantallaAccesos(sql: Sql, usuarioId: string, codigo: string): Promise<PantallaAccesos | null> {
  return sql.begin("read only", async (tx) => {
    const c = await contexto(tx, usuarioId, codigo);
    if (!c || !c.registrar) return null;
    return {
      turnoAbierto: c.turnoId !== null,
      delTurno: c.turnoId ? await registro(tx, c.sucursalId, tx`a.turno_id = ${c.turnoId}`) : [],
      visitasSinCobro: c.turnoId
        ? await autorizaciones(tx, usuarioId, tx`x.turno_id = ${c.turnoId} and x.tipo = 'visita_sin_cobro'`)
        : [],
      emergenciasSinMotivo: await registro(tx, c.sucursalId, tx`a.motivo = 'emergencia' and a.detalle is null`),
    };
  });
}

export type RevisionAccesos = {
  puedeAutorizar: boolean;
  puedeConsultar: boolean;
  porAutorizar: AutorizacionPendiente[];
  emergenciasSinMotivo: AccesoRegistro[];
  recientes: AccesoRegistro[];
  resueltas: AutorizacionPendiente[];
};

/**
 * «Accesos por autorizar» y revisión de registros: Encargado (autoriza y revisa), Dirección con permiso explícito
 * (autoriza) y Administración (revisa). null sin ninguno de esos permisos en la sucursal.
 */
export async function revisionAccesos(sql: Sql, usuarioId: string, codigo: string): Promise<RevisionAccesos | null> {
  return sql.begin("read only", async (tx) => {
    const c = await contexto(tx, usuarioId, codigo);
    if (!c || !(c.autorizar || c.consultar)) return null;
    return {
      puedeAutorizar: c.autorizar,
      puedeConsultar: c.consultar,
      porAutorizar: c.autorizar ? await autorizaciones(tx, usuarioId, tx`x.sucursal_id = ${c.sucursalId} and x.estado = 'solicitada'`) : [],
      emergenciasSinMotivo: await registro(tx, c.sucursalId, tx`a.motivo = 'emergencia' and a.detalle is null`),
      recientes: c.consultar ? await registro(tx, c.sucursalId, tx`a.registrado_en >= now() - interval '7 days'`) : [],
      resueltas: c.consultar
        ? await autorizaciones(tx, usuarioId, tx`x.sucursal_id = ${c.sucursalId} and x.estado <> 'solicitada' and x.resuelta_en >= now() - interval '7 days'`)
        : [],
    };
  });
}

/** Conteos para la página del turno (quien ve el turno). */
export async function resumenAccesosTurno(sql: Sql, turnoId: string) {
  const [r] = await sql<{ entradas: number; reingresos: number; sin_pase: number; sin_motivo: number; con_transferencia: number }[]>`
    select count(*) filter (where a.tipo = 'entrada')::int as entradas,
           count(*) filter (where a.tipo = 'reingreso')::int as reingresos,
           count(*) filter (where a.tipo = 'sin_pase')::int as sin_pase,
           count(*) filter (where a.motivo = 'emergencia' and a.detalle is null)::int as sin_motivo,
           count(*) filter (where a.autorizacion_id is not null and a.tipo = 'entrada')::int as con_transferencia
    from acceso a where a.turno_id = ${turnoId}`;
  const [{ pendientes }] = await sql<{ pendientes: number }[]>`
    select count(*)::int as pendientes from autorizacion_acceso where turno_id = ${turnoId} and estado = 'solicitada'`;
  return { entradas: r.entradas, reingresos: r.reingresos, sinPase: r.sin_pase, sinMotivo: r.sin_motivo, conTransferencia: r.con_transferencia, pendientes };
}

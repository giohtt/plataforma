import type postgres from "postgres";
import {
  cifrarContrasena,
  obtenerHuellaFicticia,
  revisarContrasena,
  verificarContrasena,
} from "./contrasena";
import type { Entorno } from "./entorno";
import { formatoTokenValido, generarToken, huellaToken } from "./tokens";

/**
 * Lógica de sesión y recuperación de cuenta. Recibe la conexión como parámetro para poder
 * probarla contra una base real; las pantallas la usan a través de sesion-servidor.ts.
 */
type Sql = postgres.Sql;

export const DURACION_SESION_HORAS = 12;
export const DURACION_ENLACE_MINUTOS = 30;
export const MAX_FALLOS = 5;
export const VENTANA_FALLOS_MINUTOS = 15;
export const MAX_ENLACES_POR_HORA = 3;

export function normalizarCorreo(correo: string): string {
  return correo.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Inicio y cierre de sesión
// ---------------------------------------------------------------------------

export type ResultadoInicio =
  | { ok: true; token: string; expiraEn: Date }
  | { ok: false; motivo: "credenciales" | "bloqueado" };

/** Puntos de espera solo para pruebas de concurrencia. La aplicación nunca los usa. */
export type PausasPrueba = {
  trasVerificar?: () => Promise<void>;
  dentroDeTransaccion?: () => Promise<void>;
};

export async function iniciarSesion(
  sql: Sql,
  correoEscrito: string,
  contrasena: string,
  pausas: PausasPrueba = {},
): Promise<ResultadoInicio> {
  const correo = normalizarCorreo(correoEscrito);

  const [{ fallos }] = await sql<{ fallos: number }[]>`
    select count(*)::int as fallos from intento_acceso
    where correo = ${correo} and not exito
      and en > now() - make_interval(mins => ${VENTANA_FALLOS_MINUTOS})`;
  if (fallos >= MAX_FALLOS) {
    await sql`insert into intento_acceso (correo, exito, motivo) values (${correo}, false, 'bloqueado')`;
    return { ok: false, motivo: "bloqueado" };
  }

  const [usuario] = await sql<{ id: string; hash_contrasena: string | null; activo: boolean }[]>`
    select id, hash_contrasena, activo from usuario where correo = ${correo}`;
  // Se verifica siempre, aunque el correo no exista, para no revelar qué correos están registrados.
  const valida = await verificarContrasena(contrasena, usuario?.hash_contrasena ?? (await obtenerHuellaFicticia()));

  let motivo: "credenciales" | "sin_contrasena" | "inactivo" | null = null;
  if (!usuario || !valida) motivo = usuario && !usuario.hash_contrasena ? "sin_contrasena" : "credenciales";
  else if (!usuario.activo) motivo = "inactivo";

  if (motivo || !usuario) {
    await sql`insert into intento_acceso (correo, exito, motivo) values (${correo}, false, ${motivo ?? "credenciales"})`;
    return { ok: false, motivo: "credenciales" };
  }

  await pausas.trasVerificar?.();

  // La sesión solo se crea si la contraseña verificada sigue siendo la vigente. El bloqueo compartido
  // sobre el usuario hace que un cambio de contraseña simultáneo espere a que esta transacción termine
  // y, al aplicarse, cierre también esta sesión; o que esta transacción vea la contraseña nueva y no cree nada.
  const token = generarToken();
  const sesion = await sql.begin(async (tx) => {
    const [vigente] = await tx`
      select id from usuario
      where id = ${usuario.id} and activo and hash_contrasena = ${usuario.hash_contrasena}
      for share`;
    await pausas.dentroDeTransaccion?.();
    if (!vigente) return null;
    const [creada] = await tx<{ expira_en: Date }[]>`
      insert into sesion (token_hash, usuario_id, expira_en)
      values (${huellaToken(token)}, ${usuario.id}, now() + make_interval(hours => ${DURACION_SESION_HORAS}))
      returning expira_en`;
    await tx`insert into intento_acceso (correo, exito, motivo) values (${correo}, true, 'ok')`;
    return creada;
  });
  if (!sesion) {
    await sql`insert into intento_acceso (correo, exito, motivo) values (${correo}, false, 'credenciales')`;
    return { ok: false, motivo: "credenciales" };
  }
  return { ok: true, token, expiraEn: sesion.expira_en };
}

export type SesionActiva = { sesionId: string; usuarioId: string; nombre: string; correo: string; expiraEn: Date };

export async function validarSesion(sql: Sql, token: string | undefined): Promise<SesionActiva | null> {
  if (!token || !formatoTokenValido(token)) return null;
  const [fila] = await sql<SesionActiva[]>`
    select s.id as "sesionId", u.id as "usuarioId", u.nombre, u.correo, s.expira_en as "expiraEn"
    from sesion s join usuario u on u.id = s.usuario_id
    where s.token_hash = ${huellaToken(token)}
      and s.cerrada_en is null and s.expira_en > now() and u.activo`;
  return fila ?? null;
}

export async function cerrarSesion(sql: Sql, token: string | undefined): Promise<void> {
  if (!token || !formatoTokenValido(token)) return;
  await sql`
    update sesion set cerrada_en = now(), motivo_cierre = 'cierre'
    where token_hash = ${huellaToken(token)} and cerrada_en is null`;
}

// ---------------------------------------------------------------------------
// Recuperación de cuenta con enlace de un solo uso
// ---------------------------------------------------------------------------

export type ResultadoSolicitud =
  | { creado: true; destino: "buzon_prueba" }
  | { creado: false; motivo: "desconocido" | "limite" | "sin_canal" };

/**
 * Crea un enlace para que la persona fije su contraseña e invalida los anteriores.
 * Mientras no haya servicio de correo, el enlace solo se entrega en el buzón de pruebas,
 * fuera de producción y solo a usuarios marcados como de prueba. La pantalla responde
 * siempre lo mismo, exista o no el correo.
 */
export async function solicitarEnlace(
  sql: Sql,
  correoEscrito: string,
  { entorno, urlBase }: { entorno: Entorno; urlBase: string },
): Promise<ResultadoSolicitud> {
  const correo = normalizarCorreo(correoEscrito);
  const [usuario] = await sql<{ id: string; nombre: string; activo: boolean; es_prueba: boolean }[]>`
    select id, nombre, activo, es_prueba from usuario where correo = ${correo}`;
  if (!usuario || !usuario.activo) return { creado: false, motivo: "desconocido" };
  if (entorno === "produccion" || !usuario.es_prueba) return { creado: false, motivo: "sin_canal" };

  const token = generarToken();
  const enlace = `${urlBase}/recuperar/${token}`;
  // Todo en una transacción que bloquea al usuario: las solicitudes simultáneas de la misma cuenta
  // se atienden una por una, así que el límite por hora se cuenta bien y queda un solo enlace pendiente.
  return sql.begin(async (tx): Promise<ResultadoSolicitud> => {
    await tx`select id from usuario where id = ${usuario.id} for update`;
    const [{ recientes }] = await tx<{ recientes: number }[]>`
      select count(*)::int as recientes from enlace_recuperacion
      where usuario_id = ${usuario.id} and creado_en > now() - interval '1 hour'`;
    if (recientes >= MAX_ENLACES_POR_HORA) return { creado: false, motivo: "limite" };

    await tx`
      update enlace_recuperacion set invalidado_en = now()
      where usuario_id = ${usuario.id} and usado_en is null and invalidado_en is null`;
    await tx`
      insert into enlace_recuperacion (token_hash, usuario_id, expira_en)
      values (${huellaToken(token)}, ${usuario.id}, now() + make_interval(mins => ${DURACION_ENLACE_MINUTOS}))`;
    await tx`
      insert into buzon_prueba (para, asunto, cuerpo, enlace) values (
        ${correo},
        'Establece tu contraseña de Fitnessland',
        ${`Hola, ${usuario.nombre}. Usa este enlace para establecer tu contraseña. Caduca en ${DURACION_ENLACE_MINUTOS} minutos y solo funciona una vez. Si no lo pediste, ignóralo.`},
        ${enlace})`;
    return { creado: true, destino: "buzon_prueba" };
  });
}

export type EstadoEnlace =
  | { estado: "valido"; correo: string }
  | { estado: "vencido" | "usado" | "invalidado" | "inexistente" };

export async function consultarEnlace(sql: Sql, token: string): Promise<EstadoEnlace> {
  if (!formatoTokenValido(token)) return { estado: "inexistente" };
  const [fila] = await sql<{ correo: string; activo: boolean; vencido: boolean; usado_en: Date | null; invalidado_en: Date | null }[]>`
    select u.correo, u.activo, e.expira_en <= now() as vencido, e.usado_en, e.invalidado_en
    from enlace_recuperacion e join usuario u on u.id = e.usuario_id
    where e.token_hash = ${huellaToken(token)}`;
  return clasificar(fila);
}

function clasificar(
  fila: { correo: string; activo: boolean; vencido: boolean; usado_en: Date | null; invalidado_en: Date | null } | undefined,
): EstadoEnlace {
  if (!fila || !fila.activo) return { estado: "inexistente" };
  if (fila.usado_en) return { estado: "usado" };
  if (fila.invalidado_en) return { estado: "invalidado" };
  if (fila.vencido) return { estado: "vencido" };
  return { estado: "valido", correo: fila.correo };
}

export type ResultadoContrasena =
  | { ok: true }
  | { ok: false; error: string; estado?: Exclude<EstadoEnlace["estado"], "valido"> };

/**
 * Usa el enlace para fijar la contraseña. Todo ocurre en una transacción que bloquea el enlace:
 * si dos personas lo usan a la vez, solo una lo consigue. Al terminar, se cierran todas las
 * sesiones abiertas del usuario y se invalidan sus demás enlaces.
 */
export async function establecerContrasena(
  sql: Sql,
  token: string,
  contrasena: string,
  confirmacion: string,
): Promise<ResultadoContrasena> {
  if (!formatoTokenValido(token)) return { ok: false, error: "El enlace no es válido.", estado: "inexistente" };
  return sql.begin(async (tx) => {
    const [fila] = await tx<{ id: string; usuario_id: string; correo: string; activo: boolean; vencido: boolean; usado_en: Date | null; invalidado_en: Date | null }[]>`
      select e.id, e.usuario_id, u.correo, u.activo, e.expira_en <= now() as vencido, e.usado_en, e.invalidado_en
      from enlace_recuperacion e join usuario u on u.id = e.usuario_id
      where e.token_hash = ${huellaToken(token)}
      for update of e`;
    const estado = clasificar(fila);
    if (estado.estado !== "valido" || !fila) {
      return { ok: false as const, error: "Este enlace ya no se puede usar.", estado: estado.estado as Exclude<EstadoEnlace["estado"], "valido"> };
    }
    const problema = revisarContrasena(contrasena, confirmacion, fila.correo);
    if (problema) return { ok: false as const, error: problema };

    const hash = await cifrarContrasena(contrasena);
    await tx`update usuario set hash_contrasena = ${hash}, contrasena_actualizada_en = now(), actualizado_en = now()
             where id = ${fila.usuario_id}`;
    await tx`update enlace_recuperacion set usado_en = now() where id = ${fila.id}`;
    await tx`update enlace_recuperacion set invalidado_en = now()
             where usuario_id = ${fila.usuario_id} and id <> ${fila.id} and usado_en is null and invalidado_en is null`;
    await tx`update sesion set cerrada_en = now(), motivo_cierre = 'cambio_contrasena'
             where usuario_id = ${fila.usuario_id} and cerrada_en is null`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, motivo, usuario_id)
             values ('usuario', ${fila.usuario_id}, 'establecer_contrasena', 'Enlace de recuperación de un solo uso', ${fila.usuario_id})`;
    return { ok: true as const };
  });
}

"use server";

/**
 * Sección «Usuarios, roles y permisos», por POST. Cada acción vuelve a comprobar en el servidor el permiso de quien la
 * hace (src/lib/usuarios.ts) y la base respalda las reglas (restricciones, 90 días, última cuenta que administra).
 */
import { redirect } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual, urlBaseEnlaces } from "@/lib/sesion-servidor";
import {
  aplicarCambio, cambiarEstadoPersona, crearPersona, editarPersona, invitarPersona, previsualizarCambio,
  type Alcance, type CambioAcceso, type ErrorUsuarios, type VistaPrevia,
} from "@/lib/usuarios";

export type EstadoUsuarios = {
  error?: string;
  errores?: Record<string, string | undefined>;
  valores?: Record<string, string>;
  intento: number;
  /** Vista previa del cambio de acceso: cómo quedarán sus permisos y sucursales. */
  vista?: VistaPrevia & { detalle: string };
  /** Invitación recién generada (se muestra una sola vez). */
  invitacion?: { enlace: string; expira: string };
} | null;

async function inicio() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}
const lector = (datos: FormData) => (campo: string, max = 60) => {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
};
const MARCADOS = "Revisa los campos marcados.";
const MENSAJES_USUARIOS: Record<ErrorUsuarios, string> = {
  sin_permiso: "Tu cuenta no tiene permiso para esto.",
  no_encontrada: "No encontrada.",
  nombre: "Escribe el nombre (de 2 a 120 caracteres).",
  correo: "Escribe un correo válido.",
  correo_repetido: "Ya hay una cuenta con ese correo. Cada persona tiene una sola cuenta.",
  puesto: "El puesto debe tener de 2 a 80 caracteres (o déjalo vacío).",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
  propia: "No puedes desactivar tu propia cuenta.",
  sin_canal: "Solo se invita a cuentas activas de prueba, fuera de producción.",
  ultimo_administrador: "No se puede: quedaría la plataforma sin una cuenta activa que administre accesos sin vencimiento. Da primero ese acceso a otra persona.",
  rol: "Elige un perfil.",
  permiso: "Elige un permiso.",
  alcance: "Este permiso es general: solo se da o se restringe en todas las sucursales.",
  sucursales: "Elige las sucursales (una o varias) o «Todas las sucursales».",
  limite: "Los permisos de autorizar llevan límite de monto: escribe un importe mayor que 0.",
  sin_limite: "Este permiso no lleva límite de monto.",
  hasta: "Revisa la fecha de fin (no puede ser anterior a hoy ni pasar del máximo permitido).",
  ya_tiene: "Ya lo tiene vigente en esa sucursal.",
  no_vigente: "Ya no está vigente. Recarga la página.",
  no_direccion: "Esta autorización es solo para una cuenta con Dirección en esas sucursales.",
  ya_autorizada: "Ya hay una autorización vigente: renuévala o termínala.",
  sin_cambio: "No hay cambios que guardar.",
  bloqueado_produccion: "Esta sección está desactivada fuera del entorno de pruebas.",
};
const CAMPO: Partial<Record<ErrorUsuarios, string>> = {
  nombre: "nombre", correo: "correo", correo_repetido: "correo", puesto: "puesto", motivo: "motivo", rol: "rol", permiso: "permiso",
  alcance: "alcance", sucursales: "alcance", limite: "limite", sin_limite: "limite", hasta: "hasta", no_direccion: "alcance",
};
function conError(error: ErrorUsuarios, valores: Record<string, string>, intento: number): EstadoUsuarios {
  const campo = CAMPO[error];
  return campo ? { error: MARCADOS, errores: { [campo]: MENSAJES_USUARIOS[error] }, valores, intento } : { error: MENSAJES_USUARIOS[error], valores, intento };
}

export async function accionCrearPersona(previo: EstadoUsuarios, datos: FormData): Promise<EstadoUsuarios> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const valores = { nombre: leer("nombre", 160), correo: leer("correo", 260), puesto: leer("puesto", 100) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await crearPersona(sql, sesion.usuarioId, valores, { entorno: leerEntorno() });
  if (r.ok) redirect(`/usuarios/${r.id}?aviso=creada`);
  return conError(r.error, valores, intento);
}

export async function accionEditarPersona(previo: EstadoUsuarios, datos: FormData): Promise<EstadoUsuarios> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const id = leer("id", 40);
  const valores = { nombre: leer("nombre", 160), puesto: leer("puesto", 100) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await editarPersona(sql, sesion.usuarioId, { id, ...valores }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/usuarios/${id}?aviso=editada`);
  return conError(r.error, valores, intento);
}

export async function accionEstadoPersona(previo: EstadoUsuarios, datos: FormData): Promise<EstadoUsuarios> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const id = leer("id", 40);
  const activo = leer("activo", 5) === "si";
  const valores = { motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await cambiarEstadoPersona(sql, sesion.usuarioId, { id, activo, motivo: valores.motivo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/usuarios/${id}?aviso=${activo ? "activada" : "desactivada"}`);
  return conError(r.error, valores, intento);
}

export async function accionInvitar(previo: EstadoUsuarios, datos: FormData): Promise<EstadoUsuarios> {
  const { sesion, sql } = await inicio();
  const id = lector(datos)("id", 40);
  const intento = (previo?.intento ?? 0) + 1;
  const r = await invitarPersona(sql, sesion.usuarioId, { id }, { entorno: leerEntorno(), urlBase: urlBaseEnlaces() });
  if (!r.ok) return { error: MENSAJES_USUARIOS[r.error], intento };
  return { intento, invitacion: { enlace: r.enlace, expira: r.expira.toISOString() } };
}

function leerAlcance(datos: FormData): Alcance {
  if (datos.get("alcance") === "todas") return { todas: true };
  return { todas: false, sucursales: datos.getAll("sucursal").filter((s): s is string => typeof s === "string").slice(0, 50).map((s) => s.slice(0, 40)) };
}
function leerCambio(datos: FormData): { cambio: CambioAcceso | null; valores: Record<string, string> } {
  const leer = lector(datos);
  const tipo = leer("tipo", 30);
  const motivo = leer("motivo", 400);
  const alcance = leerAlcance(datos);
  const valores: Record<string, string> = {
    tipo, motivo, rol: leer("rol", 40), permiso: leer("permiso", 60), limite: leer("limite", 20), hasta: leer("hasta", 10),
    alcance: leer("alcance", 10), sucursales: alcance.todas ? "" : alcance.sucursales.join(","), id: leer("id", 40), general: leer("general", 5),
  };
  const comun = { motivo, hasta: valores.hasta };
  switch (tipo) {
    case "dar_perfil": return { cambio: { tipo, rol: valores.rol, alcance, ...comun }, valores };
    case "dar_permiso": return { cambio: { tipo, permiso: valores.permiso, alcance, limite: valores.limite, ...comun }, valores };
    case "restringir": return { cambio: { tipo, permiso: valores.permiso, alcance, ...comun }, valores };
    case "autorrevision": return { cambio: { tipo, alcance, ...comun }, valores };
    case "quitar_perfil": return { cambio: { tipo, id: valores.id, general: valores.general === "si", motivo }, valores };
    case "quitar_permiso":
    case "quitar_restriccion":
    case "terminar_autorrevision": return { cambio: { tipo, id: valores.id, motivo }, valores };
    default: return { cambio: null, valores };
  }
}

/**
 * Dos pasos: «Revisar cómo quedará» muestra los permisos y sucursales resultantes sin guardar; «Confirmar y guardar»
 * vuelve a validar todo en el servidor y lo guarda con su historial.
 */
export async function accionCambioAcceso(previo: EstadoUsuarios, datos: FormData): Promise<EstadoUsuarios> {
  const { sesion, sql } = await inicio();
  const personaId = lector(datos)("persona", 40);
  const paso = lector(datos)("paso", 12);
  const { cambio, valores } = leerCambio(datos);
  const intento = (previo?.intento ?? 0) + 1;
  if (!cambio) return { error: "Cambio no reconocido.", valores, intento };
  const entorno = leerEntorno();
  if (paso === "confirmar") {
    const r = await aplicarCambio(sql, sesion.usuarioId, personaId, cambio, { entorno });
    if (r.ok) redirect(`/usuarios/${personaId}?aviso=guardado`);
    return conError(r.error, valores, intento);
  }
  const r = await previsualizarCambio(sql, sesion.usuarioId, personaId, cambio, { entorno });
  if (!r.ok) return conError(r.error, valores, intento);
  return { valores, intento, vista: { ...r.vista, detalle: r.detalle } };
}

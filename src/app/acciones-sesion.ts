"use server";

/**
 * Acciones de inicio de sesión y recuperación. Cada acción se puede invocar con una solicitud
 * POST directa, así que todo se valida aquí, en el servidor. Next.js rechaza las acciones cuyo
 * Origin no coincide con el sitio (protección contra CSRF).
 */
import { redirect } from "next/navigation";
import {
  cerrarSesion,
  establecerContrasena,
  iniciarSesion,
  solicitarEnlace,
} from "@/lib/autenticacion";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import {
  borrarCookieSesion,
  guardarCookieSesion,
  leerTokenSesion,
  urlBaseEnlaces,
} from "@/lib/sesion-servidor";

export type EstadoFormulario = { error?: string; aviso?: string } | null;

function texto(datos: FormData, campo: string, maximo = 300): string {
  const valor = datos.get(campo);
  return typeof valor === "string" ? valor.slice(0, maximo) : "";
}

const SIN_BASE: EstadoFormulario = { error: "El sistema no está disponible en este momento. Intenta más tarde." };

export async function accionIniciarSesion(_previo: EstadoFormulario, datos: FormData): Promise<EstadoFormulario> {
  const sql = obtenerBaseDatos();
  if (!sql) return SIN_BASE;
  const correo = texto(datos, "correo", 254);
  const contrasena = texto(datos, "contrasena", 200);
  if (!correo || !contrasena) return { error: "Escribe tu correo y tu contraseña." };

  const resultado = await iniciarSesion(sql, correo, contrasena);
  if (!resultado.ok) {
    return {
      error:
        resultado.motivo === "bloqueado"
          ? "Demasiados intentos fallidos. Espera 15 minutos o restablece tu contraseña."
          : "Correo o contraseña incorrectos.",
    };
  }
  await guardarCookieSesion(resultado.token, resultado.expiraEn);
  redirect("/");
}

export async function accionCerrarSesion(): Promise<void> {
  const sql = obtenerBaseDatos();
  if (sql) await cerrarSesion(sql, await leerTokenSesion());
  await borrarCookieSesion();
  redirect("/iniciar-sesion?sesion=cerrada");
}

export async function accionSolicitarEnlace(_previo: EstadoFormulario, datos: FormData): Promise<EstadoFormulario> {
  const sql = obtenerBaseDatos();
  if (!sql) return SIN_BASE;
  const correo = texto(datos, "correo", 254);
  if (!correo.includes("@")) return { error: "Escribe un correo válido." };
  await solicitarEnlace(sql, correo, { entorno: leerEntorno(), urlBase: urlBaseEnlaces() });
  // La respuesta es la misma exista o no el correo, para no revelar qué cuentas existen.
  return {
    aviso:
      "Si el correo pertenece a una cuenta activa, se generó un enlace para establecer la contraseña. Caduca en 30 minutos y solo funciona una vez.",
  };
}

export async function accionEstablecerContrasena(_previo: EstadoFormulario, datos: FormData): Promise<EstadoFormulario> {
  const sql = obtenerBaseDatos();
  if (!sql) return SIN_BASE;
  const resultado = await establecerContrasena(
    sql,
    texto(datos, "token", 100),
    texto(datos, "contrasena", 200),
    texto(datos, "confirmacion", 200),
  );
  if (!resultado.ok) return { error: resultado.error };
  redirect("/iniciar-sesion?contrasena=lista");
}

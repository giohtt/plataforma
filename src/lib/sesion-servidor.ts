import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { validarSesion, type SesionActiva } from "./autenticacion";
import { obtenerBaseDatos } from "./db";

/**
 * Cookie de sesión. El prefijo __Host- obliga a Secure, Path=/ y sin Domain:
 * solo viaja por HTTPS (o localhost) y solo a este sitio.
 */
export const NOMBRE_COOKIE = "__Host-fl_sesion";

export async function leerTokenSesion(): Promise<string | undefined> {
  return (await cookies()).get(NOMBRE_COOKIE)?.value;
}

/** Sesión del usuario actual, consultada una vez por solicitud. Null si no hay sesión válida. */
export const obtenerSesionActual = cache(async (): Promise<SesionActiva | null> => {
  // Leer la cookie primero obliga a evaluar la sesión en cada visita, nunca al compilar.
  const token = await leerTokenSesion();
  const sql = obtenerBaseDatos();
  if (!sql) return null;
  return validarSesion(sql, token);
});

/** Para pantallas y acciones que requieren sesión: si no hay, manda a iniciar sesión. */
export async function requerirSesion(): Promise<SesionActiva> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  return sesion;
}

export async function guardarCookieSesion(token: string, expiraEn: Date): Promise<void> {
  (await cookies()).set(NOMBRE_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: expiraEn,
  });
}

export async function borrarCookieSesion(): Promise<void> {
  // Se sobrescribe con los mismos atributos y caducidad inmediata para que el navegador la borre.
  (await cookies()).set(NOMBRE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}

/**
 * Dirección base para los enlaces. No se toma del encabezado Host de la solicitud,
 * que un atacante podría alterar para fabricar enlaces hacia otro sitio.
 */
export function urlBaseEnlaces(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "";
}

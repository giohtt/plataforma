import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Contraseñas con scrypt (incluido en Node). Formato guardado:
 *   scrypt$N$r$p$salBase64$huellaBase64
 * Los parámetros viajan con la huella para poder subirlos en el futuro sin romper las existentes.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const LONGITUD = 64;
const MEMORIA_MAXIMA = 64 * 1024 * 1024;

export const LONGITUD_MINIMA = 12;
export const LONGITUD_MAXIMA = 128;

function derivar(contrasena: string, sal: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolver, rechazar) => {
    scrypt(contrasena.normalize("NFKC"), sal, LONGITUD, { N: n, r, p, maxmem: MEMORIA_MAXIMA }, (e, clave) =>
      e ? rechazar(e) : resolver(clave),
    );
  });
}

export async function cifrarContrasena(contrasena: string): Promise<string> {
  const sal = randomBytes(16);
  const huella = await derivar(contrasena, sal, N, R, P);
  return `scrypt$${N}$${R}$${P}$${sal.toString("base64")}$${huella.toString("base64")}`;
}

export async function verificarContrasena(contrasena: string, guardada: string): Promise<boolean> {
  const partes = guardada.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;
  const [, n, r, p, sal, huella] = partes;
  const esperada = Buffer.from(huella, "base64");
  const calculada = await derivar(contrasena, Buffer.from(sal, "base64"), Number(n), Number(r), Number(p));
  return esperada.length === calculada.length && timingSafeEqual(esperada, calculada);
}

/**
 * Huella de una contraseña que nadie tiene. Se verifica contra ella cuando el correo no existe,
 * para que la respuesta tarde lo mismo y no revele qué correos están registrados.
 */
let huellaFicticia: Promise<string> | null = null;
export function obtenerHuellaFicticia(): Promise<string> {
  huellaFicticia ??= cifrarContrasena(randomBytes(32).toString("hex"));
  return huellaFicticia;
}

/** Devuelve el motivo por el que no se acepta la contraseña, o null si es válida. */
export function revisarContrasena(contrasena: string, confirmacion: string, correo: string): string | null {
  if (contrasena !== confirmacion) return "Las dos contraseñas no coinciden.";
  const largo = [...contrasena].length;
  if (largo < LONGITUD_MINIMA) return `Usa al menos ${LONGITUD_MINIMA} caracteres.`;
  if (largo > LONGITUD_MAXIMA) return `Usa como máximo ${LONGITUD_MAXIMA} caracteres.`;
  const local = correo.split("@")[0]?.toLowerCase() ?? "";
  if (contrasena.toLowerCase() === correo.toLowerCase() || (local.length >= 4 && contrasena.toLowerCase().includes(local))) {
    return "La contraseña no debe contener tu correo.";
  }
  return null;
}

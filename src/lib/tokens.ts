import { createHash, randomBytes } from "node:crypto";

/** Código aleatorio de 256 bits, apto para cookies y enlaces. */
export function generarToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Huella SHA-256 en hexadecimal. Es lo único que se guarda en la base. */
export function huellaToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Un token válido tiene exactamente el formato que genera generarToken. */
export function formatoTokenValido(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * Prepara la dirección de conexión que entrega el proveedor (por ejemplo, Neon) para el cliente `postgres`.
 *
 * - Quita `channel_binding`: es una opción de libpq que el cliente `postgres` enviaría al servidor como
 *   parámetro desconocido, y el servidor rechazaría la conexión.
 * - Para servidores que no son locales, exige `sslmode=verify-full`: cifrado y verificación del
 *   certificado del servidor, que protege contra suplantaciones.
 * - No registra ni devuelve la contraseña en ningún mensaje.
 *
 * @param {string} direccion
 * @returns {string}
 */
export function prepararUrlConexion(direccion) {
  const url = new URL(direccion);
  url.searchParams.delete("channel_binding");
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (!local) {
    const modo = url.searchParams.get("sslmode");
    if (modo !== "verify-full") url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

import { consultarEstadoBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";

/**
 * Comprobación básica: confirma que la aplicación responde y si la base de datos está conectada.
 * No devuelve datos de operación ni detalles de la conexión.
 */
export async function GET() {
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
  const baseDatos = await consultarEstadoBaseDatos();
  return Response.json(
    {
      estado: "ok",
      entorno: leerEntorno(),
      version,
      baseDatos: baseDatos.estado,
      migracionesAplicadas: baseDatos.migracionesAplicadas,
      hora: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

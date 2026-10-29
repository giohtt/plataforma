import { leerEntorno } from "@/lib/entorno";

/**
 * Comprobación básica: confirma que la aplicación responde.
 * No consulta la base de datos ni devuelve información de operación.
 */
export function GET() {
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
  return Response.json(
    {
      estado: "ok",
      entorno: leerEntorno(),
      version,
      hora: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

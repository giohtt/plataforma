import { obtenerBaseDatos } from "@/lib/db";
import { sucursalesAccesibles } from "@/lib/permisos";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

/**
 * Sucursales que la persona puede consultar. Sin sesión: 401. Solo devuelve las suyas;
 * la lista se filtra en la base con tiene_permiso, no en la pantalla.
 */
export async function GET() {
  const sesion = await obtenerSesionActual();
  if (!sesion) return Response.json({ error: "Sin sesión" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const sql = obtenerBaseDatos()!;
  const sucursales = await sucursalesAccesibles(sql, sesion.usuarioId);
  return Response.json(
    { sucursales: sucursales.map(({ id, codigo, nombre, estadoOperativo, perfiles }) => ({ id, codigo, nombre, estadoOperativo, perfiles })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

import { obtenerBaseDatos } from "@/lib/db";
import { sucursalAccesiblePorId } from "@/lib/permisos";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

/**
 * Detalle de una sucursal. Sin sesión: 401. Sin permiso para esa sucursal: 404, la misma
 * respuesta que si no existiera, para no revelar qué sucursales hay.
 */
export async function GET(_solicitud: Request, { params }: RouteContext<"/api/sucursales/[id]">) {
  const sinCache = { "Cache-Control": "no-store" };
  const sesion = await obtenerSesionActual();
  if (!sesion) return Response.json({ error: "Sin sesión" }, { status: 401, headers: sinCache });
  const { id } = await params;
  const sucursal = await sucursalAccesiblePorId(obtenerBaseDatos()!, sesion.usuarioId, id);
  if (!sucursal) return Response.json({ error: "No encontrada" }, { status: 404, headers: sinCache });
  return Response.json({ sucursal }, { headers: sinCache });
}

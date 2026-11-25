"use server";

/**
 * Dirección resuelve el faltante confirmado de un retiro o de un sobre recogido (bloque 5), por POST. Quién puede, el
 * estado del caso y el bloqueo de producción se comprueban en src/lib/resoluciones.ts y en la base.
 */
import { redirect } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { MENSAJES_RESOLUCION, resolverFaltanteRetiro, resolverFaltanteSobre } from "@/lib/resoluciones";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

export type EstadoResolverFaltante = { error?: string; errorMotivo?: string; motivo?: string; intento: number } | null;

async function inicio() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}
const leer = (datos: FormData, campo: string, max = 40) => {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
};

export async function accionResolverFaltante(previo: EstadoResolverFaltante, datos: FormData): Promise<EstadoResolverFaltante> {
  const { sesion, sql } = await inicio();
  const codigo = leer(datos, "codigo");
  const clase = leer(datos, "clase");
  const id = leer(datos, "id");
  const motivo = leer(datos, "motivo", 400);
  const intento = (previo?.intento ?? 0) + 1;
  if (motivo.trim().length < 5) return { error: "Revisa los campos marcados.", errorMotivo: MENSAJES_RESOLUCION.motivo, motivo, intento };
  const r = clase === "retiro"
    ? await resolverFaltanteRetiro(sql, sesion.usuarioId, codigo, { retiroId: id, motivo }, { entorno: leerEntorno() })
    : await resolverFaltanteSobre(sql, sesion.usuarioId, codigo, { diferenciaId: id, motivo }, { entorno: leerEntorno() });
  if (r.ok) redirect(clase === "retiro" ? `/sucursales/${codigo}/retiros/${id}?aviso=resuelto` : `/sucursales/${codigo}/recoleccion?aviso=resuelto`);
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errorMotivo: MENSAJES_RESOLUCION.motivo, motivo, intento };
  return { error: MENSAJES_RESOLUCION[r.error], motivo, intento };
}

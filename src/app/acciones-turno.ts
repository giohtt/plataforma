"use server";

/**
 * Apertura de turno, por POST. Aquí se leen la sesión y los dos totales; permisos, turno único, sucursal
 * inactiva y bloqueo en producción se comprueban en src/lib/turnos.ts.
 */
import { redirect } from "next/navigation";
import { leerImporte, MENSAJES_IMPORTE } from "@/lib/datos-turno";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";
import { abrirTurno } from "@/lib/turnos";

export type EstadoApertura = {
  error?: string;
  errores?: { bolsa?: string; cajon?: string };
  valores?: { bolsa: string; cajon: string };
  intento: number;
} | null;

const MENSAJES = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para abrir turno en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada: no se pueden abrir turnos.",
  ya_abierto: "Ya hay un turno de Recepción abierto en esta sucursal. Solo puede haber uno a la vez.",
  bloqueado_produccion: "La apertura de turnos está desactivada fuera del entorno de pruebas.",
} as const;

export async function accionAbrirTurno(previo: EstadoApertura, datos: FormData): Promise<EstadoApertura> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  const texto = (campo: string) => {
    const v = datos.get(campo);
    return typeof v === "string" ? v.slice(0, 30) : "";
  };
  const codigo = texto("codigo");
  const valores = { bolsa: texto("bolsa"), cajon: texto("cajon") };
  const intento = (previo?.intento ?? 0) + 1;

  const bolsa = leerImporte(valores.bolsa);
  const cajon = leerImporte(valores.cajon);
  if (!bolsa.ok || !cajon.ok) {
    return {
      error: "Revisa los totales.",
      errores: { bolsa: bolsa.ok ? undefined : MENSAJES_IMPORTE[bolsa.motivo], cajon: cajon.ok ? undefined : MENSAJES_IMPORTE[cajon.motivo] },
      valores,
      intento,
    };
  }
  const r = await abrirTurno(sql, sesion.usuarioId, codigo, { bolsa: bolsa.valor, cajon: cajon.valor }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/turno?aviso=abierto`);
  return { error: MENSAJES[r.error], valores, intento };
}

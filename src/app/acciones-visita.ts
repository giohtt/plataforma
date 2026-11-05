"use server";

/**
 * Visita individual en efectivo, por POST: revisar el cobro y confirmarlo. Aquí se leen la sesión y el
 * formulario; permisos, turno, responsable de la bolsa, ficha activa, repetidos y bloqueo en producción se
 * comprueban en src/lib/visitas.ts.
 */
import { redirect } from "next/navigation";
import { leerRecibido, MENSAJES_RECIBIDO } from "@/lib/datos-visita";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";
import { confirmarVisita, revisarVisita, type ErrorVisita, type ResumenVisita } from "@/lib/visitas";

const MENSAJES: Record<ErrorVisita, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para registrar visitas en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada: no se pueden registrar cobros.",
  sin_turno: "No hay turno abierto en esta sucursal. Abre el turno antes de cobrar.",
  turno_cambio: "El turno cambió después de revisar el cobro. No se guardó nada: revisa el cobro de nuevo.",
  no_responsable: "Solo la responsable de la bolsa de visitas puede cobrar en este turno. No se guardó nada.",
  visitante_no_encontrado: "No se encontró la ficha elegida. Búscala de nuevo.",
  visitante_unido: "Esta ficha se unió a otra. Búscala de nuevo y elige la ficha activa.",
  clave_ajena: "No se pudo confirmar este cobro. Revisa el cobro de nuevo.",
  bloqueado_produccion: "El registro de visitas está desactivado fuera del entorno de pruebas.",
};

function leer(datos: FormData, campo: string, max: number) {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
}

async function contextoAccion() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}

export type EstadoRevision = {
  error?: string;
  errorRecibido?: string;
  recibido: string;
  resumen?: ResumenVisita;
  intento: number;
} | null;

export async function accionRevisarVisita(previo: EstadoRevision, datos: FormData): Promise<EstadoRevision> {
  const { sesion, sql } = await contextoAccion();
  const intento = (previo?.intento ?? 0) + 1;
  const recibidoTexto = leer(datos, "recibido", 30);
  const r = leerRecibido(recibidoTexto);
  if (!r.ok) return { error: "Revisa lo recibido.", errorRecibido: MENSAJES_RECIBIDO[r.motivo], recibido: recibidoTexto, intento };
  const res = await revisarVisita(sql, sesion.usuarioId, leer(datos, "codigo", 10), {
    visitanteId: leer(datos, "visitanteId", 40), recibido: r.recibido, cambio: r.cambio,
  }, { entorno: leerEntorno() });
  if (!res.ok) return { error: MENSAJES[res.error], recibido: recibidoTexto, intento };
  return { resumen: res.resumen, recibido: recibidoTexto, intento };
}

export type EstadoConfirmacion = { error?: string; intento: number } | null;

/**
 * Confirma con lo que se mostró al revisar: la clave, el turno y la ficha. Lo recibido se valida otra vez
 * aquí (no se confía en el navegador): si no cubre el total, no se guarda.
 */
export async function accionConfirmarVisita(previo: EstadoConfirmacion, datos: FormData): Promise<EstadoConfirmacion> {
  const { sesion, sql } = await contextoAccion();
  const intento = (previo?.intento ?? 0) + 1;
  const codigo = leer(datos, "codigo", 10);
  const r = leerRecibido(leer(datos, "recibido", 30));
  if (!r.ok) return { error: MENSAJES_RECIBIDO[r.motivo], intento };
  const res = await confirmarVisita(sql, sesion.usuarioId, codigo, {
    clave: leer(datos, "clave", 40),
    turnoId: leer(datos, "turnoId", 40),
    visitanteId: leer(datos, "visitanteId", 40),
    recibido: r.recibido,
    cambio: r.cambio,
  }, { entorno: leerEntorno() });
  if (res.ok) redirect(`/sucursales/${codigo}/turno?aviso=visita`);
  return { error: MENSAJES[res.error], intento };
}

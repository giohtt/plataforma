"use server";

/**
 * Cobro de una visita individual en efectivo, por POST. Aquí se leen la sesión y el formulario; permisos,
 * turno, responsable de la bolsa, ficha activa, cobros repetidos y bloqueo en producción se comprueban en
 * src/lib/visitas.ts. La pantalla llama a esta acción directamente para poder reintentar con la misma clave
 * si se pierde la conexión.
 */
import { redirect } from "next/navigation";
import { leerRecibido, MENSAJES_RECIBIDO } from "@/lib/datos-visita";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";
import { confirmarVisita, type CobroRegistrado, type ErrorVisita } from "@/lib/visitas";

const MENSAJES: Record<ErrorVisita, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para registrar visitas en esta sucursal. No se guardó nada.",
  sucursal_inactiva: "Esta sucursal está desactivada: no se pueden registrar cobros. No se guardó nada.",
  sin_turno: "Ya no hay turno abierto en esta sucursal. No se guardó nada.",
  turno_cambio: "El turno cambió mientras cobrabas. No se guardó nada: vuelve a abrir «Registrar visita» desde el turno.",
  no_responsable: "Solo la responsable de la bolsa de visitas puede cobrar en este turno. No se guardó nada.",
  visitante_no_encontrado: "No se encontró la ficha elegida. Búscala de nuevo.",
  visitante_unido: "Esta ficha se unió a otra. Búscala de nuevo y elige la ficha activa.",
  clave_ajena: "No se pudo registrar este cobro. Vuelve a abrir «Registrar visita» desde el turno.",
  bloqueado_produccion: "El registro de visitas está desactivado fuera del entorno de pruebas.",
};

export type RespuestaCobro =
  | { ok: true; cobro: CobroRegistrado; repetida: boolean }
  | { ok: false; error: string; errorRecibido?: string };

export async function accionConfirmarVisita(datos: FormData): Promise<RespuestaCobro> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  const leer = (campo: string, max: number) => {
    const v = datos.get(campo);
    return typeof v === "string" ? v.slice(0, max) : "";
  };

  // Lo recibido se valida otra vez aquí: no se confía en el navegador.
  const r = leerRecibido(leer("recibido", 30));
  if (!r.ok) return { ok: false, error: "Revisa lo recibido.", errorRecibido: MENSAJES_RECIBIDO[r.motivo] };
  const res = await confirmarVisita(sql, sesion.usuarioId, leer("codigo", 10), {
    clave: leer("clave", 40),
    turnoId: leer("turnoId", 40),
    visitanteId: leer("visitanteId", 40),
    recibido: r.recibido,
    cambio: r.cambio,
  }, { entorno: leerEntorno() });
  if (!res.ok) return { ok: false, error: MENSAJES[res.error] };
  return { ok: true, cobro: res.cobro, repetida: res.repetida };
}

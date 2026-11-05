"use server";

/**
 * Cobro de visitas en efectivo o con tarjeta, de una persona o de un grupo (hasta 20), por POST. Aquí se leen la sesión y
 * el formulario; permisos, turno, responsable de la bolsa, fichas activas, cobros repetidos y bloqueo en
 * producción se comprueban en src/lib/visitas.ts. La pantalla llama a esta acción directamente para poder
 * reintentar con la misma clave si se pierde la conexión.
 */
import { redirect } from "next/navigation";
import {
  leerAutorizacion, leerRecibido, leerReferencia, MAXIMO_PERSONAS, MENSAJES_AUTORIZACION, MENSAJES_REFERENCIA, mensajeRecibido,
  totalVisitas, type FormaPago, type TipoReferencia,
} from "@/lib/datos-visita";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";
import { confirmarVisita, visitasDeHoy, type CobroPrevio, type CobroRegistrado, type ErrorVisita, type VisitaHoy } from "@/lib/visitas";

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
  datos_distintos: "Este cobro ya se había enviado con otras personas o con otro importe recibido. No se guardó nada.",
  grupo_vacio: "Agrega al menos una persona antes de confirmar.",
  grupo_grande: `Un cobro puede tener como máximo ${MAXIMO_PERSONAS} personas.`,
  persona_repetida: "La misma persona aparece dos veces en el grupo. No se guardó nada.",
  recibido_menor: "Lo recibido es menor que el total. No se guardó nada.",
  autorizacion_invalida: MENSAJES_AUTORIZACION.formato,
  autorizacion_repetida: "Esta autorización ya se registró hoy en esta sucursal. Revisa el cobro anterior: si es otra venta, confírmalo para continuar.",
  forma_invalida: "Elige un solo medio de pago para el cobro: efectivo, tarjeta o transferencia. No se guardó nada.",
  referencia_invalida: MENSAJES_REFERENCIA.formato,
  referencia_repetida: "Esta referencia ya está registrada en otro cobro. Revisa el cobro anterior: si es otra transferencia, confírmalo para continuar.",
  bloqueado_produccion: "El registro de visitas está desactivado fuera del entorno de pruebas.",
};

export type RespuestaCobro =
  | { ok: true; cobro: CobroRegistrado; repetida: boolean }
  | { ok: false; error: string; errorRecibido?: string; errorAutorizacion?: string; errorReferencia?: string; previos?: CobroPrevio[] };

/** Con tarjeta, un rechazo del servidor no significa que el pago no se cobró en la terminal. */
const NO_REPASAR = " El pago ya se cobró en la terminal: no vuelvas a pasar la tarjeta; registra este cobro con la misma autorización.";

export async function accionConfirmarVisita(datos: FormData): Promise<RespuestaCobro> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  const leer = (campo: string, max: number) => {
    const v = datos.get(campo);
    return typeof v === "string" ? v.slice(0, max) : "";
  };

  // Todo se valida otra vez aquí (no se confía en el navegador): un solo medio de pago por operación.
  const visitanteIds = datos.getAll("visitanteId").filter((x): x is string => typeof x === "string").slice(0, MAXIMO_PERSONAS + 1);
  const total = totalVisitas(Math.max(visitanteIds.length, 1));
  const forma = leer("formaPago", 15);
  const formaPago: FormaPago | null = forma === "efectivo" || forma === "tarjeta" || forma === "transferencia" ? forma : null;
  if (!formaPago) return { ok: false, error: MENSAJES.forma_invalida };

  let recibido: string | null = null;
  let cambio: string | null = null;
  let autorizacion: string | null = null;
  let referencia: string | null = null;
  let tipoReferencia: TipoReferencia | null = null;
  if (formaPago === "transferencia") {
    const tipo = leer("tipoReferencia", 20);
    if (tipo !== "clave_rastreo" && tipo !== "folio_bancario") return { ok: false, error: "Revisa la referencia.", errorReferencia: MENSAJES_REFERENCIA.tipo };
    const ref = leerReferencia(leer("referencia", 60));
    if (!ref.ok) return { ok: false, error: "Revisa la referencia.", errorReferencia: MENSAJES_REFERENCIA[ref.motivo] };
    referencia = ref.valor;
    tipoReferencia = tipo;
  } else if (formaPago === "efectivo") {
    const r = leerRecibido(leer("recibido", 30), total);
    if (!r.ok) return { ok: false, error: "Revisa lo recibido.", errorRecibido: mensajeRecibido(r.motivo, total) };
    ({ recibido, cambio } = r);
  } else {
    const a = leerAutorizacion(leer("autorizacion", 40));
    if (!a.ok) return { ok: false, error: "Revisa la autorización.", errorAutorizacion: MENSAJES_AUTORIZACION[a.motivo] };
    autorizacion = a.valor;
  }
  const res = await confirmarVisita(sql, sesion.usuarioId, leer("codigo", 10), {
    clave: leer("clave", 40),
    turnoId: leer("turnoId", 40),
    visitanteIds,
    formaPago,
    recibido,
    cambio,
    autorizacion,
    referencia,
    tipoReferencia,
    otraVenta: formaPago !== "efectivo" && datos.get("otraVenta") === "si",
  }, { entorno: leerEntorno() });
  if (!res.ok) {
    if (res.error === "autorizacion_repetida" || res.error === "referencia_repetida") return { ok: false, error: MENSAJES[res.error], previos: res.previos };
    const base = res.error === "visitante_unido" && res.detalle
      ? `La ficha de ${res.detalle} se unió a otra. Quítala del grupo, búscala de nuevo y elige la ficha activa. No se guardó nada.`
      : MENSAJES[res.error];
    return { ok: false, error: formaPago === "tarjeta" && res.error !== "datos_distintos" ? base + NO_REPASAR : base };
  }
  return { ok: true, cobro: res.cobro, repetida: res.repetida };
}

/** Para el aviso previo: quiénes del grupo ya tienen una visita registrada hoy. No bloquea el cobro. */
export async function accionVisitasDeHoy(codigo: string, visitanteIds: string[]): Promise<VisitaHoy[]> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  if (typeof codigo !== "string" || !Array.isArray(visitanteIds)) return [];
  return (await visitasDeHoy(sql, sesion.usuarioId, codigo, visitanteIds.filter((x) => typeof x === "string"))) ?? [];
}

"use server";

/**
 * Cancelación de un cobro duplicado en efectivo, por POST. Aquí se leen la sesión y el formulario; permisos,
 * facultad con límite, turno abierto, cobro que se conserva y quién no puede aprobar se comprueban en
 * src/lib/cancelaciones.ts.
 */
import { redirect } from "next/navigation";
import { resolverCancelacion, solicitarCancelacion, type ErrorResolucion, type ErrorSolicitud } from "@/lib/cancelaciones";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

const SOLICITUD: Record<ErrorSolicitud, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no puede solicitar cancelaciones en esta sucursal.",
  no_cancelable: "Solo se puede pedir la cancelación de un cobro en efectivo vigente.",
  turno_no_abierto: "El cobro es de un turno que ya no está abierto. Los turnos cerrados se verán en otro paso.",
  no_responsable: "Solo la responsable de la bolsa de este turno puede solicitar la cancelación.",
  entrega_en_curso: "El turno se está entregando: no se pueden solicitar cancelaciones hasta que la entrante confirme o se cancele la entrega.",
  ya_solicitada: "Este cobro ya tiene una solicitud de cancelación.",
  conserva_invalido: "Elige el cobro correcto que se conserva: del mismo turno, en efectivo, por el mismo total y con las mismas personas.",
  explicacion: "Explica qué pasó (de 5 a 300 caracteres).",
  sin_confirmar: "Confirma que el dinero de este cobro no entró: el dinero físico es el del cobro que se conserva.",
  bloqueado_produccion: "Las cancelaciones están desactivadas fuera del entorno de pruebas.",
};

const RESOLUCION: Record<ErrorResolucion, string> = {
  no_encontrada: "No encontrada.",
  propia: "No puedes aprobar ni rechazar una cancelación que tú pediste.",
  registro_propio: "No puedes aprobar ni rechazar la cancelación de un cobro que tú registraste.",
  excede_limite: "El importe es mayor que tu límite para autorizar cancelaciones.",
  cambio: "La solicitud cambió mientras la revisabas. Recarga la página para ver su estado actual.",
  conserva_invalido: "El cobro que se conserva ya no está vigente. No se aprobó nada.",
  turno_no_abierto: "El turno del cobro ya no está abierto. Los turnos cerrados se verán en otro paso.",
  motivo: "Explica por qué se rechaza (de 5 a 300 caracteres).",
  bloqueado_produccion: "Las cancelaciones están desactivadas fuera del entorno de pruebas.",
};

function leer(datos: FormData, campo: string, max: number) {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
}
async function contexto() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}

export type EstadoCancelacion = { error?: string; id?: string; intento: number } | null;

export async function accionSolicitarCancelacion(previo: EstadoCancelacion, datos: FormData): Promise<EstadoCancelacion> {
  const { sesion, sql } = await contexto();
  const intento = (previo?.intento ?? 0) + 1;
  const codigo = leer(datos, "codigo", 10);
  const operacionId = leer(datos, "operacionId", 40);
  const r = await solicitarCancelacion(sql, sesion.usuarioId, codigo, operacionId, {
    conservaOperacionId: leer(datos, "conserva", 40),
    explicacion: leer(datos, "explicacion", 400),
    sinDinero: datos.get("sinDinero") === "si",
  }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/turno/cobros/${operacionId}?aviso=solicitada`);
  return { error: SOLICITUD[r.error], intento };
}

export async function accionResolverCancelacion(previo: EstadoCancelacion, datos: FormData): Promise<EstadoCancelacion> {
  const { sesion, sql } = await contexto();
  const intento = (previo?.intento ?? 0) + 1;
  const codigo = leer(datos, "codigo", 10);
  const id = leer(datos, "id", 40);
  const decision = leer(datos, "decision", 10) === "aprobar" ? "aprobar" : "rechazar";
  const version = Number(leer(datos, "version", 10));
  const r = await resolverCancelacion(sql, sesion.usuarioId, codigo, id, {
    version: Number.isInteger(version) ? version : 0, decision, motivo: leer(datos, "motivo", 400),
  }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/cancelaciones?aviso=${decision === "aprobar" ? "aprobada" : "rechazada"}`);
  return { error: RESOLUCION[r.error], id, intento };
}

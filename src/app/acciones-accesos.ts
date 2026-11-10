"use server";

/**
 * Registro de accesos (apertura manual) del piloto de Tenango, por POST. Aquí se leen la sesión y el formulario;
 * permisos, turno abierto, vigencia del pase, autorizaciones y quién no puede aprobar se comprueban en
 * src/lib/accesos.ts (y otra vez en la base).
 */
import { redirect } from "next/navigation";
import {
  completarMotivo, pedirAutorizacion, registrarAcceso, registrarSinPase, resolverAutorizacion, type ErrorAcceso,
} from "@/lib/accesos";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

const MENSAJES: Record<ErrorAcceso, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no puede registrar aperturas en esta sucursal.",
  sin_turno: "No hay turno abierto en esta sucursal: las aperturas se registran durante el turno.",
  pase_invalido: "No se encontró el pase. Recarga la página.",
  otra_sucursal: "El pase es de otra sucursal: aquí necesita un pase nuevo.",
  otro_dia: "El pase solo vale el día del cobro: hoy necesita un pase nuevo.",
  no_vigente: "Este pase ya no está vigente (cobro cancelado o transferencia no localizada).",
  ya_entro: "Esta persona ya tiene su entrada con este pase. Si volvió, registra un reingreso.",
  sin_entrada: "Primero registra la entrada con este pase.",
  requiere_autorizacion: "Necesita una autorización aprobada antes de registrar la entrada.",
  autorizacion_invalida: "La autorización no corresponde a este acceso.",
  ya_solicitada: "Ya hay una solicitud de autorización para este pase.",
  no_pendiente: "Este pase no necesita autorización: registra la entrada.",
  nota: "Escribe qué muestra el visitante o por qué lo pides (de 5 a 300 caracteres).",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
  detalle: "Escribe el detalle del motivo (de 5 a 300 caracteres).",
  clave: "No se pudo registrar. Recarga la página e inténtalo de nuevo.",
  propia: "No puedes resolver una autorización que tú pediste.",
  registro_propio: "No puedes resolver la autorización de un cobro que tú registraste.",
  cambio: "La solicitud cambió mientras la revisabas. Recarga la página para ver su estado actual.",
  ya_completado: "El motivo de esta emergencia ya se había completado.",
  bloqueado_produccion: "El registro de accesos está desactivado fuera del entorno de pruebas.",
};

export type EstadoAcceso = { error?: string; intento: number } | null;

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
/** A dónde volver: solo páginas de la misma sucursal (nunca otro sitio). */
function volverA(datos: FormData, codigo: string, aviso: string) {
  const v = leer(datos, "volver", 200);
  const base = v.startsWith(`/sucursales/${codigo}/`) && !v.includes("//") && !v.includes("?") ? v : `/sucursales/${codigo}/turno/accesos`;
  const [ruta, ancla] = base.split("#");
  return `${ruta}?aviso=${aviso}${ancla ? `#${ancla}` : ""}`;
}

export async function accionRegistrarAcceso(previo: EstadoAcceso, datos: FormData): Promise<EstadoAcceso> {
  const { sesion, sql } = await contexto();
  const intento = (previo?.intento ?? 0) + 1;
  const codigo = leer(datos, "codigo", 10);
  const tipo = leer(datos, "tipo", 20) === "reingreso" ? "reingreso" : "entrada";
  const r = await registrarAcceso(sql, sesion.usuarioId, codigo, {
    clave: leer(datos, "clave", 40), paseId: leer(datos, "paseId", 40), tipo,
  }, { entorno: leerEntorno() });
  if (!r.ok) return { error: MENSAJES[r.error], intento };
  redirect(volverA(datos, codigo, tipo));
}

export async function accionPedirAutorizacion(previo: EstadoAcceso, datos: FormData): Promise<EstadoAcceso> {
  const { sesion, sql } = await contexto();
  const intento = (previo?.intento ?? 0) + 1;
  const codigo = leer(datos, "codigo", 10);
  const tipo = leer(datos, "tipo", 30) === "visita_sin_cobro" ? "visita_sin_cobro" : "transferencia_pendiente";
  const r = await pedirAutorizacion(sql, sesion.usuarioId, codigo, {
    tipo, paseId: leer(datos, "paseId", 40) || undefined, nota: leer(datos, "nota", 400),
  }, { entorno: leerEntorno() });
  if (!r.ok) return { error: MENSAJES[r.error], intento };
  redirect(volverA(datos, codigo, "autorizacion"));
}

export async function accionResolverAutorizacion(previo: EstadoAcceso, datos: FormData): Promise<EstadoAcceso> {
  const { sesion, sql } = await contexto();
  const intento = (previo?.intento ?? 0) + 1;
  const codigo = leer(datos, "codigo", 10);
  const decision = leer(datos, "decision", 10) === "rechazar" ? "rechazar" : "aprobar";
  const r = await resolverAutorizacion(sql, sesion.usuarioId, codigo, leer(datos, "id", 40), {
    version: Number(leer(datos, "version", 10)) || 0, decision, motivo: leer(datos, "motivo", 400),
  }, { entorno: leerEntorno() });
  if (!r.ok) return { error: MENSAJES[r.error], intento };
  redirect(`/sucursales/${codigo}/accesos?aviso=${decision === "aprobar" ? "aprobada" : "rechazada"}`);
}

export async function accionSinPase(previo: EstadoAcceso, datos: FormData): Promise<EstadoAcceso> {
  const { sesion, sql } = await contexto();
  const intento = (previo?.intento ?? 0) + 1;
  const codigo = leer(datos, "codigo", 10);
  const motivo = leer(datos, "motivo", 30);
  const r = await registrarSinPase(sql, sesion.usuarioId, codigo, {
    clave: leer(datos, "clave", 40), motivo, detalle: leer(datos, "detalle", 400),
    autorizacionId: leer(datos, "autorizacionId", 40) || undefined,
  }, { entorno: leerEntorno() });
  if (!r.ok) return { error: MENSAJES[r.error], intento };
  redirect(volverA(datos, codigo, motivo === "emergencia" ? "emergencia" : "sin_pase"));
}

export async function accionCompletarMotivo(previo: EstadoAcceso, datos: FormData): Promise<EstadoAcceso> {
  const { sesion, sql } = await contexto();
  const intento = (previo?.intento ?? 0) + 1;
  const codigo = leer(datos, "codigo", 10);
  const r = await completarMotivo(sql, sesion.usuarioId, codigo, leer(datos, "id", 40), { detalle: leer(datos, "detalle", 400) }, { entorno: leerEntorno() });
  if (!r.ok) return { error: MENSAJES[r.error], intento };
  redirect(volverA(datos, codigo, "motivo"));
}

"use server";

/**
 * Cambio de turno (bloque 5), por POST. Aquí se leen la sesión y los datos del formulario; quién entrega, a quién,
 * quién recibe, el bloqueo de cobros y el de producción se comprueban en src/lib/entregas.ts.
 */
import { redirect } from "next/navigation";
import { leerImporte, MENSAJES_IMPORTE } from "@/lib/datos-turno";
import { obtenerBaseDatos } from "@/lib/db";
import { cancelarEntrega, recibirTurno, registrarEntrega, type ErrorEntrega } from "@/lib/entregas";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

export type EstadoFormularioEntrega = {
  error?: string;
  errores?: { bolsa?: string; cajon?: string; recibe?: string; nota?: string; aclaracion?: string; motivo?: string };
  valores?: Record<string, string>;
  intento: number;
} | null;

const MENSAJES: Record<ErrorEntrega | "sin_entrega", string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para esta entrega en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada: no se pueden entregar ni recibir turnos.",
  sin_turno: "No hay turno abierto en esta sucursal.",
  no_responsable: "Solo la responsable vigente de la bolsa y del cajón puede entregar el turno.",
  entrega_en_curso: "Ya hay una entrega en curso en este turno.",
  cancelaciones_pendientes: "Hay solicitudes de cancelación pendientes en este turno: deben resolverse antes de entregar.",
  receptor: "Elige a otra persona de Recepción de esta sucursal para recibir.",
  nota: "La nota debe tener entre 5 y 300 caracteres, o déjala vacía.",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
  aclaracion: "Escribe la aclaración del recuento (de 5 a 300 caracteres).",
  cambio: "La entrega cambió mientras la tenías abierta. Revisa los datos actuales.",
  sin_entrega: "No tienes una entrega pendiente de recibir en esta sucursal.",
  bloqueado_produccion: "El cambio de turno está desactivado fuera del entorno de pruebas.",
};

async function inicio() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}
const lector = (datos: FormData) => (campo: string, max = 30) => {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
};
function importes(valores: { bolsa: string; cajon: string }) {
  const bolsa = leerImporte(valores.bolsa);
  const cajon = leerImporte(valores.cajon);
  if (bolsa.ok && cajon.ok) return { ok: true as const, conteo: { bolsa: bolsa.valor, cajon: cajon.valor } };
  return {
    ok: false as const,
    errores: { bolsa: bolsa.ok ? undefined : MENSAJES_IMPORTE[bolsa.motivo], cajon: cajon.ok ? undefined : MENSAJES_IMPORTE[cajon.motivo] },
  };
}

export async function accionEntregarTurno(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { bolsa: leer("bolsa"), cajon: leer("cajon"), recibe: leer("recibe", 40), nota: leer("nota", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const i = importes(valores);
  const sinReceptor = !valores.recibe;
  if (!i.ok || sinReceptor) {
    return {
      error: "Revisa los campos marcados.",
      errores: { ...(i.ok ? {} : i.errores), recibe: sinReceptor ? "Elige quién recibe." : undefined },
      valores, intento,
    };
  }
  const r = await registrarEntrega(sql, sesion.usuarioId, codigo,
    { turnoId: leer("turno", 40), conteo: i.conteo, recibe: valores.recibe, nota: valores.nota }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/turno?aviso=entregado`);
  if (r.error === "nota") return { error: "Revisa los campos marcados.", errores: { nota: MENSAJES.nota }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

export async function accionCancelarEntrega(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await cancelarEntrega(sql, sesion.usuarioId, codigo,
    { entregaId: leer("entrega", 40), version: Number(leer("version")), motivo: valores.motivo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/turno?aviso=entrega-cancelada`);
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errores: { motivo: MENSAJES.motivo }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

export async function accionRecibirTurno(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { bolsa: leer("bolsa"), cajon: leer("cajon"), aclaracion: leer("aclaracion", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const i = importes(valores);
  if (!i.ok) return { error: "Revisa los campos marcados.", errores: i.errores, valores, intento };
  const r = await recibirTurno(sql, sesion.usuarioId, codigo,
    { entregaId: leer("entrega", 40), version: Number(leer("version")), conteo: i.conteo, aclaracion: valores.aclaracion },
    { entorno: leerEntorno() });
  if (r.ok && r.resultado === "confirmada") redirect(`/sucursales/${codigo}/turno?aviso=recibido`);
  if (r.ok) redirect(`/sucursales/${codigo}/turno/recibir?aviso=recuento`);
  if (r.error === "aclaracion") return { error: "Revisa los campos marcados.", errores: { aclaracion: MENSAJES.aclaracion }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

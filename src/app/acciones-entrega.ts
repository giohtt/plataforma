"use server";

/**
 * Cambio de turno (bloque 5), por POST. Aquí se leen la sesión y los datos del formulario; quién entrega, a quién,
 * quién recibe, el bloqueo de cobros y el de producción se comprueban en src/lib/entregas.ts.
 */
import { redirect } from "next/navigation";
import { importes, leerApoyo, leerLlaveFormulario, leerVerificacionSobres, MENSAJES_VERIFICACION } from "@/lib/formulario-conteo";
import { obtenerBaseDatos } from "@/lib/db";
import { cancelarEntrega, confirmarApoyo, recibirTurno, registrarEntrega, type ErrorEntrega } from "@/lib/entregas";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

export type EstadoFormularioEntrega = {
  error?: string;
  errores?: { bolsa?: string; cajon?: string; recibe?: string; nota?: string; aclaracion?: string; motivo?: string; apoyo?: string; [campo: string]: string | undefined };
  valores?: Record<string, string>;
  personas?: string[];
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
  apoyo: "Indica si alguien te ayudó a contar y, si sí, elige a las personas de la sucursal que participaron.",
  cambio: "La entrega cambió mientras la tenías abierta. Revisa los datos actuales.",
  sin_entrega: "No tienes una entrega pendiente de recibir en esta sucursal.",
  sobres: MENSAJES_VERIFICACION.sobres,
  estado: MENSAJES_VERIFICACION.estado,
  folio_visto: MENSAJES_VERIFICACION.folio_visto,
  motivo_llave: "Indica si recibiste la llave del cajón de los fondos y, si hay un problema, escribe el motivo (de 5 a 300 caracteres).",
  motivo_llave_caja: "Indica si recibiste la llave de la caja de sobres y, si hay un problema, escribe el motivo (de 5 a 300 caracteres).",
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
export async function accionEntregarTurno(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { bolsa: leer("bolsa"), cajon: leer("cajon"), recibe: leer("recibe", 40), nota: leer("nota", 400), apoyo: leer("apoyo") };
  const intento = (previo?.intento ?? 0) + 1;
  const i = importes(valores);
  const a = leerApoyo(datos);
  const sinReceptor = !valores.recibe;
  if (!i.ok || sinReceptor || !a.ok) {
    return {
      error: "Revisa los campos marcados.",
      errores: { ...(i.ok ? {} : i.errores), recibe: sinReceptor ? "Elige quién recibe." : undefined, apoyo: a.ok ? undefined : MENSAJES.apoyo },
      valores, personas: a.personas, intento,
    };
  }
  const r = await registrarEntrega(sql, sesion.usuarioId, codigo,
    { turnoId: leer("turno", 40), conteo: i.conteo, recibe: valores.recibe, nota: valores.nota, apoyo: a.apoyo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/turno?aviso=entregado`);
  if (r.error === "nota") return { error: "Revisa los campos marcados.", errores: { nota: MENSAJES.nota }, valores, personas: a.personas, intento };
  if (r.error === "apoyo") return { error: "Revisa los campos marcados.", errores: { apoyo: MENSAJES.apoyo }, valores, personas: a.personas, intento };
  return { error: MENSAJES[r.error], valores, personas: a.personas, intento };
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
  const { sobres, valores: vs } = leerVerificacionSobres(datos);
  const llave = leerLlaveFormulario(datos);
  const llaveCaja = leerLlaveFormulario(datos, "llave_caja");
  const conCaja = leer("caja") === "si";
  const valores = {
    ...vs, bolsa: leer("bolsa"), cajon: leer("cajon"), aclaracion: leer("aclaracion", 400), apoyo: leer("apoyo"),
    llave: llave.estado, motivo_llave: llave.motivo, llave_caja: llaveCaja.estado, motivo_llave_caja: llaveCaja.motivo,
  };
  const intento = (previo?.intento ?? 0) + 1;
  const i = importes(valores);
  const a = leerApoyo(datos);
  const elegida = (l: { estado: string }) => l.estado === "correcta" || l.estado === "incidencia";
  const sinLlave = conCaja && !elegida(llave);
  // Con buzón no hay llave de la caja de sobres en el turno (solo la del cajón).
  const sinLlaveCaja = conCaja && leer("buzon") !== "si" && !elegida(llaveCaja);
  if (!i.ok || !a.ok || sinLlave || sinLlaveCaja) {
    return {
      error: "Revisa los campos marcados.",
      errores: {
        ...(i.ok ? {} : i.errores), apoyo: a.ok ? undefined : MENSAJES.apoyo,
        motivo_llave: sinLlave ? MENSAJES.motivo_llave : undefined, motivo_llave_caja: sinLlaveCaja ? MENSAJES.motivo_llave_caja : undefined,
      },
      valores, personas: a.personas, intento,
    };
  }
  const r = await recibirTurno(sql, sesion.usuarioId, codigo,
    { entregaId: leer("entrega", 40), version: Number(leer("version")), conteo: i.conteo, aclaracion: valores.aclaracion, apoyo: a.apoyo,
      caja: conCaja ? { sobres, llaveCaja, llaveCajon: llave } : undefined },
    { entorno: leerEntorno() });
  if (r.ok && r.resultado === "confirmada") redirect(`/sucursales/${codigo}/turno?aviso=recibido`);
  if (r.ok) redirect(`/sucursales/${codigo}/turno/recibir?aviso=recuento`);
  if (r.error === "aclaracion") return { error: "Revisa los campos marcados.", errores: { aclaracion: MENSAJES.aclaracion }, valores, personas: a.personas, intento };
  if (r.error === "apoyo") return { error: "Revisa los campos marcados.", errores: { apoyo: MENSAJES.apoyo }, valores, personas: a.personas, intento };
  if (r.error === "motivo_llave" || r.error === "motivo_llave_caja") {
    return { error: "Revisa los campos marcados.", errores: { [r.error]: MENSAJES[r.error] }, valores, personas: a.personas, intento };
  }
  if (r.error in MENSAJES_VERIFICACION) {
    const campo = r.sobreId ? `sobre-${r.sobreId}` : "sobres";
    return { error: "Revisa los campos marcados.", errores: { [campo]: MENSAJES_VERIFICACION[r.error] }, valores, personas: a.personas, intento };
  }
  return { error: MENSAJES[r.error], valores, personas: a.personas, intento };
}

/** La persona declarada como apoyo confirma su participación desde su propia cuenta. */
export async function accionConfirmarApoyo(datos: FormData): Promise<void> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const r = await confirmarApoyo(sql, sesion.usuarioId, codigo, leer("apoyo", 40), { entorno: leerEntorno() });
  redirect(`/sucursales/${codigo}/apoyos?aviso=${r.ok ? "confirmado" : r.error}`);
}

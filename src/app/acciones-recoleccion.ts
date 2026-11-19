"use server";

/**
 * Recolección semanal de los sobres guardados (bloque 5, regla 7), por POST. Quién entrega, quién recoge, el conteo a
 * ciegas, las diferencias, los depósitos y producción se comprueban en src/lib/recolecciones.ts.
 */
import { redirect } from "next/navigation";
import type { EstadoFormularioEntrega } from "@/app/acciones-entrega";
import { leerImporte, MENSAJES_IMPORTE } from "@/lib/datos-turno";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { leerLlaveFormulario, leerVerificacionSobres, MENSAJES_VERIFICACION } from "@/lib/formulario-conteo";
import {
  cancelarEntregaSobres, confirmarRecoleccion, recogerBuzon, registrarDepositoRecoleccion, registrarDevolucion, registrarEntregaSobres, revisarDiferenciaSobre,
  revisarIncidenciaLlave,
  type ErrorRecoleccion,
} from "@/lib/recolecciones";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

async function inicio() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}
const lector = (datos: FormData) => (campo: string, max = 40) => {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
};
const MARCADOS = "Revisa los campos marcados.";
const MENSAJES: Record<ErrorRecoleccion, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para esto en esta sucursal.",
  sin_turno: "Se entrega con un turno abierto: abre el turno primero.",
  no_responsable: "Entrega los sobres la responsable que tiene el turno (y la llave).",
  entrega_en_curso: "Hay un cambio de turno pendiente o en recuento: confírmalo o cancélalo antes de entregar sobres.",
  ya_pendiente: "Ya hay una entrega de sobres pendiente en esta sucursal: que Dirección la confirme o cancélala.",
  sobres: "Elige al menos un sobre de la caja.",
  recibe: "Elige a la persona de Dirección que recoge.",
  sin_pendiente: "No tienes una entrega de sobres pendiente en esta sucursal.",
  cambio: "La entrega cambió mientras tenías la pantalla abierta. Revisa los datos actuales.",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
  contado: "Escribe lo que contaste en cada sobre (si no hay dinero, escribe 0).",
  motivo_llave: "Si hay un problema con la caja o la llave, escribe el motivo (de 5 a 300 caracteres).",
  importe: "Escribe el importe depositado, mayor que 0.",
  fecha: "La fecha del depósito no puede ser anterior a la recolección ni futura.",
  referencia: "Escribe una referencia ficticia del depósito (de 3 a 60 caracteres).",
  saldo: "El depósito no puede ser mayor que lo que falta por depositar.",
  resultado: "Elige un resultado que corresponda a la diferencia.",
  participaste: "Participaste en la cadena de este sobre: lo revisa otra persona de Administración.",
  devolucion_pendiente: "Hay una entrega cancelada por devolver: registra primero que los sobres volvieron a la caja.",
  sin_devolucion: "No hay una devolución pendiente con esos datos.",
  devuelve_misma: "Quien devuelve los sobres no registra que los recibe: lo hace la responsable en turno.",
  buzon: "Con buzón no hay entrega: Dirección recoge directamente del buzón.",
  sin_llave_buzon: "Solo Dirección con la llave del buzón lo abre y recoge los sobres.",
  buzon_vacio: "No hay sobres registrados como depositados en el buzón.",
  estado: MENSAJES_VERIFICACION.estado,
  folio_visto: MENSAJES_VERIFICACION.folio_visto,
  bloqueado_produccion: "La recolección está desactivada fuera del entorno de pruebas.",
};

export async function accionEntregarSobres(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 10);
  const sobres = datos.getAll("entregar").filter((s): s is string => typeof s === "string").slice(0, 60).map((s) => s.slice(0, 40));
  const valores = { recibe: leer("recibe"), entregar: sobres.join(",") };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await registrarEntregaSobres(sql, sesion.usuarioId, codigo, { sobres, recibe: valores.recibe }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/recoleccion?aviso=entregados`);
  if (r.error === "sobres" || r.error === "recibe") return { error: MARCADOS, errores: { [r.error]: MENSAJES[r.error] }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

export async function accionCancelarEntregaSobres(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 10);
  const valores = { motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await cancelarEntregaSobres(sql, sesion.usuarioId, codigo,
    { recoleccionId: leer("recoleccion"), version: Number(leer("version")), motivo: valores.motivo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/recoleccion?aviso=cancelada`);
  if (r.error === "motivo") return { error: MARCADOS, errores: { motivo: MENSAJES.motivo }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

export async function accionConfirmarRecoleccion(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 10);
  const { sobres, valores: vs } = leerVerificacionSobres(datos, 60);
  const llave = leerLlaveFormulario(datos, "llave_caja");
  const valores: Record<string, string> = { ...vs, llave_caja: llave.estado, motivo_llave_caja: llave.motivo };
  const errores: Record<string, string> = {};
  const conteo = sobres.map((s) => {
    const contado = leer(`contado-${s.sobreId}`, 30);
    valores[`contado-${s.sobreId}`] = contado;
    const i = leerImporte(contado);
    if (!i.ok) errores[`contado-${s.sobreId}`] = MENSAJES_IMPORTE[i.motivo];
    return { ...s, contado };
  });
  const intento = (previo?.intento ?? 0) + 1;
  if (Object.keys(errores).length) return { error: MARCADOS, errores, valores, intento };
  const r = await confirmarRecoleccion(sql, sesion.usuarioId, codigo,
    { recoleccionId: leer("recoleccion"), version: Number(leer("version")), sobres: conteo, llave: llave.estado ? llave : undefined },
    { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/recoleccion?aviso=recogida&diferencias=${r.diferencias}`);
  if (r.error === "contado" && r.sobreId) return { error: MARCADOS, errores: { [`contado-${r.sobreId}`]: MENSAJES.contado }, valores, intento };
  if (r.error in MENSAJES_VERIFICACION && r.error !== "motivo") {
    return { error: MARCADOS, errores: { [r.sobreId ? `sobre-${r.sobreId}` : "sobres"]: MENSAJES_VERIFICACION[r.error] }, valores, intento };
  }
  if (r.error === "motivo" && r.sobreId) return { error: MARCADOS, errores: { [`sobre-${r.sobreId}`]: MENSAJES.motivo }, valores, intento };
  if (r.error === "motivo_llave") return { error: MARCADOS, errores: { motivo_llave_caja: MENSAJES.motivo_llave }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

/** Dirección abre el buzón: verifica y cuenta a ciegas cada sobre registrado como depositado. */
export async function accionRecogerBuzon(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 10);
  const { sobres, valores: vs } = leerVerificacionSobres(datos, 60);
  const llave = leerLlaveFormulario(datos, "llave_caja");
  const valores: Record<string, string> = { ...vs, llave_caja: llave.estado, motivo_llave_caja: llave.motivo };
  const errores: Record<string, string> = {};
  const conteo = sobres.map((s) => {
    const contado = leer(`contado-${s.sobreId}`, 30);
    valores[`contado-${s.sobreId}`] = contado;
    // Si el sobre no está, no se cuenta.
    if (s.estado !== "falta") {
      const i = leerImporte(contado);
      if (!i.ok) errores[`contado-${s.sobreId}`] = MENSAJES_IMPORTE[i.motivo];
    }
    return { ...s, contado };
  });
  const intento = (previo?.intento ?? 0) + 1;
  if (Object.keys(errores).length) return { error: MARCADOS, errores, valores, intento };
  const r = await recogerBuzon(sql, sesion.usuarioId, codigo, { sobres: conteo, llave }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/recoleccion?aviso=recogida&diferencias=${r.diferencias}&investigar=${r.investigar}`);
  if (r.error === "contado" && r.sobreId) return { error: MARCADOS, errores: { [`contado-${r.sobreId}`]: MENSAJES.contado }, valores, intento };
  if (r.error === "motivo" && r.sobreId) return { error: MARCADOS, errores: { [`sobre-${r.sobreId}`]: MENSAJES.motivo }, valores, intento };
  if (r.error in MENSAJES_VERIFICACION && r.error !== "motivo") {
    return { error: MARCADOS, errores: { [r.sobreId ? `sobre-${r.sobreId}` : "sobres"]: MENSAJES_VERIFICACION[r.error] }, valores, intento };
  }
  if (r.error === "motivo_llave") {
    return { error: MARCADOS, errores: { motivo_llave_caja: "Indica si el buzón estaba cerrado con llave; si hay un problema, escribe el motivo (de 5 a 300 caracteres)." }, valores, intento };
  }
  return { error: MENSAJES[r.error], valores, intento };
}

export async function accionRegistrarDevolucion(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 10);
  const { sobres, valores: vs } = leerVerificacionSobres(datos, 60);
  const llave = leerLlaveFormulario(datos, "llave_caja");
  const valores: Record<string, string> = { ...vs, llave_caja: llave.estado, motivo_llave_caja: llave.motivo };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await registrarDevolucion(sql, sesion.usuarioId, codigo, { recoleccionId: leer("recoleccion"), sobres, llave }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/recoleccion?aviso=devuelta&pendientes=${r.pendientes}&incidencias=${r.incidencias}`);
  if (r.error === "motivo_llave") {
    return { error: MARCADOS, errores: { motivo_llave_caja: "Indica si la caja de sobres está cerrada y tienes su llave; si hay un problema, escribe el motivo." }, valores, intento };
  }
  if (r.error in MENSAJES_VERIFICACION) {
    return { error: MARCADOS, errores: { [r.sobreId ? `sobre-${r.sobreId}` : "sobres"]: MENSAJES_VERIFICACION[r.error] }, valores, intento };
  }
  return { error: MENSAJES[r.error], valores, intento };
}

export async function accionRegistrarDeposito(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 10);
  const valores = { importe: leer("importe", 30), fecha: leer("fecha", 10), referencia: leer("referencia", 80) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await registrarDepositoRecoleccion(sql, sesion.usuarioId, codigo, { recoleccionId: leer("recoleccion"), ...valores }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/recoleccion?aviso=deposito`);
  if (r.error === "importe" || r.error === "saldo") return { error: MARCADOS, errores: { importe: MENSAJES[r.error] }, valores, intento };
  if (r.error === "fecha" || r.error === "referencia") return { error: MARCADOS, errores: { [r.error]: MENSAJES[r.error] }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

export async function accionRevisarDiferenciaSobre(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 10);
  const valores = { resultado: leer("resultado", 30), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await revisarDiferenciaSobre(sql, sesion.usuarioId, codigo, { diferenciaId: leer("diferencia"), ...valores }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/recoleccion?aviso=revisada`);
  if (r.error === "motivo" || r.error === "resultado") return { error: MARCADOS, errores: { [r.error]: MENSAJES[r.error] }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

export async function accionRevisarIncidenciaLlave(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 10);
  const valores = { resultado: leer("resultado", 30), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await revisarIncidenciaLlave(sql, sesion.usuarioId, codigo, { incidenciaId: leer("incidencia"), ...valores }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/recoleccion?aviso=revisada`);
  if (r.error === "motivo" || r.error === "resultado") return { error: MARCADOS, errores: { [r.error]: MENSAJES[r.error] }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

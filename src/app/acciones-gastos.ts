"use server";

/**
 * Solicitudes de gasto (bloque 6, PR 3), por POST. Aquí se leen la sesión y el formulario; quién puede solicitar o
 * corregir y el bloqueo en producción se comprueban en src/lib/gastos.ts y la base los respalda.
 */
import { redirect } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { corregirGasto, decidirGasto, pedirExcedente, registrarComprobante, registrarPago, solicitarGasto, TEXTO_IMPEDIMENTO, type ErrorGasto } from "@/lib/gastos";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

export type EstadoGasto = { error?: string; errores?: Partial<Record<string, string>>; valores?: Record<string, string>; intento: number } | null;

const MENSAJES: Record<ErrorGasto, string> = {
  sin_permiso: "Tu cuenta no tiene permiso para esto en esta sucursal.",
  no_encontrada: "No encontrada.",
  concepto: "Escribe qué se va a comprar o pagar (de 3 a 120 caracteres).",
  categoria: "Elige una categoría.",
  importe: "Escribe el importe en pesos, mayor que 0 (por ejemplo 350 o 1,200.50).",
  proveedor: "El proveedor debe tener de 2 a 120 caracteres (o déjalo vacío).",
  nota: "La nota puede tener hasta 300 caracteres.",
  sucursal_paga: "Elige una sucursal que pague donde también puedas solicitar gastos.",
  compra: "Elige una solicitud original de esta sucursal.",
  motivo: "Escribe el motivo de la corrección (de 5 a 300 caracteres).",
  version: "Alguien más corrigió la solicitud mientras la editabas. Recarga la página para ver la versión actual.",
  sin_cambio: "No hay cambios: la solicitud ya tiene esos datos.",
  repetida: "Esta solicitud ya se envió. Recarga la página.",
  bloqueado_produccion: "Los gastos están desactivados fuera del entorno de pruebas.",
  decision: "Elige autorizar o rechazar.",
  ...TEXTO_IMPEDIMENTO,
  ya_decidido: "Esta versión ya se decidió (quizá otra persona la decidió al mismo tiempo). Recarga la página.",
  no_autorizado: "Solo se paga un gasto autorizado en su versión vigente.",
  ya_pagado: "Este gasto ya tiene su pago registrado.",
  origen: "Elige de dónde salió el dinero (solo los orígenes que puedes usar).",
  excede: "No puedes registrar más de lo autorizado. Si costó más, pide autorización por el excedente.",
  fecha: "La fecha del pago va desde el día de la autorización hasta hoy.",
  cuenta: "Escribe el nombre corto de la cuenta o tarjeta (de 2 a 40 caracteres), sin números de cuenta ni de tarjeta.",
  referencia: "Escribe la referencia de la operación (de 3 a 60 caracteres).",
  a_quien: "A quién se pagó debe tener de 2 a 120 caracteres (o déjalo vacío).",
  autorizo: "Tú autorizaste este gasto: lo paga otra persona.",
  sin_turno: "Para pagar en efectivo debe haber un turno abierto en la sucursal que paga.",
  no_responsable: "Para pagar en efectivo debes ser la responsable vigente de ese lugar en el turno abierto.",
  entrega_en_curso: "Hay un cambio de turno en curso: termina la entrega antes de pagar en efectivo.",
  comprobante: "Elige ticket, nota o factura, o «Sin comprobante» con motivo (si ya quedó «sin comprobante», lo revisa Dirección).",
  folio: "El folio puede tener hasta 60 caracteres.",
  no_excede: "Ese importe no pasa de lo autorizado: registra el pago directamente.",
};
const CAMPO: Partial<Record<ErrorGasto, string>> = {
  concepto: "concepto", categoria: "categoria", importe: "importe", proveedor: "proveedor", nota: "nota",
  sucursal_paga: "paga", compra: "compra", motivo: "motivo",
  origen: "origen", excede: "importe", fecha: "pagadoEl", cuenta: "cuenta", referencia: "referencia", a_quien: "aQuien", comprobante: "tipo", folio: "folio",
  no_excede: "importeReal",
};

async function inicio() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}
const lector = (datos: FormData) => (campo: string, max = 60) => {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
};
function conError(error: ErrorGasto, valores: Record<string, string>, intento: number): EstadoGasto {
  const campo = CAMPO[error];
  return campo ? { error: "Revisa los campos marcados.", errores: { [campo]: MENSAJES[error] }, valores, intento } : { error: MENSAJES[error], valores, intento };
}
const campos = (leer: ReturnType<typeof lector>) => ({
  concepto: leer("concepto", 200), categoria: leer("categoria", 40), importe: leer("importe", 20), proveedor: leer("proveedor", 200), nota: leer("nota", 400),
});

export async function accionSolicitarGasto(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const valores = { ...campos(leer), paga: leer("paga", 40), compra: leer("compra", 40), parte: leer("parte", 3) };
  const intento = (previo?.intento ?? 0) + 1;
  if (valores.parte === "si" && !valores.compra) return conError("compra", valores, intento);
  const r = await solicitarGasto(sql, sesion.usuarioId, codigo,
    { ...valores, pagaId: valores.paga, compraDe: valores.parte === "si" ? valores.compra : "", envio: leer("envio", 40) }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${r.clave}?aviso=solicitado`);
  return conError(r.error, valores, intento);
}

export async function accionCorregirGasto(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const valores = { ...campos(leer), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await corregirGasto(sql, sesion.usuarioId, codigo, { ...valores, clave, version: Number(leer("version", 8)) }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=corregido`);
  return conError(r.error, valores, intento);
}

export async function accionDecidirGasto(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const decision = leer("decision", 12);
  const valores = { motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  if (decision === "rechazado" && valores.motivo.trim().length < 5) {
    return { error: "Revisa los campos marcados.", errores: { motivo: "Para rechazar escribe el motivo (de 5 a 300 caracteres)." }, valores, intento };
  }
  const r = await decidirGasto(sql, sesion.usuarioId, codigo, { clave, version: Number(leer("version", 8)), decision, motivo: valores.motivo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=${decision}`);
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errores: { motivo: "El motivo debe tener de 5 a 300 caracteres." }, valores, intento };
  return conError(r.error, valores, intento);
}

const comprobante = (leer: ReturnType<typeof lector>) => ({ tipo: leer("tipo", 12), folio: leer("folio", 80), motivoSin: leer("motivoSin", 400) });

export async function accionRegistrarPago(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const valores = { origen: leer("origen", 30), importe: leer("importe", 20), aQuien: leer("aQuien", 200), pagadoEl: leer("pagadoEl", 10),
                    cuenta: leer("cuenta", 60), referencia: leer("referencia", 80), ...comprobante(leer) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await registrarPago(sql, sesion.usuarioId, codigo, { ...valores, clave, version: Number(leer("version", 8)) }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=pagado`);
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errores: { motivoSin: "Escribe por qué no hay comprobante (de 5 a 300 caracteres)." }, valores, intento };
  return conError(r.error, valores, intento);
}

export async function accionRegistrarComprobante(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const valores = comprobante(leer);
  const intento = (previo?.intento ?? 0) + 1;
  const r = await registrarComprobante(sql, sesion.usuarioId, codigo, { ...valores, clave }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=comprobante`);
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errores: { motivoSin: "Escribe por qué no hay comprobante (de 5 a 300 caracteres)." }, valores, intento };
  return conError(r.error, valores, intento);
}

export async function accionPedirExcedente(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const valores = { importeReal: leer("importeReal", 20) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await pedirExcedente(sql, sesion.usuarioId, codigo, { clave: leer("clave", 20), importeReal: valores.importeReal, envio: leer("envio", 40) },
    { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${r.clave}?aviso=excedente`);
  if (r.error === "importe") return { error: "Revisa los campos marcados.", errores: { importeReal: MENSAJES.importe }, valores, intento };
  return conError(r.error, valores, intento);
}

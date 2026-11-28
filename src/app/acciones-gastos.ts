"use server";

/**
 * Solicitudes de gasto (bloque 6, PR 3), por POST. Aquí se leen la sesión y el formulario; quién puede solicitar o
 * corregir y el bloqueo en producción se comprueban en src/lib/gastos.ts y la base los respalda.
 */
import { redirect } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import {
  registrarGastoPagado, comprobarAnticipo, confirmarAnticipo, confirmarReembolso, corregirGasto, decidirGasto, decidirReembolso, entregarAnticipo, pagarReembolso, pedirExcedente,
  presentarReembolso, recibirCambioAnticipo, registrarComprobante, registrarPago, solicitarGasto, TEXTO_IMPEDIMENTO, type ErrorGasto,
} from "@/lib/gastos";
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
  con_anticipo: "Este gasto ya tiene un anticipo entregado: se paga al comprobar el anticipo.",
  lugar: "Elige de dónde sale el anticipo: bolsa de visitas o cajón de mensualidades.",
  recibe: "Elige a otra persona de la sucursal que paga (no puede ser quien autorizó el gasto, salvo Dirección).",
  no_recibe: "Solo quien recibió el anticipo lo confirma y lo comprueba, desde su cuenta.",
  anticipo_estado: "El anticipo ya avanzó a otro paso (quizá desde otra pantalla). Recarga la página.",
  cambio: "Es más de lo que falta por devolver. Cuenta otra vez el dinero antes de recibirlo.",
  devuelve: "Tú devuelves el cambio: lo recibe la responsable vigente del lugar.",
  sin_reembolso: "Este gasto no se pagó con dinero personal: no lleva reembolso.",
  reembolso_decidido: "El reembolso ya se decidió (quizá desde otra pantalla). Recarga la página.",
  no_direccion: "El reembolso lo decide Dirección, con su facultad de gasto vigente en esta sucursal.",
  reembolso_no_autorizado: "Solo se paga un reembolso autorizado por Dirección.",
  ya_reembolsado: "Este reembolso ya se pagó.",
  propio_reembolso: "Tú recibes este reembolso: lo paga otra persona.",
  motivo_sin_comprobante: "Falta comprobante: para autorizar el reembolso así, escribe expresamente el motivo (de 5 a 300 caracteres).",
  no_rechazado: "Solo se presenta de nuevo un reembolso rechazado (y una vez por rechazo). Recarga la página.",
  pagado_por: "Elige a la persona que pagó. Si fue en efectivo, debe haber sido responsable de ese lugar en ese turno.",
  turno: "Elige el turno cerrado del que salió el efectivo.",
  turno_abierto: "Del turno abierto no se registra como ya pagado: al contar se verá la salida; cuando se cierre, regístralo como pago de ese turno cerrado.",
  motivo_ya_pagado: "Escribe por qué se pagó sin pedir autorización antes (de 5 a 300 caracteres).",
  excedente_anticipo: "Este excedente ya se pagó al proveedor con dinero de quien recibió el anticipo: lo registra esa persona, como dinero personal. Lo que salga de caja para devolvérselo es su reembolso.",
};
const CAMPO: Partial<Record<ErrorGasto, string>> = {
  concepto: "concepto", categoria: "categoria", importe: "importe", proveedor: "proveedor", nota: "nota",
  sucursal_paga: "paga", compra: "compra", motivo: "motivo",
  origen: "origen", excede: "importe", fecha: "pagadoEl", cuenta: "cuenta", referencia: "referencia", a_quien: "aQuien", comprobante: "tipo", folio: "folio",
  no_excede: "importeReal",
  pagado_por: "pagadoPor", turno: "turno", turno_abierto: "turno", motivo_ya_pagado: "motivoPagado",
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

export async function accionEntregarAnticipo(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const valores = { lugar: leer("lugar", 30), recibe: leer("recibe", 40) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await entregarAnticipo(sql, sesion.usuarioId, codigo, { ...valores, clave, version: Number(leer("version", 8)) }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=anticipo`);
  if (r.error === "lugar" || r.error === "recibe") return { error: "Revisa los campos marcados.", errores: { [r.error]: MENSAJES[r.error] }, valores, intento };
  return conError(r.error, valores, intento);
}

export async function accionConfirmarAnticipo(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const intento = (previo?.intento ?? 0) + 1;
  const r = await confirmarAnticipo(sql, sesion.usuarioId, codigo, { clave }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=anticipo_recibido`);
  return conError(r.error, {}, intento);
}

export async function accionComprobarAnticipo(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const valores = { gastado: leer("gastado", 20), pagadoEl: leer("pagadoEl", 10), aQuien: leer("aQuien", 200), ...comprobante(leer) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await comprobarAnticipo(sql, sesion.usuarioId, codigo, { ...valores, clave, envio: leer("envio", 40) }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=${r.excedente ? "anticipo_excedente" : Number(r.cambio) > 0 ? "anticipo_cambio" : "anticipo_comprobado"}`);
  if (r.error === "importe") return { error: "Revisa los campos marcados.", errores: { gastado: MENSAJES.importe }, valores, intento };
  if (r.error === "fecha") return { error: "Revisa los campos marcados.", errores: { pagadoEl: "La fecha del pago al proveedor va desde el día de la entrega del anticipo hasta hoy." }, valores, intento };
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errores: { motivoSin: "Escribe por qué no hay comprobante (de 5 a 300 caracteres)." }, valores, intento };
  if (r.error === "comprobante") return { error: "Revisa los campos marcados.", errores: { tipo: "Para comprobar, elige ticket, nota o factura, o «Sin comprobante» con motivo." }, valores, intento };
  return conError(r.error, valores, intento);
}

export async function accionRecibirCambioAnticipo(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const valores = { importe: leer("importe", 20) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await recibirCambioAnticipo(sql, sesion.usuarioId, codigo, { clave, importe: valores.importe }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=${Number(r.pendiente) > 0 ? "cambio_parcial" : "cambio_recibido"}`);
  if (r.error === "cambio" || r.error === "importe") return { error: "Revisa los campos marcados.", errores: { importe: MENSAJES[r.error] }, valores, intento };
  return conError(r.error, valores, intento);
}

export async function accionDecidirReembolso(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
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
  const r = await decidirReembolso(sql, sesion.usuarioId, codigo, { clave, decision, motivo: valores.motivo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=reembolso_${decision}`);
  if (r.error === "motivo_sin_comprobante") return { error: "Revisa los campos marcados.", errores: { motivo: MENSAJES.motivo_sin_comprobante }, valores, intento };
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errores: { motivo: "El motivo debe tener de 5 a 300 caracteres." }, valores, intento };
  return conError(r.error, valores, intento);
}

export async function accionPagarReembolso(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const valores = { origen: leer("origen", 30), cuenta: leer("cuenta", 60), referencia: leer("referencia", 80) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await pagarReembolso(sql, sesion.usuarioId, codigo, { clave, ...valores }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=reembolso_pagado`);
  return conError(r.error, valores, intento);
}

export async function accionConfirmarReembolso(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const intento = (previo?.intento ?? 0) + 1;
  const r = await confirmarReembolso(sql, sesion.usuarioId, codigo, { clave }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=reembolso_recibido`);
  return conError(r.error, {}, intento);
}

export async function accionPresentarReembolso(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const clave = leer("clave", 20);
  const valores = { nota: leer("nota", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await presentarReembolso(sql, sesion.usuarioId, codigo, { clave, nota: valores.nota }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${clave}?aviso=reembolso_presentado`);
  if (r.error === "nota") return { error: "Revisa los campos marcados.", errores: { nota: "Escribe qué corregiste o qué información agregas (de 5 a 300 caracteres)." }, valores, intento };
  return conError(r.error, valores, intento);
}

export async function accionRegistrarGastoPagado(previo: EstadoGasto, datos: FormData): Promise<EstadoGasto> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo", 8);
  const valores = {
    ...campos(leer), ...comprobante(leer), origen: leer("origen", 30), pagadoPor: leer("pagadoPor", 40), pagadoEl: leer("pagadoEl", 10),
    pagaId: leer("paga", 40), turno: leer("turno", 40), aQuien: leer("aQuien", 200), cuenta: leer("cuenta", 60), referencia: leer("referencia", 80), motivoPagado: leer("motivoPagado", 400),
  };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await registrarGastoPagado(sql, sesion.usuarioId, codigo, { ...valores, envio: leer("envio", 40) }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/gastos/${r.clave}?aviso=ya_pagado`);
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errores: { motivoSin: "Escribe por qué no hay comprobante (de 5 a 300 caracteres)." }, valores, intento };
  if (r.error === "comprobante") return { error: "Revisa los campos marcados.", errores: { tipo: "Elige ticket, nota o factura, o «Sin comprobante» con motivo." }, valores, intento };
  if (r.error === "fecha") return { error: "Revisa los campos marcados.", errores: { pagadoEl: "La fecha no puede ser futura y, si fue en efectivo, cae dentro del turno elegido." }, valores, intento };
  return conError(r.error, valores, intento);
}

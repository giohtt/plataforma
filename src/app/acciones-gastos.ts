"use server";

/**
 * Solicitudes de gasto (bloque 6, PR 3), por POST. Aquí se leen la sesión y el formulario; quién puede solicitar o
 * corregir y el bloqueo en producción se comprueban en src/lib/gastos.ts y la base los respalda.
 */
import { redirect } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { corregirGasto, decidirGasto, solicitarGasto, TEXTO_IMPEDIMENTO, type ErrorGasto } from "@/lib/gastos";
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
};
const CAMPO: Partial<Record<ErrorGasto, string>> = {
  concepto: "concepto", categoria: "categoria", importe: "importe", proveedor: "proveedor", nota: "nota",
  sucursal_paga: "paga", compra: "compra", motivo: "motivo",
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

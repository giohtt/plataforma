/**
 * Datos de un visitante: normalización, validación y enmascaramiento. Sin acceso a la base.
 *
 * REGLAS PROVISIONALES. Los campos obligatorios, el enmascaramiento del teléfono y lo que se ve
 * entre sucursales son la decisión 3, todavía pendiente. Mientras tanto, el sitio de pruebas usa lo
 * que dice REGLAS_PROVISIONALES; cambiarlas es cambiar este objeto, no el resto del código.
 */
import { claveNombre, limpiarTexto } from "@/lib/datos-sucursal";

export const REGLAS_PROVISIONALES = {
  /** Opción A: solo el nombre completo es obligatorio. */
  telefonoObligatorio: false,
  estadoObligatorio: false,
  /** Opción A: el teléfono se muestra con los últimos 4 dígitos, salvo que se haya buscado completo. */
  enmascararTelefono: true,
} as const;

/** Las 32 entidades federativas y una opción para quien viene de otro país. */
export const ESTADOS_PROCEDENCIA = [
  "Aguascalientes", "Baja California", "Baja California Sur", "Campeche", "Chiapas", "Chihuahua",
  "Ciudad de México", "Coahuila", "Colima", "Durango", "Estado de México", "Guanajuato", "Guerrero",
  "Hidalgo", "Jalisco", "Michoacán", "Morelos", "Nayarit", "Nuevo León", "Oaxaca", "Puebla", "Querétaro",
  "Quintana Roo", "San Luis Potosí", "Sinaloa", "Sonora", "Tabasco", "Tamaulipas", "Tlaxcala", "Veracruz",
  "Yucatán", "Zacatecas", "Otro país",
] as const;

export type DatosVisitante = { nombre: string; telefono: string | null; estadoProcedencia: string | null };
export type ErroresVisitante = Partial<Record<"nombre" | "telefono" | "estadoProcedencia", string>>;

/**
 * Teléfono a 10 dígitos. Acepta espacios, guiones, paréntesis y el prefijo +52.
 * Devuelve null si no son 10 dígitos (los números de otros países quedan pendientes de decidir).
 */
export function normalizarTelefono(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  let digitos = valor.replace(/\D/g, "");
  if (digitos.length === 12 && digitos.startsWith("52")) digitos = digitos.slice(2);
  return /^[0-9]{10}$/.test(digitos) ? digitos : null;
}

/** «•• •••• 5678». El número completo no sale del servidor cuando se enmascara. */
export function enmascararTelefono(telefono: string | null): string | null {
  if (!telefono) return null;
  return `•• •••• ${telefono.slice(-4)}`;
}

/** Formato legible para un número que sí se muestra completo: «55 1234 5678». */
export function formatoTelefono(telefono: string): string {
  return `${telefono.slice(0, 2)} ${telefono.slice(2, 6)} ${telefono.slice(6)}`;
}

export function validarVisitante(entrada: Record<string, unknown>): { ok: true; datos: DatosVisitante } | { ok: false; errores: ErroresVisitante } {
  const errores: ErroresVisitante = {};

  const nombre = limpiarTexto(entrada.nombre);
  if (nombre.length < 3 || nombre.length > 120) errores.nombre = "Escribe el nombre completo (de 3 a 120 caracteres).";
  else if (!/\p{L}/u.test(nombre)) errores.nombre = "El nombre debe llevar letras.";

  const telefonoEscrito = limpiarTexto(entrada.telefono);
  const telefono = telefonoEscrito ? normalizarTelefono(telefonoEscrito) : null;
  if (telefonoEscrito && !telefono) errores.telefono = "El teléfono debe tener 10 dígitos.";
  if (!telefonoEscrito && REGLAS_PROVISIONALES.telefonoObligatorio) errores.telefono = "Escribe el teléfono.";

  const estado = limpiarTexto(entrada.estadoProcedencia);
  if (estado && !(ESTADOS_PROCEDENCIA as readonly string[]).includes(estado)) errores.estadoProcedencia = "Elige un estado de la lista.";
  if (!estado && REGLAS_PROVISIONALES.estadoObligatorio) errores.estadoProcedencia = "Elige el estado de procedencia.";

  if (Object.keys(errores).length) return { ok: false, errores };
  return { ok: true, datos: { nombre, telefono, estadoProcedencia: estado || null } };
}

export type Consulta =
  | { modo: "telefono"; telefono: string }
  | { modo: "nombre"; clave: string; palabras: string[] }
  | { modo: "invalida"; motivo: string };

/**
 * Interpreta lo que Recepción escribe en el buscador. Si son solo dígitos (con espacios o guiones),
 * es un teléfono y debe estar completo: buscar por pedazos de teléfono permitiría adivinar números.
 */
export function interpretarConsulta(valor: unknown): Consulta {
  const texto = limpiarTexto(valor).slice(0, 120);
  if (!texto) return { modo: "invalida", motivo: "Escribe un nombre o un teléfono." };
  if (/^[\d\s()+-]+$/.test(texto)) {
    const telefono = normalizarTelefono(texto);
    return telefono ? { modo: "telefono", telefono } : { modo: "invalida", motivo: "Para buscar por teléfono escribe los 10 dígitos." };
  }
  const clave = claveNombre(texto);
  if (clave.replace(/\s/g, "").length < 3) return { modo: "invalida", motivo: "Escribe al menos 3 letras del nombre." };
  return { modo: "nombre", clave, palabras: clave.split(" ").filter(Boolean).slice(0, 6) };
}

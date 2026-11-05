/**
 * Datos de la apertura de turno. Sin acceso a la base.
 *
 * REGLA PROVISIONAL: en esta prueba la misma recepcionista que abre el turno queda como responsable de la
 * bolsa de visitas y del cajón de mensualidades. Se registran por separado porque todavía no está
 * confirmado que siempre sea así.
 */
export const REGLAS_PROVISIONALES_TURNO = { mismoResponsableEnAmbos: true } as const;

export type Importe = { ok: true; valor: string } | { ok: false; motivo: "vacio" | "formato" | "maximo" };

/** Máximo que se acepta como total contado en un lugar. */
const MAXIMO = 9_999_999.99;

/**
 * Total contado. Distingue un campo vacío («no lo escribió») de un 0 («contó y no hay dinero»).
 * Acepta «0», «350», «1,200», «1200.5», «$1,200.50». No acepta negativos, letras ni más de dos decimales.
 */
export function leerImporte(entrada: unknown): Importe {
  if (typeof entrada !== "string" || entrada.trim() === "") return { ok: false, motivo: "vacio" };
  const limpio = entrada.trim().replace(/^\$\s*/, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return { ok: false, motivo: "formato" };
  const numero = Number(limpio);
  if (!Number.isFinite(numero) || numero > MAXIMO) return { ok: false, motivo: "maximo" };
  return { ok: true, valor: numero.toFixed(2) };
}

export const MENSAJES_IMPORTE = {
  vacio: "Escribe el total contado. Si no hay dinero, escribe 0.",
  formato: "Escribe solo el total en pesos, por ejemplo 350 o 1,200.50.",
  maximo: "El total es demasiado alto. Revisa la cantidad.",
} as const;

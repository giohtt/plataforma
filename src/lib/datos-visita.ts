/**
 * Datos del cobro de una visita. Sin acceso a la base.
 *
 * - Tarifa de visita: $50 por persona, igual en todas las sucursales (confirmado el 4 nov 2026). Las
 *   promociones llegan en el bloque 7; mientras tanto no hay descuento.
 * - «Recibido» es opcional. Si se escribe, no puede ser menor que el total y se muestra el cambio.
 *   A la bolsa solo entra el total de la visita, nunca lo recibido.
 */
import { leerImporte } from "@/lib/datos-turno";

const centavos = (importe: string) => Math.round(Number(importe) * 100);
const pesos = (c: number) => (c / 100).toFixed(2);

export const TARIFA_VISITA = "50.00";

/** Máximo PROVISIONAL de personas en un mismo cobro (indicado el 5 nov 2026). */
export const MAXIMO_PERSONAS = 20;

/** Total de un cobro de `personas` visitas a la tarifa base. */
export function totalVisitas(personas: number): string {
  return pesos(centavos(TARIFA_VISITA) * personas);
}

export type Recibido =
  | { ok: true; recibido: string | null; cambio: string | null }
  | { ok: false; motivo: "formato" | "maximo" | "menor" };

/** Vacío = no lo escribió (se puede confirmar). Con valor: debe cubrir el total. */
export function leerRecibido(entrada: unknown, total: string = TARIFA_VISITA): Recibido {
  const r = leerImporte(entrada);
  if (!r.ok) return r.motivo === "vacio" ? { ok: true, recibido: null, cambio: null } : { ok: false, motivo: r.motivo };
  const cambio = centavos(r.valor) - centavos(total);
  if (cambio < 0) return { ok: false, motivo: "menor" };
  return { ok: true, recibido: r.valor, cambio: pesos(cambio) };
}

/** Mensaje de «menor» con el total a la vista: «… menor que el total ($150.00) …». */
export function mensajeRecibido(motivo: "formato" | "maximo" | "menor", total: string = TARIFA_VISITA): string {
  if (motivo !== "menor") return MENSAJES_RECIBIDO[motivo];
  const t = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(total));
  return `Lo recibido es menor que el total (${t}). No se puede confirmar así.`;
}

export const MENSAJES_RECIBIDO = {
  formato: "Escribe solo la cantidad en pesos, por ejemplo 100, o deja el campo vacío.",
  maximo: "La cantidad es demasiado alta. Revísala.",
  menor: "Lo recibido es menor que el total. No se puede confirmar así.",
} as const;

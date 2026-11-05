/**
 * Datos del cobro de una visita. Sin acceso a la base.
 *
 * - Tarifa de visita: $50 por persona, igual en todas las sucursales (confirmado el 4 nov 2026). Las
 *   promociones llegan en el bloque 7; mientras tanto no hay descuento.
 * - «Recibido» es opcional. Si se escribe, no puede ser menor que el total y se muestra el cambio.
 *   A la bolsa solo entra el total de la visita, nunca lo recibido.
 */
import { leerImporte } from "@/lib/datos-turno";

export const TARIFA_VISITA = "50.00";

export type Recibido =
  | { ok: true; recibido: string | null; cambio: string | null }
  | { ok: false; motivo: "formato" | "maximo" | "menor" };

const centavos = (importe: string) => Math.round(Number(importe) * 100);
const pesos = (c: number) => (c / 100).toFixed(2);

/** Vacío = no lo escribió (se puede confirmar). Con valor: debe cubrir el total. */
export function leerRecibido(entrada: unknown, total: string = TARIFA_VISITA): Recibido {
  const r = leerImporte(entrada);
  if (!r.ok) return r.motivo === "vacio" ? { ok: true, recibido: null, cambio: null } : { ok: false, motivo: r.motivo };
  const cambio = centavos(r.valor) - centavos(total);
  if (cambio < 0) return { ok: false, motivo: "menor" };
  return { ok: true, recibido: r.valor, cambio: pesos(cambio) };
}

export const MENSAJES_RECIBIDO = {
  formato: "Escribe solo la cantidad en pesos, por ejemplo 100, o deja el campo vacío.",
  maximo: "La cantidad es demasiado alta. Revísala.",
  menor: "Lo recibido es menor que el total de la visita ($50.00). No se puede confirmar así.",
} as const;

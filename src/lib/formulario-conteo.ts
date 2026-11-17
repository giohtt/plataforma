/** Lectura compartida de los formularios de conteo (cambio de turno, cierre y apertura). */
import { leerImporte, MENSAJES_IMPORTE } from "@/lib/datos-turno";
import type { DeclaracionApoyo } from "@/lib/entregas";

/** «¿Alguien te ayudó a contar?»: «no», o «si» con al menos una persona elegida. */
export function leerApoyo(datos: FormData): { ok: true; apoyo: DeclaracionApoyo; personas: string[] } | { ok: false; personas: string[] } {
  const hubo = datos.get("apoyo");
  const personas = datos.getAll("personas").filter((p): p is string => typeof p === "string").slice(0, 10).map((p) => p.slice(0, 40));
  if (hubo === "no") return { ok: true, apoyo: { hubo: false }, personas: [] };
  if (hubo === "si" && personas.length) return { ok: true, apoyo: { hubo: true, personas }, personas };
  return { ok: false, personas };
}

export function importes(valores: { bolsa: string; cajon: string }) {
  const bolsa = leerImporte(valores.bolsa);
  const cajon = leerImporte(valores.cajon);
  if (bolsa.ok && cajon.ok) return { ok: true as const, conteo: { bolsa: bolsa.valor, cajon: cajon.valor } };
  return {
    ok: false as const,
    errores: { bolsa: bolsa.ok ? undefined : MENSAJES_IMPORTE[bolsa.motivo], cajon: cajon.ok ? undefined : MENSAJES_IMPORTE[cajon.motivo] },
  };
}


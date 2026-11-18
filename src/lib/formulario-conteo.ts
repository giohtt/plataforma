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


/** Sello y folio de cada sobre (campos sobre, estado-<id>, folio-<id>, motivo-<id>), con sus valores para repintar. */
export function leerVerificacionSobres(datos: FormData, max = 80) {
  const leer = (campo: string, n: number) => {
    const v = datos.get(campo);
    return typeof v === "string" ? v.slice(0, n) : "";
  };
  const ids = datos.getAll("sobre").filter((s): s is string => typeof s === "string").slice(0, max).map((s) => s.slice(0, 40));
  const valores: Record<string, string> = {};
  const sobres = ids.map((id) => {
    const v = { sobreId: id, estado: leer(`estado-${id}`, 30), folioVisto: leer(`folio-${id}`, 40), motivo: leer(`motivo-${id}`, 400) };
    Object.assign(valores, { [`estado-${id}`]: v.estado, [`folio-${id}`]: v.folioVisto, [`motivo-${id}`]: v.motivo });
    return v;
  });
  return { sobres, valores };
}

/** Llave de la caja y del cajón: «correcta» o «incidencia» con motivo. */
export function leerLlaveFormulario(datos: FormData) {
  const v = (campo: string, n: number) => {
    const x = datos.get(campo);
    return typeof x === "string" ? x.slice(0, n) : "";
  };
  return { estado: v("llave", 30), motivo: v("motivo_llave", 400) };
}

export const MENSAJES_VERIFICACION: Record<string, string> = {
  sobres: "Verifica cada sobre de la caja.",
  estado: "Indica cómo está el sobre.",
  folio_visto: "Escribe el folio que trae el sobre.",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
};

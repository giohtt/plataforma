/**
 * Entorno en el que corre la aplicación.
 *
 * - desarrollo: la computadora o el espacio de trabajo de quien programa. Datos ficticios.
 * - pruebas:    el sitio privado de pruebas. Datos ficticios.
 * - produccion: la operación real. Sin usuarios ni datos de prueba.
 *
 * Se define con la variable APP_ENV. Si falta o trae un valor desconocido,
 * se trata como "desarrollo" para que nunca se muestre como operación real por error.
 */
export type Entorno = "desarrollo" | "pruebas" | "produccion";

const VALIDOS: readonly Entorno[] = ["desarrollo", "pruebas", "produccion"];

/** Convierte un texto en un entorno válido; lo que falte o no se reconozca es "desarrollo". */
export function normalizarEntorno(valor: string | undefined): Entorno {
  const limpio = (valor ?? "").trim().toLowerCase();
  return (VALIDOS as readonly string[]).includes(limpio) ? (limpio as Entorno) : "desarrollo";
}

/** Entorno actual, leído de la variable APP_ENV. */
export function leerEntorno(): Entorno {
  return normalizarEntorno(process.env.APP_ENV);
}

/** Texto de la franja superior. En producción no se muestra franja. */
export function etiquetaEntorno(entorno: Entorno): string | null {
  switch (entorno) {
    case "desarrollo":
      return "Desarrollo · solo datos ficticios";
    case "pruebas":
      return "Entorno de pruebas · solo datos ficticios";
    case "produccion":
      return null;
  }
}

/** Los entornos que no son producción no deben aparecer en buscadores. */
export function permitirIndexado(entorno: Entorno): boolean {
  return entorno === "produccion";
}

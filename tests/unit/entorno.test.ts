import { describe, expect, it } from "vitest";
import { etiquetaEntorno, leerEntorno, permitirIndexado } from "@/lib/entorno";

describe("leerEntorno", () => {
  it("reconoce los tres entornos", () => {
    expect(leerEntorno("desarrollo")).toBe("desarrollo");
    expect(leerEntorno("pruebas")).toBe("pruebas");
    expect(leerEntorno("produccion")).toBe("produccion");
  });

  it("acepta mayúsculas y espacios", () => {
    expect(leerEntorno("  PRUEBAS ")).toBe("pruebas");
  });

  it("si falta o es desconocido, nunca se trata como producción", () => {
    expect(leerEntorno(undefined)).toBe("desarrollo");
    expect(leerEntorno("")).toBe("desarrollo");
    expect(leerEntorno("production")).toBe("desarrollo");
  });
});

describe("franja e indexado", () => {
  it("muestra franja fuera de producción", () => {
    expect(etiquetaEntorno("pruebas")).toMatch(/pruebas/i);
    expect(etiquetaEntorno("desarrollo")).toMatch(/ficticios/i);
    expect(etiquetaEntorno("produccion")).toBeNull();
  });

  it("solo producción puede aparecer en buscadores", () => {
    expect(permitirIndexado("produccion")).toBe(true);
    expect(permitirIndexado("pruebas")).toBe(false);
    expect(permitirIndexado("desarrollo")).toBe(false);
  });
});

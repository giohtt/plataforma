import { afterEach, describe, expect, it, vi } from "vitest";
import { etiquetaEntorno, leerEntorno, normalizarEntorno, permitirIndexado } from "@/lib/entorno";

describe("normalizarEntorno", () => {
  it("reconoce los tres entornos", () => {
    expect(normalizarEntorno("desarrollo")).toBe("desarrollo");
    expect(normalizarEntorno("pruebas")).toBe("pruebas");
    expect(normalizarEntorno("produccion")).toBe("produccion");
  });

  it("acepta mayúsculas y espacios", () => {
    expect(normalizarEntorno("  PRUEBAS ")).toBe("pruebas");
  });

  it("si falta o es desconocido, nunca se trata como producción", () => {
    expect(normalizarEntorno(undefined)).toBe("desarrollo");
    expect(normalizarEntorno("")).toBe("desarrollo");
    expect(normalizarEntorno("production")).toBe("desarrollo");
  });
});

describe("leerEntorno", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lee la variable APP_ENV", () => {
    vi.stubEnv("APP_ENV", "pruebas");
    expect(leerEntorno()).toBe("pruebas");
  });

  it("sin APP_ENV es desarrollo", () => {
    vi.stubEnv("APP_ENV", "");
    expect(leerEntorno()).toBe("desarrollo");
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

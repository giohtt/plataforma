import { describe, expect, it } from "vitest";
import { cifrarContrasena, revisarContrasena, verificarContrasena } from "@/lib/contrasena";
import { formatoTokenValido, generarToken, huellaToken } from "@/lib/tokens";

describe("contraseñas", () => {
  it("verifica la correcta y rechaza otra", async () => {
    const h = await cifrarContrasena("frase larga de prueba 1");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain("frase");
    expect(await verificarContrasena("frase larga de prueba 1", h)).toBe(true);
    expect(await verificarContrasena("frase larga de prueba 2", h)).toBe(false);
  });

  it("la misma contraseña produce huellas distintas (sal propia)", async () => {
    expect(await cifrarContrasena("misma frase larga 123")).not.toBe(await cifrarContrasena("misma frase larga 123"));
  });

  it("rechaza huellas con formato desconocido", async () => {
    expect(await verificarContrasena("x", "texto-en-claro")).toBe(false);
  });

  it("revisa largo, confirmación y que no contenga el correo", () => {
    const correo = "ana.lopez@prueba.fitnessland.invalid";
    expect(revisarContrasena("corta", "corta", correo)).toMatch(/12/);
    expect(revisarContrasena("frase larga uno 1", "frase larga dos 2", correo)).toMatch(/no coinciden/);
    expect(revisarContrasena("ana.lopez 2026 frase", "ana.lopez 2026 frase", correo)).toMatch(/correo/);
    expect(revisarContrasena("x".repeat(129), "x".repeat(129), correo)).toMatch(/128/);
    expect(revisarContrasena("una frase larga y propia", "una frase larga y propia", correo)).toBeNull();
  });
});

describe("tokens", () => {
  it("son aleatorios, con formato fijo, y su huella es SHA-256", () => {
    const a = generarToken();
    expect(formatoTokenValido(a)).toBe(true);
    expect(a).not.toBe(generarToken());
    expect(huellaToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(formatoTokenValido("con espacios y cosas")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { esIdentificadorValido } from "@/lib/permisos";

describe("formato de identificador de sucursal", () => {
  it("acepta un UUID completo, en minúsculas o mayúsculas", () => {
    expect(esIdentificadorValido("12345678-90ab-cdef-1234-567890abcdef")).toBe(true);
    expect(esIdentificadorValido("12345678-90AB-CDEF-1234-567890ABCDEF")).toBe(true);
  });

  it("rechaza todo lo demás", () => {
    for (const id of [
      "",
      "abc",
      "TEN",
      "-".repeat(36),
      "g".repeat(36),
      "1234567890abcdef1234567890abcdef",
      "12345678-90ab-cdef-1234-567890abcdef0",
      " 12345678-90ab-cdef-1234-567890abcdef",
      "12345678-90ab-cdef-1234-567890abcdeg",
      "' or '1'='1",
    ]) {
      expect(esIdentificadorValido(id), JSON.stringify(id)).toBe(false);
    }
  });
});

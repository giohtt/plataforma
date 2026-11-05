import { describe, expect, it } from "vitest";
import { leerRecibido, TARIFA_VISITA } from "@/lib/datos-visita";

describe("lo recibido en una visita de $50", () => {
  it("la tarifa de visita es $50", () => {
    expect(TARIFA_VISITA).toBe("50.00");
  });

  it("vacío se puede confirmar, sin cambio", () => {
    expect(leerRecibido("")).toEqual({ ok: true, recibido: null, cambio: null });
    expect(leerRecibido("  ")).toEqual({ ok: true, recibido: null, cambio: null });
    expect(leerRecibido(undefined)).toEqual({ ok: true, recibido: null, cambio: null });
  });

  it("$100 da $50 de cambio; $50 justo da $0", () => {
    expect(leerRecibido("100")).toEqual({ ok: true, recibido: "100.00", cambio: "50.00" });
    expect(leerRecibido("$100.00")).toEqual({ ok: true, recibido: "100.00", cambio: "50.00" });
    expect(leerRecibido("50")).toEqual({ ok: true, recibido: "50.00", cambio: "0.00" });
    expect(leerRecibido("1,000")).toEqual({ ok: true, recibido: "1000.00", cambio: "950.00" });
    expect(leerRecibido("70.10")).toEqual({ ok: true, recibido: "70.10", cambio: "20.10" });
  });

  it("menos de $50 no se puede confirmar", () => {
    for (const poco of ["0", "20", "49.99"]) expect(leerRecibido(poco), poco).toEqual({ ok: false, motivo: "menor" });
  });

  it("rechaza formatos que no son una cantidad", () => {
    for (const malo of ["-100", "cien", "100.555"]) expect(leerRecibido(malo), malo).toEqual({ ok: false, motivo: "formato" });
    expect(leerRecibido("10000000")).toEqual({ ok: false, motivo: "maximo" });
  });
});

describe("total de un cobro grupal", () => {
  it("$50 por persona; lo recibido se compara con el total del grupo", async () => {
    const { totalVisitas, mensajeRecibido, MAXIMO_PERSONAS } = await import("@/lib/datos-visita");
    expect([totalVisitas(1), totalVisitas(3), totalVisitas(20)]).toEqual(["50.00", "150.00", "1000.00"]);
    expect(MAXIMO_PERSONAS).toBe(20);
    expect(leerRecibido("200", "150.00")).toEqual({ ok: true, recibido: "200.00", cambio: "50.00" });
    expect(leerRecibido("100", "150.00")).toEqual({ ok: false, motivo: "menor" });
    expect(mensajeRecibido("menor", "150.00")).toBe("Lo recibido es menor que el total ($150.00). No se puede confirmar así.");
  });
});

describe("autorización de la terminal (formato provisional)", () => {
  it("es obligatoria; acepta de 4 a 12 letras o números, sin espacios ni guiones, en mayúsculas", async () => {
    const { leerAutorizacion } = await import("@/lib/datos-visita");
    expect(leerAutorizacion("")).toEqual({ ok: false, motivo: "vacia" });
    expect(leerAutorizacion("  ")).toEqual({ ok: false, motivo: "vacia" });
    expect(leerAutorizacion("123456")).toEqual({ ok: true, valor: "123456" });
    expect(leerAutorizacion(" ab 12-3c ")).toEqual({ ok: true, valor: "AB123C" });
    for (const malo of ["123", "1234567890123", "12$456", "ñandú1"]) expect(leerAutorizacion(malo).ok, malo).toBe(false);
  });
});

describe("clave de rastreo o folio bancario (formato provisional)", () => {
  it("es obligatoria; de 4 a 30 letras o números, sin espacios ni guiones, en mayúsculas", async () => {
    const { leerReferencia } = await import("@/lib/datos-visita");
    expect(leerReferencia("")).toEqual({ ok: false, motivo: "vacia" });
    expect(leerReferencia("mban 0100-2611")).toEqual({ ok: true, valor: "MBAN01002611" });
    expect(leerReferencia("12345678901234567890123456789X")).toEqual({ ok: true, valor: "12345678901234567890123456789X" });
    for (const malo of ["123", "1234567890123456789012345678901", "AB$12", "año1234"]) expect(leerReferencia(malo).ok, malo).toBe(false);
  });
});

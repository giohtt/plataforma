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

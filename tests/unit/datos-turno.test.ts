import { describe, expect, it } from "vitest";
import { leerImporte } from "@/lib/datos-turno";

describe("total contado al abrir turno", () => {
  it("distingue vacío de cero", () => {
    expect(leerImporte("")).toEqual({ ok: false, motivo: "vacio" });
    expect(leerImporte("   ")).toEqual({ ok: false, motivo: "vacio" });
    expect(leerImporte(undefined)).toEqual({ ok: false, motivo: "vacio" });
    expect(leerImporte("0")).toEqual({ ok: true, valor: "0.00" });
    expect(leerImporte("0.00")).toEqual({ ok: true, valor: "0.00" });
  });

  it("acepta pesos con separador de miles, signo de pesos y hasta dos decimales", () => {
    expect(leerImporte("350")).toEqual({ ok: true, valor: "350.00" });
    expect(leerImporte("1,200")).toEqual({ ok: true, valor: "1200.00" });
    expect(leerImporte("$1,200.50")).toEqual({ ok: true, valor: "1200.50" });
    expect(leerImporte(" 1200.5 ")).toEqual({ ok: true, valor: "1200.50" });
  });

  it("rechaza negativos, letras, más de dos decimales y cantidades exageradas", () => {
    for (const malo of ["-5", "abc", "12a", "1.234", "1,20", "$", "1 200"]) expect(leerImporte(malo).ok, malo).toBe(false);
    expect(leerImporte("10000000")).toEqual({ ok: false, motivo: "maximo" });
  });
});

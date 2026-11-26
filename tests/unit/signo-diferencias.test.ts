import { describe, expect, it } from "vitest";
import { $signo } from "@/app/(privado)/reportes/caja/comun";

describe("importe de una diferencia en la lista", () => {
  it("lleva «+» en sobrantes y «−» en faltantes", () => {
    expect($signo("20.00")).toBe("+$20.00");
    expect($signo("-50.00")).toBe("−$50.00");
  });
});

import { describe, expect, it } from "vitest";
import { claveNombre, validarDatosSucursal, validarMotivo, validarNuevaSucursal } from "@/lib/datos-sucursal";

const base = { nombre: "  Valle   Ficticio ", codigo: " vf1 ", color: "#AABBCC", direccion: "", estadoRepublica: " México ", estadoOperativo: "proxima" };

describe("datos de sucursal", () => {
  it("normaliza espacios, código en mayúsculas y color en minúsculas; vacíos quedan como null", () => {
    expect(validarNuevaSucursal(base)).toEqual({
      ok: true,
      datos: { nombre: "Valle Ficticio", codigo: "VF1", color: "#aabbcc", direccion: null, estadoRepublica: "México", estadoOperativo: "proxima" },
    });
  });

  it("rechaza datos inválidos con un mensaje por campo", () => {
    const r = validarNuevaSucursal({ nombre: "A", codigo: "TENANGO", color: "rojo", estadoOperativo: "inactiva", direccion: "x".repeat(201) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errores).sort()).toEqual(["codigo", "color", "direccion", "estadoOperativo", "nombre"]);
  });

  it("el código no admite acentos, guiones ni espacios", () => {
    for (const codigo of ["TÑ", "T-1", "T 1", "A", "ABCDEF"]) expect(validarNuevaSucursal({ ...base, codigo }).ok, codigo).toBe(false);
  });

  it("al editar no se pide código y no se puede elegir «inactiva»", () => {
    expect(validarDatosSucursal({ ...base, codigo: undefined }).ok).toBe(true);
    expect(validarDatosSucursal({ ...base, estadoOperativo: "inactiva" }).ok).toBe(false);
  });

  it("sin color es válido (San Cristóbal aún no tiene color)", () => {
    expect(validarDatosSucursal({ ...base, color: "" })).toMatchObject({ ok: true, datos: { color: null } });
  });

  it("compara nombres sin mayúsculas, acentos ni espacios repetidos", () => {
    expect(claveNombre(" San  Andrés ")).toBe(claveNombre("san andres"));
    expect(claveNombre("Rayón")).toBe("rayon");
    expect(claveNombre("Tenango")).not.toBe(claveNombre("Tenancingo"));
  });

  it("el motivo es obligatorio, de 5 a 300 caracteres", () => {
    expect(validarMotivo("  ")).toBeNull();
    expect(validarMotivo("abc")).toBeNull();
    expect(validarMotivo("  Cambio de color  ")).toBe("Cambio de color");
    expect(validarMotivo("x".repeat(301))).toBeNull();
  });
});

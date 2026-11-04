import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cambiarActividadSucursal,
  crearSucursal,
  editarSucursal,
  historialSucursal,
  sucursalEditable,
} from "@/lib/catalogo-sucursales";
import type { DatosNuevaSucursal, DatosSucursal } from "@/lib/datos-sucursal";
import { sucursalesAccesibles, tienePermiso } from "@/lib/permisos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
let n = 0;
const ids: Record<string, string> = {};

async function usuario({ sucursal = [], general }: { sucursal?: [string, string][]; general?: string } = {}) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Catálogo " + n}, ${`catalogo${n}@prueba.fitnessland.invalid`}, true)
    returning id`;
  for (const [rol, codigo] of sucursal) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de catálogo')`;
  }
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${general}, 'Prueba de catálogo')`;
  return u.id;
}

let consecutivo = 0;
function nueva(extra: Partial<DatosNuevaSucursal> = {}): DatosNuevaSucursal {
  consecutivo++;
  return {
    nombre: `Sucursal de prueba ${consecutivo}`,
    codigo: `P${consecutivo}`,
    color: null,
    direccion: null,
    estadoRepublica: null,
    estadoOperativo: "proxima",
    ...extra,
  };
}

async function fila(id: string) {
  const [s] = await sql<{ nombre: string; codigo: string; color: string | null; estado_operativo: string; version: number; desactivada_en: Date | null }[]>`
    select nombre, codigo, color, estado_operativo, version, desactivada_en from sucursal where id = ${id}`;
  return s;
}
async function historial(id: string) {
  return sql<{ accion: string; cambios: Record<string, unknown>; motivo: string | null; usuario_id: string | null }[]>`
    select accion, cambios, motivo, usuario_id from historial_cambio where entidad = 'sucursal' and entidad_id = ${id} order by id`;
}
const editables = (s: { nombre: string; color: string | null; estadoOperativo?: string }): DatosSucursal => ({
  nombre: s.nombre,
  color: s.color,
  direccion: null,
  estadoRepublica: null,
  estadoOperativo: (s.estadoOperativo as "activa" | "proxima") ?? "activa",
});

describe.skipIf(!URL_ADMIN)("catálogo de sucursales", () => {
  let general: string;

  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
    general = await usuario({ general: "direccion" });
  });
  afterAll(async () => cerrar?.());

  describe("crear", () => {
    it("Dirección con alcance general crea una sucursal; queda en el historial y no se asigna a nadie", async () => {
      const antes = await sql`select count(*)::int as n from asignacion`;
      const r = await crearSucursal(sql, general, nueva({ color: "#123abc" }), "Apertura de prueba");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(await fila(r.id)).toMatchObject({ estado_operativo: "proxima", version: 1, color: "#123abc", desactivada_en: null });
      expect(await sql`select count(*)::int as n from asignacion`).toEqual(antes);
      expect(await sql`select 1 from asignacion where sucursal_id = ${r.id}`).toHaveLength(0);
      expect(await sql`select 1 from facultad_otorgada where sucursal_id = ${r.id}`).toHaveLength(0);
      const h = await historial(r.id);
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ accion: "crear", motivo: "Apertura de prueba", usuario_id: general });

      // Nadie la ve por estar recién creada, salvo quien ya tenía alcance general otorgado aparte.
      const soloTenango = await usuario({ sucursal: [["recepcion", "TEN"]] });
      expect((await sucursalesAccesibles(sql, soloTenango)).map((s) => s.codigo)).toEqual(["TEN"]);
      expect(await tienePermiso(sql, general, "sucursal.consultar", r.id)).toBe(true);
    });

    it("sin el permiso general de crear, nadie crea: ni Recepción, ni Dirección de una sola sucursal, ni Administración", async () => {
      const cuentas = [
        await usuario(),
        await usuario({ sucursal: [["recepcion", "TEN"]] }),
        await usuario({ sucursal: [["direccion", "TEN"]] }),
        await usuario({ sucursal: [["administracion", "TEN"], ["administracion", "STG"]] }),
      ];
      for (const u of cuentas) {
        const datos = nueva();
        expect(await crearSucursal(sql, u, datos, null)).toEqual({ ok: false, error: "sin_permiso" });
        expect(await sql`select 1 from sucursal where codigo = ${datos.codigo}`).toHaveLength(0);
      }
    });

    it("una persona desactivada ya no puede crear", async () => {
      const u = await usuario({ general: "direccion" });
      await sql`update usuario set activo = false where id = ${u}`;
      expect(await crearSucursal(sql, u, nueva(), null)).toEqual({ ok: false, error: "sin_permiso" });
    });

    it("rechaza código repetido y nombre repetido aunque cambien mayúsculas, acentos o espacios", async () => {
      expect(await crearSucursal(sql, general, nueva({ codigo: "TEN" }), null)).toEqual({ ok: false, error: "codigo_duplicado" });
      for (const nombre of ["Tenango", "tenango", "TENANGO", "Rayon", "rayón", "San  Andrés"]) {
        expect(await crearSucursal(sql, general, nueva({ nombre }), null), nombre).toEqual({ ok: false, error: "nombre_duplicado" });
      }
    });

    it("dos altas simultáneas con el mismo nombre: solo una se guarda", async () => {
      const a = nueva({ nombre: "Simultánea" });
      const b = nueva({ nombre: "simultanea" });
      const resultados = await Promise.all([crearSucursal(sql, general, a, null), crearSucursal(sql, general, b, null)]);
      expect(resultados.filter((r) => r.ok)).toHaveLength(1);
      expect(resultados.filter((r) => !r.ok)).toEqual([{ ok: false, error: "nombre_duplicado" }]);
    });
  });

  describe("editar", () => {
    it("Dirección de Tenango edita Tenango: cambia la versión y guarda antes, después y motivo", async () => {
      const dir = await usuario({ sucursal: [["direccion", "TEN"]] });
      const actual = (await sucursalEditable(sql, dir, "TEN"))!;
      expect(actual).toMatchObject({ puedeEditar: true, puedeDesactivar: true });
      const r = await editarSucursal(sql, dir, ids.TEN, actual.version, { ...editables(actual), direccion: "Calle Ficticia 1" }, "Dirección de prueba");
      expect(r).toEqual({ ok: true, id: ids.TEN, codigo: "TEN" });
      expect((await fila(ids.TEN)).version).toBe(actual.version + 1);
      const h = (await historial(ids.TEN)).at(-1)!;
      expect(h).toMatchObject({ accion: "editar", motivo: "Dirección de prueba", usuario_id: dir });
      expect(h.cambios).toEqual({ direccion: { antes: null, despues: "Calle Ficticia 1" } });
    });

    it("no puede editar otra sucursal, ni con una solicitud directa por identificador", async () => {
      const dir = await usuario({ sucursal: [["direccion", "TEN"]] });
      const stg = await fila(ids.STG);
      expect(await sucursalEditable(sql, dir, "STG")).toBeNull();
      expect(await editarSucursal(sql, dir, ids.STG, stg.version, editables({ nombre: "Robada", color: null }), "Intento")).toEqual({
        ok: false,
        error: "no_encontrada",
      });
      expect((await fila(ids.STG)).nombre).toBe("Santiago");
    });

    it("Recepción y Encargado consultan su sucursal pero no la editan ni la desactivan", async () => {
      for (const rol of ["recepcion", "encargado", "administracion"]) {
        const u = await usuario({ sucursal: [[rol, "TEN"]] });
        const v = (await fila(ids.TEN)).version;
        expect(await sucursalEditable(sql, u, "TEN"), rol).toBeNull();
        expect(await editarSucursal(sql, u, ids.TEN, v, editables({ nombre: "Otro", color: null }), "Intento"), rol).toEqual({ ok: false, error: "sin_permiso" });
        expect(await cambiarActividadSucursal(sql, u, ids.TEN, v, "Intento", { tipo: "desactivar" }), rol).toEqual({ ok: false, error: "sin_permiso" });
      }
    });

    it("identificador mal formado o inexistente: no encontrada, sin error de la base", async () => {
      for (const id of ["-".repeat(36), "abc", "00000000-0000-0000-0000-000000000000"]) {
        expect(await editarSucursal(sql, general, id, 1, editables({ nombre: "X y", color: null }), "Intento")).toEqual({ ok: false, error: "no_encontrada" });
        expect(await cambiarActividadSucursal(sql, general, id, 1, "Intento", { tipo: "desactivar" })).toEqual({ ok: false, error: "no_encontrada" });
      }
    });

    it("si otra persona guardó antes, el cambio se rechaza en vez de sobrescribirlo", async () => {
      const r = await crearSucursal(sql, general, nueva(), null);
      if (!r.ok) throw new Error();
      const s = (await sucursalEditable(sql, general, r.codigo))!;
      expect((await editarSucursal(sql, general, r.id, s.version, { ...editables(s), color: "#000000" }, "Primera persona")).ok).toBe(true);
      expect(await editarSucursal(sql, general, r.id, s.version, { ...editables(s), color: "#ffffff" }, "Segunda persona")).toEqual({ ok: false, error: "modificada" });
      expect((await fila(r.id)).color).toBe("#000000");
    });

    it("sin cambios no escribe historial; un nombre repetido se rechaza al editar", async () => {
      const r = await crearSucursal(sql, general, nueva(), null);
      if (!r.ok) throw new Error();
      const s = (await sucursalEditable(sql, general, r.codigo))!;
      expect(await editarSucursal(sql, general, r.id, s.version, editables(s), "Nada")).toEqual({ ok: false, error: "sin_cambios" });
      expect(await editarSucursal(sql, general, r.id, s.version, { ...editables(s), nombre: "SANTIAGO" }, "Copia")).toEqual({ ok: false, error: "nombre_duplicado" });
      expect(await historial(r.id)).toHaveLength(1);
      // Mayúsculas en su propio nombre sí se pueden corregir.
      expect((await editarSucursal(sql, general, r.id, s.version, { ...editables(s), nombre: s.nombre.toUpperCase() }, "Mayúsculas")).ok).toBe(true);
    });

    it("el código no se puede cambiar al editar", async () => {
      const r = await crearSucursal(sql, general, nueva(), null);
      if (!r.ok) throw new Error();
      const s = (await sucursalEditable(sql, general, r.codigo))!;
      const datos = { ...editables(s), codigo: "ZZZ", color: "#00ff00" } as DatosSucursal;
      expect((await editarSucursal(sql, general, r.id, s.version, datos, "Intento de código")).ok).toBe(true);
      expect((await fila(r.id)).codigo).toBe(r.codigo);
    });
  });

  describe("desactivar y reactivar", () => {
    it("desactivar no borra ni quita accesos; queda en historial; reactivar la regresa", async () => {
      const r = await crearSucursal(sql, general, nueva({ estadoOperativo: "activa" }), null);
      if (!r.ok) throw new Error();
      const recep = await usuario();
      await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${recep}, 'recepcion', ${r.id}, 'Prueba')`;

      expect((await cambiarActividadSucursal(sql, general, r.id, 1, "Cierre temporal de prueba", { tipo: "desactivar" })).ok).toBe(true);
      expect(await fila(r.id)).toMatchObject({ estado_operativo: "inactiva", version: 2 });
      expect((await fila(r.id)).desactivada_en).not.toBeNull();
      expect((await sucursalesAccesibles(sql, recep)).map((s) => [s.codigo, s.estadoOperativo])).toEqual([[r.codigo, "inactiva"]]);

      // Desactivar dos veces no hace nada; editar no la reactiva.
      expect(await cambiarActividadSucursal(sql, general, r.id, 2, "Otra vez", { tipo: "desactivar" })).toEqual({ ok: false, error: "estado_invalido" });
      const s = (await sucursalEditable(sql, general, r.codigo))!;
      expect((await editarSucursal(sql, general, r.id, 2, { ...editables(s), estadoOperativo: "activa", color: "#111111" }, "Color")).ok).toBe(true);
      expect((await fila(r.id)).estado_operativo).toBe("inactiva");

      expect((await cambiarActividadSucursal(sql, general, r.id, 3, "Reapertura de prueba", { tipo: "reactivar", estado: "activa" })).ok).toBe(true);
      expect(await fila(r.id)).toMatchObject({ estado_operativo: "activa", desactivada_en: null });
      expect((await historial(r.id)).map((h) => h.accion)).toEqual(["crear", "desactivar", "editar", "reactivar"]);
      await expect(sql`delete from sucursal where id = ${r.id}`).rejects.toThrow();
    });

    it("Dirección de Tenango no desactiva Santiago", async () => {
      const dir = await usuario({ sucursal: [["direccion", "TEN"]] });
      const v = (await fila(ids.STG)).version;
      expect(await cambiarActividadSucursal(sql, dir, ids.STG, v, "Intento", { tipo: "desactivar" })).toEqual({ ok: false, error: "no_encontrada" });
      expect((await fila(ids.STG)).estado_operativo).toBe("activa");
    });

    it("la base no admite un estado inactivo sin fecha de desactivación", async () => {
      await expect(sql`update sucursal set estado_operativo = 'inactiva' where id = ${ids.RAY}`).rejects.toThrow(/sucursal_desactivacion_coherente/);
    });
  });

  describe("historial", () => {
    it("solo con el permiso de consultar historial", async () => {
      expect((await historialSucursal(sql, general, ids.TEN))?.length).toBeGreaterThan(0);
      const dir = await usuario({ sucursal: [["direccion", "TEN"]] });
      expect(await historialSucursal(sql, dir, ids.TEN)).toBeNull();
      expect(await historialSucursal(sql, await usuario({ sucursal: [["recepcion", "TEN"]] }), ids.TEN)).toBeNull();
    });
  });
});

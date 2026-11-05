import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fusionarVisitantes } from "@/lib/fusion-visitantes";
import { periodoPorOmision, reporteExpedientes, sucursalesConReporteExpedientes } from "@/lib/reporte-expedientes";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;
const TODO = { desde: "2000-01-01", hasta: "2100-12-31" };

async function cuenta(asignaciones: [string, string][], { general }: { general?: string } = {}) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Reporte exp " + n}, ${`repexp${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de reporte')`;
  }
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${general}, 'Prueba')`;
  return u.id;
}
const pares = async (u: string, codigo: string | null = null) => {
  const r = await reporteExpedientes(sql, u, { codigo, ...TODO });
  if (!r) throw new Error("sin reporte");
  return r.duplicados.map((p) => [p.a.nombre, p.b.nombre].sort().join(" / ")).sort();
};
const creados = async (u: string, codigo: string | null = null, periodo = TODO) =>
  Object.fromEntries((await reporteExpedientes(sql, u, { codigo, ...periodo }))!.creados.map((f) => [f.codigo, [f.creados, f.unidosDespues]]));

describe.skipIf(!URL_ADMIN)("reporte de expedientes creados y posibles duplicados", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal());
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  describe("quién lo ve", () => {
    it("Recepción y cuentas sin asignaciones no lo ven, ni pidiendo una sucursal", async () => {
      for (const u of [await cuenta([["recepcion", "TEN"]]), await cuenta([])]) {
        expect(await sucursalesConReporteExpedientes(sql, u)).toEqual([]);
        expect(await reporteExpedientes(sql, u, {})).toBeNull();
        expect(await reporteExpedientes(sql, u, { codigo: "TEN" })).toBeNull();
      }
    });

    it("Encargado, Administración y Dirección lo ven solo de sus sucursales; otra sucursal o un código malo: null", async () => {
      for (const rol of ["encargado", "administracion", "direccion"]) {
        const u = await cuenta([[rol, "TEN"]]);
        expect((await sucursalesConReporteExpedientes(sql, u)).map((s) => s.codigo), rol).toEqual(["TEN"]);
        expect(Object.keys(await creados(u)), rol).toEqual(["TEN"]);
        expect(await reporteExpedientes(sql, u, { codigo: "STG" }), rol).toBeNull();
        expect(await reporteExpedientes(sql, u, { codigo: "ten'--" }), rol).toBeNull();
      }
    });
  });

  describe("expedientes creados", () => {
    it("cuenta por la sucursal donde se creó cada ficha; marca las que después se unieron a otra", async () => {
      const general = await cuenta([], { general: "direccion" });
      expect(await creados(general)).toMatchObject({ TEN: [6, 0], STG: [1, 0], ATL: [1, 0], RAY: [0, 0] });
      const r = (await reporteExpedientes(sql, general, TODO))!;
      expect(r.totalCreados).toBe(r.creados.reduce((t, f) => t + f.creados, 0));
    });

    it("el periodo usa las fechas de la zona horaria de la sucursal", async () => {
      const general = await cuenta([], { general: "direccion" });
      // 31 oct a las 23:30 en el centro de México = 1 nov a las 05:30 UTC: cuenta en octubre, no en noviembre.
      await sql`insert into visitante (nombre, sucursal_alta_id, creado_en)
                values ('Frontera Del Periodo', ${ids.RAY}, '2026-10-31 23:30:00'::timestamp at time zone 'America/Mexico_City')`;
      expect((await creados(general, "RAY", { desde: "2026-10-01", hasta: "2026-10-31" })).RAY).toEqual([1, 0]);
      expect((await creados(general, "RAY", { desde: "2026-11-01", hasta: "2026-11-30" })).RAY).toEqual([0, 0]);
      // Fechas al revés se ordenan; fechas inválidas usan el periodo por omisión.
      expect((await creados(general, "RAY", { desde: "2026-10-31", hasta: "2026-10-01" })).RAY).toEqual([1, 0]);
      const r = (await reporteExpedientes(sql, general, { desde: "no-es-fecha", hasta: "2026-02-30" }))!;
      expect(r.filtro).toMatchObject(periodoPorOmision());
    });
  });

  describe("posibles duplicados", () => {
    it("Encargado de Tenango ve el par de Valeria; no el de María, que tiene una ficha en Santiago", async () => {
      expect(await pares(await cuenta([["encargado", "TEN"]]))).toEqual(["Valeria Gomes Pineda / Valeria Gómez Pineda"]);
    });

    it("con el reporte en Tenango y Santiago aparece también el par de María; cada par una sola vez", async () => {
      const adm = await cuenta([["administracion", "TEN"], ["administracion", "STG"]]);
      expect(await pares(adm)).toEqual(["María Hernández García / María Hernández García", "Valeria Gomes Pineda / Valeria Gómez Pineda"]);
      const r = (await reporteExpedientes(sql, adm, TODO))!;
      expect(r.totalDuplicados).toBe(2);
      const maria = r.duplicados.find((p) => p.a.nombre.startsWith("María"))!;
      expect(maria.motivos).toEqual(["mismo_nombre"]);
      expect([maria.a.codigo, maria.b.codigo].sort()).toEqual(["STG", "TEN"]);
      const valeria = r.duplicados.find((p) => p.a.nombre.startsWith("Valeria"))!;
      expect(valeria.motivos).toEqual(["mismo_telefono", "nombre_parecido"]);
      // Filtrando por Santiago queda solo el par que tiene una ficha ahí.
      expect(await pares(adm, "STG")).toEqual(["María Hernández García / María Hernández García"]);
    });

    it("Encargado de Santiago tampoco ve el par de María si no tiene el reporte en Tenango", async () => {
      expect(await pares(await cuenta([["encargado", "STG"]]))).toEqual([]);
    });

    it("excluye a Ana y Luis (confirmados como distintos) aunque compartan teléfono; los teléfonos salen enmascarados", async () => {
      const general = await cuenta([], { general: "direccion" });
      const lista = await pares(general);
      expect(lista.some((p) => p.includes("Ana Martínez") || p.includes("Luis Martínez"))).toBe(false);
      const r = (await reporteExpedientes(sql, general, TODO))!;
      expect(r.duplicados.every((p) => [p.a.telefono, p.b.telefono].every((t) => t === null || t.startsWith("•• ••••")))).toBe(true);
      expect(JSON.stringify(r)).not.toMatch(/0000000\d{3}/);
    });

    it("un par desaparece al unir las fichas, y la ficha unida sigue contando como expediente creado", async () => {
      const direccionTen = await cuenta([["direccion", "TEN"]]);
      const [g, s] = (await sql<{ id: string; version: number }[]>`select id, version from visitante where telefono = '0000000401' order by nombre desc`);
      const r = await fusionarVisitantes(
        sql, direccionTen, "TEN",
        { a: g.id, b: s.id, versionA: g.version, versionB: s.version, activa: "a", tomar: { nombre: "a", telefono: "a", estado_procedencia: "a" } },
        "Duplicado de prueba", { entorno: "pruebas" },
      );
      expect(r.ok).toBe(true);
      expect(await pares(direccionTen)).toEqual([]);
      expect((await creados(direccionTen)).TEN).toEqual([6, 1]);
    });

    it("una confirmación de personas distintas en una ficha ya unida también excluye el par", async () => {
      const general = await cuenta([], { general: "direccion" });
      const nueva = async (nombre: string, telefono: string) =>
        (await sql<{ id: string }[]>`insert into visitante (nombre, telefono, sucursal_alta_id) values (${nombre}, ${telefono}, ${ids.RAY}) returning id`)[0].id;
      const x = await nueva("Xochitl Prueba Uno", "0000000881");
      const duplicadoDeX = await nueva("Xochitl Prueba Uno", "0000000881");
      const y = await nueva("Yolanda Prueba Dos", "0000000881");
      await sql`insert into visitante_distinto (visitante_id, distinto_de_id, motivo) values (${duplicadoDeX}, ${y}, 'Confirmado antes')`;
      expect((await pares(general, "RAY")).length).toBe(2); // x-duplicado y x-y
      await sql`update visitante set fusionado_en = now(), fusionado_en_id = ${x} where id = ${duplicadoDeX}`;
      expect(await pares(general, "RAY")).toEqual([]);
    });
  });
});

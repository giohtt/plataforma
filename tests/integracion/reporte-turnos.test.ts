import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reporteTurnos } from "@/lib/reporte-turnos";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;

async function cuenta(asignaciones: [string, string][], nombre?: string) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${nombre ?? "Reporte turnos " + n}, ${`repturno${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba')`;
  }
  return u.id;
}

describe.skipIf(!URL_ADMIN)("reporte de turnos abiertos y responsables", () => {
  let recepTen: string;

  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal());
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
    recepTen = await cuenta([["recepcion", "TEN"]], "Recepcionista Ficticia Tenango");
    const r = await abrirTurno(sql, recepTen, "TEN", { bolsa: "0.00", cajon: "1200.00" }, { entorno: "pruebas" });
    if (!r.ok) throw new Error("no se abrió el turno de prueba");
  });
  afterAll(async () => cerrar?.());

  it("Recepción ve su turno, pero no el reporte (ni pidiendo una sucursal)", async () => {
    expect((await estadoTurno(sql, recepTen, "TEN"))?.turno?.abiertoPor).toBe("Recepcionista Ficticia Tenango");
    expect(await reporteTurnos(sql, recepTen, null)).toBeNull();
    expect(await reporteTurnos(sql, recepTen, "TEN")).toBeNull();
    expect(await reporteTurnos(sql, await cuenta([]), null)).toBeNull();
  });

  it("Encargado de Tenango ve el turno abierto con quién abrió y los responsables de la bolsa y del cajón por separado", async () => {
    const r = (await reporteTurnos(sql, await cuenta([["encargado", "TEN"]]), null))!;
    expect(r.sucursales.map((s) => s.codigo)).toEqual(["TEN"]);
    expect(r.turnosAbiertos).toBe(1);
    const fila = r.filas[0];
    expect(fila.codigo).toBe("TEN");
    expect(fila.turno).toMatchObject({
      abiertoPor: "Recepcionista Ficticia Tenango",
      bolsa: { nombre: "Recepcionista Ficticia Tenango" },
      cajon: { nombre: "Recepcionista Ficticia Tenango" },
    });
    expect(fila.turno!.abiertoEn).toBeInstanceOf(Date);
    // Solo consulta: no entrega importes.
    expect(JSON.stringify(r)).not.toContain("1200");
  });

  it("Administración de Tenango y Santiago ve las dos; Santiago sin turno abierto", async () => {
    const r = (await reporteTurnos(sql, await cuenta([["administracion", "TEN"], ["administracion", "STG"]]), null))!;
    expect(r.filas.map((f) => [f.codigo, f.turno ? "abierto" : "sin turno"])).toEqual([["STG", "sin turno"], ["TEN", "abierto"]]);
    expect((await reporteTurnos(sql, await cuenta([["administracion", "TEN"], ["administracion", "STG"]]), "STG"))!.filas.map((f) => f.codigo)).toEqual(["STG"]);
  });

  it("Encargado de Santiago no ve Tenango; Dirección general ve todas", async () => {
    const encStg = await cuenta([["encargado", "STG"]]);
    expect((await reporteTurnos(sql, encStg, null))!.filas.map((f) => f.codigo)).toEqual(["STG"]);
    expect(await reporteTurnos(sql, encStg, "TEN")).toBeNull();
    const [{ id: general }] = await sql<{ id: string }[]>`select id from usuario where correo = 'direccion.general@prueba.fitnessland.invalid'`;
    const r = (await reporteTurnos(sql, general, null))!;
    expect(r.filas.length).toBe((await sql`select count(*)::int as n from sucursal`)[0].n);
    expect(r.turnosAbiertos).toBe(1);
  });

  it("un código mal formado responde igual que sin permiso", async () => {
    expect(await reporteTurnos(sql, await cuenta([["encargado", "TEN"]]), "ten'--")).toBeNull();
  });
});

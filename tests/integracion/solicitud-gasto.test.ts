import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { corregirGasto, detalleGasto, pantallaGastos, solicitarGasto, type CamposGasto } from "@/lib/gastos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/** Bloque 6, PR 3 (acordado el 27 nov 2026; solo datos ficticios): solicitudes de gasto. */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const s: Record<string, string> = {};
const D = "@prueba.fitnessland.invalid";

const campos = (x: Partial<CamposGasto> = {}): CamposGasto =>
  ({ concepto: "Garrafones de agua", categoria: "prueba_agua", importe: "480", proveedor: "Proveedor ficticio A", nota: "", ...x });
const solicitar = (u: string, codigo: string, x: Partial<CamposGasto & { pagaId: string; compraDe: string; envio: string }> = {}) =>
  solicitarGasto(sql, u, codigo, { ...campos(x), pagaId: "", compraDe: "", envio: randomUUID(), ...x }, PRUEBAS);

async function cuenta(nombre: string, asignaciones: [string, string][]) {
  const [x] = await sql<{ id: string }[]>`insert into usuario (nombre, correo, es_prueba) values (${nombre}, ${`g-${randomUUID().slice(0, 8)}${D}`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${x.id}, ${rol}, ${s[codigo]}, 'Prueba')`;
  return x.id;
}

describe.skipIf(!URL_ADMIN)("solicitudes de gasto", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const x of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) s[x.codigo] = x.id;
  });
  afterAll(async () => cerrar?.());

  it("Recepción solicita: clave fija por sucursal, versión 1, sin mover dinero; ve solo lo suyo", async () => {
    const r1 = await cuenta("Recepción G1", [["recepcion", "TEN"]]);
    const r2 = await cuenta("Recepción G2", [["recepcion", "TEN"]]);
    const enc = await cuenta("Encargado G", [["encargado", "TEN"]]);
    const a = await solicitar(r1, "TEN");
    expect(a).toEqual({ ok: true, clave: "TEN-G1" });
    expect(await solicitar(r2, "TEN", { concepto: "Cloro" , categoria: "prueba_limpieza", importe: "1,200.50" })).toEqual({ ok: true, clave: "TEN-G2" });
    // Otra sucursal numera aparte.
    const rs = await cuenta("Recepción STG", [["recepcion", "STG"]]);
    expect(await solicitar(rs, "STG")).toEqual({ ok: true, clave: "STG-G1" });

    // Recepción ve solo lo suyo; Encargado ve todo lo de la sucursal.
    expect((await pantallaGastos(sql, r1, "TEN"))!.gastos.map((g) => g.clave)).toEqual(["TEN-G1"]);
    expect((await pantallaGastos(sql, r1, "TEN"))!.consultaTodos).toBe(false);
    expect((await pantallaGastos(sql, enc, "TEN"))!.gastos.map((g) => g.clave)).toEqual(["TEN-G2", "TEN-G1"]);
    expect(await detalleGasto(sql, r2, "TEN", "TEN-G1")).toBeNull();
    expect(await detalleGasto(sql, enc, "TEN", "TEN-G1")).toMatchObject({ gasto: { clave: "TEN-G1", importe: "480.00", concepto: "Garrafones de agua" }, puedeCorregir: false });
    // Sin permiso en la sucursal: «No encontrada».
    expect(await pantallaGastos(sql, rs, "TEN")).toBeNull();
    expect(await solicitar(rs, "TEN")).toEqual({ ok: false, error: "no_encontrada" });

    // Solicitar no mueve dinero.
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from movimiento_efectivo`;
    expect(n).toBe(0);
  });

  it("valida los campos; las categorías de prueba vienen marcadas; idempotente por envío", async () => {
    const r = await cuenta("Recepción validar", [["recepcion", "RAY"]]);
    expect(await solicitar(r, "RAY", { concepto: "ab" })).toEqual({ ok: false, error: "concepto" });
    expect(await solicitar(r, "RAY", { categoria: "inventada" })).toEqual({ ok: false, error: "categoria" });
    expect(await solicitar(r, "RAY", { importe: "0" })).toEqual({ ok: false, error: "importe" });
    expect(await solicitar(r, "RAY", { importe: "abc" })).toEqual({ ok: false, error: "importe" });
    expect(await solicitar(r, "RAY", { proveedor: "x" })).toEqual({ ok: false, error: "proveedor" });
    expect(await solicitar(r, "RAY", { nota: "n".repeat(301) })).toEqual({ ok: false, error: "nota" });
    expect((await pantallaGastos(sql, r, "RAY"))!.categorias.every((c) => c.dePrueba && c.nombre.endsWith("(de prueba)"))).toBe(true);
    const envio = randomUUID();
    const a = await solicitar(r, "RAY", { envio });
    const b = await solicitar(r, "RAY", { envio });
    expect(a).toEqual(b);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from gasto where clave_envio = ${envio}`;
    expect(n).toBe(1);
    expect(await solicitarGasto(sql, r, "RAY", { ...campos(), pagaId: "", compraDe: "", envio: randomUUID() }, { entorno: "produccion" }))
      .toEqual({ ok: false, error: "bloqueado_produccion" });
  });

  it("sucursal que paga y beneficiada por separado: requiere poder solicitar en ambas; se ve en las dos", async () => {
    const e = await cuenta("Encargado dos sucursales", [["encargado", "TEN"], ["encargado", "SCR"]]);
    const soloTen = await cuenta("Encargado solo TEN", [["encargado", "TEN"]]);
    expect(await solicitar(soloTen, "SCR", { pagaId: s.TEN })).toEqual({ ok: false, error: "no_encontrada" });
    expect(await solicitar(soloTen, "TEN", { pagaId: s.SCR })).toEqual({ ok: false, error: "sucursal_paga" });
    const r = await solicitar(e, "SCR", { concepto: "Pintura para recepción", categoria: "prueba_mantenimiento", importe: "200", pagaId: s.TEN });
    expect(r).toMatchObject({ ok: true, clave: expect.stringMatching(/^SCR-G\d+$/) });
    const clave = (r as { clave: string }).clave;
    const d = await detalleGasto(sql, e, "TEN", clave);
    expect(d?.gasto).toMatchObject({ beneficiada: "San Cristóbal", paga: "Tenango", pagaOtra: true });
    expect((await pantallaGastos(sql, soloTen, "TEN"))!.gastos.map((g) => g.clave)).toContain(clave);
  });

  it("parte de una compra ya solicitada: solo de la misma sucursal beneficiada y a la original", async () => {
    const e = await cuenta("Encargado compras", [["encargado", "STG"], ["encargado", "TEN"]]);
    const o = await solicitar(e, "STG", { concepto: "Material de limpieza", categoria: "prueba_limpieza", importe: "300" });
    const [orig] = await sql<{ id: string }[]>`select id from gasto where clave = ${(o as { clave: string }).clave}`;
    const p = await solicitar(e, "STG", { concepto: "Más material de limpieza", categoria: "prueba_limpieza", importe: "300", compraDe: orig.id });
    expect(p.ok).toBe(true);
    const [parte] = await sql<{ id: string }[]>`select id from gasto where clave = ${(p as { clave: string }).clave}`;
    // No se liga a una parte (solo a la original) ni a otra sucursal.
    expect(await solicitar(e, "STG", { compraDe: parte.id })).toEqual({ ok: false, error: "compra" });
    expect(await solicitar(e, "TEN", { compraDe: orig.id })).toEqual({ ok: false, error: "compra" });
    const d = await detalleGasto(sql, e, "STG", (o as { clave: string }).clave);
    expect(d?.gasto.partes).toEqual([{ clave: (p as { clave: string }).clave, importe: "300.00" }]);
    expect((await detalleGasto(sql, e, "STG", (p as { clave: string }).clave))?.gasto.compraDe).toBe((o as { clave: string }).clave);
  });

  it("corrección: solo quien solicitó, con motivo, como versión nueva; las anteriores se conservan", async () => {
    const r = await cuenta("Recepción corrige", [["recepcion", "SAD"]]);
    const enc = await cuenta("Encargado SAN", [["encargado", "SAD"]]);
    const { clave } = (await solicitar(r, "SAD")) as { clave: string };
    const corregir = (u: string, x: Partial<CamposGasto & { version: number; motivo: string }>) =>
      corregirGasto(sql, u, "SAD", { ...campos(), clave, version: 1, motivo: "Faltaba un garrafón", ...x }, PRUEBAS);
    expect(await corregir(enc, { importe: "600" })).toEqual({ ok: false, error: "sin_permiso" });
    expect(await corregir(r, { importe: "600", motivo: "x" })).toEqual({ ok: false, error: "motivo" });
    expect(await corregir(r, {})).toEqual({ ok: false, error: "sin_cambio" });
    expect(await corregir(r, { importe: "600" })).toEqual({ ok: true });
    expect(await corregir(r, { importe: "700" })).toEqual({ ok: false, error: "version" });
    const d = await detalleGasto(sql, r, "SAD", clave);
    expect(d?.gasto.importe).toBe("600.00");
    expect(d?.versiones.map((v) => [v.version, v.importe, v.motivo])).toEqual([[1, "480.00", null], [2, "600.00", "Faltaba un garrafón"]]);
  });

  it("la base respalda: nada se edita ni se borra; versiones consecutivas y de quien solicitó; versión 1 obligatoria", async () => {
    const r = await cuenta("Recepción base", [["recepcion", "ATL"]]);
    const otro = await cuenta("Otra cuenta", [["recepcion", "ATL"]]);
    const { clave } = (await solicitar(r, "ATL")) as { clave: string };
    const [g] = await sql<{ id: string }[]>`select id from gasto where clave = ${clave}`;
    await expect(sql`update gasto set clave = 'X' where id = ${g.id}`).rejects.toThrow(/no se edita/);
    await expect(sql`delete from gasto_version where gasto_id = ${g.id}`).rejects.toThrow(/no se edita/);
    const v = (version: number, por: string, motivo: string | null) =>
      sql`insert into gasto_version (gasto_id, version, concepto, categoria, importe, motivo, registrada_por) values (${g.id}, ${version}, 'Concepto', 'prueba_agua', 10, ${motivo}, ${por})`;
    await expect(v(3, r, "Salta una versión")).rejects.toThrow(/no es la siguiente/);
    await expect(v(2, otro, "Otra persona corrige")).rejects.toThrow(/Solo quien solicitó/);
    await expect(v(2, r, null)).rejects.toThrow(/gasto_version_motivo/);
    await expect(sql`insert into gasto (sucursal_id, sucursal_paga_id, solicitado_por, clave_envio, numero, clave)
                     values (${s.ATL}, ${s.ATL}, ${r}, ${randomUUID()}, 0, '')`).rejects.toThrow(/registra su versión 1/);
    await expect(sql`truncate gasto_version`).rejects.toThrow();
  });

  it("la clave conserva el código original aunque cambie el de la sucursal", async () => {
    const [x] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values ('Cambio de código', 'CCA') returning id`;
    s.CCA = x.id;
    const r = await cuenta("Recepción CCA", [["recepcion", "CCA"]]);
    expect(await solicitar(r, "CCA")).toEqual({ ok: true, clave: "CCA-G1" });
    await sql`update sucursal set codigo = 'CCB' where id = ${x.id}`;
    expect(await solicitar(r, "CCB")).toEqual({ ok: true, clave: "CCB-G2" });
    expect((await pantallaGastos(sql, r, "CCB"))!.gastos.map((g) => g.clave)).toEqual(["CCB-G2", "CCA-G1"]);
  });
});

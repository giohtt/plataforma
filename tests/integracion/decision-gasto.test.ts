import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bandejaGastos, corregirGasto, decidirGasto, detalleGasto, gastosPorDecidir, solicitarGasto } from "@/lib/gastos";
import { aplicarCambio, type Alcance, type CambioAcceso } from "@/lib/usuarios";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 6, PR 4 (acordado el 27 nov 2026; solo datos ficticios): ruta de autorización de gastos, rechazos, bandejas y
 * delegaciones temporales. Los límites de estas pruebas son ficticios; en el sitio no se configura ninguno.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const s: Record<string, string> = {};
const D = "@prueba.fitnessland.invalid";
let general: string;

const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const masDias = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() + n * 86_400_000));
const cambiar = (persona: string, c: CambioAcceso) => aplicarCambio(sql, general, persona, c, PRUEBAS);
const solo = (...codigos: string[]): Alcance => ({ todas: false, sucursales: codigos.map((c) => s[c]) });
const facultad = (persona: string, alcance: Alcance, limite: string, diario: string) =>
  cambiar(persona, { tipo: "facultad_gasto", alcance, sinLimite: false, limite, diario, hasta: "", motivo: "Límites ficticios de prueba" });
const sinLimite = (persona: string, alcance: Alcance) =>
  cambiar(persona, { tipo: "facultad_gasto", alcance, sinLimite: true, limite: "", diario: "", hasta: "", motivo: "Dirección sin límite (prueba)" });

async function cuenta(nombre: string, asignaciones: [string, string][], general = false) {
  const [x] = await sql<{ id: string }[]>`insert into usuario (nombre, correo, es_prueba) values (${nombre}, ${`d-${randomUUID().slice(0, 8)}${D}`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${x.id}, ${rol}, ${s[codigo]}, 'Prueba')`;
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${x.id}, 'direccion', 'Prueba')`;
  return x.id;
}
async function solicitar(u: string, codigo: string, importe: string, extra: { pagaId?: string; compraDe?: string } = {}) {
  const r = await solicitarGasto(sql, u, codigo, {
    concepto: `Gasto ficticio ${importe}`, categoria: "prueba_otros", importe, proveedor: "", nota: "",
    pagaId: extra.pagaId ?? "", compraDe: extra.compraDe ?? "", envio: randomUUID(),
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return r.clave;
}
const decidir = (u: string, codigo: string, clave: string, decision: string, motivo = "", version = 1) =>
  decidirGasto(sql, u, codigo, { clave, version, decision, motivo }, PRUEBAS);
const idDe = async (clave: string) => (await sql<{ id: string }[]>`select id from gasto where clave = ${clave}`)[0].id;

describe.skipIf(!URL_ADMIN)("autorización de gastos", () => {
  // Personas: Recepción y Encargado de TEN; Gestión administrativa de TEN y STG; Dirección en todas.
  let rec: string, enc: string, ges: string, dir: string;
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const x of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) s[x.codigo] = x.id;
    [{ id: general }] = await sql<{ id: string }[]>`select id from usuario where correo = ${`direccion.general${D}`}`;
    rec = await cuenta("Recepción D", [["recepcion", "TEN"]]);
    enc = await cuenta("Encargado D", [["encargado", "TEN"]]);
    ges = await cuenta("Gestión administrativa D", [["gestion_administrativa", "TEN"], ["gestion_administrativa", "STG"]]);
    dir = await cuenta("Dirección D", [], true);
  });
  afterAll(async () => cerrar?.());

  it("sin facultades configuradas nadie decide: queda por autorizar", async () => {
    const clave = await solicitar(rec, "TEN", "100");
    for (const u of [rec, enc, ges, dir]) expect(await decidir(u, "TEN", clave, "autorizado")).toMatchObject({ ok: false });
    expect(await decidir(enc, "TEN", clave, "autorizado")).toEqual({ ok: false, error: "sin_facultad" });
    const d = await detalleGasto(sql, dir, "TEN", clave);
    expect(d?.gasto.estado).toBe("por_autorizar");
    expect(d?.puedenDecidir).toEqual([]);
  });

  it("Encargado dentro de sus límites; lo que pasa de ahí llega a Gestión administrativa y a Dirección; la primera decide", async () => {
    expect(await facultad(enc, solo("TEN"), "300", "400")).toEqual({ ok: true });
    expect(await facultad(ges, solo("TEN", "STG"), "1000", "3000")).toEqual({ ok: true });
    expect(await sinLimite(dir, { todas: true })).toEqual({ ok: true });

    const a = await solicitar(rec, "TEN", "200");
    expect((await detalleGasto(sql, rec, "TEN", a))?.puedenDecidir).toEqual(["Dirección D", "Encargado D", "Gestión administrativa D"]);
    expect(await gastosPorDecidir(sql, enc, s.TEN)).toBeGreaterThan(0);
    expect(await decidir(enc, "TEN", a, "autorizado", "Prueba: dentro de su límite")).toEqual({ ok: true });
    const da = await detalleGasto(sql, rec, "TEN", a);
    expect(da?.gasto).toMatchObject({ estado: "autorizado", decididoPor: "Encargado D" });
    expect(da?.decisiones).toMatchObject([{ decision: "autorizado", importe: "200.00", sinLimite: false, limite: "300.00", diario: "400.00" }]);
    // Ya decidido: nadie más lo decide.
    expect(await decidir(dir, "TEN", a, "autorizado")).toEqual({ ok: false, error: "ya_decidido" });

    // Acumulado del día: 200 + 250 > 400.
    const b = await solicitar(rec, "TEN", "250");
    expect(await decidir(enc, "TEN", b, "autorizado")).toEqual({ ok: false, error: "diario" });
    // Límite por gasto: 350 > 300.
    const c = await solicitar(rec, "TEN", "350");
    expect(await decidir(enc, "TEN", c, "autorizado")).toEqual({ ok: false, error: "limite" });
    expect((await detalleGasto(sql, rec, "TEN", c))?.puedenDecidir).toEqual(["Dirección D", "Gestión administrativa D"]);
    expect(await decidir(ges, "TEN", c, "autorizado")).toEqual({ ok: true });
    expect(await decidir(dir, "TEN", c, "autorizado")).toEqual({ ok: false, error: "ya_decidido" });
    expect(await decidir(dir, "TEN", b, "autorizado")).toEqual({ ok: true });
  });

  it("separación: quien solicitó no decide lo suyo (salvo Dirección); lo de Dirección solo lo decide Dirección", async () => {
    const delEnc = await solicitar(enc, "TEN", "50");
    expect(await decidir(enc, "TEN", delEnc, "autorizado")).toEqual({ ok: false, error: "propio" });
    expect(await decidir(ges, "TEN", delEnc, "autorizado")).toEqual({ ok: true });
    const deGes = await solicitar(ges, "TEN", "60");
    expect(await decidir(ges, "TEN", deGes, "autorizado")).toEqual({ ok: false, error: "propio" });
    expect((await detalleGasto(sql, dir, "TEN", deGes))?.puedenDecidir).toEqual(["Dirección D", "Encargado D"]);
    expect(await decidir(dir, "TEN", deGes, "autorizado")).toEqual({ ok: true });
    const deDir = await solicitar(dir, "TEN", "70");
    expect(await decidir(ges, "TEN", deDir, "autorizado")).toEqual({ ok: false, error: "de_direccion" });
    expect(await decidir(enc, "TEN", deDir, "autorizado")).toEqual({ ok: false, error: "de_direccion" });
    expect(await decidir(dir, "TEN", deDir, "autorizado", "Gasto propio de Dirección")).toEqual({ ok: true });
  });

  it("si paga otra sucursal, quien decide necesita facultad suficiente en ambas; si no, llega a Dirección", async () => {
    const e2 = await cuenta("Encargado dos sucursales D", [["encargado", "SCR"], ["encargado", "TEN"]]);
    expect(await facultad(e2, solo("SCR"), "500", "1000")).toEqual({ ok: true });
    const r = await cuenta("Recepción SCR D", [["recepcion", "SCR"], ["recepcion", "TEN"]]);
    const clave = await solicitar(r, "SCR", "100", { pagaId: s.TEN });
    expect(await decidir(e2, "SCR", clave, "autorizado")).toEqual({ ok: false, error: "sin_facultad" });
    expect((await detalleGasto(sql, dir, "SCR", clave))?.puedenDecidir).toEqual(["Dirección D"]);
    expect(await decidir(dir, "TEN", clave, "autorizado")).toEqual({ ok: true });
  });

  it("una compra dividida se compara completa con el límite por gasto", async () => {
    const r = await cuenta("Recepción STG D", [["recepcion", "STG"]]);
    const e = await cuenta("Encargado STG D", [["encargado", "STG"]]);
    expect(await facultad(e, solo("STG"), "300", "2000")).toEqual({ ok: true });
    const orig = await solicitar(r, "STG", "200");
    const parte = await solicitar(r, "STG", "200", { compraDe: await idDe(orig) });
    expect(await decidir(e, "STG", orig, "autorizado")).toEqual({ ok: false, error: "limite" });
    expect(await decidir(e, "STG", parte, "autorizado")).toEqual({ ok: false, error: "limite" });
    expect((await detalleGasto(sql, r, "STG", orig))?.gasto.totalCompra).toBe("400.00");
    // Si se rechaza una parte, deja de sumar.
    expect(await decidir(ges, "STG", parte, "rechazado", "Prueba: era la misma compra")).toEqual({ ok: true });
    expect(await decidir(e, "STG", orig, "autorizado")).toEqual({ ok: true });
  });

  it("rechazar exige motivo; corregir crea versión nueva por decidir y la decisión anterior deja de valer", async () => {
    const clave = await solicitar(rec, "TEN", "40");
    expect(await decidir(ges, "TEN", clave, "rechazado", "")).toEqual({ ok: false, error: "motivo" });
    expect(await decidir(ges, "TEN", clave, "otra")).toEqual({ ok: false, error: "decision" });
    expect(await decidir(ges, "TEN", clave, "rechazado", "Faltan datos del proveedor")).toEqual({ ok: true });
    expect((await detalleGasto(sql, rec, "TEN", clave))?.gasto).toMatchObject({ estado: "rechazado", motivoDecision: "Faltan datos del proveedor" });
    expect(await corregirGasto(sql, rec, "TEN", { concepto: "Gasto ficticio 40", categoria: "prueba_otros", importe: "45", proveedor: "Proveedor ficticio B", nota: "",
      clave, version: 1, motivo: "Agrego proveedor" }, PRUEBAS)).toEqual({ ok: true });
    expect((await detalleGasto(sql, rec, "TEN", clave))?.gasto.estado).toBe("por_autorizar");
    // La decisión es sobre la versión vigente.
    expect(await decidir(ges, "TEN", clave, "autorizado", "", 1)).toEqual({ ok: false, error: "version" });
    expect(await decidir(ges, "TEN", clave, "autorizado", "", 2)).toEqual({ ok: true });
    // Corregir algo autorizado lo regresa a «por autorizar».
    expect(await corregirGasto(sql, rec, "TEN", { concepto: "Gasto ficticio 40", categoria: "prueba_otros", importe: "48", proveedor: "Proveedor ficticio B", nota: "",
      clave, version: 2, motivo: "Cambió el precio" }, PRUEBAS)).toEqual({ ok: true });
    const d = await detalleGasto(sql, rec, "TEN", clave);
    expect(d?.gasto.estado).toBe("por_autorizar");
    expect(d?.decisiones.map((x) => [x.version, x.decision])).toEqual([[1, "rechazado"], [2, "autorizado"]]);
  });

  it("bandeja: Dirección ve todo; Gestión administrativa solo sus sucursales; Recepción no tiene bandeja", async () => {
    await solicitar(await cuenta("Recepción ATL D", [["recepcion", "ATL"]]), "ATL", "10");
    const bd = (await bandejaGastos(sql, dir, "todos"))!;
    const bg = (await bandejaGastos(sql, ges, "todos"))!;
    expect(bd.gastos.some((g) => g.clave.startsWith("SCR-"))).toBe(true);
    // Gestión administrativa: lo de sus sucursales, como beneficiada o como la que paga (SCR pagado por Tenango sí).
    expect(bg.gastos.every((g) => ["Tenango", "Santiago"].includes(g.beneficiada) || ["Tenango", "Santiago"].includes(g.paga))).toBe(true);
    expect(bd.gastos.length).toBeGreaterThan(bg.gastos.length);
    expect(await bandejaGastos(sql, rec, "todos")).toBeNull();
    const tuyos = (await bandejaGastos(sql, dir, "tuyos"))!;
    expect(tuyos.gastos.every((g) => g.estado === "por_autorizar" && g.impedimento === null)).toBe(true);
    expect(bd.cuentas.todos).toBe(bd.gastos.length);
  });

  it("la base respalda: decisión directa sin facultad, sobre otra versión o con otra facultad se rechaza; nada se edita", async () => {
    const clave = await solicitar(rec, "TEN", "30");
    const id = await idDe(clave);
    const ins = (por: string, extra: Record<string, unknown> = {}) => sql`insert into decision_gasto ${sql({
      gasto_id: id, version: 1, decision: "autorizado", importe: 30, por, sin_limite: false, ...extra })}`;
    const otra = await cuenta("Recepción sin facultad D", [["recepcion", "TEN"]]);
    await expect(ins(otra)).rejects.toThrow(/sin_facultad/);
    await expect(ins(rec)).rejects.toThrow(/propio/);
    await expect(ins(dir, { version: 2 })).rejects.toThrow();
    await expect(ins(dir, { sin_limite: false })).rejects.toThrow(/facultad vigente/);
    const [f] = await sql<{ facultad_id: string }[]>`select facultad_id from facultad_gasto(${dir}, ${s.TEN})`;
    await ins(dir, { sin_limite: true, facultad_id: f.facultad_id });
    await expect(sql`update decision_gasto set motivo = 'x' where gasto_id = ${id}`).rejects.toThrow(/no se edita/);
    await expect(sql`delete from decision_gasto where gasto_id = ${id}`).rejects.toThrow(/no se edita/);
    await expect(sql`insert into decision_gasto (gasto_id, version, decision, importe, por, sin_limite) values (${id}, 1, 'rechazado', 30, ${dir}, true)`)
      .rejects.toThrow();
  });

  it("delegación temporal: límites y sucursales fijados, con inicio y fin; no aplica antes ni después; no se cruza", async () => {
    const sup = await cuenta("Encargado suplente D", [["encargado", "ATL"]]);
    const deleg = (x: Partial<{ limite: string; diario: string; desde: string; hasta: string }>) =>
      cambiar(sup, { tipo: "delegacion_gasto", alcance: solo("ATL"), limite: "200", diario: "500", desde: hoyMx(), hasta: masDias(7), motivo: "Vacaciones ficticias", ...x });
    expect(await deleg({ hasta: "" })).toEqual({ ok: false, error: "hasta" });
    expect(await deleg({ desde: masDias(-1) })).toEqual({ ok: false, error: "desde" });
    expect(await deleg({ desde: masDias(5), hasta: masDias(2) })).toEqual({ ok: false, error: "hasta" });
    expect(await deleg({ limite: "" })).toEqual({ ok: false, error: "limite" });
    // Empieza en el futuro: hoy no aplica.
    expect(await deleg({ desde: masDias(3), hasta: masDias(6) })).toEqual({ ok: true });
    const [{ n: hoy }] = await sql<{ n: number }[]>`select count(*)::int as n from facultad_gasto(${sup}, ${s.ATL})`;
    expect(hoy).toBe(0);
    // Se cruza con la anterior: rechazada.
    expect(await deleg({ desde: masDias(5), hasta: masDias(9) })).toEqual({ ok: false, error: "ya_tiene_gasto" });
    // Otra que empieza hoy y termina antes: sí.
    expect(await deleg({ desde: hoyMx(), hasta: masDias(1) })).toEqual({ ok: true });
    const [v] = await sql<{ limite_monto: string; limite_diario: string }[]>`select limite_monto::text, limite_diario::text from facultad_gasto(${sup}, ${s.ATL})`;
    expect(v).toEqual({ limite_monto: "200.00", limite_diario: "500.00" });
    const [f] = await sql<{ es_delegacion: boolean; vigente_hasta: Date }[]>`
      select es_delegacion, vigente_hasta from facultad_otorgada where usuario_id = ${sup} order by vigente_desde limit 1`;
    expect(f.es_delegacion).toBe(true);
    // La base exige el fin.
    await expect(sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, es_delegacion, motivo)
                     values (${sup}, 'autorizacion.gasto', ${s.ATL}, 100, 200, true, 'Sin fin')`).rejects.toThrow(/facultad_delegacion_completa/);
  });
});

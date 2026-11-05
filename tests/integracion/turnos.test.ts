import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;

async function cuenta(asignaciones: [string, string][]) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Turno " + n}, ${`turno${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de turno')`;
  }
  return u.id;
}
let k = 0;
/** Sucursal nueva para cada prueba, para que los turnos no se crucen entre pruebas. */
async function sucursalNueva(estado = "activa") {
  k++;
  const codigo = `T${k}`;
  const [s] = await sql<{ id: string }[]>`
    insert into sucursal (nombre, codigo, estado_operativo, desactivada_en)
    values (${"Sucursal turno " + k}, ${codigo}, ${estado}, ${estado === "inactiva" ? sql`now()` : null}) returning id`;
  ids[codigo] = s.id;
  return codigo;
}
const abrir = (u: string, codigo: string, bolsa = "350.00", cajon = "1200.00") =>
  abrirTurno(sql, u, codigo, { bolsa, cajon }, { entorno: "pruebas" });

describe.skipIf(!URL_ADMIN)("apertura de turno de Recepción", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("cada sucursal tiene su bolsa de visitas y su cajón de mensualidades, también las que se crean después", async () => {
    const codigo = await sucursalNueva();
    const tipos = await sql`select tipo from lugar_efectivo where sucursal_id = ${ids[codigo]} order by tipo`;
    expect(tipos.map((t) => t.tipo)).toEqual(["bolsa_visitas", "cajon_mensualidades"]);
    expect((await sql`select count(*)::int as n from lugar_efectivo where sucursal_id = ${ids.TEN}`)[0].n).toBe(2);
  });

  it("Recepción abre: se registra por separado lo contado y el responsable de cada lugar; el cajón no está conciliado", async () => {
    const codigo = await sucursalNueva();
    const recep = await cuenta([["recepcion", codigo]]);
    const r = await abrir(recep, codigo, "350.00", "1200.00");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const e = (await estadoTurno(sql, recep, codigo))!;
    expect(e.turno?.id).toBe(r.turnoId);
    expect(e.turno?.lugares.map((l) => [l.tipo, l.contadoAlAbrir, l.responsable, l.conciliado])).toEqual([
      ["bolsa_visitas", "350.00", `Turno ${n}`, false],
      ["cajon_mensualidades", "1200.00", `Turno ${n}`, false],
    ]);
    // Dos registros de responsable, uno por lugar, aunque sea la misma persona.
    const resp = await sql`select usuario_id from responsable_lugar where turno_id = ${r.turnoId}`;
    expect(resp.map((x) => x.usuario_id)).toEqual([recep, recep]);
    // Abrir no registra cobros ni movimientos: solo turno, responsables, conteos e historial.
    expect(await sql`select momento, importe::text, contado_por from conteo_efectivo where turno_id = ${r.turnoId} order by conteo_efectivo.importe`).toEqual([
      { momento: "apertura", importe: "350.00", contado_por: recep },
      { momento: "apertura", importe: "1200.00", contado_por: recep },
    ]);
  });

  it("$0 es un conteo válido en ambos lugares", async () => {
    const codigo = await sucursalNueva();
    const recep = await cuenta([["recepcion", codigo]]);
    expect((await abrir(recep, codigo, "0.00", "0.00")).ok).toBe(true);
    expect((await estadoTurno(sql, recep, codigo))!.turno!.lugares.map((l) => l.contadoAlAbrir)).toEqual(["0.00", "0.00"]);
  });

  it("solo un turno abierto a la vez por sucursal, aunque lo intente otra recepcionista", async () => {
    const codigo = await sucursalNueva();
    const a = await cuenta([["recepcion", codigo]]);
    const b = await cuenta([["recepcion", codigo]]);
    expect((await abrir(a, codigo)).ok).toBe(true);
    expect(await abrir(b, codigo)).toEqual({ ok: false, error: "ya_abierto" });
    expect(await abrir(a, codigo)).toEqual({ ok: false, error: "ya_abierto" });
    // Otra sucursal no se ve afectada.
    const otra = await sucursalNueva();
    expect((await abrir(await cuenta([["recepcion", otra]]), otra)).ok).toBe(true);
  });

  it("dos personas abren al mismo tiempo: solo una lo consigue", async () => {
    const codigo = await sucursalNueva();
    const personas = [await cuenta([["recepcion", codigo]]), await cuenta([["recepcion", codigo]]), await cuenta([["recepcion", codigo]])];
    const resultados = await Promise.all(personas.map((p) => abrir(p, codigo)));
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    expect(resultados.filter((r) => !r.ok)).toEqual([{ ok: false, error: "ya_abierto" }, { ok: false, error: "ya_abierto" }]);
    expect((await sql`select count(*)::int as n from turno where sucursal_id = ${ids[codigo]} and cerrado_en is null`)[0].n).toBe(1);
  });

  it("la base también impide un segundo turno abierto aunque se intente sin pasar por la aplicación", async () => {
    const codigo = await sucursalNueva();
    const u = await cuenta([["recepcion", codigo]]);
    await sql`insert into turno (sucursal_id, abierto_por) values (${ids[codigo]}, ${u})`;
    await expect(sql`insert into turno (sucursal_id, abierto_por) values (${ids[codigo]}, ${u})`).rejects.toThrow(/turno_uno_abierto/);
  });

  it("Encargado, Administración y Dirección consultan el turno, pero no lo abren; sin permiso en la sucursal no se encuentra", async () => {
    const codigo = await sucursalNueva();
    for (const rol of ["encargado", "administracion", "direccion"]) {
      const u = await cuenta([[rol, codigo]]);
      expect((await estadoTurno(sql, u, codigo))?.puedeAbrir, rol).toBe(false);
      expect(await abrir(u, codigo), rol).toEqual({ ok: false, error: "sin_permiso" });
    }
    for (const u of [await cuenta([]), await cuenta([["recepcion", "STG"]])]) {
      expect(await estadoTurno(sql, u, codigo)).toBeNull();
      expect(await abrir(u, codigo)).toEqual({ ok: false, error: "no_encontrada" });
    }
    expect(await sql`select 1 from turno where sucursal_id = ${ids[codigo]}`).toHaveLength(0);
  });

  it("no se abre turno en una sucursal inactiva; en producción está bloqueado", async () => {
    const inactiva = await sucursalNueva("inactiva");
    expect(await abrir(await cuenta([["recepcion", inactiva]]), inactiva)).toEqual({ ok: false, error: "sucursal_inactiva" });
    const codigo = await sucursalNueva();
    expect(await abrirTurno(sql, await cuenta([["recepcion", codigo]]), codigo, { bolsa: "0.00", cajon: "0.00" }, { entorno: "produccion" }))
      .toEqual({ ok: false, error: "bloqueado_produccion" });
  });

  it("los conteos no se editan ni se borran, y la base no admite importes negativos", async () => {
    const codigo = await sucursalNueva();
    const recep = await cuenta([["recepcion", codigo]]);
    const r = await abrir(recep, codigo);
    if (!r.ok) throw new Error();
    await expect(sql`update conteo_efectivo set importe = 1 where turno_id = ${r.turnoId}`).rejects.toThrow();
    await expect(sql`delete from conteo_efectivo where turno_id = ${r.turnoId}`).rejects.toThrow();
    const [lugar] = await sql`select id from lugar_efectivo where sucursal_id = ${ids[codigo]} limit 1`;
    const [t2] = await sql`select id from turno where sucursal_id = ${ids[codigo]}`;
    await expect(sql`insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por) values (${t2.id}, ${lugar.id}, 'apertura', -1, ${recep})`).rejects.toThrow();
  });
});

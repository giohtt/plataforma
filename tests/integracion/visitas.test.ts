import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { confirmarVisita, impedimentoRegistroVisita, pantallaCobro, visitasDelTurno } from "@/lib/visitas";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;
let k = 0;
const PRUEBAS = { entorno: "pruebas" as const };

async function cuenta(asignaciones: [string, string][]) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Visita " + n}, ${`visita${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de visita')`;
  }
  return u.id;
}
/** Sucursal nueva con su turno abierto ($0 en la bolsa, $1,200 en el cajón) por una recepcionista nueva. */
async function escenario() {
  k++;
  const codigo = `V${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal visita " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const recep = await cuenta([["recepcion", codigo]]);
  const t = await abrirTurno(sql, recep, codigo, { bolsa: "0.00", cajon: "1200.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  return { codigo, recep, turnoId: t.turnoId };
}
/** Ficha ficticia creada en otra sucursal (Atlacomulco), como la de un visitante que ya existía. */
async function ficha(nombre = `Diego Prueba ${randomUUID().slice(0, 6)}`) {
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, telefono, sucursal_alta_id) values (${nombre}, '0000000201', ${ids.ATL}) returning id`;
  return v.id;
}
const conteos = async (codigo: string) => {
  const [r] = await sql<{ operaciones: number; cobros: number; pases: number; movimientos: number; suma: string }[]>`
    select (select count(*)::int from operacion_visita o where o.sucursal_id = s.id) as operaciones,
           (select count(*)::int from cobro_visita c join operacion_visita o on o.id = c.operacion_id where o.sucursal_id = s.id) as cobros,
           (select count(*)::int from pase_visita p where p.sucursal_id = s.id) as pases,
           (select count(*)::int from movimiento_efectivo m join lugar_efectivo l on l.id = m.lugar_id where l.sucursal_id = s.id) as movimientos,
           (select coalesce(sum(m.importe), 0)::text from movimiento_efectivo m join lugar_efectivo l on l.id = m.lugar_id where l.sucursal_id = s.id) as suma
    from sucursal s where s.codigo = ${codigo}`;
  return r;
};
/** La pantalla de cobro: el turno abierto que muestra y la responsable de la bolsa (no guarda nada). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const revisar = (u: string, codigo: string, _visitanteId?: string) => pantallaCobro(sql, u, codigo, "pruebas");
/** Lo que envía la pantalla al confirmar: una clave nueva, el turno mostrado, la ficha y lo recibido. */
async function revisada(u: string, codigo: string, visitanteId: string, recibido: string | null = null, cambio: string | null = null) {
  const p = await revisar(u, codigo);
  if (!p.ok) throw new Error(p.error);
  return { clave: randomUUID(), turnoId: p.turnoId, visitante: { id: visitanteId }, recibido, cambio };
}
const confirmar = (u: string, codigo: string, r: { clave: string; turnoId: string; visitante: { id: string }; recibido: string | null; cambio: string | null }) =>
  confirmarVisita(sql, u, codigo, { clave: r.clave, turnoId: r.turnoId, visitanteId: r.visitante.id, recibido: r.recibido, cambio: r.cambio }, PRUEBAS);

describe.skipIf(!URL_ADMIN)("visita individual de $50 en efectivo", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  describe("pantalla de cobro y confirmación", () => {
    it("la pantalla de cobro trae el turno abierto, la sucursal y la responsable de la bolsa; no guarda nada", async () => {
      const { codigo, recep, turnoId } = await escenario();
      expect(await pantallaCobro(sql, recep, codigo, "pruebas")).toEqual({
        ok: true, turnoId, sucursal: `Sucursal visita ${k}`, responsableBolsa: `Visita ${n}`,
      });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0, cobros: 0, pases: 0, movimientos: 0 });
    });

    it("confirmar guarda una operación, un cobro, un pase en la sucursal de la visita y $50 en la bolsa", async () => {
      const { codigo, recep, turnoId } = await escenario();
      const v = await ficha();
      const c = await confirmar(recep, codigo, await revisada(recep, codigo, v));
      expect(c).toMatchObject({ ok: true, repetida: false, cobro: { total: "50.00", recibido: null, cambio: null } });
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 1, movimientos: 1, suma: "50.00" });

      const [p] = await sql`select p.visitante_id, p.sucursal_id, p.tarifa::text, p.descuento::text, p.total::text from pase_visita p
                            join operacion_visita o on o.id = p.operacion_id where o.sucursal_id = ${ids[codigo]}`;
      // La ficha es de Atlacomulco; la visita queda en la sucursal donde ocurrió.
      expect(p).toEqual({ visitante_id: v, sucursal_id: ids[codigo], tarifa: "50.00", descuento: "0.00", total: "50.00" });
      const [m] = await sql`select l.tipo, m.turno_id, m.responsable_id, m.registrado_por, m.importe::text, m.tipo as mov
                            from movimiento_efectivo m join lugar_efectivo l on l.id = m.lugar_id where l.sucursal_id = ${ids[codigo]}`;
      expect(m).toEqual({ tipo: "bolsa_visitas", turno_id: turnoId, responsable_id: recep, registrado_por: recep, importe: "50.00", mov: "entrada_cobro_visita" });
      const [cobro] = await sql`select forma_pago, estado, importe::text, recibido, cambio from cobro_visita`;
      expect(cobro).toEqual({ forma_pago: "efectivo", estado: "confirmado", importe: "50.00", recibido: null, cambio: null });

      // La bolsa: contado al abrir $0 + $50 = $50 esperado. El cajón no cambia y su esperado no se calcula.
      const e = (await estadoTurno(sql, recep, codigo))!;
      expect(e.turno!.lugares.map((l) => [l.tipo, l.contadoAlAbrir, l.entradas, l.cantidadEntradas, l.esperado])).toEqual([
        ["bolsa_visitas", "0.00", "50.00", 1, "50.00"],
        ["cajon_mensualidades", "1200.00", "0.00", 0, null],
      ]);
      expect((await visitasDelTurno(sql, turnoId)).map((x) => [x.total, x.formaPago])).toEqual([["50.00", "efectivo"]]);
    });

    it("con $100 recibidos: cambio de $50 guardado en el cobro; a la bolsa entran solo $50", async () => {
      const { codigo, recep } = await escenario();
      const r = await revisada(recep, codigo, await ficha(), "100.00", "50.00");
      expect(await confirmar(recep, codigo, r)).toMatchObject({ ok: true, cobro: { total: "50.00", recibido: "100.00", cambio: "50.00" } });
      expect(await conteos(codigo)).toMatchObject({ movimientos: 1, suma: "50.00" });
      const [c] = await sql`select c.recibido::text, c.cambio::text from cobro_visita c join operacion_visita o on o.id = c.operacion_id where o.sucursal_id = ${ids[codigo]}`;
      expect(c).toEqual({ recibido: "100.00", cambio: "50.00" });
    });

    it("la base rechaza un cobro con lo recibido menor que el total o un cambio mal calculado", async () => {
      const { codigo, recep, turnoId } = await escenario();
      const [o] = await sql`insert into operacion_visita (clave, sucursal_id, turno_id, registrada_por, total)
                            values (${randomUUID()}, ${ids[codigo]}, ${turnoId}, ${recep}, 50) returning id`;
      for (const [recibido, cambio] of [["20.00", "0.00"], ["100.00", "40.00"], ["100.00", null]]) {
        await expect(sql`insert into cobro_visita (operacion_id, forma_pago, estado, importe, recibido, cambio)
                         values (${o.id}, 'efectivo', 'confirmado', 50, ${recibido}, ${cambio})`).rejects.toThrow();
      }
    });
  });

  describe("doble clic y reintentos", () => {
    it("la misma confirmación enviada dos veces guarda una sola visita y una sola entrada de efectivo", async () => {
      const { codigo, recep } = await escenario();
      const r = await revisada(recep, codigo, await ficha());
      const a = await confirmar(recep, codigo, r);
      const b = await confirmar(recep, codigo, r);
      expect(a).toMatchObject({ ok: true, repetida: false });
      expect(b).toEqual({ ...a, repetida: true });
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 1, movimientos: 1, suma: "50.00" });
    });

    it("reintento tras perder la conexión, aun con otro «Recibido»: responde con el cobro ya guardado y no cobra otra vez", async () => {
      const { codigo, recep } = await escenario();
      const r = await revisada(recep, codigo, await ficha(), "100.00", "50.00");
      expect((await confirmar(recep, codigo, r)).ok).toBe(true); // se guardó, pero la respuesta no llegó
      const otra = await confirmar(recep, codigo, { ...r, recibido: "200.00", cambio: "150.00" });
      expect(otra).toMatchObject({ ok: true, repetida: true, cobro: { recibido: "100.00", cambio: "50.00" } });
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 1, movimientos: 1, suma: "50.00" });
    });

    it("cinco envíos simultáneos de la misma confirmación (doble clic): una sola visita", async () => {
      const { codigo, recep } = await escenario();
      const r = await revisada(recep, codigo, await ficha());
      const todos = await Promise.all(Array.from({ length: 5 }, () => confirmar(recep, codigo, r)));
      expect(todos.every((x) => x.ok)).toBe(true);
      expect(todos.filter((x) => x.ok && !x.repetida)).toHaveLength(1);
      expect(new Set(todos.map((x) => (x as { operacionId: string }).operacionId)).size).toBe(1);
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 1, movimientos: 1, suma: "50.00" });
    });

    it("dos cobros con claves distintas son dos visitas (por ejemplo, la misma persona vuelve más tarde)", async () => {
      const { codigo, recep } = await escenario();
      const v = await ficha();
      expect((await confirmar(recep, codigo, await revisada(recep, codigo, v))).ok).toBe(true);
      expect((await confirmar(recep, codigo, await revisada(recep, codigo, v))).ok).toBe(true);
      expect(await conteos(codigo)).toMatchObject({ operaciones: 2, movimientos: 2, suma: "100.00" });
    });

    it("una clave usada por otra persona no confirma nada", async () => {
      const { codigo, recep } = await escenario();
      const r = await revisada(recep, codigo, await ficha());
      expect((await confirmar(recep, codigo, r)).ok).toBe(true);
      const otra = await cuenta([["recepcion", codigo]]);
      expect(await confirmar(otra, codigo, r)).toEqual({ ok: false, error: "clave_ajena" });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 1 });
    });
  });

  describe("el mismo turno y la misma responsable al confirmar", () => {
    it("si el turno que se mostró ya no está abierto, no se guarda nada", async () => {
      const { codigo, recep, turnoId } = await escenario();
      const r = await revisada(recep, codigo, await ficha());
      // Simula el cierre (llega en el bloque 5): el turno se cierra y sus responsables dejan de estar vigentes.
      await sql`update turno set cerrado_en = now() where id = ${turnoId}`;
      await sql`update responsable_lugar set hasta = now() where turno_id = ${turnoId}`;
      expect(await confirmar(recep, codigo, r)).toEqual({ ok: false, error: "sin_turno" });
      // Se abre otro turno: la confirmación del turno anterior sigue rechazada.
      expect((await abrirTurno(sql, recep, codigo, { bolsa: "0.00", cajon: "0.00" }, PRUEBAS)).ok).toBe(true);
      expect(await confirmar(recep, codigo, r)).toEqual({ ok: false, error: "turno_cambio" });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0, movimientos: 0 });
    });

    it("solo cobra la responsable de la bolsa: otra recepcionista no puede abrir la pantalla de cobro ni confirmar", async () => {
      const { codigo, recep } = await escenario();
      const otra = await cuenta([["recepcion", codigo]]);
      const v = await ficha();
      expect(await revisar(otra, codigo, v)).toEqual({ ok: false, error: "no_responsable" });
      const r = await revisada(recep, codigo, v);
      expect(await confirmar(otra, codigo, r)).toEqual({ ok: false, error: "no_responsable" });
      expect(await impedimentoRegistroVisita(sql, otra, codigo, "pruebas")).toBe("no_responsable");
      expect(await impedimentoRegistroVisita(sql, recep, codigo, "pruebas")).toBeNull();
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0 });
    });

    it("si la bolsa cambia de responsable después de abrir la pantalla, la confirmación se rechaza", async () => {
      const { codigo, recep, turnoId } = await escenario();
      const otra = await cuenta([["recepcion", codigo]]);
      const r = await revisada(recep, codigo, await ficha());
      // Simula la entrega de la bolsa a otra recepcionista (la entrega real llega en el bloque 5).
      await sql`update responsable_lugar r set usuario_id = ${otra} from lugar_efectivo l
                where l.id = r.lugar_id and l.tipo = 'bolsa_visitas' and r.turno_id = ${turnoId}`;
      expect(await confirmar(recep, codigo, r)).toEqual({ ok: false, error: "no_responsable" });
      // Y si la bolsa queda sin responsable vigente, tampoco.
      await sql`update responsable_lugar r set hasta = now() from lugar_efectivo l
                where l.id = r.lugar_id and l.tipo = 'bolsa_visitas' and r.turno_id = ${turnoId}`;
      expect(await confirmar(otra, codigo, r)).toMatchObject({ ok: false, error: "no_responsable" });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0, movimientos: 0 });
    });
  });

  describe("permisos y bloqueos, también por solicitud directa", () => {
    it("Encargado, Administración y Dirección no registran visitas; otra sucursal: No encontrada", async () => {
      const { codigo, recep } = await escenario();
      const v = await ficha();
      const r = await revisada(recep, codigo, v);
      for (const rol of ["encargado", "administracion", "direccion"]) {
        const u = await cuenta([[rol, codigo]]);
        expect(await revisar(u, codigo, v), rol).toEqual({ ok: false, error: "sin_permiso" });
        expect(await confirmar(u, codigo, r), rol).toMatchObject({ ok: false, error: "sin_permiso" });
      }
      const deTenango = await cuenta([["recepcion", "TEN"]]);
      expect(await revisar(deTenango, codigo, v)).toEqual({ ok: false, error: "no_encontrada" });
      expect(await confirmar(deTenango, codigo, r)).toMatchObject({ ok: false, error: "no_encontrada" });
      expect(await revisar(recep, "ten'--", v)).toEqual({ ok: false, error: "no_encontrada" });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0 });
    });

    it("sin turno abierto, en sucursal inactiva o en producción no se cobra", async () => {
      k++;
      const codigo = `V${k}`;
      const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sin turno " + k}, ${codigo}) returning id`;
      ids[codigo] = s.id;
      const recep = await cuenta([["recepcion", codigo]]);
      const v = await ficha();
      expect(await revisar(recep, codigo, v)).toEqual({ ok: false, error: "sin_turno" });

      const e = await escenario();
      const r = await revisada(e.recep, e.codigo, v);
      await sql`update sucursal set estado_operativo = 'inactiva', desactivada_en = now() where codigo = ${e.codigo}`;
      expect(await confirmar(e.recep, e.codigo, r)).toEqual({ ok: false, error: "sucursal_inactiva" });
      expect(await revisar(e.recep, e.codigo, v)).toEqual({ ok: false, error: "sucursal_inactiva" });

      const p = await escenario();
      const rp = await revisada(p.recep, p.codigo, v);
      expect(await pantallaCobro(sql, p.recep, p.codigo, "produccion")).toEqual({ ok: false, error: "bloqueado_produccion" });
      expect(await confirmarVisita(sql, p.recep, p.codigo, { clave: rp.clave, turnoId: rp.turnoId, visitanteId: v, recibido: null, cambio: null }, { entorno: "produccion" }))
        .toEqual({ ok: false, error: "bloqueado_produccion" });
      expect(await conteos(e.codigo)).toMatchObject({ operaciones: 0 });
      expect(await conteos(p.codigo)).toMatchObject({ operaciones: 0 });
    });

    it("una ficha unida a otra o inexistente no se cobra", async () => {
      const { codigo, recep } = await escenario();
      const activa = await ficha();
      const unida = await ficha();
      const r = await revisada(recep, codigo, unida);
      await sql`update visitante set fusionado_en = now(), fusionado_en_id = ${activa} where id = ${unida}`;
      expect(await confirmar(recep, codigo, r)).toEqual({ ok: false, error: "visitante_unido" });
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, unida))).toEqual({ ok: false, error: "visitante_unido" });
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, randomUUID()))).toEqual({ ok: false, error: "visitante_no_encontrado" });
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, "no-es-id"))).toEqual({ ok: false, error: "visitante_no_encontrado" });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0 });
    });
  });

  describe("la base protege los registros", () => {
    it("no se editan ni se borran; el efectivo solo entra a un lugar de la sucursal del turno abierto", async () => {
      const { codigo, recep, turnoId } = await escenario();
      expect((await confirmar(recep, codigo, await revisada(recep, codigo, await ficha()))).ok).toBe(true);
      for (const tabla of ["operacion_visita", "cobro_visita", "pase_visita", "movimiento_efectivo"]) {
        await expect(sql.unsafe(`delete from ${tabla}`), tabla).rejects.toThrow();
      }
      await expect(sql`update movimiento_efectivo set importe = 100`).rejects.toThrow();
      await expect(sql`update cobro_visita set importe = 1`).rejects.toThrow();

      const [cobro] = await sql`select c.id from cobro_visita c join operacion_visita o on o.id = c.operacion_id where o.turno_id = ${turnoId}`;
      const [ajena] = await sql`select id from lugar_efectivo where sucursal_id = ${ids.TEN} and tipo = 'bolsa_visitas'`;
      await expect(sql`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, cobro_id, responsable_id, registrado_por)
                       values (${ajena.id}, ${turnoId}, 'entrada_cobro_visita', 50, ${cobro.id}, ${recep}, ${recep})`).rejects.toThrow();
    });
  });
});

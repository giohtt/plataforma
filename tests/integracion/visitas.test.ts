import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cobrosDelTurno, confirmarVisita, detalleCobro, impedimentoRegistroVisita, pantallaCobro, visitasDeHoy } from "@/lib/visitas";
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
async function revisada(u: string, codigo: string, visitantes: string | string[], recibido: string | null = null, cambio: string | null = null) {
  const p = await revisar(u, codigo);
  if (!p.ok) throw new Error(p.error);
  return {
    clave: randomUUID(), turnoId: p.turnoId, visitanteIds: ([] as string[]).concat(visitantes),
    formaPago: "efectivo" as "efectivo" | "tarjeta", recibido, cambio, autorizacion: null as string | null, otraVenta: false,
  };
}
/** Lo que envía la pantalla con tarjeta: sin recibido ni cambio, con la autorización del comprobante. */
async function conTarjeta(u: string, codigo: string, visitantes: string | string[], autorizacion: string, otraVenta = false) {
  return { ...(await revisada(u, codigo, visitantes)), formaPago: "tarjeta" as const, autorizacion, otraVenta };
}
type Envio = Awaited<ReturnType<typeof revisada>>;
const confirmar = (u: string, codigo: string, r: Envio) => confirmarVisita(sql, u, codigo, r, PRUEBAS);

describe.skipIf(!URL_ADMIN)("cobro de visitas en efectivo: individual y grupal", () => {
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
      expect(c).toMatchObject({ ok: true, repetida: false, cobro: { personas: 1, total: "50.00", recibido: null, cambio: null } });
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
      expect(e.turno!.lugares.map((l) => [l.tipo, l.contadoAlAbrir, l.entradas, l.cantidadEntradas, l.visitasEntradas, l.esperado])).toEqual([
        ["bolsa_visitas", "0.00", "50.00", 1, 1, "50.00"],
        ["cajon_mensualidades", "1200.00", "0.00", 0, 0, null],
      ]);
      expect((await cobrosDelTurno(sql, turnoId)).map((x) => [x.personas, x.total, x.formaPago])).toEqual([[1, "50.00", "efectivo"]]);
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
      for (const [recibido, cambio] of [["20.00", "0.00"], ["100.00", "40.00"], ["100.00", null]]) {
        await expect(sql.begin(async (tx) => {
          const [o] = await tx`insert into operacion_visita (clave, sucursal_id, turno_id, registrada_por, total)
                               values (${randomUUID()}, ${ids[codigo]}, ${turnoId}, ${recep}, 50) returning id`;
          await tx`insert into cobro_visita (operacion_id, forma_pago, estado, importe, recibido, cambio)
                   values (${o.id}, 'efectivo', 'confirmado', 50, ${recibido}, ${cambio})`;
        })).rejects.toThrow();
      }
    });

    it("la base rechaza una operación que no cuadra: sin pases, pases que no suman el total o efectivo distinto", async () => {
      const { codigo, recep, turnoId } = await escenario();
      const v1 = await ficha();
      const v2 = await ficha();
      const [bolsa] = await sql`select id from lugar_efectivo where sucursal_id = ${ids[codigo]} and tipo = 'bolsa_visitas'`;
      const intento = (pases: string[], cobro: number, efectivo: number) => sql.begin(async (tx) => {
        const [o] = await tx`insert into operacion_visita (clave, sucursal_id, turno_id, registrada_por, total)
                             values (${randomUUID()}, ${ids[codigo]}, ${turnoId}, ${recep}, 100) returning id`;
        const [c] = await tx`insert into cobro_visita (operacion_id, forma_pago, estado, importe)
                             values (${o.id}, 'efectivo', 'confirmado', ${cobro}) returning id`;
        for (const [i, v] of pases.entries()) {
          await tx`insert into pase_visita (operacion_id, visitante_id, sucursal_id, tarifa, descuento, total, orden)
                   values (${o.id}, ${v}, ${ids[codigo]}, 50, 0, 50, ${i + 1})`;
        }
        await tx`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, cobro_id, responsable_id, registrado_por)
                 values (${bolsa.id}, ${turnoId}, 'entrada_cobro_visita', ${efectivo}, ${c.id}, ${recep}, ${recep})`;
      });
      await expect(intento([], 100, 100)).rejects.toThrow(/no cuadra/);
      await expect(intento([v1], 100, 100)).rejects.toThrow(/no cuadra/);
      await expect(intento([v1, v2], 50, 100)).rejects.toThrow(/no cuadra/);
      await expect(intento([v1, v2], 100, 50)).rejects.toThrow(/no cuadra/);
      await expect(intento([v1, v1], 100, 100)).rejects.toThrow();
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0 });
      await intento([v1, v2], 100, 100); // cuadra
      expect(await conteos(codigo)).toMatchObject({ operaciones: 1, pases: 2, suma: "100.00" });
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

    it("reintento tras perder la conexión con los mismos datos: responde con el cobro ya guardado y no cobra otra vez", async () => {
      const { codigo, recep } = await escenario();
      const r = await revisada(recep, codigo, await ficha(), "100.00", "50.00");
      expect((await confirmar(recep, codigo, r)).ok).toBe(true); // se guardó, pero la respuesta no llegó
      expect(await confirmar(recep, codigo, r)).toMatchObject({ ok: true, repetida: true, cobro: { recibido: "100.00", cambio: "50.00" } });
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 1, movimientos: 1, suma: "50.00" });
    });

    it("la misma clave con otros datos (otro «Recibido», otras personas u otro orden) se rechaza y no guarda nada", async () => {
      const { codigo, recep } = await escenario();
      const [a, b, c] = [await ficha(), await ficha(), await ficha()];
      const r = await revisada(recep, codigo, [a, b], "100.00", "0.00");
      expect((await confirmar(recep, codigo, r)).ok).toBe(true);
      for (const otra of [
        { ...r, recibido: "200.00", cambio: "100.00" },
        { ...r, recibido: null, cambio: null },
        { ...r, visitanteIds: [a], recibido: "100.00", cambio: "50.00" },
        { ...r, visitanteIds: [a, b, c], recibido: "150.00", cambio: "0.00" },
        { ...r, visitanteIds: [b, a] },
      ]) {
        expect(await confirmar(recep, codigo, otra)).toEqual({ ok: false, error: "datos_distintos" });
      }
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 2, movimientos: 1, suma: "100.00" });
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
      expect(await confirmarVisita(sql, p.recep, p.codigo, { ...rp, visitanteIds: [v] }, { entorno: "produccion" }))
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
      expect(await confirmar(recep, codigo, r)).toMatchObject({ ok: false, error: "visitante_unido" });
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, unida))).toMatchObject({ ok: false, error: "visitante_unido" });
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, randomUUID()))).toEqual({ ok: false, error: "visitante_no_encontrado" });
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, "no-es-id"))).toEqual({ ok: false, error: "visitante_no_encontrado" });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0 });
    });
  });

  describe("cobro grupal", () => {
    it("tres personas: una operación, un cobro de $150, un pase por persona y una sola entrada de $150 a la bolsa", async () => {
      const { codigo, recep, turnoId } = await escenario();
      const ana = await ficha("Ana Prueba Grupal");
      const luis = await ficha("Luis Prueba Grupal");
      const diego = await ficha("Diego Prueba Grupal");
      const c = await confirmar(recep, codigo, await revisada(recep, codigo, [ana, luis, diego], "200.00", "50.00"));
      expect(c).toMatchObject({
        ok: true, repetida: false,
        cobro: { personas: 3, visitantes: ["Ana Prueba Grupal", "Luis Prueba Grupal", "Diego Prueba Grupal"], total: "150.00", recibido: "200.00", cambio: "50.00" },
      });
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 3, movimientos: 1, suma: "150.00" });
      const pases = await sql`select p.visitante_id, p.orden, p.total::text, p.sucursal_id from pase_visita p
                              join operacion_visita o on o.id = p.operacion_id where o.turno_id = ${turnoId} order by p.orden`;
      expect(pases.map((p) => [p.visitante_id, p.orden, p.total, p.sucursal_id])).toEqual([
        [ana, 1, "50.00", ids[codigo]], [luis, 2, "50.00", ids[codigo]], [diego, 3, "50.00", ids[codigo]],
      ]);
      // La bolsa: 1 cobro que cubre 3 visitas; el turno lista una línea por cobro.
      const bolsa = (await estadoTurno(sql, recep, codigo))!.turno!.lugares[0];
      expect([bolsa.entradas, bolsa.cantidadEntradas, bolsa.visitasEntradas, bolsa.esperado]).toEqual(["150.00", 1, 3, "150.00"]);
      expect((await cobrosDelTurno(sql, turnoId)).map((x) => [x.personas, x.total])).toEqual([[3, "150.00"]]);
    });

    it("el detalle del cobro muestra visitantes y pases con teléfono enmascarado, solo a quien ve los turnos de la sucursal", async () => {
      const { codigo, recep } = await escenario();
      const [a, b] = [await ficha("Primera Persona Detalle"), await ficha("Segunda Persona Detalle")];
      const c = await confirmar(recep, codigo, await revisada(recep, codigo, [a, b]));
      if (!c.ok) throw new Error(c.error);
      const d = (await detalleCobro(sql, recep, codigo, c.operacionId))!;
      expect(d).toMatchObject({ total: "100.00", entradaBolsa: "100.00", responsableBolsa: `Visita ${n}`, recibido: null });
      expect(d.pases.map((p) => [p.orden, p.nombre, p.telefono, p.fichaDe, p.total])).toEqual([
        [1, "Primera Persona Detalle", "•• •••• 0201", "Atlacomulco", "50.00"],
        [2, "Segunda Persona Detalle", "•• •••• 0201", "Atlacomulco", "50.00"],
      ]);
      expect(JSON.stringify(d)).not.toMatch(/0000000201/);
      const encargado = await cuenta([["encargado", codigo]]);
      expect((await detalleCobro(sql, encargado, codigo, c.operacionId))?.pases).toHaveLength(2);
      expect(await detalleCobro(sql, await cuenta([["encargado", "TEN"]]), codigo, c.operacionId)).toBeNull();
      expect(await detalleCobro(sql, recep, "TEN", c.operacionId)).toBeNull();
      expect(await detalleCobro(sql, recep, codigo, randomUUID())).toBeNull();
    });

    it("rechaza un grupo vacío, de más de 20, con alguien repetido o con lo recibido menor que el total del grupo", async () => {
      const { codigo, recep } = await escenario();
      const a = await ficha();
      const veintiuno = await Promise.all(Array.from({ length: 21 }, () => ficha()));
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, []))).toEqual({ ok: false, error: "grupo_vacio" });
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, veintiuno))).toEqual({ ok: false, error: "grupo_grande" });
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, [a, a]))).toEqual({ ok: false, error: "persona_repetida" });
      const [b] = [await ficha()];
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, [a, b], "50.00", "0.00"))).toEqual({ ok: false, error: "recibido_menor" });
      expect(await confirmar(recep, codigo, await revisada(recep, codigo, [a, b], "150.00", "100.00"))).toEqual({ ok: false, error: "recibido_menor" });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0 });
      // Veinte sí.
      const c = await confirmar(recep, codigo, await revisada(recep, codigo, veintiuno.slice(0, 20)));
      expect(c).toMatchObject({ ok: true, cobro: { personas: 20, total: "1000.00" } });
    });

    it("si una ficha del grupo se unió a otra, no se guarda nada y se indica cuál", async () => {
      const { codigo, recep } = await escenario();
      const a = await ficha();
      const unida = await ficha("Ficha Que Se Unio");
      const r = await revisada(recep, codigo, [a, unida]);
      await sql`update visitante set fusionado_en = now(), fusionado_en_id = ${a} where id = ${unida}`;
      expect(await confirmar(recep, codigo, r)).toEqual({ ok: false, error: "visitante_unido", detalle: "Ficha Que Se Unio" });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0 });
    });

    it("cinco envíos simultáneos del mismo cobro grupal: una sola operación con sus tres pases", async () => {
      const { codigo, recep } = await escenario();
      const r = await revisada(recep, codigo, [await ficha(), await ficha(), await ficha()]);
      const todos = await Promise.all(Array.from({ length: 5 }, () => confirmar(recep, codigo, r)));
      expect(todos.every((x) => x.ok)).toBe(true);
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 3, movimientos: 1, suma: "150.00" });
    });
  });

  describe("cobro con tarjeta", () => {
    const efectivoDe = async (codigo: string) =>
      (await sql`select count(*)::int as n from movimiento_efectivo m join cobro_visita c on c.id = m.cobro_id
                 join operacion_visita o on o.id = c.operacion_id where o.sucursal_id = ${ids[codigo]} and c.forma_pago = 'tarjeta'`)[0].n;

    it("una persona: confirmado operativamente, liquidación pendiente, sin entrada de efectivo; la bolsa no cambia", async () => {
      const { codigo, recep, turnoId } = await escenario();
      expect((await confirmar(recep, codigo, await revisada(recep, codigo, await ficha()))).ok).toBe(true); // $50 en efectivo antes
      const valeria = await ficha("Valeria Prueba Tarjeta");
      const c = await confirmar(recep, codigo, await conTarjeta(recep, codigo, valeria, "A1B2C3"));
      expect(c).toMatchObject({
        ok: true, repetida: false,
        cobro: { personas: 1, total: "50.00", formaPago: "tarjeta", estado: "confirmado_operativamente", autorizacion: "A1B2C3", conciliacion: "pendiente", recibido: null, cambio: null },
      });
      expect(await efectivoDe(codigo)).toBe(0);
      expect(await conteos(codigo)).toEqual({ operaciones: 2, cobros: 2, pases: 2, movimientos: 1, suma: "50.00" });
      const bolsa = (await estadoTurno(sql, recep, codigo))!.turno!.lugares[0];
      expect([bolsa.entradas, bolsa.cantidadEntradas, bolsa.visitasEntradas, bolsa.esperado]).toEqual(["50.00", 1, 1, "50.00"]);
      const lista = await cobrosDelTurno(sql, turnoId);
      expect(lista.map((x) => [x.formaPago, x.estado, x.conciliacion, x.total])).toEqual([
        ["tarjeta", "confirmado_operativamente", "pendiente", "50.00"], ["efectivo", "confirmado", null, "50.00"],
      ]);
      if (!c.ok) return;
      expect(await detalleCobro(sql, recep, codigo, c.operacionId)).toMatchObject({
        formaPago: "tarjeta", estado: "confirmado_operativamente", autorizacion: "A1B2C3", conciliacion: "pendiente", entradaBolsa: null,
      });
    });

    it("un grupo de tres con tarjeta: un cobro de $150, tres pases y ninguna entrada de efectivo", async () => {
      const { codigo, recep } = await escenario();
      const c = await confirmar(recep, codigo, await conTarjeta(recep, codigo, [await ficha(), await ficha(), await ficha()], "778899"));
      expect(c).toMatchObject({ ok: true, cobro: { personas: 3, total: "150.00", formaPago: "tarjeta" } });
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 3, movimientos: 0, suma: "0" });
    });

    it("un solo medio por operación: autorización obligatoria con tarjeta; sin recibido con tarjeta ni autorización con efectivo", async () => {
      const { codigo, recep } = await escenario();
      const v = await ficha();
      const base = await conTarjeta(recep, codigo, v, "123456");
      expect(await confirmar(recep, codigo, { ...base, autorizacion: null })).toEqual({ ok: false, error: "autorizacion_invalida" });
      expect(await confirmar(recep, codigo, { ...base, autorizacion: "12" })).toEqual({ ok: false, error: "autorizacion_invalida" });
      expect(await confirmar(recep, codigo, { ...base, autorizacion: "abc-123" })).toEqual({ ok: false, error: "autorizacion_invalida" });
      expect(await confirmar(recep, codigo, { ...base, recibido: "100.00", cambio: "50.00" })).toEqual({ ok: false, error: "forma_invalida" });
      const efectivo = await revisada(recep, codigo, v);
      expect(await confirmar(recep, codigo, { ...efectivo, autorizacion: "123456" })).toEqual({ ok: false, error: "forma_invalida" });
      expect(await confirmar(recep, codigo, { ...efectivo, formaPago: "cheque" as "efectivo" })).toEqual({ ok: false, error: "forma_invalida" });
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0 });
    });

    it("autorización repetida hoy en la sucursal: muestra el cobro previo y pide confirmar que es otra venta", async () => {
      const { codigo, recep } = await escenario();
      const otra = await escenario();
      const primero = await confirmar(recep, codigo, await conTarjeta(recep, codigo, await ficha(), "555000"));
      expect(primero.ok).toBe(true);
      const segunda = await conTarjeta(recep, codigo, await ficha(), "555000");
      const r = await confirmar(recep, codigo, segunda);
      expect(r).toMatchObject({ ok: false, error: "autorizacion_repetida" });
      if (r.ok || !primero.ok) return;
      expect(r.previos!.map((p) => [p.id, p.personas, p.total])).toEqual([[primero.operacionId, 1, "50.00"]]);
      expect(await conteos(codigo)).toMatchObject({ operaciones: 1 });
      // Confirmando que es otra venta, se registra y queda anotado.
      const ok = await confirmar(recep, codigo, { ...segunda, otraVenta: true });
      expect(ok).toMatchObject({ ok: true, cobro: { autorizacion: "555000" } });
      expect((await sql`select count(*)::int as n from cobro_visita where autorizacion = '555000' and autorizacion_repetida_confirmada`)[0].n).toBe(1);
      // En otra sucursal la misma autorización no se considera repetida.
      expect((await confirmar(otra.recep, otra.codigo, await conTarjeta(otra.recep, otra.codigo, await ficha(), "555000"))).ok).toBe(true);
      // Una autorización de un día anterior tampoco.
      await sql`alter table operacion_visita disable trigger operacion_visita_inmutable`;
      await sql`update operacion_visita set registrada_en = now() - interval '1 day' where sucursal_id = ${ids[codigo]}`;
      await sql`alter table operacion_visita enable trigger operacion_visita_inmutable`;
      expect((await confirmar(recep, codigo, await conTarjeta(recep, codigo, await ficha(), "555000"))).ok).toBe(true);
    });

    it("reintento tras perder la conexión con la misma autorización: no la toma como repetida ni registra dos veces", async () => {
      const { codigo, recep } = await escenario();
      const t = await conTarjeta(recep, codigo, [await ficha(), await ficha()], "900100");
      expect((await confirmar(recep, codigo, t)).ok).toBe(true);
      expect(await confirmar(recep, codigo, t)).toMatchObject({ ok: true, repetida: true, cobro: { personas: 2, autorizacion: "900100" } });
      expect(await confirmar(recep, codigo, { ...t, autorizacion: "900101" })).toEqual({ ok: false, error: "datos_distintos" });
      expect(await confirmar(recep, codigo, { ...t, formaPago: "efectivo", autorizacion: null })).toEqual({ ok: false, error: "datos_distintos" });
      expect(await conteos(codigo)).toEqual({ operaciones: 1, cobros: 1, pases: 2, movimientos: 0, suma: "0" });
    });

    it("dos registros simultáneos distintos con la misma autorización: uno pasa y el otro pide confirmar otra venta", async () => {
      const { codigo, recep } = await escenario();
      const [a, b] = [await conTarjeta(recep, codigo, await ficha(), "424242"), await conTarjeta(recep, codigo, await ficha(), "424242")];
      const res = await Promise.all([confirmar(recep, codigo, a), confirmar(recep, codigo, b)]);
      expect(res.filter((x) => x.ok)).toHaveLength(1);
      expect(res.filter((x) => !x.ok && x.error === "autorizacion_repetida")).toHaveLength(1);
      expect(await conteos(codigo)).toMatchObject({ operaciones: 1 });
    });

    it("la base rechaza tarjeta con entrada de efectivo, sin autorización o con recibido", async () => {
      const { codigo, recep, turnoId } = await escenario();
      const v = await ficha();
      const [bolsa] = await sql`select id from lugar_efectivo where sucursal_id = ${ids[codigo]} and tipo = 'bolsa_visitas'`;
      const intento = (efectivo: boolean, campos: { autorizacion?: string; estado?: string; conciliacion?: string | null; recibido?: string; cambio?: string }) => sql.begin(async (tx) => {
        const [o] = await tx`insert into operacion_visita (clave, sucursal_id, turno_id, registrada_por, total)
                             values (${randomUUID()}, ${ids[codigo]}, ${turnoId}, ${recep}, 50) returning id`;
        const [c] = await tx`insert into cobro_visita (operacion_id, forma_pago, estado, importe, autorizacion, conciliacion, recibido, cambio)
                             values (${o.id}, 'tarjeta', ${campos.estado ?? "confirmado_operativamente"}, 50, ${campos.autorizacion ?? null},
                                     ${campos.conciliacion === undefined ? "pendiente" : campos.conciliacion},
                                     ${campos.recibido ?? null}, ${campos.cambio ?? null}) returning id`;
        await tx`insert into pase_visita (operacion_id, visitante_id, sucursal_id, tarifa, descuento, total, orden)
                 values (${o.id}, ${v}, ${ids[codigo]}, 50, 0, 50, 1)`;
        if (efectivo) {
          await tx`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, cobro_id, responsable_id, registrado_por)
                   values (${bolsa.id}, ${turnoId}, 'entrada_cobro_visita', 50, ${c.id}, ${recep}, ${recep})`;
        }
      });
      await expect(intento(true, { autorizacion: "ABC123" })).rejects.toThrow(/no cuadra/);
      await expect(intento(false, {})).rejects.toThrow();
      await expect(intento(false, { autorizacion: "ABC123", recibido: "100.00", cambio: "50.00" })).rejects.toThrow();
      await expect(intento(false, { autorizacion: "ABC123", estado: "confirmado" })).rejects.toThrow();
      await expect(intento(false, { autorizacion: "ABC123", conciliacion: null })).rejects.toThrow();
      expect(await conteos(codigo)).toMatchObject({ operaciones: 0 });
      await intento(false, { autorizacion: "ABC123" }); // correcto
      expect(await conteos(codigo)).toMatchObject({ operaciones: 1, movimientos: 0 });
    });
  });

  describe("aviso de visita registrada hoy", () => {
    it("indica quién ya tiene visita hoy, en esta u otra sucursal, también por una ficha unida; no bloquea", async () => {
      const { codigo, recep } = await escenario();
      const otra = await escenario();
      const [aqui, alla, nueva, absorbida] = [await ficha(), await ficha(), await ficha(), await ficha()];
      expect((await confirmar(recep, codigo, await revisada(recep, codigo, aqui))).ok).toBe(true);
      expect((await confirmar(otra.recep, otra.codigo, await revisada(otra.recep, otra.codigo, [alla, absorbida]))).ok).toBe(true);
      await sql`update visitante set fusionado_en = now(), fusionado_en_id = ${nueva} where id = ${absorbida}`;
      const r = await visitasDeHoy(sql, recep, codigo, [aqui, alla, nueva, randomUUID()]);
      const por = Object.fromEntries(r!.map((x) => [x.id, [x.visitasHoy, x.enEstaSucursal]]));
      expect(por[aqui]).toEqual([1, true]);
      expect(por[alla]).toEqual([1, false]);
      expect(por[nueva]).toEqual([1, false]); // por la ficha que se le unió
      // No bloquea: se puede cobrar otra visita (la regla de reingreso está pendiente).
      expect((await confirmar(recep, codigo, await revisada(recep, codigo, aqui))).ok).toBe(true);
      // Una visita de ayer no cuenta.
      const ayer = await ficha();
      expect((await confirmar(recep, codigo, await revisada(recep, codigo, ayer))).ok).toBe(true);
      await sql`alter table pase_visita disable trigger pase_visita_inmutable`;
      await sql`update pase_visita set creado_en = now() - interval '1 day' where visitante_id = ${ayer}`;
      await sql`alter table pase_visita enable trigger pase_visita_inmutable`;
      expect((await visitasDeHoy(sql, recep, codigo, [ayer]))![0].visitasHoy).toBe(0);
      // Sin permiso de registrar visitas en la sucursal: null.
      expect(await visitasDeHoy(sql, await cuenta([["encargado", codigo]]), codigo, [aqui])).toBeNull();
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

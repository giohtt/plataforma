import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { solicitarCancelacion } from "@/lib/cancelaciones";
import {
  cancelarEntrega, entregaEnCurso, entregaRecibida, pantallaEntrega, pantallaRecepcion, recibirTurno, registrarEntrega,
} from "@/lib/entregas";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { confirmarVisita, pantallaCobro } from "@/lib/visitas";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";
import { duplicarCobro } from "./duplicado";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;
let k = 0;
const PRUEBAS = { entorno: "pruebas" as const };
const ACLARACION = "Recontamos juntas y seguimos con $50 menos";

async function cuenta(asignaciones: [string, string][]) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Entrega " + n}, ${`entrega${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de entrega')`;
  }
  return u.id;
}
async function cobrar(u: string, codigo: string) {
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, telefono, sucursal_alta_id) values (${"Paola Entrega " + randomUUID().slice(0, 6)}, null, ${ids[codigo]}) returning id`;
  const p = await pantallaCobro(sql, u, codigo, "pruebas");
  if (!p.ok) return { ok: false as const, error: p.error };
  return confirmarVisita(sql, u, codigo, {
    clave: randomUUID(), turnoId: p.turnoId, visitanteIds: [v.id], formaPago: "efectivo", recibido: null, cambio: null,
    autorizacion: null, referencia: null, tipoReferencia: null, otraVenta: false,
  }, PRUEBAS);
}

/** Sucursal nueva: Laura abre con $200 en la bolsa y $1,200 en el cajón y cobra 3 visitas ($150): la bolsa espera $350. */
async function escenario() {
  k++;
  const codigo = `E${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal entrega " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const laura = await cuenta([["recepcion", codigo]]);
  const sofia = await cuenta([["recepcion", codigo]]);
  const tercera = await cuenta([["recepcion", codigo]]);
  const encargado = await cuenta([["encargado", codigo]]);
  const t = await abrirTurno(sql, laura, codigo, { bolsa: "200.00", cajon: "1200.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  for (let i = 0; i < 3; i++) {
    const r = await cobrar(laura, codigo);
    if (!r.ok) throw new Error(r.error);
  }
  return { codigo, laura, sofia, tercera, encargado, turnoId: t.turnoId };
}
type Esc = Awaited<ReturnType<typeof escenario>>;

const entregar = (e: Esc, bolsa: string, cajon: string, extra: Partial<{ recibe: string; nota: string; quien: string }> = {}) =>
  registrarEntrega(sql, extra.quien ?? e.laura, e.codigo,
    { turnoId: e.turnoId, conteo: { bolsa, cajon }, recibe: extra.recibe ?? e.sofia, nota: extra.nota ?? "" }, PRUEBAS);
async function enCurso(e: Esc) {
  const x = await entregaEnCurso(sql, e.turnoId);
  if (!x) throw new Error("sin entrega en curso");
  return x;
}
const recibir = async (e: Esc, bolsa: string, cajon: string, aclaracion = "", quien?: string) => {
  const x = await enCurso(e);
  return recibirTurno(sql, quien ?? e.sofia, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa, cajon }, aclaracion }, PRUEBAS);
};
const diferencias = (turnoId: string) => sql<{ tipo: string; lugar: string; importe: string }[]>`
  select d.tipo, l.tipo as lugar, d.importe::text as importe from diferencia_efectivo d
  join lugar_efectivo l on l.id = d.lugar_id where d.turno_id = ${turnoId} order by l.tipo, d.tipo`;

describe.skipIf(!URL_ADMIN)("cambio de turno con confirmación de quien recibe", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("faltan $50 contra el esperado y la entrante confirma lo entregado: se cierra un turno, se abre el suyo y queda una sola diferencia", async () => {
    const e = await escenario();
    const p = await pantallaEntrega(sql, e.laura, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.esperadoBolsa).toBe("350.00");
    expect(p.receptores.map((r) => r.id).sort()).toEqual([e.sofia, e.tercera].sort());

    expect(await entregar(e, "300", "1850", { nota: "Revisé dos veces; no encuentro el faltante." })).toMatchObject({ ok: true });
    // La entrante no ve el conteo de la saliente antes de capturar el suyo.
    const r = await pantallaRecepcion(sql, e.sofia, e.codigo, "pruebas");
    expect(r).toMatchObject({ ok: true, entrega: { estado: "pendiente", entregaPorId: e.laura }, recuento: null });
    expect(JSON.stringify(r)).not.toMatch(/300|1850/);

    const ok = await recibir(e, "300.00", "1850.00");
    if (!ok.ok || ok.resultado !== "confirmada") throw new Error(JSON.stringify(ok));
    expect((await sql`select cerrado_en from turno where id = ${e.turnoId}`)[0].cerrado_en).not.toBeNull();
    const t = (await estadoTurno(sql, e.sofia, e.codigo))!.turno!;
    expect(t.id).toBe(ok.turnoId);
    expect(t.lugares.map((l) => [l.tipo, l.contadoAlAbrir, l.responsableId])).toEqual([
      ["bolsa_visitas", "300.00", e.sofia], ["cajon_mensualidades", "1850.00", e.sofia],
    ]);
    expect(t.lugares[0].esperado).toBe("300.00");
    expect(await diferencias(e.turnoId)).toEqual([{ tipo: "contra_esperado", lugar: "bolsa_visitas", importe: "-50.00" }]);
    expect(await entregaRecibida(sql, ok.turnoId)).toMatchObject({
      esperadoBolsa: "350.00", entregado: { bolsa: "300.00", cajon: "1850.00" }, inicial: { bolsa: "300.00", cajon: "1850.00" },
      confirmado: { bolsa: "300.00", cajon: "1850.00" }, aclaracion: null, nota: "Revisé dos veces; no encuentro el faltante.",
      diferencias: [{ lugar: "bolsa_visitas", tipo: "contra_esperado", importe: "-50.00" }],
    });
    // Ya responde Sofía: ella cobra; Laura no.
    expect(await cobrar(e.sofia, e.codigo)).toMatchObject({ ok: true });
    expect(await cobrar(e.laura, e.codigo)).toMatchObject({ ok: false, error: "no_responsable" });
  });

  it("si no coinciden, recuentan: se conservan el conteo inicial y la aclaración, y el desacuerdo que persiste queda registrado aparte", async () => {
    const e = await escenario();
    await entregar(e, "350", "1000");
    expect(await recibir(e, "300", "1000")).toEqual({ ok: true, resultado: "recuento" });
    // Ahora sí ve ambos conteos.
    expect(await pantallaRecepcion(sql, e.sofia, e.codigo, "pruebas")).toMatchObject({
      ok: true, entrega: { estado: "recuento" },
      recuento: { entregado: { bolsa: "350.00", cajon: "1000.00" }, inicial: { bolsa: "300.00", cajon: "1000.00" } },
    });
    expect(await recibir(e, "300", "1000", "")).toEqual({ ok: false, error: "aclaracion" });
    const ok = await recibir(e, "300", "1000", ACLARACION);
    if (!ok.ok || ok.resultado !== "confirmada") throw new Error(JSON.stringify(ok));
    expect(await diferencias(e.turnoId)).toEqual([{ tipo: "entre_personas", lugar: "bolsa_visitas", importe: "-50.00" }]);
    expect(await entregaRecibida(sql, ok.turnoId)).toMatchObject({
      entregado: { bolsa: "350.00" }, inicial: { bolsa: "300.00" }, confirmado: { bolsa: "300.00" }, aclaracion: ACLARACION,
    });
    // La entrante empieza con lo que confirmó.
    expect((await estadoTurno(sql, e.sofia, e.codigo))!.turno!.lugares[0].contadoAlAbrir).toBe("300.00");
  });

  it("si el recuento resuelve la diferencia, no queda diferencia, pero el primer conteo y la aclaración se conservan", async () => {
    const e = await escenario();
    await entregar(e, "350", "1200");
    await recibir(e, "340", "1200");
    const ok = await recibir(e, "350", "1200", "Faltaba un billete de $10 en el sobre");
    if (!ok.ok || ok.resultado !== "confirmada") throw new Error(JSON.stringify(ok));
    expect(await diferencias(e.turnoId)).toEqual([]);
    expect(await entregaRecibida(sql, ok.turnoId)).toMatchObject({ inicial: { bolsa: "340.00" }, confirmado: { bolsa: "350.00" } });
  });

  it("valida en el servidor quién entrega, a quién y quién recibe", async () => {
    const e = await escenario();
    const otra = await escenario();
    expect(await entregar(e, "350", "1200", { quien: e.sofia })).toEqual({ ok: false, error: "no_responsable" });
    expect(await entregar(e, "350", "1200", { quien: e.encargado })).toEqual({ ok: false, error: "sin_permiso" });
    expect(await entregar(e, "350", "1200", { recibe: e.laura })).toEqual({ ok: false, error: "receptor" });
    expect(await entregar(e, "350", "1200", { recibe: otra.sofia })).toEqual({ ok: false, error: "receptor" });
    expect(await entregar(e, "350", "1200", { recibe: e.encargado })).toEqual({ ok: false, error: "receptor" });
    expect(await entregar(e, "350", "1200", { nota: "no" })).toEqual({ ok: false, error: "nota" });
    expect(await registrarEntrega(sql, e.laura, e.codigo, { turnoId: otra.turnoId, conteo: { bolsa: "1", cajon: "1" }, recibe: e.sofia, nota: "" }, PRUEBAS))
      .toEqual({ ok: false, error: "cambio" });

    expect(await entregar(e, "350", "1200")).toMatchObject({ ok: true });
    expect(await entregar(e, "350", "1200")).toEqual({ ok: false, error: "entrega_en_curso" });
    // Solo la elegida recibe; otra cuenta de Recepción de la sucursal, no; de otra sucursal, ni la ve.
    expect(await recibir(e, "350", "1200", "", e.tercera)).toEqual({ ok: false, error: "sin_entrega" });
    expect(await pantallaRecepcion(sql, e.tercera, e.codigo, "pruebas")).toEqual({ ok: false, error: "sin_entrega" });
    expect(await recibir(e, "350", "1200", "", otra.sofia)).toEqual({ ok: false, error: "no_encontrada" });
    expect(await recibir(e, "350", "1200", "", e.laura)).toEqual({ ok: false, error: "sin_entrega" });
    const x = await enCurso(e);
    expect(await recibirTurno(sql, e.sofia, e.codigo, { entregaId: x.id, version: x.version + 1, conteo: { bolsa: "350", cajon: "1200" }, aclaracion: "" }, PRUEBAS))
      .toEqual({ ok: false, error: "cambio" });
    expect(await recibirTurno(sql, e.sofia, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "350", cajon: "1200" }, aclaracion: "" }, { entorno: "produccion" }))
      .toEqual({ ok: false, error: "bloqueado_produccion" });
  });

  it("mientras se entrega no entra efectivo nuevo; la saliente puede cancelar con motivo y todo sigue igual", async () => {
    const e = await escenario();
    await entregar(e, "350", "1200");
    expect(await cobrar(e.laura, e.codigo)).toMatchObject({ ok: false, error: "entrega_en_curso" });
    const [op] = await sql<{ id: string }[]>`select id from operacion_visita where turno_id = ${e.turnoId} order by registrada_en limit 1`;
    const dup = await duplicarCobro(sql, op.id);
    expect(await solicitarCancelacion(sql, e.laura, e.codigo, dup, { conservaOperacionId: op.id, explicacion: "Se capturó dos veces", sinDinero: true }, PRUEBAS))
      .toEqual({ ok: false, error: "entrega_en_curso" });

    const x = await enCurso(e);
    expect(await cancelarEntrega(sql, e.sofia, e.codigo, { entregaId: x.id, version: x.version, motivo: "Me equivoqué de persona" }, PRUEBAS))
      .toEqual({ ok: false, error: "no_responsable" });
    expect(await cancelarEntrega(sql, e.laura, e.codigo, { entregaId: x.id, version: x.version, motivo: "no" }, PRUEBAS)).toEqual({ ok: false, error: "motivo" });
    expect(await cancelarEntrega(sql, e.laura, e.codigo, { entregaId: x.id, version: x.version, motivo: "Me equivoqué de persona" }, PRUEBAS)).toEqual({ ok: true });
    expect(await entregaEnCurso(sql, e.turnoId)).toBeNull();
    expect((await sql`select estado, motivo_cancelacion from entrega_turno where id = ${x.id}`)[0])
      .toEqual({ estado: "cancelada", motivo_cancelacion: "Me equivoqué de persona" });
    expect(await cobrar(e.laura, e.codigo)).toMatchObject({ ok: true });

    // Con una solicitud de cancelación pendiente no se entrega (solo se resuelve con el turno abierto).
    expect(await solicitarCancelacion(sql, e.laura, e.codigo, dup, { conservaOperacionId: op.id, explicacion: "Se capturó dos veces", sinDinero: true }, PRUEBAS))
      .toMatchObject({ ok: true });
    expect(await entregar(e, "400", "1200")).toEqual({ ok: false, error: "cancelaciones_pendientes" });
  });

  describe("entrega y solicitud de cancelación en paralelo: mismo bloqueo del turno", () => {
    /** Cuántas operaciones de esta base están esperando un bloqueo. */
    const esperando = async () =>
      (await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where not l.granted and a.datname = current_database()`)[0].n;
    async function hasta(n: number) {
      for (let i = 0; i < 200; i++) {
        if ((await esperando()) >= n) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`no llegaron a ${n} operaciones en espera`);
    }
    /**
     * Retiene el bloqueo del turno, lanza `primera` y espera a que quede formada; luego `segunda`. Al soltarlo, la
     * base atiende primero a `primera`. Así se fuerza cada orden sin depender de tiempos.
     */
    async function enOrden<A, B>(turnoId: string, primera: () => Promise<A>, segunda: () => Promise<B>): Promise<[A, B]> {
      let soltar!: () => void;
      const suelto = new Promise<void>((r) => (soltar = r));
      let tomado!: () => void;
      const retenido = new Promise<void>((r) => (tomado = r));
      const retencion = sql.begin(async (tx) => {
        await tx`select id from turno where id = ${turnoId} for update`;
        tomado();
        await suelto;
      });
      await retenido;
      const a = primera();
      await hasta(1);
      const b = segunda();
      await hasta(2);
      soltar();
      await retencion;
      return Promise.all([a, b]);
    }
    async function conDuplicado() {
      const e = await escenario();
      const [op] = await sql<{ id: string }[]>`select id from operacion_visita where turno_id = ${e.turnoId} order by registrada_en limit 1`;
      const dup = await duplicarCobro(sql, op.id);
      const solicitar = () => solicitarCancelacion(sql, e.laura, e.codigo, dup, { conservaOperacionId: op.id, explicacion: "Se capturó dos veces", sinDinero: true }, PRUEBAS);
      return { e, solicitar };
    }

    it("si se registra primero la solicitud, la entrega queda bloqueada", async () => {
      const { e, solicitar } = await conDuplicado();
      const [s, r] = await enOrden(e.turnoId, solicitar, () => entregar(e, "400", "1200"));
      expect(s).toMatchObject({ ok: true, repetida: false });
      expect(r).toEqual({ ok: false, error: "cancelaciones_pendientes" });
      expect(await entregaEnCurso(sql, e.turnoId)).toBeNull();
      expect((await sql`select count(*)::int as n from entrega_turno where turno_id = ${e.turnoId}`)[0].n).toBe(0);
    });

    it("si se registra primero la entrega, la solicitud queda bloqueada", async () => {
      const { e, solicitar } = await conDuplicado();
      const [r, s] = await enOrden(e.turnoId, () => entregar(e, "400", "1200"), solicitar);
      expect(r).toMatchObject({ ok: true });
      expect(s).toEqual({ ok: false, error: "entrega_en_curso" });
      expect((await sql`select count(*)::int as n from cancelacion_cobro c join cobro_visita v on v.id = c.cobro_id
                        join operacion_visita o on o.id = v.operacion_id where o.turno_id = ${e.turnoId}`)[0].n).toBe(0);
    });

    it("lanzadas a la vez sin forzar el orden, solo una de las dos queda registrada", async () => {
      const { e, solicitar } = await conDuplicado();
      const [s, r] = await Promise.all([solicitar(), entregar(e, "400", "1200")]);
      expect([s.ok, r.ok].filter(Boolean)).toHaveLength(1);
      if (s.ok) expect(r).toEqual({ ok: false, error: "cancelaciones_pendientes" });
      else expect(s).toEqual({ ok: false, error: "entrega_en_curso" });
    });
  });

  it("no se entrega ni se recibe en una sucursal inactiva ni en producción", async () => {
    const e = await escenario();
    expect(await registrarEntrega(sql, e.laura, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "350", cajon: "1200" }, recibe: e.sofia, nota: "" }, { entorno: "produccion" }))
      .toEqual({ ok: false, error: "bloqueado_produccion" });
    await entregar(e, "350", "1200");
    await sql`update sucursal set estado_operativo = 'inactiva', desactivada_en = now() where id = ${ids[e.codigo]}`;
    expect(await recibir(e, "350", "1200")).toEqual({ ok: false, error: "sucursal_inactiva" });
    expect(await pantallaEntrega(sql, e.laura, e.codigo, "pruebas")).toEqual({ ok: false, error: "sucursal_inactiva" });
  });

  it("dos confirmaciones simultáneas: solo una abre turno", async () => {
    const e = await escenario();
    await entregar(e, "350", "1200");
    const [a, b] = await Promise.all([recibir(e, "350", "1200"), recibir(e, "350", "1200")]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect((await sql`select count(*)::int as n from turno where sucursal_id = ${ids[e.codigo]}`)[0].n).toBe(2);
  });

  it("la base no deja editar conteos ni diferencias, ni regresar una entrega confirmada", async () => {
    const e = await escenario();
    await entregar(e, "300", "1200");
    await recibir(e, "300", "1200");
    const [x] = await sql<{ id: string }[]>`select id from entrega_turno where turno_id = ${e.turnoId}`;
    await expect(sql`update entrega_conteo set importe = 350 where entrega_id = ${x.id}`).rejects.toThrow();
    await expect(sql`delete from diferencia_efectivo where entrega_id = ${x.id}`).rejects.toThrow();
    await expect(sql`update entrega_turno set estado = 'cancelada', motivo_cancelacion = 'Intento de prueba', version = version + 1 where id = ${x.id}`).rejects.toThrow();
    await expect(sql`delete from entrega_turno where id = ${x.id}`).rejects.toThrow();
  });
});

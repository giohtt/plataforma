import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import {
  cancelacionesDeCobro, cancelacionesPorAutorizar, pantallaSolicitud, puedeAutorizarCancelaciones, resolverCancelacion,
  solicitarCancelacion,
} from "@/lib/cancelaciones";
import { cobrosDelTurno, confirmarVisita, detalleCobro, pantallaCobro, visitasDeHoy } from "@/lib/visitas";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";
import { duplicarCobro } from "./duplicado";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;
let k = 0;
const PRUEBAS = { entorno: "pruebas" as const };
const EXPLICACION = "Se capturó dos veces el mismo pago de Ana";

async function cuenta(asignaciones: [string, string][], facultad?: { codigo: string; limite: number }) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Cancela " + n}, ${`cancela${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de cancelación')`;
  }
  if (facultad) {
    await sql`
      insert into facultad_otorgada (usuario_id, permiso, sucursal_id, todas_las_sucursales, limite_monto, motivo)
      values (${u.id}, 'autorizacion.devolucion', ${ids[facultad.codigo]}, false, ${facultad.limite}, 'Prueba de cancelación (ficticia)')`;
  }
  return u.id;
}
async function ficha(nombre: string) {
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, telefono, sucursal_alta_id) values (${nombre + " " + randomUUID().slice(0, 4)}, '0000000301', ${ids.ATL}) returning id`;
  return v.id;
}
async function cobrar(u: string, codigo: string, visitantes: string[]) {
  const p = await pantallaCobro(sql, u, codigo, "pruebas");
  if (!p.ok) throw new Error(p.error);
  const r = await confirmarVisita(sql, u, codigo, {
    clave: randomUUID(), turnoId: p.turnoId, visitanteIds: visitantes, formaPago: "efectivo", recibido: null, cambio: null,
    autorizacion: null, referencia: null, tipoReferencia: null, otraVenta: false,
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return r.operacionId;
}
const bolsa = async (u: string, codigo: string) => {
  const e = await estadoTurno(sql, u, codigo);
  return e!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!;
};
/** Ventas del turno como las muestra la pantalla: sin los cobros cancelados. */
const ventas = async (turnoId: string) => {
  const vigentes = (await cobrosDelTurno(sql, turnoId)).filter((c) => c.estado !== "cancelado");
  return { cobros: vigentes.length, total: vigentes.reduce((s, c) => s + Number(c.total), 0) };
};

/**
 * Sucursal nueva con la bolsa en $150 y tres cobros en efectivo de $50: Luis, Ana y Ana otra vez (el duplicado).
 * La bolsa espera $300. Dirección de la sucursal tiene la facultad con límite de $150.
 */
async function escenario() {
  k++;
  const codigo = `C${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal cancela " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const recep = await cuenta([["recepcion", codigo]]);
  const dir = await cuenta([["direccion", codigo]], { codigo, limite: 150 });
  const t = await abrirTurno(sql, recep, codigo, { bolsa: "150.00", cajon: "0.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const luis = await ficha("Luis Prueba");
  const ana = await ficha("Ana Prueba");
  const cobroLuis = await cobrar(recep, codigo, [luis]);
  const correcto = await cobrar(recep, codigo, [ana]);
  const duplicado = await duplicarCobro(sql, correcto);
  return { codigo, recep, dir, turnoId: t.turnoId, luis, ana, cobroLuis, correcto, duplicado };
}
const solicitar = (u: string, codigo: string, dup: string, conserva: string, extra: Partial<{ explicacion: string; sinDinero: boolean }> = {}) =>
  solicitarCancelacion(sql, u, codigo, dup, { conservaOperacionId: conserva, explicacion: EXPLICACION, sinDinero: true, ...extra }, PRUEBAS);
async function solicitada(u: string, codigo: string, dup: string, conserva: string) {
  const r = await solicitar(u, codigo, dup, conserva);
  if (!r.ok) throw new Error(r.error);
  const [x] = await sql<{ version: number }[]>`select version from cancelacion_cobro where id = ${r.cancelacionId}`;
  return { id: r.cancelacionId, version: x.version };
}
const aprobar = (u: string, codigo: string, x: { id: string; version: number }) =>
  resolverCancelacion(sql, u, codigo, x.id, { version: x.version, decision: "aprobar" }, PRUEBAS);
const cobroId = async (operacionId: string) =>
  (await sql<{ id: string }[]>`select id from cobro_visita where operacion_id = ${operacionId}`)[0].id;

describe.skipIf(!URL_ADMIN)("cancelación de un cobro duplicado en efectivo", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  describe("solicitud de Recepción", () => {
    it("ofrece como cobro que se conserva solo el de las mismas personas, total y turno; solicitar no cambia nada", async () => {
      const e = await escenario();
      const p = await pantallaSolicitud(sql, e.recep, e.codigo, e.duplicado, "pruebas");
      expect(p.ok && p.candidatos.map((c) => c.operacionId)).toEqual([e.correcto]);

      const antes = await bolsa(e.recep, e.codigo);
      expect(antes.esperado).toBe("300.00");
      const r = await solicitar(e.recep, e.codigo, e.duplicado, e.correcto);
      expect(r).toMatchObject({ ok: true, repetida: false });

      const despues = await bolsa(e.recep, e.codigo);
      expect(despues.esperado).toBe("300.00");
      expect(despues.cantidadAjustes).toBe(0);
      expect(await ventas(e.turnoId)).toEqual({ cobros: 3, total: 150 });
      const lista = await cobrosDelTurno(sql, e.turnoId);
      expect(lista.find((c) => c.id === e.duplicado)).toMatchObject({ estado: "confirmado", cancelacionSolicitada: true });
    });

    it("no se puede conservar un cobro de otra persona, el mismo cobro ni uno inventado", async () => {
      const e = await escenario();
      expect(await solicitar(e.recep, e.codigo, e.duplicado, e.cobroLuis)).toEqual({ ok: false, error: "conserva_invalido" });
      expect(await solicitar(e.recep, e.codigo, e.duplicado, e.duplicado)).toEqual({ ok: false, error: "conserva_invalido" });
      expect(await solicitar(e.recep, e.codigo, e.duplicado, randomUUID())).toEqual({ ok: false, error: "conserva_invalido" });
      expect(await solicitar(e.recep, e.codigo, e.duplicado, "no-es-id")).toEqual({ ok: false, error: "conserva_invalido" });
    });

    it("pide explicación y confirmar que no salió dinero de la bolsa", async () => {
      const e = await escenario();
      expect(await solicitar(e.recep, e.codigo, e.duplicado, e.correcto, { explicacion: "  ya " })).toEqual({ ok: false, error: "explicacion" });
      expect(await solicitar(e.recep, e.codigo, e.duplicado, e.correcto, { sinDinero: false })).toEqual({ ok: false, error: "sin_confirmar" });
      const [{ n: total }] = await sql<{ n: number }[]>`select count(*)::int as n from cancelacion_cobro where sucursal_id = ${ids[e.codigo]}`;
      expect(total).toBe(0);
    });

    it("el doble envío devuelve la misma solicitud; no se puede pedir otra para el mismo cobro ni conservar uno con solicitud", async () => {
      const e = await escenario();
      const a = await solicitar(e.recep, e.codigo, e.duplicado, e.correcto);
      const b = await solicitar(e.recep, e.codigo, e.duplicado, e.correcto);
      expect(a.ok && b.ok && b.repetida && b.cancelacionId === a.cancelacionId).toBe(true);
      // Al revés: el correcto ya no puede cancelarse conservando el que tiene la solicitud.
      expect(await solicitar(e.recep, e.codigo, e.correcto, e.duplicado)).toEqual({ ok: false, error: "conserva_invalido" });
      expect(await pantallaSolicitud(sql, e.recep, e.codigo, e.duplicado, "pruebas")).toEqual({ ok: false, error: "ya_solicitada" });
      // Dos envíos simultáneos con otra persona de Recepción: solo queda una solicitud activa.
      const otra = await escenario();
      const resultados = await Promise.all([
        solicitar(otra.recep, otra.codigo, otra.duplicado, otra.correcto),
        solicitar(otra.recep, otra.codigo, otra.duplicado, otra.correcto),
      ]);
      expect(resultados.every((r) => r.ok)).toBe(true);
      const [{ n: activas }] = await sql<{ n: number }[]>`
        select count(*)::int as n from cancelacion_cobro where cobro_id = ${await cobroId(otra.duplicado)}`;
      expect(activas).toBe(1);
    });

    it("sin permiso en la sucursal, o con tarjeta o transferencia: no se solicita, tampoco por solicitud directa", async () => {
      const e = await escenario();
      const ajena = await cuenta([["recepcion", "TEN"]]);
      expect(await solicitar(ajena, e.codigo, e.duplicado, e.correcto)).toEqual({ ok: false, error: "no_encontrada" });
      // Dirección ve el turno pero no solicita: aprueba.
      expect(await solicitar(e.dir, e.codigo, e.duplicado, e.correcto)).toEqual({ ok: false, error: "sin_permiso" });
      const p = await pantallaCobro(sql, e.recep, e.codigo, "pruebas");
      if (!p.ok) throw new Error(p.error);
      const tarjeta = await confirmarVisita(sql, e.recep, e.codigo, {
        clave: randomUUID(), turnoId: p.turnoId, visitanteIds: [await ficha("Rocío Prueba")], formaPago: "tarjeta", recibido: null, cambio: null,
        autorizacion: "AB12CD", referencia: null, tipoReferencia: null, otraVenta: false,
      }, PRUEBAS);
      if (!tarjeta.ok) throw new Error(tarjeta.error);
      expect(await solicitar(e.recep, e.codigo, tarjeta.operacionId, e.correcto)).toEqual({ ok: false, error: "no_cancelable" });
    });

    it("en producción está bloqueado", async () => {
      const e = await escenario();
      const prod = { entorno: "produccion" as const };
      expect(await solicitarCancelacion(sql, e.recep, e.codigo, e.duplicado,
        { conservaOperacionId: e.correcto, explicacion: EXPLICACION, sinDinero: true }, prod)).toEqual({ ok: false, error: "bloqueado_produccion" });
      expect(await pantallaSolicitud(sql, e.recep, e.codigo, e.duplicado, "produccion")).toEqual({ ok: false, error: "bloqueado_produccion" });
      const x = await solicitada(e.recep, e.codigo, e.duplicado, e.correcto);
      expect(await resolverCancelacion(sql, e.dir, e.codigo, x.id, { version: x.version, decision: "aprobar" }, prod))
        .toEqual({ ok: false, error: "bloqueado_produccion" });
    });
  });

  describe("solo la responsable de la bolsa del turno abierto", () => {
    it("Tenango, dos cuentas de Recepción: la responsable la pide; la otra no, ni por envío directo; Dirección Tenango la aprueba", async () => {
      const responsable = await cuenta([["recepcion", "TEN"]]);
      const otra = await cuenta([["recepcion", "TEN"]]);
      const t = await abrirTurno(sql, responsable, "TEN", { bolsa: "150.00", cajon: "0.00" }, PRUEBAS);
      if (!t.ok) throw new Error(t.error);
      const luis = await ficha("Luis Prueba");
      const ana = await ficha("Ana Prueba");
      await cobrar(responsable, "TEN", [luis]);
      const correcto = await cobrar(responsable, "TEN", [ana]);
      const duplicado = await duplicarCobro(sql, correcto);
      expect((await bolsa(responsable, "TEN")).esperado).toBe("300.00");

      // La otra cuenta tiene el permiso en Tenango, pero no tiene a su cargo la bolsa: ni la pantalla ni el envío directo.
      expect(await pantallaSolicitud(sql, otra, "TEN", duplicado, "pruebas")).toEqual({ ok: false, error: "no_responsable" });
      expect(await solicitar(otra, "TEN", duplicado, correcto)).toEqual({ ok: false, error: "no_responsable" });
      const [{ n: ninguna }] = await sql<{ n: number }[]>`select count(*)::int as n from cancelacion_cobro where sucursal_id = ${ids.TEN}`;
      expect(ninguna).toBe(0);

      // La responsable sí.
      const p = await pantallaSolicitud(sql, responsable, "TEN", duplicado, "pruebas");
      expect(p.ok && p.candidatos.map((c) => c.operacionId)).toEqual([correcto]);
      const x = await solicitada(responsable, "TEN", duplicado, correcto);
      // Con la solicitud ya hecha, la otra cuenta tampoco puede repetirla ni pedir otra.
      expect(await solicitar(otra, "TEN", duplicado, correcto)).toEqual({ ok: false, error: "no_responsable" });

      // La autorización sigue aparte: Dirección Tenango (facultad de los datos de prueba, hasta $150).
      const [dir] = await sql<{ id: string }[]>`select id from usuario where correo = 'direccion@prueba.fitnessland.invalid'`;
      expect(await aprobar(responsable, "TEN", x)).toEqual({ ok: false, error: "no_encontrada" });
      expect(await aprobar(otra, "TEN", x)).toEqual({ ok: false, error: "no_encontrada" });
      expect(await aprobar(dir.id, "TEN", x)).toEqual({ ok: true });
      expect((await bolsa(responsable, "TEN")).esperado).toBe("250.00");
    });
  });

  describe("aprobación", () => {
    it("bolsa de $300 a $250: un solo ajuste de −$50, el duplicado y su pase cancelados, el historial se conserva", async () => {
      const e = await escenario();
      const x = await solicitada(e.recep, e.codigo, e.duplicado, e.correcto);
      expect(await aprobar(e.dir, e.codigo, x)).toEqual({ ok: true });

      const b = await bolsa(e.recep, e.codigo);
      expect({ esperado: b.esperado, entradas: b.entradas, ajustes: b.ajustes, cantidadAjustes: b.cantidadAjustes, cantidadEntradas: b.cantidadEntradas })
        .toEqual({ esperado: "250.00", entradas: "150.00", ajustes: "-50.00", cantidadAjustes: 1, cantidadEntradas: 3 });

      // Los $50 se descuentan una sola vez del saldo: entradas $150 − ajuste $50 = $100 movidos.
      const movimientos = await sql<{ tipo: string; importe: string }[]>`
        select m.tipo, m.importe::text as importe from movimiento_efectivo m where m.turno_id = ${e.turnoId} order by m.id`;
      expect(movimientos.map((m) => m.importe)).toEqual(["50.00", "50.00", "50.00", "-50.00"]);
      expect(movimientos.reduce((s, m) => s + Number(m.importe), 0)).toBe(100);

      // Las ventas dejan de contar el duplicado; eso no vuelve a tocar la bolsa.
      expect(await ventas(e.turnoId)).toEqual({ cobros: 2, total: 100 });

      // Nada se borra: la operación, el cobro y el pase siguen, marcados como cancelados.
      const d = await detalleCobro(sql, e.recep, e.codigo, e.duplicado);
      expect(d?.estado).toBe("cancelado");
      expect(d?.entradaBolsa).toBe("50.00");
      expect(d?.cambios).toMatchObject([{ de: "confirmado", a: "cancelado", motivo: `Duplicado: ${EXPLICACION}` }]);
      const [pase] = await sql<{ cancelado_en: Date | null }[]>`select cancelado_en from pase_visita where operacion_id = ${e.duplicado}`;
      expect(pase.cancelado_en).not.toBeNull();
      const [correcto] = await sql<{ estado: string; cancelado: Date | null }[]>`
        select c.estado, p.cancelado_en as cancelado from cobro_visita c join pase_visita p on p.operacion_id = c.operacion_id
        where c.operacion_id = ${e.correcto}`;
      expect(correcto).toEqual({ estado: "confirmado", cancelado: null });

      const propias = await cancelacionesDeCobro(sql, await cobroId(e.duplicado));
      expect(propias.propias).toMatchObject([{ estado: "aprobada", ajuste: "-50.00", conservaOperacionId: e.correcto }]);
      expect((await cancelacionesDeCobro(sql, await cobroId(e.correcto))).comoConservado).toEqual([{ operacionId: e.duplicado, estado: "aprobada" }]);

      // La visita de Ana sigue contando una vez hoy.
      const hoy = await visitasDeHoy(sql, e.recep, e.codigo, [e.ana]);
      expect(hoy?.map((v) => ({ id: v.id, visitasHoy: v.visitasHoy }))).toEqual([{ id: e.ana, visitasHoy: 1 }]);
    });

    it("aprobar dos veces, o dos personas a la vez, deja un solo ajuste", async () => {
      const e = await escenario();
      const dir2 = await cuenta([["direccion", e.codigo]], { codigo: e.codigo, limite: 150 });
      const x = await solicitada(e.recep, e.codigo, e.duplicado, e.correcto);
      const r = await Promise.all([aprobar(e.dir, e.codigo, x), aprobar(dir2, e.codigo, x)]);
      expect(r.filter((y) => y.ok)).toHaveLength(1);
      expect(r.find((y) => !y.ok)).toEqual({ ok: false, error: "cambio" });
      expect(await aprobar(e.dir, e.codigo, x)).toEqual({ ok: false, error: "cambio" });
      expect((await bolsa(e.recep, e.codigo)).esperado).toBe("250.00");
    });

    it("quien pidió la cancelación o registró el cobro no puede aprobarla", async () => {
      // La responsable de la bolsa tiene además la facultad: cobra y pide la cancelación ella misma.
      k++;
      const codigo = `C${k}`;
      const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal cancela " + k}, ${codigo}) returning id`;
      ids[codigo] = s.id;
      const registra = await cuenta([["recepcion", codigo]], { codigo, limite: 150 });
      const t = await abrirTurno(sql, registra, codigo, { bolsa: "0.00", cajon: "0.00" }, PRUEBAS);
      if (!t.ok) throw new Error(t.error);
      const ana = await ficha("Ana Prueba");
      const correcto = await cobrar(registra, codigo, [ana]);
      const duplicado = await duplicarCobro(sql, correcto);
      const x = await solicitada(registra, codigo, duplicado, correcto);

      expect(await aprobar(registra, codigo, x)).toEqual({ ok: false, error: "propia" });
      expect((await cancelacionesPorAutorizar(sql, registra, codigo))?.pendientes.map((p) => p.impedimento)).toEqual(["propia"]);
      expect(await resolverCancelacion(sql, registra, codigo, x.id, { version: x.version, decision: "rechazar", motivo: "No procede" }, PRUEBAS))
        .toEqual({ ok: false, error: "propia" });
      // La base tampoco deja que la resuelva quien la pidió.
      await expect(sql`update cancelacion_cobro set estado = 'rechazada', resuelta_por = ${registra}, resuelta_en = now(),
        motivo_rechazo = 'Prueba directa', version = version + 1 where id = ${x.id}`).rejects.toThrow(/cancelacion_otra_persona_resuelve/);

      // Aunque otra persona hubiera pedido la cancelación (simulado en la base), quien registró el cobro no la aprueba.
      const otra = await cuenta([["recepcion", codigo]]);
      await sql`update cancelacion_cobro set estado = 'rechazada', resuelta_por = ${otra}, resuelta_en = now(),
        motivo_rechazo = 'Se repite para la prueba', version = version + 1 where id = ${x.id}`;
      const [y] = await sql<{ id: string; version: number }[]>`
        insert into cancelacion_cobro (cobro_id, conserva_cobro_id, tipo, explicacion, sucursal_id, solicitada_por)
        values (${await cobroId(duplicado)}, ${await cobroId(correcto)}, 'duplicado', 'Pedida por otra persona', ${s.id}, ${otra})
        returning id, version`;
      expect(await aprobar(registra, codigo, y)).toEqual({ ok: false, error: "registro_propio" });
      expect((await cancelacionesPorAutorizar(sql, registra, codigo))?.pendientes.map((p) => p.impedimento)).toEqual(["registro_propio"]);
    });

    it("sin la facultad en la sucursal: «No encontrada», también para Dirección con el rol pero sin facultad", async () => {
      const e = await escenario();
      const x = await solicitada(e.recep, e.codigo, e.duplicado, e.correcto);
      const sinFacultad = await cuenta([["direccion", e.codigo]]);
      const otraSucursal = await cuenta([["direccion", e.codigo]], { codigo: "TEN", limite: 150 });
      for (const u of [sinFacultad, otraSucursal, e.recep]) {
        expect(await aprobar(u, e.codigo, x)).toEqual({ ok: false, error: "no_encontrada" });
        expect(await cancelacionesPorAutorizar(sql, u, e.codigo)).toBeNull();
        expect(await puedeAutorizarCancelaciones(sql, u, e.codigo)).toBe(false);
      }
      // Una facultad revocada o vencida tampoco sirve.
      await sql`update facultad_otorgada set revocada_en = now() where usuario_id = ${e.dir}`;
      expect(await aprobar(e.dir, e.codigo, x)).toEqual({ ok: false, error: "no_encontrada" });
    });

    it("por encima del límite no se aprueba: un grupo de $200 con límite de $150", async () => {
      k++;
      const codigo = `C${k}`;
      const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal cancela " + k}, ${codigo}) returning id`;
      ids[codigo] = s.id;
      const recep = await cuenta([["recepcion", codigo]]);
      const dir = await cuenta([["direccion", codigo]], { codigo, limite: 150 });
      const t = await abrirTurno(sql, recep, codigo, { bolsa: "0.00", cajon: "0.00" }, PRUEBAS);
      if (!t.ok) throw new Error(t.error);
      const grupo = [await ficha("A"), await ficha("B"), await ficha("C"), await ficha("D")];
      const correcto = await cobrar(recep, codigo, grupo);
      const duplicado = await duplicarCobro(sql, correcto);
      const x = await solicitada(recep, codigo, duplicado, correcto);
      expect(await aprobar(dir, codigo, x)).toEqual({ ok: false, error: "excede_limite" });
      expect((await cancelacionesPorAutorizar(sql, dir, codigo))?.pendientes.map((p) => p.impedimento)).toEqual(["excede_limite"]);
      expect((await bolsa(recep, codigo)).esperado).toBe("400.00");
    });

    it("el rechazo pide motivo, no cambia el saldo ni las ventas y permite una nueva solicitud", async () => {
      const e = await escenario();
      const x = await solicitada(e.recep, e.codigo, e.duplicado, e.correcto);
      expect(await resolverCancelacion(sql, e.dir, e.codigo, x.id, { version: x.version, decision: "rechazar", motivo: " no " }, PRUEBAS))
        .toEqual({ ok: false, error: "motivo" });
      expect(await resolverCancelacion(sql, e.dir, e.codigo, x.id, { version: x.version, decision: "rechazar", motivo: "Eran dos visitas distintas" }, PRUEBAS))
        .toEqual({ ok: true });
      expect((await bolsa(e.recep, e.codigo)).esperado).toBe("300.00");
      expect(await ventas(e.turnoId)).toEqual({ cobros: 3, total: 150 });
      expect(await aprobar(e.dir, e.codigo, x)).toEqual({ ok: false, error: "cambio" });
      expect(await solicitar(e.recep, e.codigo, e.duplicado, e.correcto)).toMatchObject({ ok: true, repetida: false });
    });

    it("dos solicitudes cruzadas no pueden cancelar ambos cobros", async () => {
      const e = await escenario();
      // La primera conserva el correcto; la segunda intentaría conservar el duplicado.
      await solicitada(e.recep, e.codigo, e.duplicado, e.correcto);
      expect(await solicitar(e.recep, e.codigo, e.correcto, e.duplicado)).toEqual({ ok: false, error: "conserva_invalido" });
    });
  });

  describe("la base protege los registros", () => {
    it("no acepta un segundo ajuste, un ajuste de otro importe ni uno sin entrada", async () => {
      const e = await escenario();
      const x = await solicitada(e.recep, e.codigo, e.duplicado, e.correcto);
      await aprobar(e.dir, e.codigo, x);
      const dup = await cobroId(e.duplicado);
      const [m] = await sql<{ lugar_id: string; responsable_id: string }[]>`
        select lugar_id, responsable_id from movimiento_efectivo where cobro_id = ${dup} and tipo = 'entrada_cobro_visita'`;
      const insertar = (cobro: string, importe: string) => sql`
        insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, cobro_id, responsable_id, registrado_por)
        values (${m.lugar_id}, ${e.turnoId}, 'ajuste_cancelacion_cobro', ${importe}, ${cobro}, ${m.responsable_id}, ${e.dir})`;
      await expect(insertar(dup, "-50.00")).rejects.toThrow(/movimiento_efectivo_cobro_tipo_unico/);
      await expect(insertar(await cobroId(e.cobroLuis), "-40.00")).rejects.toThrow(/anular exactamente/);
      await expect(insertar(await cobroId(e.cobroLuis), "50.00")).rejects.toThrow(/anular exactamente|movimiento_efectivo_tipo_signo/);
      expect((await bolsa(e.recep, e.codigo)).esperado).toBe("250.00");
    });

    it("un cobro cancelado no vuelve a confirmado y un pase no se cancela si su cobro sigue vigente", async () => {
      const e = await escenario();
      const x = await solicitada(e.recep, e.codigo, e.duplicado, e.correcto);
      await aprobar(e.dir, e.codigo, x);
      await expect(sql`update cobro_visita set estado = 'confirmado', version = version + 1 where operacion_id = ${e.duplicado}`)
        .rejects.toThrow(/cambio no permitido/);
      await expect(sql`update pase_visita set cancelado_en = now() where operacion_id = ${e.cobroLuis}`).rejects.toThrow(/cambio no permitido/);
      await expect(sql`update pase_visita set cancelado_en = null where operacion_id = ${e.duplicado}`).rejects.toThrow(/cambio no permitido/);
      await expect(sql`delete from cancelacion_cobro where id = ${x.id}`).rejects.toThrow(/no se permite delete/);
      await expect(sql`update cancelacion_cobro set explicacion = 'Otra explicación', version = version + 1 where id = ${x.id}`)
        .rejects.toThrow(/cambio no permitido/);
      // Una tarjeta no se cancela en este paso.
      const p = await pantallaCobro(sql, e.recep, e.codigo, "pruebas");
      if (!p.ok) throw new Error(p.error);
      const tarjeta = await confirmarVisita(sql, e.recep, e.codigo, {
        clave: randomUUID(), turnoId: p.turnoId, visitanteIds: [await ficha("Rocío Prueba")], formaPago: "tarjeta", recibido: null, cambio: null,
        autorizacion: "ZX98YW", referencia: null, tipoReferencia: null, otraVenta: false,
      }, PRUEBAS);
      if (!tarjeta.ok) throw new Error(tarjeta.error);
      await expect(sql`update cobro_visita set estado = 'cancelado', version = version + 1 where operacion_id = ${tarjeta.operacionId}`)
        .rejects.toThrow(/cambio no permitido/);
    });

    it("una solicitud aprobada exige su ajuste", async () => {
      const e = await escenario();
      const x = await solicitada(e.recep, e.codigo, e.duplicado, e.correcto);
      await expect(sql`update cancelacion_cobro set estado = 'aprobada', resuelta_por = ${e.dir}, resuelta_en = now(),
        version = version + 1 where id = ${x.id}`).rejects.toThrow(/cancelacion_estado_coherente/);
    });
  });
});

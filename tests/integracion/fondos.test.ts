import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirDesdeCierre, cerrarDia, cierrePendiente, configurarCustodia, confirmarCustodia, pantallaApertura, pantallaCierre, prepararCierre,
  terminarApertura,
} from "@/lib/cierres";
import { detalleDiferencias, revisarIncidencia } from "@/lib/diferencias";
import { cambiarMontoFondo, cancelarEntradaFondo, confirmarEntradaFondo, pantallaFondos, registrarReposicion } from "@/lib/fondos";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/** Bloque 5, regla 7: fondo fijo de caja ($300 y $300, aprobado el 17 nov 2026), con datos ficticios. */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;
let k = 0;
const PRUEBAS = { entorno: "pruebas" as const };
const NADIE = { hubo: false as const };

async function cuenta(asignaciones: [string, string][], nombre: string) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${`${nombre} ${n}`}, ${`fondo${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de fondo')`;
  }
  return u.id;
}

/**
 * Sucursal nueva: Recepción abre con $900 en la bolsa y $3,100 en el cajón; Dirección define la custodia (con el cajón
 * y su acceso) y, si se pide, los fondos de $300 y $300 que entrega ella misma y Recepción confirma.
 */
async function escenario({ fondos = true } = {}) {
  k++;
  const codigo = `F${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal fondo " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const recepcion = await cuenta([["recepcion", codigo]], "Recepción");
  const vespertina = await cuenta([["recepcion", codigo]], "Recepción vespertina");
  const encargado = await cuenta([["encargado", codigo]], "Encargado");
  const admin = await cuenta([["administracion", codigo]], "Administración");
  const dir = await cuenta([["direccion", codigo]], "Dirección");
  const t = await abrirTurno(sql, recepcion, codigo, { bolsa: "900.00", cajon: "3100.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const c = await configurarCustodia(sql, dir, codigo, {
    lugar: "Caja con llave de la oficina", acceso: [encargado], lugarFondos: "Cajón con llave de recepción", accesoCajon: [recepcion, vespertina, encargado],
  }, PRUEBAS);
  if (!c.ok) throw new Error(c.error);
  const e = { codigo, sucursalId: s.id, recepcion, vespertina, encargado, admin, dir, turnoId: t.turnoId };
  if (fondos) {
    for (const lugar of ["bolsa_visitas", "cajon_mensualidades"]) {
      const r = await cambiarMontoFondo(sql, dir, codigo,
        { lugar, monto: "300", origen: "entrega_persona", destino: "", detalleOrigen: "Efectivo ficticio de Dirección", motivo: "Fondo provisional" }, PRUEBAS);
      if (!r.ok) throw new Error(r.error);
      const x = await confirmarEntradaFondo(sql, recepcion, codigo, { entradaId: r.entradaId!, recibido: "300" }, PRUEBAS);
      if (!x.ok) throw new Error(x.error);
    }
  }
  return e;
}
type Esc = Awaited<ReturnType<typeof escenario>>;

async function preparar(e: Esc) {
  const p = await prepararCierre(sql, e.recepcion, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
  if (!p.ok) throw new Error(p.error);
  return p.sobres;
}
const cerrarCon = (e: Esc, conteo: { bolsa: string; cajon: string }, fondos: { bolsa: string; cajon: string }, extra: Partial<Parameters<typeof cerrarDia>[3]> = {}) =>
  cerrarDia(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, conteo, fondos, custodio: e.encargado, nota: "", apoyo: NADIE, ...extra }, PRUEBAS);
const correctos = (sobres: { id: string }[]) => sobres.map((s) => ({ sobreId: s.id, estado: "correcto", folioVisto: "", motivo: "" }));
async function custodiar(e: Esc, llave = { estado: "correcta", motivo: "" }) {
  const c = (await cierrePendiente(sql, e.sucursalId))!;
  const r = await confirmarCustodia(sql, e.encargado, e.codigo, { entregaId: c.entregaId, ubicacion: "Caja con llave de la oficina", sobres: correctos(c.sobres), llave }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
}
async function abrir(e: Esc, quien: string, conteo: { bolsa: string; cajon: string }, fondos: { bolsa: string; cajon: string }) {
  const c = (await cierrePendiente(sql, e.sucursalId))!;
  return abrirDesdeCierre(sql, quien, e.codigo, { entregaId: c.entregaId, version: c.version, sobres: correctos(c.sobres), conteo, fondos, apoyo: NADIE }, PRUEBAS);
}
const separado = (entregaId: string) => sql<{ lugar: string; momento: string; fondo: string; sobre: string; fondo_monto: string }[]>`
  select l.tipo as lugar, c.momento, c.fondo::text, c.sobre::text, c.fondo_monto::text from conteo_fondo c join lugar_efectivo l on l.id = c.lugar_id
  where c.entrega_id = ${entregaId} order by l.tipo, c.momento`;
const incidencias = (entregaId: string) => sql<{ tipo: string; revisada: boolean }[]>`
  select i.tipo, exists (select 1 from revision_incidencia r where r.incidencia_id = i.id) as revisada
  from incidencia_cierre i where i.entrega_id = ${entregaId} order by i.tipo`;

describe.skipIf(!URL_ADMIN)("fondo fijo de caja", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("solo Dirección cambia el monto, con origen o destino; el aumento entregado queda pendiente hasta que se recibe", async () => {
    const e = await escenario({ fondos: false });
    const aumento = { lugar: "bolsa_visitas", monto: "300", origen: "entrega_persona", destino: "", detalleOrigen: "Efectivo ficticio de Dirección", motivo: "Fondo provisional" };
    expect(await cambiarMontoFondo(sql, e.admin, e.codigo, aumento, PRUEBAS)).toEqual({ ok: false, error: "sin_permiso" });
    expect(await cambiarMontoFondo(sql, e.dir, e.codigo, { ...aumento, origen: "" }, PRUEBAS)).toEqual({ ok: false, error: "origen" });
    expect(await cambiarMontoFondo(sql, e.dir, e.codigo, { ...aumento, detalleOrigen: "" }, PRUEBAS)).toEqual({ ok: false, error: "origen" });
    const r = await cambiarMontoFondo(sql, e.dir, e.codigo, aumento, PRUEBAS);
    expect(r).toMatchObject({ ok: true, entradaId: expect.any(String) });
    let p = (await pantallaFondos(sql, e.dir, e.codigo))!;
    expect(p.vigentes).toEqual([{ tipo: "bolsa_visitas", monto: "300.00" }, { tipo: "cajon_mensualidades", monto: "0.00" }]);
    expect(p.entradas[0]).toMatchObject({ tipo: "aumento", importe: "300.00", estado: "pendiente", puedoConfirmar: false, puedoCancelar: true });
    // Reducción: a dónde va el dinero.
    expect(await cambiarMontoFondo(sql, e.dir, e.codigo, { lugar: "bolsa_visitas", monto: "200", origen: "", destino: "", detalleOrigen: "", motivo: "Casi no se usa" }, PRUEBAS))
      .toEqual({ ok: false, error: "destino" });
    expect(await cambiarMontoFondo(sql, e.dir, e.codigo, { lugar: "bolsa_visitas", monto: "200", origen: "", destino: "sobre_cierre", detalleOrigen: "", motivo: "Casi no se usa" }, PRUEBAS))
      .toEqual({ ok: true, entradaId: null });
    p = (await pantallaFondos(sql, e.dir, e.codigo))!;
    expect(p.cambios.map((c) => [c.anterior, c.monto, c.origen, c.destino])).toEqual([["300.00", "200.00", null, "sobre_cierre"], ["0.00", "300.00", "entrega_persona", null]]);
    // La base lo respalda.
    const [l] = await sql<{ id: string }[]>`select id from lugar_efectivo where sucursal_id = ${e.sucursalId} and tipo = 'cajon_mensualidades'`;
    await expect(sql`insert into fondo_caja (sucursal_id, lugar_id, monto, anterior, origen, motivo, autorizado_por)
                     values (${e.sucursalId}, ${l.id}, 300, 0, 'excedente_cierre', 'Prueba directa', ${e.admin})`).rejects.toThrow(/Solo Dirección/);
    await expect(sql`insert into fondo_caja (sucursal_id, lugar_id, monto, anterior, motivo, autorizado_por)
                     values (${e.sucursalId}, ${l.id}, 300, 0, 'Prueba directa', ${e.dir})`).rejects.toThrow(/fondo_origen_destino/);
  });

  it("la responsable confirma cuánto recibe; si no coincide no se aplica, y lo recibido entra al esperado de la bolsa", async () => {
    const e = await escenario({ fondos: false });
    const r = await cambiarMontoFondo(sql, e.dir, e.codigo,
      { lugar: "bolsa_visitas", monto: "300", origen: "entrega_persona", destino: "", detalleOrigen: "Efectivo ficticio de Dirección", motivo: "Fondo provisional" }, PRUEBAS);
    const entradaId = (r as { entradaId: string }).entradaId;
    // Ni quien entrega ni otra recepcionista que no es responsable confirman.
    expect(await confirmarEntradaFondo(sql, e.dir, e.codigo, { entradaId, recibido: "300" }, PRUEBAS)).toEqual({ ok: false, error: "no_puedes" });
    expect(await confirmarEntradaFondo(sql, e.vespertina, e.codigo, { entradaId, recibido: "300" }, PRUEBAS)).toEqual({ ok: false, error: "no_puedes" });
    expect(await confirmarEntradaFondo(sql, e.recepcion, e.codigo, { entradaId, recibido: "250" }, PRUEBAS)).toEqual({ ok: false, error: "no_coincide" });
    expect(await confirmarEntradaFondo(sql, e.recepcion, e.codigo, { entradaId, recibido: "300" }, PRUEBAS)).toEqual({ ok: true });
    const bolsa = (await estadoTurno(sql, e.recepcion, e.codigo))!.turno!.lugares[0];
    expect(bolsa).toMatchObject({ fondos: "300.00", cantidadFondos: 1, esperado: "1200.00" });
    expect(await confirmarEntradaFondo(sql, e.recepcion, e.codigo, { entradaId, recibido: "300" }, PRUEBAS)).toEqual({ ok: false, error: "no_pendiente" });
  });

  it("Dirección y Administración reponen con origen; si entrega la propia responsable, confirma otra persona autorizada", async () => {
    const e = await escenario();
    expect(await registrarReposicion(sql, e.encargado, e.codigo, { lugar: "bolsa_visitas", importe: "50", origen: "Caja chica ficticia" }, PRUEBAS))
      .toEqual({ ok: false, error: "sin_permiso" });
    expect(await registrarReposicion(sql, e.admin, e.codigo, { lugar: "bolsa_visitas", importe: "50", origen: "" }, PRUEBAS)).toEqual({ ok: false, error: "origen" });
    const r = await registrarReposicion(sql, e.admin, e.codigo, { lugar: "bolsa_visitas", importe: "50", origen: "Caja chica ficticia de Administración" }, PRUEBAS);
    expect(r).toMatchObject({ ok: true });
    // Se puede cancelar mientras está pendiente, solo quien la registró.
    expect(await cancelarEntradaFondo(sql, e.dir, e.codigo, { entradaId: (r as { entradaId: string }).entradaId, motivo: "Prueba de cancelación" }, PRUEBAS))
      .toEqual({ ok: false, error: "no_encontrada" });
    expect(await confirmarEntradaFondo(sql, e.recepcion, e.codigo, { entradaId: (r as { entradaId: string }).entradaId, recibido: "50" }, PRUEBAS)).toEqual({ ok: true });

    // Una persona de Administración que además es la responsable en turno entrega y no puede confirmar lo suyo.
    const adminRecepcion = await cuenta([["administracion", e.codigo], ["recepcion", e.codigo]], "Administración y Recepción");
    await sql`update responsable_lugar set usuario_id = ${adminRecepcion} where turno_id = ${e.turnoId} and hasta is null`;
    const x = await registrarReposicion(sql, adminRecepcion, e.codigo, { lugar: "bolsa_visitas", importe: "20", origen: "Caja chica ficticia de Administración" }, PRUEBAS);
    const entradaId = (x as { entradaId: string }).entradaId;
    expect(await confirmarEntradaFondo(sql, adminRecepcion, e.codigo, { entradaId, recibido: "20" }, PRUEBAS)).toEqual({ ok: false, error: "no_puedes" });
    expect(await confirmarEntradaFondo(sql, e.vespertina, e.codigo, { entradaId, recibido: "20" }, PRUEBAS)).toEqual({ ok: false, error: "no_puedes" });
    expect(await confirmarEntradaFondo(sql, e.encargado, e.codigo, { entradaId, recibido: "20" }, PRUEBAS)).toEqual({ ok: true });
    await expect(sql`update entrada_fondo set estado = 'recibida' where id = ${entradaId}`).rejects.toThrow();
  });

  it("al cerrar se cuenta aparte el fondo, primero se completa y solo el excedente va al sobre; fondo + sobre = lo contado", async () => {
    const e = await escenario();
    const sobres = await preparar(e);
    const p = await pantallaCierre(sql, e.recepcion, e.codigo, "pruebas");
    expect(p).toMatchObject({ ok: true, fondos: [{ tipo: "bolsa_visitas", monto: "300.00" }, { tipo: "cajon_mensualidades", monto: "300.00" }] });
    // Bolsa: esperado $1,200 ($900 + $300 del fondo recibido). Cajón: $3,400.
    expect(await cerrarCon(e, { bolsa: "1200", cajon: "3400" }, { bolsa: "200", cajon: "300" })).toEqual({ ok: false, error: "fondo_primero", lugar: "bolsa_visitas" });
    expect(await cerrarCon(e, { bolsa: "1200", cajon: "3400" }, { bolsa: "400", cajon: "300" })).toEqual({ ok: false, error: "fondo", lugar: "bolsa_visitas" });
    expect(await cerrarCon(e, { bolsa: "1200", cajon: "3400" }, { bolsa: "300", cajon: "300" })).toMatchObject({ ok: true, diferenciaEsperado: null });
    const c = (await cierrePendiente(sql, e.sucursalId))!;
    expect(c.sobres.map((s) => s.id)).toEqual(sobres.map((s) => s.id));
    expect(c.fondos).toEqual([{ lugar: "bolsa_visitas", monto: "300.00", tieneSobre: true }, { lugar: "cajon_mensualidades", monto: "300.00", tieneSobre: true }]);
    expect(await separado(c.entregaId)).toEqual([
      { lugar: "bolsa_visitas", momento: "cierre", fondo: "300.00", sobre: "900.00", fondo_monto: "300.00" },
      { lugar: "cajon_mensualidades", momento: "cierre", fondo: "300.00", sobre: "3100.00", fondo_monto: "300.00" },
    ]);
    // La base exige el cuadre y que primero se complete el fondo.
    const [l] = await sql<{ id: string }[]>`select id from lugar_efectivo where sucursal_id = ${e.sucursalId} and tipo = 'bolsa_visitas'`;
    await expect(sql`insert into conteo_fondo (entrega_id, lugar_id, momento, fondo_monto, fondo, sobre, contado_por)
                     values (${c.entregaId}, ${l.id}, 'apertura_inicial', 300, 300, 800, ${e.recepcion})`).rejects.toThrow();
  });

  it("Tenango con fondo: la diferencia de −$50 queda en el sobre del cajón y el turno abre con $3,350; se conservan los conteos separados", async () => {
    const e = await escenario();
    await preparar(e);
    await cerrarCon(e, { bolsa: "1200", cajon: "3400" }, { bolsa: "300", cajon: "300" });
    await custodiar(e);
    const c = (await cierrePendiente(sql, e.sucursalId))!;
    // Conteo a ciegas: la pantalla muestra el monto del fondo, no lo cerrado.
    const p = await pantallaApertura(sql, e.vespertina, e.codigo, "pruebas");
    expect(JSON.stringify(p)).not.toMatch(/3100|3400/);
    expect(await abrir(e, e.vespertina, { bolsa: "1200", cajon: "3350" }, { bolsa: "300", cajon: "300" })).toEqual({ ok: true, resultado: "recuento" });
    const r = await pantallaApertura(sql, e.vespertina, e.codigo, "pruebas");
    expect(r).toMatchObject({ ok: true, recuento: { separado: [
      { lugar: "bolsa_visitas", cerrado: { fondo: "300.00", sobre: "900.00" }, inicial: { fondo: "300.00", sobre: "900.00" } },
      { lugar: "cajon_mensualidades", cerrado: { fondo: "300.00", sobre: "3100.00" }, inicial: { fondo: "300.00", sobre: "3050.00" } },
    ] } });
    // Recuento con el custodio: se conserva el primer conteo y el final también va separado.
    expect(await terminarApertura(sql, e.vespertina, e.codigo,
      { entregaId: c.entregaId, version: (await cierrePendiente(sql, e.sucursalId))!.version, recontaron: true,
        conteo: { bolsa: "1200", cajon: "3350" }, fondos: { bolsa: "300", cajon: "300" }, motivo: "" }, PRUEBAS)).toMatchObject({ ok: true });
    const filas = await separado(c.entregaId);
    expect(filas.filter((f) => f.lugar === "cajon_mensualidades").map((f) => [f.momento, f.fondo, f.sobre])).toEqual([
      ["apertura_final", "300.00", "3050.00"], ["apertura_inicial", "300.00", "3050.00"], ["cierre", "300.00", "3100.00"],
    ]);
    const t = (await estadoTurno(sql, e.vespertina, e.codigo))!.turno!;
    expect(t.lugares.map((l) => l.contadoAlAbrir)).toEqual(["1200.00", "3350.00"]);
    const [d] = await sql<{ importe: string }[]>`select importe::text from diferencia_efectivo where entrega_id = ${c.entregaId} and tipo = 'entre_personas'`;
    expect(d.importe).toBe("-50.00");
  });

  it("fondo incompleto: se registra lo contado, no hay sobre y la diferencia queda por revisar; reponer no la cierra", async () => {
    const e = await escenario();
    const sobres = await preparar(e);
    // En la bolsa solo hay $250 (de un esperado de $1,200).
    expect(await cerrarCon(e, { bolsa: "250", cajon: "3400" }, { bolsa: "250", cajon: "300" })).toMatchObject({ ok: true, diferenciaEsperado: "-950.00" });
    const c = (await cierrePendiente(sql, e.sucursalId))!;
    expect(c.sobres.map((s) => s.lugar)).toEqual(["cajon_mensualidades"]);
    const [cancelado] = await sql<{ estado: string }[]>`select estado from sobre_cierre where id = ${sobres[0].id}`;
    expect(cancelado.estado).toBe("cancelado");
    await custodiar(e);
    expect(await abrir(e, e.vespertina, { bolsa: "250", cajon: "3400" }, { bolsa: "250", cajon: "300" })).toMatchObject({ ok: true, resultado: "abierto" });
    expect(await incidencias(c.entregaId)).toEqual([{ tipo: "fondo_incompleto", revisada: false }]);
    const d = (await detalleDiferencias(sql, e.admin, e.codigo, c.entregaId))!;
    expect(d.incidencias[0].detalle).toMatch(/Fondo de la bolsa de visitas incompleto al cerrar: \$250\.00 contados de \$300\.00/);
    // Reposición de $50: se recibe, pero la incidencia sigue por revisar.
    const r = await registrarReposicion(sql, e.admin, e.codigo, { lugar: "bolsa_visitas", importe: "50", origen: "Caja chica ficticia de Administración" }, PRUEBAS);
    expect(await confirmarEntradaFondo(sql, e.vespertina, e.codigo, { entradaId: (r as { entradaId: string }).entradaId, recibido: "50" }, PRUEBAS)).toEqual({ ok: true });
    expect(await incidencias(c.entregaId)).toEqual([{ tipo: "fondo_incompleto", revisada: false }]);
    expect(await revisarIncidencia(sql, e.admin, e.codigo, { incidenciaId: d.incidencias[0].id, motivo: "Se repuso con caja chica" }, PRUEBAS)).toMatchObject({ ok: true });
  });

  it("la llave: el custodio puede registrar una incidencia con motivo y queda por revisar", async () => {
    const e = await escenario();
    await preparar(e);
    await cerrarCon(e, { bolsa: "1200", cajon: "3400" }, { bolsa: "300", cajon: "300" });
    const c = (await cierrePendiente(sql, e.sucursalId))!;
    expect(await confirmarCustodia(sql, e.encargado, e.codigo,
      { entregaId: c.entregaId, ubicacion: "Caja con llave de la oficina", sobres: correctos(c.sobres), llave: { estado: "incidencia", motivo: "" } }, PRUEBAS))
      .toEqual({ ok: false, error: "motivo_llave" });
    await custodiar(e, { estado: "incidencia", motivo: "El cajón quedó sin llave; la llave no apareció" });
    await abrir(e, e.vespertina, { bolsa: "1200", cajon: "3400" }, { bolsa: "300", cajon: "300" });
    expect(await incidencias(c.entregaId)).toEqual([{ tipo: "llave_custodia", revisada: false }]);
  });

  it("misma persona: con Recepción y Encargado cierra, custodia y abre con una sola cuenta; revisa Administración", async () => {
    const e = await escenario();
    const ambos = await cuenta([["recepcion", e.codigo], ["encargado", e.codigo]], "Encargado y Recepción");
    await sql`update responsable_lugar set usuario_id = ${ambos} where turno_id = ${e.turnoId} and hasta is null`;
    // Una recepcionista sin perfil de Encargado no aparece como custodio de sí misma.
    let p = await pantallaCierre(sql, e.recepcion, e.codigo, "pruebas");
    expect(p).toEqual({ ok: false, error: "no_responsable" });
    p = await pantallaCierre(sql, ambos, e.codigo, "pruebas");
    expect(p.ok && p.custodios.map((x) => x.id).sort()).toEqual([e.encargado, ambos].sort());
    const prep = await prepararCierre(sql, ambos, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
    const sobres = (prep as { sobres: { id: string }[] }).sobres;
    const datos = { turnoId: e.turnoId, conteo: { bolsa: "1200", cajon: "3400" }, fondos: { bolsa: "300", cajon: "300" }, custodio: ambos, nota: "", apoyo: NADIE };
    // Si queda como custodio, confirma la custodia en el mismo cierre.
    expect(await cerrarDia(sql, ambos, e.codigo, datos, PRUEBAS)).toEqual({ ok: false, error: "custodio" });
    const r = await cerrarDia(sql, ambos, e.codigo,
      { ...datos, custodia: { ubicacion: "Caja con llave de la oficina", sobres: correctos(sobres), llave: { estado: "correcta", motivo: "" } } }, PRUEBAS);
    expect(r).toMatchObject({ ok: true });
    const c = (await cierrePendiente(sql, e.sucursalId))!;
    expect(c).toMatchObject({ custodioId: ambos, cerradoPorId: ambos, custodia: { ubicacion: "Caja con llave de la oficina" }, llave: { estado: "correcta" } });
    // También abre ella misma.
    expect(await abrir(e, ambos, { bolsa: "1200", cajon: "3350" }, { bolsa: "300", cajon: "300" })).toEqual({ ok: true, resultado: "recuento" });
    await terminarApertura(sql, ambos, e.codigo,
      { entregaId: c.entregaId, version: (await cierrePendiente(sql, e.sucursalId))!.version, recontaron: false, conteo: null, motivo: "Abrí sola, sin otra persona" }, PRUEBAS);
    const d = (await detalleDiferencias(sql, e.admin, e.codigo, c.entregaId))!;
    expect(d).toMatchObject({ nivel: "administracion", puedeRevisar: true });
    expect(d.historial.map((h) => h.que)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Cierre del día/), expect.stringMatching(/la misma persona cerró, custodió y abrió/i),
    ]));
  });

  it("sin el cajón en la configuración de custodia no se cierra; Dirección debe indicarlo", async () => {
    const e = await escenario();
    await sql`insert into custodia_configuracion (sucursal_id, lugar, acceso, configurada_por, lugar_fondos, acceso_cajon)
              values (${e.sucursalId}, 'Caja con llave de la oficina', ${[e.encargado]}::uuid[], ${e.dir}, 'Cajón con llave', ${[e.encargado]}::uuid[])`;
    await expect(sql`insert into custodia_configuracion (sucursal_id, lugar, acceso, configurada_por)
                     values (${e.sucursalId}, 'Caja con llave de la oficina', ${[e.encargado]}::uuid[], ${e.dir})`).rejects.toThrow(/acceso al cajón/);
    expect(await configurarCustodia(sql, e.dir, e.codigo, { lugar: "Caja con llave", acceso: [e.encargado], lugarFondos: "", accesoCajon: [e.encargado] }, PRUEBAS))
      .toEqual({ ok: false, error: "lugar_fondos" });
    expect(await configurarCustodia(sql, e.dir, e.codigo, { lugar: "Caja con llave", acceso: [e.encargado], lugarFondos: "Cajón con llave", accesoCajon: [] }, PRUEBAS))
      .toEqual({ ok: false, error: "acceso_cajon" });
  });
});

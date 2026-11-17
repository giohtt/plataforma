import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirDesdeCierre, cancelarPreparacionCierre, cerrarDia, cierrePendiente, configurarCustodia, confirmarCustodia, custodiasPorConfirmar,
  pantallaApertura, pantallaCierre, pantallaConfiguracionCustodia, prepararCierre, sobresDelCierre, terminarApertura,
} from "@/lib/cierres";
import { detalleDiferencias, listaDiferencias, pendientesDeRevision, revisarDiferencia, revisarIncidencia } from "@/lib/diferencias";
import { registrarEntrega } from "@/lib/entregas";
import { generarFolio, registrarRetiro } from "@/lib/retiros";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

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
    insert into usuario (nombre, correo, es_prueba) values (${`${nombre} ${n}`}, ${`cierre${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de cierre')`;
  }
  return u.id;
}

/**
 * Sucursal nueva como Tenango: Recepción abre con $200 en la bolsa y $3,400 en el cajón. Dirección define la custodia
 * (caja fuerte, acceso del Encargado) salvo que se pida lo contrario.
 */
async function escenario({ configurar = true } = {}) {
  k++;
  const codigo = `C${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal cierre " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const recepcion = await cuenta([["recepcion", codigo]], "Recepción");
  const vespertina = await cuenta([["recepcion", codigo]], "Recepción vespertina");
  const encargado = await cuenta([["encargado", codigo]], "Encargado");
  const encargada = await cuenta([["encargada_retiros", codigo]], "Encargada de retiros");
  const admin = await cuenta([["administracion", codigo]], "Administración");
  const dir = await cuenta([["direccion", codigo]], "Dirección");
  const t = await abrirTurno(sql, recepcion, codigo, { bolsa: "200.00", cajon: "3400.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  if (configurar) {
    const c = await configurarCustodia(sql, dir, codigo, { lugar: "Caja fuerte de la oficina", acceso: [encargado] }, PRUEBAS);
    if (!c.ok) throw new Error(c.error);
  }
  return { codigo, sucursalId: s.id, recepcion, vespertina, encargado, encargada, admin, dir, turnoId: t.turnoId };
}
type Esc = Awaited<ReturnType<typeof escenario>>;

async function preparar(e: Esc) {
  const p = await prepararCierre(sql, e.recepcion, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
  if (!p.ok) throw new Error(p.error);
  return p.sobres;
}
const cerrarCon = (e: Esc, bolsa: string, cajon: string, extra: Partial<{ custodio: string; nota: string }> = {}) =>
  cerrarDia(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, conteo: { bolsa, cajon }, custodio: extra.custodio ?? e.encargado, nota: extra.nota ?? "", apoyo: NADIE }, PRUEBAS);
/** Prepara y cierra; devuelve el cierre pendiente. */
async function cerrarElDia(e: Esc, bolsa = "200", cajon = "3400") {
  await preparar(e);
  const r = await cerrarCon(e, bolsa, cajon);
  if (!r.ok) throw new Error(r.error);
  return (await cierrePendiente(sql, e.sucursalId))!;
}
const correctos = (sobres: { id: string }[]) => sobres.map((s) => ({ sobreId: s.id, estado: "correcto", folioVisto: "", motivo: "" }));
async function custodiar(e: Esc) {
  const c = (await cierrePendiente(sql, e.sucursalId))!;
  const r = await confirmarCustodia(sql, e.encargado, e.codigo, { entregaId: c.entregaId, ubicacion: "Caja fuerte de la oficina", sobres: correctos(c.sobres) }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
}
async function abrir(e: Esc, quien: string, bolsa: string, cajon: string,
  extra: { sinCustodia?: { motivo: string } | null; sobres?: { sobreId: string; estado: string; folioVisto: string; motivo: string }[] } = {}) {
  const c = (await cierrePendiente(sql, e.sucursalId))!;
  return abrirDesdeCierre(sql, quien, e.codigo, {
    entregaId: c.entregaId, version: c.version, sobres: extra.sobres ?? correctos(c.sobres), conteo: { bolsa, cajon }, apoyo: NADIE,
    sinCustodia: extra.sinCustodia ?? null,
  }, PRUEBAS);
}
const incidencias = (entregaId: string) => sql<{ tipo: string; revisada: boolean }[]>`
  select i.tipo, exists (select 1 from revision_incidencia r where r.incidencia_id = i.id) as revisada
  from incidencia_cierre i where i.entrega_id = ${entregaId} order by i.tipo`;
const hoyLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date()).replaceAll("-", "");
const diferencias = (entregaId: string) => sql<{ tipo: string; lugar: string; importe: string }[]>`
  select d.tipo, l.tipo as lugar, d.importe::text as importe from diferencia_efectivo d
  join lugar_efectivo l on l.id = d.lugar_id where d.entrega_id = ${entregaId} order by l.tipo, d.tipo`;

describe.skipIf(!URL_ADMIN)("cierre del día y custodia nocturna", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("Dirección define lugar y acceso de forma explícita; nadie más la configura y el historial se conserva", async () => {
    const e = await escenario({ configurar: false });
    expect(await pantallaConfiguracionCustodia(sql, e.encargado, e.codigo)).toBeNull();
    expect(await configurarCustodia(sql, e.admin, e.codigo, { lugar: "Caja fuerte", acceso: [e.encargado] }, PRUEBAS))
      .toEqual({ ok: false, error: "sin_permiso" });
    // Sin acceso o con una persona de otra sucursal, no se guarda.
    expect(await configurarCustodia(sql, e.dir, e.codigo, { lugar: "Caja fuerte", acceso: [] }, PRUEBAS)).toEqual({ ok: false, error: "acceso" });
    const ajena = await cuenta([["encargado", "TEN"]], "Encargado ajeno");
    expect(await configurarCustodia(sql, e.dir, e.codigo, { lugar: "Caja fuerte", acceso: [ajena] }, PRUEBAS)).toEqual({ ok: false, error: "acceso" });
    // Sin configuración no se puede cerrar.
    await preparar(e);
    expect(await cerrarCon(e, "200", "3400")).toEqual({ ok: false, error: "sin_configuracion" });
    expect(await configurarCustodia(sql, e.dir, e.codigo, { lugar: "Caja fuerte de la oficina", acceso: [e.encargado] }, PRUEBAS)).toEqual({ ok: true });
    expect(await configurarCustodia(sql, e.dir, e.codigo, { lugar: "Cajón con llave de Dirección", acceso: [e.encargado, e.admin] }, PRUEBAS)).toEqual({ ok: true });
    const p = (await pantallaConfiguracionCustodia(sql, e.dir, e.codigo))!;
    expect(p.vigente).toMatchObject({ lugar: "Cajón con llave de Dirección" });
    expect(p.historial).toHaveLength(2);
    // El cierre guarda la configuración vigente; un cambio posterior no la altera.
    expect(await cerrarCon(e, "200", "3400")).toMatchObject({ ok: true });
    await configurarCustodia(sql, e.dir, e.codigo, { lugar: "Otra caja fuerte", acceso: [e.encargado] }, PRUEBAS);
    expect((await cierrePendiente(sql, e.sucursalId))!.configuracion.lugar).toBe("Cajón con llave de Dirección");
    // La base también lo exige.
    await expect(sql`insert into custodia_configuracion (sucursal_id, lugar, acceso, configurada_por) values (${e.sucursalId}, 'Caja fuerte', ${[e.encargado]}::uuid[], ${e.encargado})`)
      .rejects.toThrow(/Dirección/);
  });

  it("los folios de los sobres se generan antes de cerrar, sin repetirse; cancelar no los reutiliza", async () => {
    const e = await escenario();
    const fecha = hoyLocal();
    const a = await preparar(e);
    expect(a.map((s) => [s.lugar, s.folio])).toEqual([["bolsa_visitas", `${e.codigo}-${fecha}-C1`], ["cajon_mensualidades", `${e.codigo}-${fecha}-C2`]]);
    expect(await preparar(e)).toEqual(a); // doble clic
    expect(await cancelarPreparacionCierre(sql, e.recepcion, e.codigo, { turnoId: e.turnoId }, PRUEBAS)).toEqual({ ok: true, folios: a.map((s) => s.folio) });
    expect((await preparar(e)).map((s) => s.folio)).toEqual([`${e.codigo}-${fecha}-C3`, `${e.codigo}-${fecha}-C4`]);
    expect(await cerrarCon(e, "200", "3400")).toMatchObject({ ok: true });
    const c = (await cierrePendiente(sql, e.sucursalId))!;
    expect(c.sobres.map((s) => s.folio)).toEqual([`${e.codigo}-${fecha}-C3`, `${e.codigo}-${fecha}-C4`]);
    // Otra cuenta no prepara ni cierra el turno de otra persona.
    expect(await prepararCierre(sql, e.vespertina, e.codigo, { turnoId: e.turnoId }, PRUEBAS)).toEqual({ ok: false, error: "sin_turno" });
  });

  it("con un cambio de turno en curso o un retiro en preparación, primero se resuelve; lo pendiente sigue visible", async () => {
    const e = await escenario();
    const f = await generarFolio(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, lugar: "cajon_mensualidades" }, PRUEBAS);
    if (!f.ok) throw new Error(f.error);
    expect(await prepararCierre(sql, e.recepcion, e.codigo, { turnoId: e.turnoId }, PRUEBAS)).toEqual({ ok: false, error: "retiro_en_preparacion" });
    let p = await pantallaCierre(sql, e.recepcion, e.codigo, "pruebas");
    expect(p).toMatchObject({ ok: true, bloqueos: { retiro: true, entrega: false } });
    // Recepción confirma la entrega del retiro: queda pendiente de la Encargada de retiros y ya no bloquea el cierre.
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, folioId: f.folioId, contado: "3000", cambio: "0", encargada: e.encargada }, PRUEBAS))
      .toMatchObject({ ok: true });
    p = await pantallaCierre(sql, e.recepcion, e.codigo, "pruebas");
    expect(p).toMatchObject({ ok: true, bloqueos: { retiro: false }, pendientesVisibles: { retirosPorConfirmar: 1 } });
    // Un cambio de turno en curso también bloquea.
    expect(await registrarEntrega(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "200", cajon: "400" }, recibe: e.vespertina, nota: "", apoyo: NADIE }, PRUEBAS))
      .toMatchObject({ ok: true });
    expect(await prepararCierre(sql, e.recepcion, e.codigo, { turnoId: e.turnoId }, PRUEBAS)).toEqual({ ok: false, error: "entrega_en_curso" });
  });

  it("cierre y apertura que coinciden: la misma persona puede abrir, el historial lo muestra y no hay diferencias", async () => {
    const e = await escenario();
    const c = await cerrarElDia(e);
    // Turno cerrado: sin retiros durante la noche ni aperturas desde cero.
    expect((await estadoTurno(sql, e.recepcion, e.codigo))!.turno).toBeNull();
    expect(await generarFolio(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, lugar: "cajon_mensualidades" }, PRUEBAS))
      .toMatchObject({ ok: false });
    expect(await abrirTurno(sql, e.recepcion, e.codigo, { bolsa: "200", cajon: "3400" }, PRUEBAS)).toEqual({ ok: false, error: "cierre_pendiente" });
    // El custodio confirma desde su cuenta; otra persona no ve la custodia.
    expect((await custodiasPorConfirmar(sql, e.encargado, e.codigo))!.cierre).toMatchObject({ entregaId: c.entregaId });
    expect(await custodiasPorConfirmar(sql, e.recepcion, e.codigo)).toBeNull();
    await custodiar(e);
    // A ciegas: la pantalla de apertura no muestra lo cerrado.
    const p = await pantallaApertura(sql, e.recepcion, e.codigo, "pruebas");
    expect(p).toMatchObject({ ok: true, recuento: null });
    expect(JSON.stringify(p)).not.toMatch(/3400/);
    const r = await abrir(e, e.recepcion, "200", "3400");
    expect(r).toMatchObject({ ok: true, resultado: "abierto" });
    const t = (await estadoTurno(sql, e.recepcion, e.codigo))!.turno!;
    expect(t.lugares.map((l) => l.contadoAlAbrir)).toEqual(["200.00", "3400.00"]);
    expect(await diferencias(c.entregaId)).toEqual([]);
    const [h] = await sql<{ misma: boolean }[]>`
      select (cambios->>'misma_persona')::boolean as misma from historial_cambio where entidad_id = ${c.entregaId} and accion = 'abrir_conteo'`;
    expect(h.misma).toBe(true);
  });

  it("Tenango: cierre con $3,400 en el cajón, abre con $3,350 sin recuento; motivo obligatorio y revisa Administración", async () => {
    const e = await escenario();
    const c = await cerrarElDia(e, "200", "3400");
    await custodiar(e);
    expect(await abrir(e, e.vespertina, "200", "3350")).toEqual({ ok: true, resultado: "recuento" });
    // En recuento ya se muestran los dos conteos; solo quien empezó a abrir continúa.
    const p = await pantallaApertura(sql, e.vespertina, e.codigo, "pruebas");
    expect(p).toMatchObject({ ok: true, recuento: { cerrado: { cajon: "3400.00" }, inicial: { cajon: "3350.00" } } });
    expect(await pantallaApertura(sql, e.recepcion, e.codigo, "pruebas")).toEqual({ ok: false, error: "otra_persona" });
    const v = (await cierrePendiente(sql, e.sucursalId))!.version;
    expect(await terminarApertura(sql, e.vespertina, e.codigo, { entregaId: c.entregaId, version: v, recontaron: false, conteo: null, motivo: "" }, PRUEBAS))
      .toEqual({ ok: false, error: "motivo" });
    const r = await terminarApertura(sql, e.vespertina, e.codigo,
      { entregaId: c.entregaId, version: v, recontaron: false, conteo: null, motivo: "El Encargado no estaba para recontar" }, PRUEBAS);
    expect(r).toMatchObject({ ok: true });
    const t = (await estadoTurno(sql, e.vespertina, e.codigo))!.turno!;
    expect(t.lugares.map((l) => l.contadoAlAbrir)).toEqual(["200.00", "3350.00"]);
    expect(await diferencias(c.entregaId)).toEqual([{ tipo: "entre_personas", lugar: "cajon_mensualidades", importe: "-50.00" }]);
    // El Encargado fue custodio: revisa Administración; el Encargado no.
    const d = (await detalleDiferencias(sql, e.admin, e.codigo, c.entregaId))!;
    expect(d).toMatchObject({ nivel: "administracion", puedeRevisar: true, tipo: "cierre", aclaracion: "El Encargado no estaba para recontar" });
    expect(d.cierre).toMatchObject({
      configuracion: { lugar: "Caja fuerte de la oficina" }, custodia: { ubicacion: "Caja fuerte de la oficina" },
      mismaPersona: false, recontadoConCustodio: false,
    });
    expect(d.cierre!.sobres.map((x) => [x.custodia?.estado, x.apertura?.estado])).toEqual([["correcto", "correcto"], ["correcto", "correcto"]]);
    expect(d.historial.map((h) => h.que)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Cierre del día/), expect.stringMatching(/^Custodia confirmada/),
      expect.stringMatching(/no coincidió con el cierre/), expect.stringMatching(/sin recuento con el custodio\. Motivo/),
    ]));
    const dif = d.diferencias[0];
    expect(await revisarDiferencia(sql, e.encargado, e.codigo, { diferenciaId: dif.id, resultado: "aclarada", motivo: "Revisión de prueba" }, PRUEBAS))
      .toMatchObject({ ok: false });
    expect((await listaDiferencias(sql, e.admin, e.codigo))!.casos.some((x) => x.entregaId === c.entregaId)).toBe(true);
  });

  it("si recontaron con el custodio, se conservan los dos conteos y quién participó", async () => {
    const e = await escenario();
    const c = await cerrarElDia(e, "200", "3400");
    await custodiar(e);
    await abrir(e, e.vespertina, "200", "3350");
    const v = (await cierrePendiente(sql, e.sucursalId))!.version;
    expect(await terminarApertura(sql, e.vespertina, e.codigo,
      { entregaId: c.entregaId, version: v, recontaron: true, conteo: { bolsa: "200", cajon: "3400" }, motivo: "" }, PRUEBAS)).toMatchObject({ ok: true });
    const conteos = await sql<{ tipo: string; importe: string }[]>`
      select c.tipo, c.importe::text as importe from entrega_conteo c join lugar_efectivo l on l.id = c.lugar_id
      where c.entrega_id = ${c.entregaId} and l.tipo = 'cajon_mensualidades' order by c.tipo`;
    expect(conteos).toEqual([
      { tipo: "entregado", importe: "3400.00" }, { tipo: "recibido_final", importe: "3400.00" }, { tipo: "recibido_inicial", importe: "3350.00" },
    ]);
    const [x] = await sql`select recontado_con, recibe from entrega_turno where id = ${c.entregaId}`;
    expect(x).toEqual({ recontado_con: e.encargado, recibe: e.vespertina });
    expect(await diferencias(c.entregaId)).toEqual([]);
  });

  it("la bolsa distinta del esperado deja constancia al cerrar y se vincula a la diferencia del retiro, sin duplicarla", async () => {
    const e = await escenario();
    // Al retirar la bolsa se contaron $150 de $200 esperados: diferencia de -$50 registrada en el retiro.
    const f = await generarFolio(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, lugar: "bolsa_visitas" }, PRUEBAS);
    if (!f.ok) throw new Error(f.error);
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, folioId: f.folioId, contado: "150", cambio: "0", encargada: e.encargada }, PRUEBAS))
      .toMatchObject({ ok: true });
    await preparar(e);
    const r = await cerrarCon(e, "0", "3400");
    expect(r).toMatchObject({ ok: true, diferenciaEsperado: "-50.00" });
    const c = (await cierrePendiente(sql, e.sucursalId))!;
    const [k] = await sql`select importe::text, esperado::text from entrega_conteo where entrega_id = ${c.entregaId} and tipo = 'entregado' and esperado is not null`;
    expect(k).toEqual({ importe: "0.00", esperado: "50.00" });
    await custodiar(e);
    expect(await abrir(e, e.recepcion, "0", "3400")).toMatchObject({ ok: true, resultado: "abierto" });
    expect(await diferencias(c.entregaId)).toEqual([{ tipo: "contra_esperado", lugar: "bolsa_visitas", importe: "-50.00" }]);
    const [v] = await sql`select presente::text from diferencia_retiro_entrega where entrega_id = ${c.entregaId}`;
    expect(v).toEqual({ presente: "-50.00" });
  });

  it("el custodio verifica sello y folio: una incidencia lleva motivo y queda en el cierre; solo una vez y antes de abrir", async () => {
    const e = await escenario();
    const c = await cerrarElDia(e);
    const [bolsa, cajon] = c.sobres;
    const base = { entregaId: c.entregaId, ubicacion: "Caja fuerte de la oficina" };
    expect(await confirmarCustodia(sql, e.encargado, e.codigo, { ...base, sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "" },
      { sobreId: cajon.id, estado: "otro_folio", folioVisto: "", motivo: "Trae otro folio escrito" },
    ] }, PRUEBAS)).toMatchObject({ ok: false, error: "folio_visto" });
    expect(await confirmarCustodia(sql, e.encargado, e.codigo, { ...base, sobres: [
      { sobreId: bolsa.id, estado: "abierto", folioVisto: "", motivo: "" }, { sobreId: cajon.id, estado: "correcto", folioVisto: "", motivo: "" },
    ] }, PRUEBAS)).toMatchObject({ ok: false, error: "motivo" });
    // Otra cuenta no confirma la custodia.
    expect(await confirmarCustodia(sql, e.admin, e.codigo, { ...base, sobres: correctos(c.sobres) }, PRUEBAS)).toMatchObject({ ok: false, error: "no_encontrada" });
    expect(await confirmarCustodia(sql, e.encargado, e.codigo, { ...base, sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "" },
      { sobreId: cajon.id, estado: "otro_folio", folioVisto: "ten-20261116-c9", motivo: "Trae otro folio escrito" },
    ] }, PRUEBAS)).toEqual({ ok: true, incidencias: 1 });
    expect(await confirmarCustodia(sql, e.encargado, e.codigo, { ...base, sobres: correctos(c.sobres) }, PRUEBAS)).toMatchObject({ ok: false, error: "ya_confirmada" });
    const s = await sobresDelCierre(sql, c.entregaId);
    expect(s[1].custodia).toMatchObject({ estado: "otro_folio", folioVisto: "TEN-20261116-C9" });
    // La base exige que verifique el custodio.
    await expect(sql`insert into verificacion_sobre (sobre_id, momento, estado, verificado_por) values (${bolsa.id}, 'apertura', 'correcto', ${e.admin})`)
      .rejects.toThrow(/quien abre/);
  });

  it("custodia sin confirmar: primero confirma el custodio; si no está disponible, se abre con motivo y queda por revisar", async () => {
    const e = await escenario();
    const c = await cerrarElDia(e);
    // Sin decir que el custodio no está disponible, no se abre: que confirme primero.
    expect(await abrir(e, e.vespertina, "200", "3400")).toEqual({ ok: false, error: "custodia_pendiente" });
    expect(await abrir(e, e.vespertina, "200", "3400", { sinCustodia: { motivo: "" } })).toEqual({ ok: false, error: "motivo_custodia" });
    expect((await cierrePendiente(sql, e.sucursalId))!.abreId).toBeNull();
    // No está disponible: abre con motivo, aunque el efectivo cuadre la falta de confirmación queda por revisar.
    expect(await abrir(e, e.vespertina, "200", "3400", { sinCustodia: { motivo: "El Encargado no llegó; no contesta el teléfono" } }))
      .toMatchObject({ ok: true, resultado: "abierto" });
    expect(await diferencias(c.entregaId)).toEqual([]);
    expect(await incidencias(c.entregaId)).toEqual([{ tipo: "custodia_sin_confirmar", revisada: false }]);
    // Ya no se confirma la custodia, ni en el servidor ni en la base.
    expect(await confirmarCustodia(sql, e.encargado, e.codigo, { entregaId: c.entregaId, ubicacion: "Caja fuerte de la oficina", sobres: correctos(c.sobres) }, PRUEBAS))
      .toMatchObject({ ok: false, error: "ya_abierto" });
    await expect(sql`insert into custodia_cierre (entrega_id, custodio_id, ubicacion) values (${c.entregaId}, ${e.encargado}, 'Caja fuerte de la oficina')`)
      .rejects.toThrow(/antes de abrir/);
    // Visible para revisión: cuenta como pendiente y la revisa Administración (el Encargado fue custodio).
    expect(await pendientesDeRevision(sql, e.admin, e.sucursalId)).toBe(1);
    const caso = (await listaDiferencias(sql, e.admin, e.codigo))!.casos.find((x) => x.entregaId === c.entregaId)!;
    expect(caso).toMatchObject({ pendientes: 1, incidencias: [{ tipo: "custodia_sin_confirmar", revision: null }] });
    const d = (await detalleDiferencias(sql, e.admin, e.codigo, c.entregaId))!;
    expect(d.incidencias[0].detalle).toMatch(/sin la confirmación del custodio. Motivo: «El Encargado no llegó/);
    expect(d.historial.map((h) => h.que)).toEqual(expect.arrayContaining([expect.stringMatching(/^Incidencia por revisar: Se abrió sin la confirmación/)]));
    const id = d.incidencias[0].id;
    expect(await revisarIncidencia(sql, e.encargado, e.codigo, { incidenciaId: id, motivo: "Revisión de prueba" }, PRUEBAS)).toEqual({ ok: false, error: "participaste" });
    expect(await revisarIncidencia(sql, e.admin, e.codigo, { incidenciaId: id, motivo: "" }, PRUEBAS)).toEqual({ ok: false, error: "motivo" });
    expect(await revisarIncidencia(sql, e.admin, e.codigo, { incidenciaId: id, motivo: "El Encargado confirmó por teléfono que no pudo llegar" }, PRUEBAS))
      .toEqual({ ok: true, entregaId: c.entregaId });
    expect(await incidencias(c.entregaId)).toEqual([{ tipo: "custodia_sin_confirmar", revisada: true }]);
    expect(await pendientesDeRevision(sql, e.admin, e.sucursalId)).toBe(0);
  });

  it("si el custodio confirma antes de abrir, no se pide motivo ni queda incidencia", async () => {
    const e = await escenario();
    const c = await cerrarElDia(e);
    await custodiar(e);
    expect(await abrir(e, e.vespertina, "200", "3400")).toMatchObject({ ok: true, resultado: "abierto" });
    expect(await incidencias(c.entregaId)).toEqual([]);
    await expect(sql`insert into apertura_sin_custodia (entrega_id, motivo, registrada_por) values (${c.entregaId}, 'Motivo de prueba', ${e.vespertina})`)
      .rejects.toThrow(/Solo quien abre/);
  });

  it("una incidencia de sello o folio queda por revisar aunque el efectivo cuadre", async () => {
    const e = await escenario();
    const c = await cerrarElDia(e);
    const [bolsa, cajon] = c.sobres;
    // El custodio ve otro folio en el sobre del cajón.
    expect(await confirmarCustodia(sql, e.encargado, e.codigo, { entregaId: c.entregaId, ubicacion: "Caja fuerte de la oficina", sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "" },
      { sobreId: cajon.id, estado: "otro_folio", folioVisto: "TEN-20261116-C9", motivo: "El folio escrito no es el generado" },
    ] }, PRUEBAS)).toEqual({ ok: true, incidencias: 1 });
    // Quien abre encuentra la bolsa con el sello roto, pero el efectivo cuadra en ambos lugares.
    expect(await abrir(e, e.vespertina, "200", "3400", { sobres: [
      { sobreId: bolsa.id, estado: "abierto", folioVisto: "", motivo: "La cinta del sello está despegada" },
      { sobreId: cajon.id, estado: "correcto", folioVisto: "", motivo: "" },
    ] })).toMatchObject({ ok: true, resultado: "abierto" });
    expect(await diferencias(c.entregaId)).toEqual([]);
    expect(await incidencias(c.entregaId)).toEqual([{ tipo: "sobre_al_abrir", revisada: false }, { tipo: "sobre_en_custodia", revisada: false }]);
    const d = (await detalleDiferencias(sql, e.admin, e.codigo, c.entregaId))!;
    expect(d.incidencias.map((i) => i.detalle)).toEqual([
      expect.stringMatching(/^Custodia \(.*\): sobre .*-C2 con otro folio \(TEN-20261116-C9\)\. Motivo: «El folio escrito no es el generado»$/),
      expect.stringMatching(/^Al abrir \(.*\): sobre .*-C1 abierto o con el sello roto\. Motivo: «La cinta del sello está despegada»$/),
    ]);
    const caso = (await listaDiferencias(sql, e.admin, e.codigo))!.casos.find((x) => x.entregaId === c.entregaId)!;
    expect(caso.pendientes).toBe(2);
    // Quien abrió participó: no revisa. La base también lo impide.
    await expect(sql`insert into revision_incidencia (incidencia_id, motivo, nivel, revisada_por) values (${d.incidencias[0].id}, 'Revisión de prueba', 'administracion', ${e.vespertina})`)
      .rejects.toThrow(/participó/);
    for (const i of d.incidencias) {
      expect(await revisarIncidencia(sql, e.admin, e.codigo, { incidenciaId: i.id, motivo: "Se verificó el sobre con la cámara" }, PRUEBAS)).toMatchObject({ ok: true });
    }
    expect(await incidencias(c.entregaId)).toEqual([{ tipo: "sobre_al_abrir", revisada: true }, { tipo: "sobre_en_custodia", revisada: true }]);
  });

  it("el custodio no puede ser quien cierra y debe ser Encargado de la sucursal", async () => {
    const e = await escenario();
    await preparar(e);
    expect(await cerrarCon(e, "200", "3400", { custodio: e.admin })).toEqual({ ok: false, error: "custodio" });
    expect(await cerrarCon(e, "200", "3400", { custodio: e.recepcion })).toEqual({ ok: false, error: "custodio" });
  });

  it("en producción todo queda bloqueado", async () => {
    const e = await escenario();
    const PROD = { entorno: "produccion" as const };
    expect(await prepararCierre(sql, e.recepcion, e.codigo, { turnoId: e.turnoId }, PROD)).toEqual({ ok: false, error: "bloqueado_produccion" });
    expect(await configurarCustodia(sql, e.dir, e.codigo, { lugar: "Caja fuerte", acceso: [e.encargado] }, PROD)).toEqual({ ok: false, error: "bloqueado_produccion" });
    expect(await pantallaCierre(sql, e.recepcion, e.codigo, "produccion")).toEqual({ ok: false, error: "bloqueado_produccion" });
  });
});

import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirDesdeCierre, cerrarDia, cierrePendiente, configurarCustodia, confirmarCustodia, custodiasPorConfirmar, infoBuzon, pantallaApertura,
  pantallaCierre, prepararCierre, sobresEnCaja,
} from "@/lib/cierres";
import { pantallaRecepcion, recibirTurno, registrarEntrega } from "@/lib/entregas";
import { cambiarMontoFondo, confirmarEntradaFondo } from "@/lib/fondos";
import {
  accesoRecoleccion, pantallaRecoleccion, recogerBuzon, registrarDepositoRecoleccion, registrarEntregaSobres, resumenCaja, revisarDiferenciaSobre,
  revisarIncidenciaLlave,
} from "@/lib/recolecciones";
import { abrirTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 5, regla 7 (18 nov 2026, 19:10): buzón de depósito con llave solo de Dirección. Dos sobres al día, sellados al
 * cerrar; al abrir se cuentan solo los fondos; en el cambio de turno se cuenta todo el efectivo. Solo datos ficticios.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;
let k = 0;
const PRUEBAS = { entorno: "pruebas" as const };
const NADIE = { hubo: false as const };
const LLAVE = { estado: "correcta", motivo: "" };

async function cuenta(asignaciones: [string, string][], nombre: string) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${`${nombre} ${n}`}, ${`buzon${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba del buzón')`;
  }
  return u.id;
}

/** Sucursal como Tenango con buzón: fondos de $300 y $300; la vespertina abre con $720 y $3,350. */
async function escenario() {
  k++;
  const codigo = `B${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal buzón " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const matutina = await cuenta([["recepcion", codigo]], "Recepción matutina");
  const vespertina = await cuenta([["recepcion", codigo]], "Recepción vespertina");
  const admin = await cuenta([["administracion", codigo]], "Administración");
  const dir = await cuenta([["direccion", codigo]], "Dirección");
  const dir2 = await cuenta([["direccion", codigo]], "Dirección sin llave");
  const t = await abrirTurno(sql, vespertina, codigo, { bolsa: "420.00", cajon: "3050.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const c = await configurarCustodia(sql, dir, codigo, {
    lugar: "Buzón de recepción", acceso: [dir], lugarFondos: "Cajón con llave de recepción",
    accesoCajon: [matutina, vespertina], custodias: [matutina, vespertina], buzon: true,
  }, PRUEBAS);
  if (!c.ok) throw new Error(c.error);
  for (const lugar of ["bolsa_visitas", "cajon_mensualidades"]) {
    const r = await cambiarMontoFondo(sql, dir, codigo,
      { lugar, monto: "300", origen: "entrega_persona", destino: "", detalleOrigen: "Efectivo ficticio de Dirección", motivo: "Fondo provisional" }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const x = await confirmarEntradaFondo(sql, vespertina, codigo, { entradaId: r.entradaId!, recibido: "300" }, PRUEBAS);
    if (!x.ok) throw new Error(x.error);
  }
  return { codigo, sucursalId: s.id, matutina, vespertina, admin, dir, dir2, turnoId: t.turnoId };
}
type Esc = Awaited<ReturnType<typeof escenario>>;


/** Cierra «Yo»: deposita en el buzón los sobres con excedente y se queda con la llave del cajón. */
async function cerrarYo(e: Esc, quien: string, conteo = { bolsa: "720", cajon: "3350" }) {
  const p = await prepararCierre(sql, quien, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
  if (!p.ok) throw new Error(p.error);
  const usados = p.sobres.filter((s) => (s.lugar === "bolsa_visitas" ? conteo.bolsa : conteo.cajon) !== "300");
  const r = await cerrarDia(sql, quien, e.codigo, {
    turnoId: e.turnoId, conteo, fondos: { bolsa: "300", cajon: "300" }, custodio: quien, nota: "", apoyo: NADIE,
    custodia: { ubicacion: "Llavero de recepción", sobres: [], llave: LLAVE }, depositados: usados.map((s) => s.id),
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return { ...r, sobres: p.sobres, usados };
}
async function abrir(e: Esc, quien: string, llave: { estado: string; motivo: string } | undefined = LLAVE) {
  const c = (await cierrePendiente(sql, e.sucursalId))!;
  const r = await abrirDesdeCierre(sql, quien, e.codigo, {
    entregaId: c.entregaId, version: c.version, sobres: [], conteo: { bolsa: "300", cajon: "300" }, apoyo: NADIE, llave,
  }, PRUEBAS);
  if (r.ok && r.resultado === "abierto") e.turnoId = r.turnoId;
  return r;
}
async function envejecer(folios: string[], dias: number) {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sobre_cierre set resuelto_en = resuelto_en - make_interval(days => ${dias}) where folio in ${tx(folios)}`;
  });
}

describe.skipIf(!URL_ADMIN)("buzón de depósito con llave solo de Dirección", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("la llave del buzón es solo de Dirección, nombrada de forma explícita (también en la base)", async () => {
    const e = await escenario();
    const base = { lugar: "Buzón", lugarFondos: "Cajón con llave", accesoCajon: [e.matutina], custodias: [e.matutina], buzon: true };
    expect(await configurarCustodia(sql, e.dir, e.codigo, { ...base, acceso: [e.dir, e.matutina] }, PRUEBAS)).toEqual({ ok: false, error: "acceso_buzon" });
    expect(await configurarCustodia(sql, e.dir, e.codigo, { ...base, acceso: [] }, PRUEBAS)).toEqual({ ok: false, error: "acceso" });
    await expect(sql`insert into custodia_configuracion (sucursal_id, lugar, acceso, configurada_por, lugar_fondos, acceso_cajon, custodias, buzon)
                     values (${e.sucursalId}, 'Buzón', ${[e.vespertina]}::uuid[], ${e.dir}, 'Cajón', ${[e.matutina]}::uuid[], ${[e.matutina]}::uuid[], true)`)
      .rejects.toThrow(/solo de Dirección/);
    const p = await pantallaCierre(sql, e.vespertina, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.buzon).toMatchObject({ lugar: "Buzón de recepción", sobres: 0, llave: [{ id: e.dir }] });
  });

  it("al cerrar, cada sobre se deposita en el buzón; sin excedente no hay sobre; la custodia guarda solo la llave del cajón", async () => {
    const e = await escenario();
    const p = await prepararCierre(sql, e.vespertina, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
    if (!p.ok) throw new Error(p.error);
    const datos = {
      turnoId: e.turnoId, conteo: { bolsa: "300", cajon: "3350" }, fondos: { bolsa: "300", cajon: "300" }, custodio: e.vespertina, nota: "", apoyo: NADIE,
      custodia: { ubicacion: "Llavero de recepción", sobres: [], llave: LLAVE },
    };
    const cajon = p.sobres.find((s) => s.lugar === "cajon_mensualidades")!;
    const bolsa = p.sobres.find((s) => s.lugar === "bolsa_visitas")!;
    // Hay que confirmar el depósito de cada sobre usado, y solo de esos (la bolsa no tiene excedente).
    expect(await cerrarDia(sql, e.vespertina, e.codigo, datos, PRUEBAS)).toEqual({ ok: false, error: "depositados" });
    expect(await cerrarDia(sql, e.vespertina, e.codigo, { ...datos, depositados: [cajon.id, bolsa.id] }, PRUEBAS)).toEqual({ ok: false, error: "depositados" });
    // Sin la llave del cajón no cierra; la de la caja de sobres ya no se pide.
    expect(await cerrarDia(sql, e.vespertina, e.codigo, { ...datos, custodia: { ...datos.custodia, llave: { estado: "", motivo: "" } }, depositados: [cajon.id] }, PRUEBAS))
      .toEqual({ ok: false, error: "motivo_llave" });
    const r = await cerrarDia(sql, e.vespertina, e.codigo, { ...datos, depositados: [cajon.id] }, PRUEBAS);
    expect(r).toMatchObject({ ok: true });
    const sobres = await sql<{ folio: string; estado: string; importe: string | null; depositado: string | null }[]>`
      select s.folio, s.estado, s.importe::text as importe, d.depositado_por as depositado
      from sobre_cierre s left join sobre_depositado d on d.sobre_id = s.id where s.turno_id = ${e.turnoId} order by s.folio`;
    expect(sobres).toEqual([
      { folio: bolsa.folio, estado: "cancelado", importe: null, depositado: null },
      { folio: cajon.folio, estado: "usado", importe: "3050.00", depositado: e.vespertina },
    ]);
    const [rev] = await sql<{ momento: string; llave: string | null; llave_cajon: string; filas: number }[]>`
      select r.momento, r.llave, r.llave_cajon, (select count(*)::int from verificacion_sobre v where v.revision_id = r.id) as filas
      from revision_caja r where r.sucursal_id = ${e.sucursalId}`;
    expect(rev).toEqual({ momento: "cierre", llave: null, llave_cajon: "correcta", filas: 0 });
    expect((await infoBuzon(sql, e.sucursalId))).toMatchObject({ sobres: 1, conAviso: 0, masAntiguo: 0 });
  });

  it("si cierra otra custodia, confirma solo la llave del cajón (sin verificar sobres)", async () => {
    const e = await escenario();
    const p = await prepararCierre(sql, e.vespertina, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
    if (!p.ok) throw new Error(p.error);
    const r = await cerrarDia(sql, e.vespertina, e.codigo, {
      turnoId: e.turnoId, conteo: { bolsa: "720", cajon: "3350" }, fondos: { bolsa: "300", cajon: "300" }, custodio: e.matutina, nota: "", apoyo: NADIE,
      depositados: p.sobres.map((s) => s.id),
    }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const c = await custodiasPorConfirmar(sql, e.matutina, e.codigo);
    expect(c!.cierre!.buzon).toBe(true);
    expect(c!.caja).toEqual([]);
    expect(await confirmarCustodia(sql, e.matutina, e.codigo, { entregaId: r.entregaId, ubicacion: "Llavero", sobres: [], llave: { estado: "", motivo: "" } }, PRUEBAS))
      .toEqual({ ok: false, error: "motivo_llave" });
    expect(await confirmarCustodia(sql, e.matutina, e.codigo, { entregaId: r.entregaId, ubicacion: "Llavero de recepción", sobres: [], llave: LLAVE }, PRUEBAS))
      .toEqual({ ok: true, incidencias: 0 });
  });

  it("al abrir se cuentan solo los fondos y se recibe la llave del cajón; los sobres siguen registrados en el buzón", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    const p = await pantallaApertura(sql, e.matutina, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.cierre.buzon).toBe(true);
    expect(p.caja).toEqual([]);
    expect(p.buzon).toMatchObject({ sobres: 2 });
    expect(await abrir(e, e.matutina, { estado: "", motivo: "" })).toEqual({ ok: false, error: "motivo_llave" });
    expect(await abrir(e, e.matutina)).toMatchObject({ ok: true, resultado: "abierto" });
    const revs = await sql<{ momento: string; llave: string | null; llave_cajon: string; custodio_id: string }[]>`
      select momento, llave, llave_cajon, custodio_id from revision_caja where entrega_id = ${c.entregaId} order by en`;
    expect(revs).toEqual([
      { momento: "cierre", llave: null, llave_cajon: "correcta", custodio_id: e.vespertina },
      { momento: "apertura", llave: null, llave_cajon: "correcta", custodio_id: e.matutina },
    ]);
    expect((await sobresEnCaja(sql, e.sucursalId)).map((s) => s.folio)).toEqual(c.usados.map((s) => s.folio));
  });

  it("en el cambio de turno se cuenta todo el efectivo y pasa solo la llave del cajón; el buzón no se verifica", async () => {
    const e = await escenario();
    await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const ent = await registrarEntrega(sql, e.matutina, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "300", cajon: "300" }, recibe: e.vespertina, nota: "", apoyo: NADIE }, PRUEBAS);
    if (!ent.ok) throw new Error(ent.error);
    const pr = await pantallaRecepcion(sql, e.vespertina, e.codigo, "pruebas");
    if (!pr.ok) throw new Error(pr.error);
    expect(pr.caja).toBeNull();
    expect(pr.buzon).toMatchObject({ sobres: 2 });
    const [x] = await sql<{ version: number }[]>`select version from entrega_turno where id = ${ent.entregaId}`;
    const datos = { entregaId: ent.entregaId, version: x.version, conteo: { bolsa: "300", cajon: "300" }, aclaracion: "", apoyo: NADIE };
    expect(await recibirTurno(sql, e.vespertina, e.codigo, datos, PRUEBAS)).toEqual({ ok: false, error: "motivo_llave" });
    expect(await recibirTurno(sql, e.vespertina, e.codigo, { ...datos, caja: { sobres: [], llaveCajon: LLAVE } }, PRUEBAS))
      .toMatchObject({ ok: true, resultado: "confirmada" });
    const [rev] = await sql<{ momento: string; llave: string | null; llave_cajon: string }[]>`
      select momento, llave, llave_cajon from revision_caja where entrega_id = ${ent.entregaId}`;
    expect(rev).toEqual({ momento: "cambio_turno", llave: null, llave_cajon: "correcta" });
  });

  it("solo Dirección con la llave recoge, a ciegas; un sobre que no está queda por investigar sin responsable y no suma", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    const [bolsa, cajon] = c.usados;
    // Con buzón ya no hay entrega de la responsable en turno.
    await abrir(e, e.matutina);
    expect(await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: [bolsa.id], recibe: e.dir }, PRUEBAS)).toEqual({ ok: false, error: "buzon" });
    const conteo = [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "", contado: "400" },
      { sobreId: cajon.id, estado: "falta", folioVisto: "", motivo: "No estaba en el buzón", contado: "" },
    ];
    expect(await recogerBuzon(sql, e.dir2, e.codigo, { sobres: conteo, llave: LLAVE }, PRUEBAS)).toEqual({ ok: false, error: "sin_llave_buzon" });
    expect(await recogerBuzon(sql, e.matutina, e.codigo, { sobres: conteo, llave: LLAVE }, PRUEBAS)).toEqual({ ok: false, error: "sin_llave_buzon" });
    // Dirección no ve lo anotado antes de contar; la recepcionista sí.
    const vista = await pantallaRecoleccion(sql, e.dir, e.codigo, "pruebas");
    if (!vista.ok) throw new Error(vista.error);
    expect(vista.puedeRecogerBuzon).toBe(true);
    expect(vista.caja.map((s) => s.importe)).toEqual([null, null]);
    expect((await accesoRecoleccion(sql, e.dir, e.sucursalId))).toMatchObject({ porRecoger: 2, buzon: true });
    expect((await accesoRecoleccion(sql, e.dir2, e.sucursalId))).toMatchObject({ porRecoger: 0 });
    // Hay que indicar la llave del buzón y verificar todos los sobres registrados.
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: conteo }, PRUEBAS)).toEqual({ ok: false, error: "motivo_llave" });
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: conteo.slice(0, 1), llave: LLAVE }, PRUEBAS)).toEqual({ ok: false, error: "cambio" });
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: [{ ...conteo[0], contado: "" }, conteo[1]], llave: LLAVE }, PRUEBAS))
      .toEqual({ ok: false, error: "contado", sobreId: bolsa.id });

    const r = await recogerBuzon(sql, e.dir, e.codigo, { sobres: conteo, llave: LLAVE }, PRUEBAS);
    expect(r).toEqual({ ok: true, recogido: "400.00", diferencias: 1, investigar: 1 });
    expect(await sobresEnCaja(sql, e.sucursalId)).toEqual([]);
    const estados = await sql<{ folio: string; estado: string }[]>`select folio, estado from sobre_cierre where id in ${sql([bolsa.id, cajon.id])} order by folio`;
    expect(estados.map((x) => x.estado)).toEqual(["recogido", "usado"]);
    const p = await pantallaRecoleccion(sql, e.dir, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.recolecciones[0]).toMatchObject({ buzon: true, entregaPor: null, recogido: "400.00", saldo: "400.00" });
    expect(p.recolecciones[0].sobres.map((s) => s.contado)).toEqual(["400.00", null]);
    expect(p.investigaciones).toHaveLength(1);
    expect(p.investigaciones[0]).toMatchObject({ folio: cajon.folio, anotado: "3050.00", motivo: "No estaba en el buzón" });
    expect(p.investigaciones[0].cadena.map((x) => x.momento)).toContain("Registró que lo depositó en el buzón");
    // Sin responsable asignado: la investigación no guarda a nadie como responsable del faltante.
    const cols = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'investigacion_sobre'`;
    expect(cols.map((x) => x.column_name).sort()).toEqual(["creada_en", "id", "recoleccion_id", "sobre_id", "verificacion_id"]);
    expect((await resumenCaja(sql, e.sucursalId))).toMatchObject({ sobres: 0, porInvestigar: 1, buzon: true });
    // El sobre por investigar no se vuelve a recoger ni se suma: el buzón queda vacío.
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: [conteo[1]], llave: LLAVE }, PRUEBAS)).toEqual({ ok: false, error: "buzon_vacio" });

    // Depósitos parciales: nunca más de lo recogido.
    const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
    const rid = p.recolecciones[0].id;
    expect(await registrarDepositoRecoleccion(sql, e.dir, e.codigo, { recoleccionId: rid, importe: "450", fecha: hoy, referencia: "DEP-FICT-1" }, PRUEBAS))
      .toEqual({ ok: false, error: "saldo" });
    expect(await registrarDepositoRecoleccion(sql, e.dir, e.codigo, { recoleccionId: rid, importe: "300", fecha: hoy, referencia: "DEP-FICT-1" }, PRUEBAS))
      .toEqual({ ok: true, saldo: "100.00" });

    // La diferencia de −$20 la revisa Administración (no participó); Dirección participó.
    const d = p.recolecciones[0].diferencias[0];
    expect(d).toMatchObject({ importe: "-20.00", puedeRevisar: false });
    const pa = await pantallaRecoleccion(sql, e.admin, e.codigo, "pruebas");
    if (!pa.ok) throw new Error(pa.error);
    expect(pa.recolecciones[0].diferencias[0].puedeRevisar).toBe(true);
    expect(await revisarDiferenciaSobre(sql, e.admin, e.codigo, { diferenciaId: d.id, resultado: "faltante_confirmado", motivo: "Recontado con Dirección" }, PRUEBAS))
      .toEqual({ ok: true });
    // En la base: la investigación solo existe para un sobre verificado como «falta» en una recolección del buzón.
    await expect(sql`insert into investigacion_sobre (sobre_id, recoleccion_id, verificacion_id)
                     select ${bolsa.id}, ${rid}, v.id from verificacion_sobre v where v.sobre_id = ${bolsa.id} and v.momento = 'caja'`)
      .rejects.toThrow(/no estaba en el buzón/);
  });

  it("un problema con la llave del buzón queda por revisar (Administración que no participó); aviso a los ocho días por sobre", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    await envejecer([c.usados[0].folio], 8);
    expect(await infoBuzon(sql, e.sucursalId)).toMatchObject({ sobres: 2, conAviso: 1, masAntiguo: 8 });
    const v = await pantallaRecoleccion(sql, e.vespertina, e.codigo, "pruebas");
    if (!v.ok) throw new Error(v.error);
    expect(v.caja.map((s) => s.aviso)).toEqual([true, false]);
    expect(v.puedeRecogerBuzon).toBe(false);
    const r = await recogerBuzon(sql, e.dir, e.codigo, {
      sobres: c.usados.map((s, i) => ({ sobreId: s.id, estado: "correcto", folioVisto: "", motivo: "", contado: i === 0 ? "420" : "3050" })),
      llave: { estado: "incidencia", motivo: "La cerradura del buzón estaba forzada" },
    }, PRUEBAS);
    expect(r).toEqual({ ok: true, recogido: "3470.00", diferencias: 0, investigar: 0 });
    const p = await pantallaRecoleccion(sql, e.admin, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.incidenciasLlave).toHaveLength(1);
    expect(p.incidenciasLlave[0]).toMatchObject({ momento: "recoleccion", estado: "por_revisar", puedeRevisar: true });
    const pd = await pantallaRecoleccion(sql, e.dir, e.codigo, "pruebas");
    if (!pd.ok) throw new Error(pd.error);
    expect(pd.incidenciasLlave[0].puedeRevisar).toBe(false);
    expect(await revisarIncidenciaLlave(sql, e.admin, e.codigo, { incidenciaId: p.incidenciasLlave[0].id, resultado: "incidencia_confirmada", motivo: "Se cambia la cerradura" }, PRUEBAS))
      .toEqual({ ok: true });
  });
});

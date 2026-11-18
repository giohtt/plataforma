import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirDesdeCierre, cerrarDia, cierrePendiente, configurarCustodia, confirmarCustodia, custodiasPorConfirmar, pantallaApertura,
  pantallaCierre, prepararCierre, sobresEnCaja, sobresFueraDeCaja,
} from "@/lib/cierres";
import { cancelarEntrega, pantallaRecepcion, recibirTurno, registrarEntrega } from "@/lib/entregas";
import { cambiarMontoFondo, confirmarEntradaFondo } from "@/lib/fondos";
import {
  cancelarEntregaSobres, confirmarRecoleccion, pantallaRecoleccion, registrarDepositoRecoleccion, registrarDevolucion, registrarEntregaSobres,
  revisarDiferenciaSobre, revisarIncidenciaLlave,
} from "@/lib/recolecciones";
import { listaDiferencias } from "@/lib/diferencias";
import { pantallaFondos } from "@/lib/fondos";
import { reporteTurnos } from "@/lib/reporte-turnos";
import { reporteVisitas } from "@/lib/reporte-visitas";
import { listaRetiros } from "@/lib/retiros";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 5, regla 7 (18 nov 2026): las recepcionistas custodian la caja con llave y Dirección recoge una vez por semana.
 * Solo datos ficticios.
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
    insert into usuario (nombre, correo, es_prueba) values (${`${nombre} ${n}`}, ${`recoleccion${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de recolección')`;
  }
  return u.id;
}

/**
 * Sucursal como Tenango: dos recepcionistas nombradas custodias, fondos de $300 y $300 ya en el turno. La matutina abre
 * con $420 en la bolsa y $3,050 en el cajón, más los fondos: $720 y $3,350.
 */
async function escenario({ fondos = true } = {}) {
  k++;
  const codigo = `R${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal recolección " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const matutina = await cuenta([["recepcion", codigo]], "Recepción matutina");
  const vespertina = await cuenta([["recepcion", codigo]], "Recepción vespertina");
  const encargado = await cuenta([["encargado", codigo]], "Encargado");
  const admin = await cuenta([["administracion", codigo]], "Administración");
  const dir = await cuenta([["direccion", codigo]], "Dirección");
  // La vespertina tiene el turno abierto (cierra esta noche); la matutina abre mañana.
  const t = await abrirTurno(sql, vespertina, codigo, fondos ? { bolsa: "420.00", cajon: "3050.00" } : { bolsa: "720.00", cajon: "3350.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const c = await configurarCustodia(sql, dir, codigo, {
    lugar: "Caja con llave de recepción", acceso: [matutina, vespertina], lugarFondos: "Cajón con llave de recepción",
    accesoCajon: [matutina, vespertina], custodias: [matutina, vespertina],
  }, PRUEBAS);
  if (!c.ok) throw new Error(c.error);
  if (fondos) {
    for (const lugar of ["bolsa_visitas", "cajon_mensualidades"]) {
      const r = await cambiarMontoFondo(sql, dir, codigo,
        { lugar, monto: "300", origen: "entrega_persona", destino: "", detalleOrigen: "Efectivo ficticio de Dirección", motivo: "Fondo provisional" }, PRUEBAS);
      if (!r.ok) throw new Error(r.error);
      const x = await confirmarEntradaFondo(sql, vespertina, codigo, { entradaId: r.entradaId!, recibido: "300" }, PRUEBAS);
      if (!x.ok) throw new Error(x.error);
    }
  }
  return { codigo, sucursalId: s.id, matutina, vespertina, encargado, admin, dir, turnoId: t.turnoId };
}
type Esc = Awaited<ReturnType<typeof escenario>>;

const correctos = (sobres: { id: string }[]) => sobres.map((s) => ({ sobreId: s.id, estado: "correcto", folioVisto: "", motivo: "" }));

/** Cierra el turno abierto: quien cierra se queda con la llave («Yo») y verifica la caja. */
async function cerrarYo(e: Esc, quien: string, conteo = { bolsa: "720", cajon: "3350" }, fondos = { bolsa: "300", cajon: "300" }) {
  const p = await prepararCierre(sql, quien, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
  if (!p.ok) throw new Error(p.error);
  const caja = await sobresEnCaja(sql, e.sucursalId);
  const r = await cerrarDia(sql, quien, e.codigo, {
    turnoId: e.turnoId, conteo, fondos, custodio: quien, nota: "", apoyo: NADIE,
    custodia: { ubicacion: "Caja con llave de recepción", sobres: correctos([...p.sobres, ...caja]), llave: LLAVE, llaveCaja: LLAVE },
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return { ...r, sobres: p.sobres };
}
/** Abre desde el cierre contando solo los fondos y verificando toda la caja. */
type Llaves = { llave?: { estado: string; motivo: string }; llaveCaja?: { estado: string; motivo: string } };
async function abrir(e: Esc, quien: string, conteo = { bolsa: "300", cajon: "300" }, extra: { sobres?: { sobreId: string; estado: string; folioVisto: string; motivo: string }[] } & Llaves = {}) {
  const c = (await cierrePendiente(sql, e.sucursalId))!;
  const r = await abrirDesdeCierre(sql, quien, e.codigo, {
    entregaId: c.entregaId, version: c.version, sobres: extra.sobres ?? correctos(await sobresEnCaja(sql, e.sucursalId)), conteo, apoyo: NADIE,
    llave: "llave" in extra ? extra.llave : LLAVE, llaveCaja: "llaveCaja" in extra ? extra.llaveCaja : LLAVE,
  }, PRUEBAS);
  if (r.ok && r.resultado === "abierto") e.turnoId = r.turnoId;
  return r;
}
/** Envejece los sobres guardados (para el aviso de ocho días), sin pasar por las reglas de la aplicación. */
async function envejecer(folios: string[], dias: number) {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sobre_cierre set resuelto_en = resuelto_en - make_interval(days => ${dias}) where folio in ${tx(folios)}`;
  });
}

describe.skipIf(!URL_ADMIN)("sobres guardados y recolección semanal por Dirección", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("Dirección nombra a las custodias de forma explícita; el custodio es una de ellas (también en la base)", async () => {
    const e = await escenario({ fondos: false });
    const base = { lugar: "Caja con llave", acceso: [e.matutina], lugarFondos: "Cajón con llave", accesoCajon: [e.matutina] };
    expect(await configurarCustodia(sql, e.dir, e.codigo, { ...base, custodias: [] }, PRUEBAS)).toEqual({ ok: false, error: "custodias" });
    const ajena = await cuenta([["recepcion", "TEN"]], "Recepción ajena");
    expect(await configurarCustodia(sql, e.dir, e.codigo, { ...base, custodias: [ajena] }, PRUEBAS)).toEqual({ ok: false, error: "custodias" });
    // El Encargado ya no aparece como custodio si Dirección no lo nombró.
    const p = await pantallaCierre(sql, e.vespertina, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.custodios.map((c) => c.id).sort()).toEqual([e.matutina, e.vespertina].sort());
    await prepararCierre(sql, e.vespertina, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
    expect(await cerrarDia(sql, e.vespertina, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "720", cajon: "3350" }, custodio: e.encargado, nota: "", apoyo: NADIE }, PRUEBAS))
      .toEqual({ ok: false, error: "custodio" });
    const [cfg] = await sql<{ id: string }[]>`select id from custodia_configuracion where sucursal_id = ${e.sucursalId} order by en desc limit 1`;
    await expect(sql`insert into entrega_turno (turno_id, entrega_por, tipo, custodio_id, custodia_config_id, sobres_guardados)
                     values (${e.turnoId}, ${e.vespertina}, 'cierre', ${e.encargado}, ${cfg.id}, true)`).rejects.toThrow(/custodias que nombró Dirección/);
    await expect(sql`insert into custodia_configuracion (sucursal_id, lugar, acceso, configurada_por, lugar_fondos, acceso_cajon, custodias)
                     values (${e.sucursalId}, 'Caja', ${[e.matutina]}::uuid[], ${e.dir}, 'Cajón', ${[e.matutina]}::uuid[], ${[ajena]}::uuid[])`)
      .rejects.toThrow(/asignación en la sucursal/);
  });

  it("al cerrar, el excedente sale a su sobre y pasa solo el fondo; al abrir se cuenta solo el fondo y se verifica la caja", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    expect(c.diferenciaEsperado).toBeNull();
    const sobres = await sql<{ folio: string; importe: string; estado: string }[]>`
      select folio, importe::text as importe, estado from sobre_cierre where entrega_id = ${c.entregaId} order by folio`;
    expect(sobres.map((s) => [s.importe, s.estado])).toEqual([["420.00", "usado"], ["3050.00", "usado"]]);
    const salidas = await sql<{ importe: string }[]>`
      select importe::text as importe from movimiento_efectivo where turno_id = ${e.turnoId} and tipo = 'salida_sobre' order by importe`;
    expect(salidas.map((s) => s.importe)).toEqual(["-3050.00", "-420.00"]);
    const entregado = await sql<{ importe: string; esperado: string | null }[]>`
      select c.importe::text as importe, c.esperado::text as esperado from entrega_conteo c join lugar_efectivo l on l.id = c.lugar_id
      where c.entrega_id = ${c.entregaId} and c.tipo = 'entregado' order by l.tipo`;
    expect(entregado).toEqual([{ importe: "300.00", esperado: "300.00" }, { importe: "300.00", esperado: null }]);
    // Quien cerró se quedó con la llave: no tiene nada más que confirmar.
    expect((await custodiasPorConfirmar(sql, e.vespertina, e.codigo))!.cierre).toBeNull();

    // A la mañana siguiente: no ve importes al abrir, cuenta $300 y $300 y verifica los dos sobres de la caja.
    const p = await pantallaApertura(sql, e.matutina, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.cierre.sobresGuardados).toBe(true);
    expect(p.caja.map((s) => s.folio)).toEqual(c.sobres.map((s) => s.folio));
    // Sin verificar toda la caja no abre.
    const cp = (await cierrePendiente(sql, e.sucursalId))!;
    expect(await abrirDesdeCierre(sql, e.matutina, e.codigo, { entregaId: cp.entregaId, version: cp.version, sobres: correctos(p.caja.slice(0, 1)), conteo: { bolsa: "300", cajon: "300" }, apoyo: NADIE, llave: LLAVE, llaveCaja: LLAVE }, PRUEBAS))
      .toEqual({ ok: false, error: "sobres" });
    expect(await abrir(e, e.matutina)).toMatchObject({ ok: true, resultado: "abierto" });
    const t = await estadoTurno(sql, e.matutina, e.codigo);
    expect(t!.turno!.lugares.map((l) => l.contadoAlAbrir)).toEqual(["300.00", "300.00"]);
    expect(await sql`select 1 from diferencia_efectivo where entrega_id = ${c.entregaId}`).toHaveLength(0);
    const fondos = await sql<{ momento: string; fondo: string; sobre: string }[]>`
      select momento, fondo::text as fondo, sobre::text as sobre from conteo_fondo where entrega_id = ${c.entregaId} order by momento, lugar_id`;
    expect(fondos.filter((f) => f.momento === "apertura_inicial").every((f) => f.fondo === "300.00" && f.sobre === "0.00")).toBe(true);
    // La cadena: la vespertina verificó la caja al cerrar (vacía) y la matutina al abrir; la llave la tiene la matutina.
    const revisiones = await sql<{ momento: string; custodio_id: string; sobres: number }[]>`
      select r.momento, r.custodio_id, (select count(*)::int from verificacion_sobre v where v.revision_id = r.id) as sobres
      from revision_caja r where r.entrega_id = ${c.entregaId} order by r.en`;
    expect(revisiones).toEqual([{ momento: "cierre", custodio_id: e.vespertina, sobres: 0 }, { momento: "apertura", custodio_id: e.matutina, sobres: 2 }]);
    const r = await pantallaRecoleccion(sql, e.vespertina, e.codigo, "pruebas");
    if (!r.ok) throw new Error(r.error);
    expect(r.custodia).toMatchObject({ momento: "apertura" });
    expect(r.caja.map((s) => s.importe)).toEqual(["420.00", "3050.00"]);
  });

  it("sin fondo definido todo va al sobre y al abrir se cuentan $0; un faltante al cerrar sigue contra el esperado", async () => {
    const e = await escenario({ fondos: false });
    const c = await cerrarYo(e, e.vespertina, { bolsa: "670", cajon: "3350" }, { bolsa: "0", cajon: "0" });
    expect(c.diferenciaEsperado).toBe("-50.00");
    expect(await abrir(e, e.matutina, { bolsa: "0", cajon: "0" })).toMatchObject({ ok: true, resultado: "abierto" });
    const d = await sql<{ tipo: string; importe: string }[]>`select tipo, importe::text as importe from diferencia_efectivo where entrega_id = ${c.entregaId}`;
    expect(d).toEqual([{ tipo: "contra_esperado", importe: "-50.00" }]);
  });

  it("un sobre de la caja abierto o una llave con problema quedan como incidencia; las dos llaves se registran por separado", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    const caja = await sobresEnCaja(sql, e.sucursalId);
    const sobres = correctos(caja).map((s, i) => (i === 0 ? { ...s, estado: "abierto", motivo: "Sello despegado" } : s));
    // Cada llave hay que indicarla; ninguna se da por correcta.
    expect(await abrir(e, e.matutina, undefined, { sobres, llaveCaja: undefined })).toEqual({ ok: false, error: "motivo_llave_caja" });
    expect(await abrir(e, e.matutina, undefined, { sobres, llave: undefined })).toEqual({ ok: false, error: "motivo_llave" });
    expect(await abrir(e, e.matutina, undefined, { sobres, llaveCaja: { estado: "incidencia", motivo: "" } })).toEqual({ ok: false, error: "motivo_llave_caja" });
    // La caja de sobres bien; el cajón de los fondos con problema.
    expect(await abrir(e, e.matutina, undefined, { sobres, llave: { estado: "incidencia", motivo: "La llave del cajón estaba fuera de su lugar" } }))
      .toMatchObject({ ok: true, resultado: "abierto" });
    const inc = await sql<{ tipo: string }[]>`select tipo from incidencia_cierre where entrega_id = ${c.entregaId} order by tipo`;
    expect(inc.map((i) => i.tipo)).toEqual(["llave_cajon", "sobre_caja"]);
    const [rev] = await sql<{ llave: string; llave_cajon: string; motivo_llave_cajon: string }[]>`
      select llave, llave_cajon, motivo_llave_cajon from revision_caja where entrega_id = ${c.entregaId} and momento = 'apertura'`;
    expect(rev).toEqual({ llave: "correcta", llave_cajon: "incidencia", motivo_llave_cajon: "La llave del cajón estaba fuera de su lugar" });
    // En la base, la revisión de un cambio de custodia lleva las dos llaves.
    await expect(sql`insert into revision_caja (sucursal_id, momento, entrega_id, por, custodio_id, llave)
                     values (${e.sucursalId}, 'cambio_turno', ${c.entregaId}, ${e.matutina}, ${e.matutina}, 'correcta')`).rejects.toThrow(/revision_llave_cajon/);
  });

  it("la llave de la caja de sobres con problema queda aparte de la del cajón", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    expect(await abrir(e, e.matutina, undefined, { llaveCaja: { estado: "incidencia", motivo: "La caja de sobres no cerraba bien" } }))
      .toMatchObject({ ok: true, resultado: "abierto" });
    const inc = await sql<{ tipo: string }[]>`select tipo from incidencia_cierre where entrega_id = ${c.entregaId} order by tipo`;
    expect(inc.map((i) => i.tipo)).toEqual(["llave_caja"]);
  });

  it("en el cambio de turno quien recibe toma la llave y verifica cada sobre de la caja", async () => {
    const e = await escenario();
    await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const en = await registrarEntrega(sql, e.matutina, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "300", cajon: "300" }, recibe: e.vespertina, nota: "", apoyo: NADIE }, PRUEBAS);
    if (!en.ok) throw new Error(en.error);
    const [x] = await sql<{ version: number }[]>`select version from entrega_turno where id = ${en.entregaId}`;
    const datos = { entregaId: en.entregaId, version: x.version, conteo: { bolsa: "300", cajon: "300" }, aclaracion: "", apoyo: NADIE };
    expect(await recibirTurno(sql, e.vespertina, e.codigo, datos, PRUEBAS)).toEqual({ ok: false, error: "sobres" });
    const caja = await sobresEnCaja(sql, e.sucursalId);
    expect(await recibirTurno(sql, e.vespertina, e.codigo, { ...datos, caja: { sobres: correctos(caja), llaveCaja: LLAVE } }, PRUEBAS))
      .toEqual({ ok: false, error: "motivo_llave" });
    const r = await recibirTurno(sql, e.vespertina, e.codigo, { ...datos, caja: { sobres: correctos(caja), llaveCaja: LLAVE, llaveCajon: LLAVE } }, PRUEBAS);
    expect(r).toMatchObject({ ok: true, resultado: "confirmada" });
    const [rev] = await sql<{ momento: string; custodio_id: string }[]>`select momento, custodio_id from revision_caja where entrega_id = ${en.entregaId}`;
    expect(rev).toEqual({ momento: "cambio_turno", custodio_id: e.vespertina });
  });

  it("se eligen los sobres que se entregan, los demás siguen visibles; Dirección cuenta a ciegas y las diferencias quedan por sobre", async () => {
    const e = await escenario();
    const dia1 = await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const dia2 = await cerrarYo(e, e.matutina, { bolsa: "800", cajon: "3300" }, { bolsa: "300", cajon: "300" });
    await abrir(e, e.vespertina);
    await envejecer(dia1.sobres.map((s) => s.folio), 9);

    const p = await pantallaRecoleccion(sql, e.vespertina, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.caja.map((s) => [s.folio, s.aviso])).toEqual([...dia1.sobres.map((s) => [s.folio, true]), ...dia2.sobres.map((s) => [s.folio, false])]);
    expect(p.puedeEntregar).toBe(true);
    // Solo la responsable en turno entrega, y solo a Dirección.
    expect(await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: [dia1.sobres[0].id], recibe: e.dir }, PRUEBAS)).toEqual({ ok: false, error: "no_responsable" });
    expect(await registrarEntregaSobres(sql, e.vespertina, e.codigo, { sobres: [dia1.sobres[0].id], recibe: e.admin }, PRUEBAS)).toEqual({ ok: false, error: "recibe" });
    // Entrega los dos sobres del día 1 y la bolsa del día 2; el cajón del día 2 se queda en la caja.
    const elegidos = [dia1.sobres[0].id, dia1.sobres[1].id, dia2.sobres[0].id];
    const en = await registrarEntregaSobres(sql, e.vespertina, e.codigo, { sobres: elegidos, recibe: e.dir }, PRUEBAS);
    if (!en.ok) throw new Error(en.error);
    expect(await registrarEntregaSobres(sql, e.vespertina, e.codigo, { sobres: [dia2.sobres[1].id], recibe: e.dir }, PRUEBAS)).toEqual({ ok: false, error: "ya_pendiente" });

    const d = await pantallaRecoleccion(sql, e.dir, e.codigo, "pruebas");
    if (!d.ok) throw new Error(d.error);
    expect(d.caja.every((s) => s.importe === null)).toBe(true);
    expect(d.pendiente!.sobres.map((s) => s.id)).toEqual(elegidos);
    // Los entregados ya no están en la caja: se ven aparte, con quién los entregó y quién debe confirmar.
    expect(d.caja.map((s) => s.folio)).toEqual([dia2.sobres[1].folio]);
    expect(d.fuera.map((f) => [f.folio, f.estado])).toEqual(elegidos.map((id) => [d.fuera.find((f) => f.id === id)!.folio, "por_confirmar"]));
    expect(d.fuera.every((f) => f.entrego.startsWith("Recepción vespertina") && f.recibe.startsWith("Dirección"))).toBe(true);

    // Solo quien recibe confirma. Bolsa del día 1: faltan $50. Cajón del día 1: cuadra pero llegó abierto. Bolsa del día 2: cuadra.
    const conteo = [
      { sobreId: dia1.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "370" },
      { sobreId: dia1.sobres[1].id, estado: "abierto", folioVisto: "", motivo: "Sello despegado", contado: "3050" },
      { sobreId: dia2.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "500" },
    ];
    expect(await confirmarRecoleccion(sql, e.admin, e.codigo, { recoleccionId: en.recoleccionId, version: d.pendiente!.version, sobres: conteo }, PRUEBAS))
      .toEqual({ ok: false, error: "sin_pendiente" });
    const ok = await confirmarRecoleccion(sql, e.dir, e.codigo, { recoleccionId: en.recoleccionId, version: d.pendiente!.version, sobres: conteo, llave: LLAVE }, PRUEBAS);
    expect(ok).toEqual({ ok: true, recogido: "3920.00", diferencias: 2 });
    expect((await sobresEnCaja(sql, e.sucursalId)).map((s) => s.folio)).toEqual([dia2.sobres[1].folio]);
    const estados = await sql<{ estado: string }[]>`select estado from sobre_cierre where id in ${sql(elegidos)}`;
    expect(estados.every((s) => s.estado === "recogido")).toBe(true);

    const h = await pantallaRecoleccion(sql, e.admin, e.codigo, "pruebas");
    if (!h.ok) throw new Error(h.error);
    const rc = h.recolecciones[0];
    expect(rc).toMatchObject({ recogido: "3920.00", depositado: "0.00", saldo: "3920.00" });
    expect(rc.diferencias.map((x) => [x.folio, x.importe, x.verificacion?.estado ?? null, x.puedeRevisar])).toEqual([
      [dia1.sobres[0].folio, "-50.00", null, true],
      [dia1.sobres[1].folio, "0.00", "abierto", true],
    ]);
    // La cadena del sobre muestra a quien cerró, cada revisión de la caja, quien entregó y quien recogió.
    expect(rc.diferencias[0].cadena.map((x) => x.nombre)).toEqual(expect.arrayContaining([expect.stringContaining("Recepción vespertina"), expect.stringContaining("Dirección")]));
  });

  it("Administración revisa la diferencia si no participó; Dirección registra depósitos parciales hasta lo recogido", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const en = await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: c.sobres.map((s) => s.id), recibe: e.dir }, PRUEBAS);
    if (!en.ok) throw new Error(en.error);
    const conteo = [
      { sobreId: c.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "370" },
      { sobreId: c.sobres[1].id, estado: "correcto", folioVisto: "", motivo: "", contado: "3050" },
    ];
    const ok = await confirmarRecoleccion(sql, e.dir, e.codigo, { recoleccionId: en.recoleccionId, version: 1, sobres: conteo }, PRUEBAS);
    expect(ok).toMatchObject({ ok: true, recogido: "3420.00", diferencias: 1 });
    const [dif] = await sql<{ id: string }[]>`select id from diferencia_sobre where recoleccion_id = ${en.recoleccionId}`;

    // Quien participó en la cadena no revisa, aunque sea Administración; Dirección tampoco (revisa Administración).
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${e.vespertina}, 'administracion', ${e.sucursalId}, 'Prueba: también Administración')`;
    expect(await revisarDiferenciaSobre(sql, e.vespertina, e.codigo, { diferenciaId: dif.id, resultado: "faltante_confirmado", motivo: "Faltan $50 en el sobre" }, PRUEBAS))
      .toEqual({ ok: false, error: "participaste" });
    expect(await revisarDiferenciaSobre(sql, e.dir, e.codigo, { diferenciaId: dif.id, resultado: "faltante_confirmado", motivo: "Faltan $50 en el sobre" }, PRUEBAS))
      .toEqual({ ok: false, error: "sin_permiso" });
    await expect(sql`insert into revision_diferencia_sobre (diferencia_id, resultado, motivo, revisada_por) values (${dif.id}, 'faltante_confirmado', 'Faltan $50', ${e.vespertina})`)
      .rejects.toThrow(/participó/);
    expect(await revisarDiferenciaSobre(sql, e.admin, e.codigo, { diferenciaId: dif.id, resultado: "sobrante_confirmado", motivo: "No corresponde" }, PRUEBAS))
      .toEqual({ ok: false, error: "resultado" });
    expect(await revisarDiferenciaSobre(sql, e.admin, e.codigo, { diferenciaId: dif.id, resultado: "faltante_confirmado", motivo: "Faltan $50 en el sobre de la bolsa" }, PRUEBAS))
      .toEqual({ ok: true });

    // Depósitos parciales: $3,000 y luego $400; no más que el saldo; solo quien recogió.
    const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
    const dep = (quien: string, importe: string) =>
      registrarDepositoRecoleccion(sql, quien, e.codigo, { recoleccionId: en.recoleccionId, importe, fecha: hoy, referencia: "DEP-FICTICIO-1" }, PRUEBAS);
    expect(await dep(e.admin, "100")).toEqual({ ok: false, error: "sin_pendiente" });
    expect(await dep(e.dir, "3000")).toEqual({ ok: true, saldo: "420.00" });
    expect(await dep(e.dir, "500")).toEqual({ ok: false, error: "saldo" });
    expect(await dep(e.dir, "400")).toEqual({ ok: true, saldo: "20.00" });
    await expect(sql`insert into deposito_recoleccion (recoleccion_id, importe, fecha, referencia, registrado_por) values (${en.recoleccionId}, 100, ${hoy}::date, 'DEP-X', ${e.dir})`)
      .rejects.toThrow(/no pueden pasar/);
    const p = await pantallaRecoleccion(sql, e.dir, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.recolecciones[0]).toMatchObject({ recogido: "3420.00", depositado: "3400.00", saldo: "20.00" });
    expect(p.recolecciones[0].diferencias[0]).toMatchObject({ estado: "faltante_confirmado" });
  });

  it("entrega seguida de cambio de turno antes de confirmar: quien recibe no verifica lo entregado y ve quién lo entregó y quién confirma", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    // La matutina entrega a Dirección solo la bolsa; Dirección aún no confirma.
    const en = await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: [c.sobres[0].id], recibe: e.dir }, PRUEBAS);
    if (!en.ok) throw new Error(en.error);
    // Cambio de turno: la vespertina recibe la llave.
    const ent = await registrarEntrega(sql, e.matutina, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "300", cajon: "300" }, recibe: e.vespertina, nota: "", apoyo: NADIE }, PRUEBAS);
    if (!ent.ok) throw new Error(ent.error);
    const pr = await pantallaRecepcion(sql, e.vespertina, e.codigo, "pruebas");
    if (!pr.ok) throw new Error(pr.error);
    expect(pr.caja!.map((s) => s.id)).toEqual([c.sobres[1].id]);
    expect(pr.fuera).toEqual([expect.objectContaining({
      id: c.sobres[0].id, estado: "por_confirmar", entrego: expect.stringContaining("Recepción matutina"), recibe: expect.stringContaining("Dirección"),
    })]);
    const [x] = await sql<{ version: number }[]>`select version from entrega_turno where id = ${ent.entregaId}`;
    const datos = { entregaId: ent.entregaId, version: x.version, conteo: { bolsa: "300", cajon: "300" }, aclaracion: "", apoyo: NADIE };
    // Verificar el sobre entregado no cuenta como verificar la caja, y la base no lo acepta como «en la caja».
    const r = await recibirTurno(sql, e.vespertina, e.codigo, {
      ...datos, caja: { sobres: correctos(c.sobres), llaveCaja: LLAVE, llaveCajon: LLAVE },
    }, PRUEBAS);
    expect(r).toMatchObject({ ok: true, resultado: "confirmada" });
    e.turnoId = (r as { turnoId: string }).turnoId;
    const verificados = await sql<{ sobre_id: string }[]>`
      select v.sobre_id from verificacion_sobre v join revision_caja r on r.id = v.revision_id where r.entrega_id = ${ent.entregaId}`;
    expect(verificados.map((v) => v.sobre_id)).toEqual([c.sobres[1].id]);
    const [rev] = await sql<{ id: string }[]>`select id from revision_caja where entrega_id = ${ent.entregaId}`;
    await expect(sql`insert into verificacion_sobre (sobre_id, momento, estado, verificado_por, revision_id)
                     values (${c.sobres[0].id}, 'caja', 'correcto', ${e.vespertina}, ${rev.id})`).rejects.toThrow(/no está en la caja/);
    // Después del cambio de turno, Dirección confirma lo que recibió.
    const ok = await confirmarRecoleccion(sql, e.dir, e.codigo, {
      recoleccionId: en.recoleccionId, version: 1, sobres: [{ sobreId: c.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" }],
    }, PRUEBAS);
    expect(ok).toEqual({ ok: true, recogido: "420.00", diferencias: 0 });
    expect(await sobresFueraDeCaja(sql, e.sucursalId)).toEqual([]);
    expect((await sobresEnCaja(sql, e.sucursalId)).map((s) => s.id)).toEqual([c.sobres[1].id]);
  });

  it("si se cancela la entrega, el sobre vuelve a la caja solo al registrar su devolución física", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const en = await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: [c.sobres[0].id], recibe: e.dir }, PRUEBAS);
    if (!en.ok) throw new Error(en.error);
    expect(await cancelarEntregaSobres(sql, e.matutina, e.codigo, { recoleccionId: en.recoleccionId, version: 1, motivo: "no" }, PRUEBAS)).toEqual({ ok: false, error: "motivo" });
    expect(await cancelarEntregaSobres(sql, e.dir, e.codigo, { recoleccionId: en.recoleccionId, version: 1, motivo: "No pude contarlos hoy" }, PRUEBAS)).toEqual({ ok: true });
    // Cancelada pero sin devolver: no está en la caja ni se puede volver a entregar (la base tampoco lo deja).
    expect((await sobresEnCaja(sql, e.sucursalId)).map((s) => s.id)).toEqual([c.sobres[1].id]);
    expect((await sobresFueraDeCaja(sql, e.sucursalId)).map((f) => [f.id, f.estado])).toEqual([[c.sobres[0].id, "por_devolver"]]);
    expect(await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: [c.sobres[0].id], recibe: e.dir }, PRUEBAS)).toEqual({ ok: false, error: "sobres" });
    const [x] = await sql<{ id: string }[]>`
      insert into recoleccion (sucursal_id, turno_id, entrega_por, recibe) values (${e.sucursalId}, ${e.turnoId}, ${e.matutina}, ${e.dir}) returning id`;
    await expect(sql`insert into recoleccion_sobre (recoleccion_id, sobre_id) values (${x.id}, ${c.sobres[0].id})`).rejects.toThrow(/por devolver/);
    await sql`update recoleccion set estado = 'cancelada', resuelta_en = now(), motivo_cancelacion = 'Prueba de la base' where id = ${x.id}`;
    // Dirección no registra su propia devolución; la recibe la responsable en turno, verificando el sobre.
    const datos = { recoleccionId: en.recoleccionId, sobres: [{ sobreId: c.sobres[0].id, estado: "abierto", folioVisto: "", motivo: "El sello volvió despegado" }], llave: LLAVE };
    expect(await registrarDevolucion(sql, e.dir, e.codigo, datos, PRUEBAS)).toEqual({ ok: false, error: "sin_permiso" });
    expect(await registrarDevolucion(sql, e.vespertina, e.codigo, datos, PRUEBAS)).toEqual({ ok: false, error: "no_responsable" });
    expect(await registrarDevolucion(sql, e.matutina, e.codigo, { ...datos, sobres: [] }, PRUEBAS)).toEqual({ ok: false, error: "sobres" });
    expect(await registrarDevolucion(sql, e.matutina, e.codigo, { ...datos, llave: undefined }, PRUEBAS)).toEqual({ ok: false, error: "motivo_llave" });
    expect(await registrarDevolucion(sql, e.matutina, e.codigo, datos, PRUEBAS)).toEqual({ ok: true, devueltos: 1, pendientes: 0, incidencias: 1 });
    expect((await sobresEnCaja(sql, e.sucursalId)).map((s) => s.id).sort()).toEqual(c.sobres.map((s) => s.id).sort());
    expect(await sobresFueraDeCaja(sql, e.sucursalId)).toEqual([]);
    // Ya no queda nada por devolver de esa entrega.
    expect(await registrarDevolucion(sql, e.matutina, e.codigo, datos, PRUEBAS)).toEqual({ ok: false, error: "sin_devolucion" });
    // El sobre que volvió abierto queda por revisar, y Administración que no participó lo revisa.
    const p = await pantallaRecoleccion(sql, e.admin, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    const dev = p.devoluciones.find((d) => d.id === en.recoleccionId)!;
    const dif = dev.sobres[0].diferencias;
    expect(dif).toEqual([expect.objectContaining({ folio: c.sobres[0].folio, importe: "0.00", puedeRevisar: true })]);
    expect(dif[0].cadena.map((y) => y.momento)).toEqual(expect.arrayContaining(["Entrega cancelada (por devolver)", "Revisó la devolución", "Volvió a la caja (devolución)"]));
    expect(await revisarDiferenciaSobre(sql, e.admin, e.codigo, { diferenciaId: dif[0].id, resultado: "incidencia_confirmada", motivo: "El sobre volvió abierto" }, PRUEBAS))
      .toEqual({ ok: true });
    // Ya devuelto, se puede volver a entregar.
    const otra = await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: [c.sobres[0].id], recibe: e.dir }, PRUEBAS);
    expect(otra.ok).toBe(true);
  });

  it("devolución por sobre: se devuelven dos y falta uno, que sigue pendiente con su incidencia y su cadena hasta que regresa", async () => {
    const e = await escenario();
    const dia1 = await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const dia2 = await cerrarYo(e, e.matutina, { bolsa: "800", cajon: "3300" }, { bolsa: "300", cajon: "300" });
    await abrir(e, e.vespertina);
    // Tres sobres a Dirección; el cajón del día 2 se queda en la caja.
    const tres = [dia1.sobres[0], dia1.sobres[1], dia2.sobres[0]];
    const en = await registrarEntregaSobres(sql, e.vespertina, e.codigo, { sobres: tres.map((x) => x.id), recibe: e.dir }, PRUEBAS);
    if (!en.ok) throw new Error(en.error);
    await cancelarEntregaSobres(sql, e.dir, e.codigo, { recoleccionId: en.recoleccionId, version: 1, motivo: "Se canceló la visita" }, PRUEBAS);
    expect((await sobresFueraDeCaja(sql, e.sucursalId)).map((f) => f.estado)).toEqual(["por_devolver", "por_devolver", "por_devolver"]);

    // Dirección devuelve dos; el tercero (la bolsa del día 2) no regresa. La llave de la caja también tuvo un problema.
    const verificacion = [
      { sobreId: tres[0].id, estado: "correcto", folioVisto: "", motivo: "" },
      { sobreId: tres[1].id, estado: "correcto", folioVisto: "", motivo: "" },
      { sobreId: tres[2].id, estado: "falta", folioVisto: "", motivo: "Dirección no lo trajo de vuelta" },
    ];
    // Hay que indicar qué pasó con cada sobre pendiente, también con el que falta.
    expect(await registrarDevolucion(sql, e.vespertina, e.codigo, { recoleccionId: en.recoleccionId, sobres: verificacion.slice(0, 2), llave: LLAVE }, PRUEBAS))
      .toEqual({ ok: false, error: "sobres" });
    const r1 = await registrarDevolucion(sql, e.vespertina, e.codigo, {
      recoleccionId: en.recoleccionId, sobres: verificacion, llave: { estado: "incidencia", motivo: "La caja de sobres estaba sin llave" },
    }, PRUEBAS);
    expect(r1).toEqual({ ok: true, devueltos: 2, pendientes: 1, incidencias: 2 });

    // Solo los dos recibidos vuelven a la caja; el tercero sigue visible como pendiente de devolución.
    expect((await sobresEnCaja(sql, e.sucursalId)).map((x) => x.id).sort()).toEqual([dia1.sobres[0].id, dia1.sobres[1].id, dia2.sobres[1].id].sort());
    expect(await sobresFueraDeCaja(sql, e.sucursalId)).toEqual([expect.objectContaining({ id: tres[2].id, estado: "por_devolver", recibe: expect.stringContaining("Dirección") })]);
    // La base no deja meterlo a la caja sin haberlo recibido.
    const [rev] = await sql<{ revision_id: string; id: string }[]>`
      select revision_id, id from devolucion_recoleccion where recoleccion_id = ${en.recoleccionId}`;
    await expect(sql`insert into devolucion_sobre (devolucion_id, recoleccion_id, sobre_id) values (${rev.id}, ${en.recoleccionId}, ${tres[2].id})`)
      .rejects.toThrow(/recibido y verificado/);
    // Un cambio de turno no lo pide en la caja.
    const ent = await registrarEntrega(sql, e.vespertina, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "300", cajon: "300" }, recibe: e.matutina, nota: "", apoyo: NADIE }, PRUEBAS);
    if (!ent.ok) throw new Error(ent.error);
    const pr = await pantallaRecepcion(sql, e.matutina, e.codigo, "pruebas");
    if (!pr.ok) throw new Error(pr.error);
    expect(pr.caja!.map((x) => x.id)).not.toContain(tres[2].id);
    expect(pr.fuera.map((f) => [f.id, f.estado])).toEqual([[tres[2].id, "por_devolver"]]);
    const [v] = await sql<{ version: number }[]>`select version from entrega_turno where id = ${ent.entregaId}`;
    expect(await cancelarEntrega(sql, e.vespertina, e.codigo, { entregaId: ent.entregaId, version: v.version, motivo: "Sigue la vespertina" }, PRUEBAS)).toMatchObject({ ok: true });

    // En pantalla: dos devueltos, uno pendiente con su incidencia («no está») y su cadena; la llave queda por revisar.
    const p = await pantallaRecoleccion(sql, e.admin, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    const pend = p.porDevolver.find((d) => d.id === en.recoleccionId)!;
    expect(pend.sobres.map((x) => [x.id, x.devuelto !== null])).toEqual(tres.map((x, i) => [x.id, i < 2]));
    const falta = pend.sobres[2];
    expect(falta.diferencias).toEqual([expect.objectContaining({ verificacion: expect.objectContaining({ estado: "falta" }), estado: "por_revisar", puedeRevisar: true })]);
    expect(falta.cadena.map((x) => x.momento)).toEqual(expect.arrayContaining(["Entregó a Dirección", "Entrega cancelada (por devolver)", "Revisó la devolución"]));
    expect(falta.cadena.map((x) => x.momento)).not.toContain("Volvió a la caja (devolución)");
    expect(p.incidenciasLlave).toEqual([expect.objectContaining({ momento: "devolucion", estado: "por_revisar", puedeRevisar: true })]);

    // Revisa Administración que no participó: quien recibió la devolución no, aunque también sea Administración.
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${e.vespertina}, 'administracion', ${e.sucursalId}, 'Prueba: también Administración')`;
    const llaveId = p.incidenciasLlave[0].id;
    expect(await revisarIncidenciaLlave(sql, e.vespertina, e.codigo, { incidenciaId: llaveId, resultado: "aclarada", motivo: "Se le olvidó cerrarla" }, PRUEBAS))
      .toEqual({ ok: false, error: "participaste" });
    await expect(sql`insert into revision_incidencia_llave (incidencia_id, resultado, motivo, revisada_por) values (${llaveId}, 'aclarada', 'Se le olvidó', ${e.vespertina})`)
      .rejects.toThrow(/participó/);
    expect(await revisarIncidenciaLlave(sql, e.dir, e.codigo, { incidenciaId: llaveId, resultado: "aclarada", motivo: "Se le olvidó cerrarla" }, PRUEBAS))
      .toEqual({ ok: false, error: "sin_permiso" });
    expect(await revisarIncidenciaLlave(sql, e.admin, e.codigo, { incidenciaId: llaveId, resultado: "incidencia_confirmada", motivo: "La caja quedó sin llave" }, PRUEBAS))
      .toEqual({ ok: true });

    // Días después Dirección trae el sobre que faltaba: vuelve a la caja con una segunda devolución.
    const r2 = await registrarDevolucion(sql, e.vespertina, e.codigo, {
      recoleccionId: en.recoleccionId, sobres: [{ sobreId: tres[2].id, estado: "correcto", folioVisto: "", motivo: "" }], llave: LLAVE,
    }, PRUEBAS);
    expect(r2).toEqual({ ok: true, devueltos: 1, pendientes: 0, incidencias: 0 });
    expect(await sobresFueraDeCaja(sql, e.sucursalId)).toEqual([]);
    const q = await pantallaRecoleccion(sql, e.admin, e.codigo, "pruebas");
    if (!q.ok) throw new Error(q.error);
    expect(q.porDevolver).toEqual([]);
    const hecha = q.devoluciones.find((d) => d.id === en.recoleccionId)!;
    expect(hecha.sobres.every((x) => x.devuelto)).toBe(true);
    // La incidencia de cuando no regresó se conserva.
    expect(hecha.sobres[2].diferencias).toHaveLength(1);
  });

  it("un problema con la llave de la caja al recoger queda por revisar para Administración que no participó", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const en = await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: [c.sobres[0].id], recibe: e.dir }, PRUEBAS);
    if (!en.ok) throw new Error(en.error);
    const ok = await confirmarRecoleccion(sql, e.dir, e.codigo, {
      recoleccionId: en.recoleccionId, version: 1, sobres: [{ sobreId: c.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" }],
      llave: { estado: "incidencia", motivo: "La caja de sobres no tenía puesta la llave" },
    }, PRUEBAS);
    expect(ok).toEqual({ ok: true, recogido: "420.00", diferencias: 0 });
    const p = await pantallaRecoleccion(sql, e.admin, e.codigo, "pruebas");
    if (!p.ok) throw new Error(p.error);
    expect(p.incidenciasLlave).toEqual([expect.objectContaining({ momento: "recoleccion", estado: "por_revisar", puedeRevisar: true })]);
    // Quien entregó los sobres participó: no revisa aunque tenga Administración.
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${e.matutina}, 'administracion', ${e.sucursalId}, 'Prueba: también Administración')`;
    expect(await revisarIncidenciaLlave(sql, e.matutina, e.codigo, { incidenciaId: p.incidenciasLlave[0].id, resultado: "aclarada", motivo: "Estaba bien" }, PRUEBAS))
      .toEqual({ ok: false, error: "participaste" });
    expect(await revisarIncidenciaLlave(sql, e.admin, e.codigo, { incidenciaId: p.incidenciasLlave[0].id, resultado: "aclarada", motivo: "La llave estaba en el cajón" }, PRUEBAS))
      .toEqual({ ok: true });
    const q = await pantallaRecoleccion(sql, e.admin, e.codigo, "pruebas");
    expect(q.ok && q.incidenciasLlave[0]).toMatchObject({ estado: "aclarada", puedeRevisar: false });
  });

  it("con un cambio de turno en curso no se entregan sobres", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const ent = await registrarEntrega(sql, e.matutina, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "300", cajon: "300" }, recibe: e.vespertina, nota: "", apoyo: NADIE }, PRUEBAS);
    if (!ent.ok) throw new Error(ent.error);
    expect(await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: [c.sobres[0].id], recibe: e.dir }, PRUEBAS)).toEqual({ ok: false, error: "entrega_en_curso" });
    // La base tampoco deja recoger un sobre sin confirmar la recolección.
    await expect(sql`update sobre_cierre set estado = 'recogido' where id = ${c.sobres[0].id}`).rejects.toThrow(/cambio no permitido/);
  });

  it("Dirección administra desde su cuenta: consulta saldos, reportes, fondos, retiros y depósitos solo de sus sucursales asignadas", async () => {
    const e = await escenario();
    const c = await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const en = await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: c.sobres.map((x) => x.id), recibe: e.dir }, PRUEBAS);
    if (!en.ok) throw new Error(en.error);
    await confirmarRecoleccion(sql, e.dir, e.codigo, { recoleccionId: en.recoleccionId, version: 1, sobres: [
      { sobreId: c.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" },
      { sobreId: c.sobres[1].id, estado: "correcto", folioVisto: "", motivo: "", contado: "3050" },
    ] }, PRUEBAS);
    // Su perfil sigue siendo Dirección (no se cambia el nombre ni el perfil de la cuenta).
    expect(await sql`select rol from asignacion where usuario_id = ${e.dir} and revocada_en is null`).toEqual([{ rol: "direccion" }]);
    // Saldos del turno, fondos, retiros, reportes, diferencias y lo recogido con su saldo por depositar.
    const t = await estadoTurno(sql, e.dir, e.codigo);
    expect(t?.turno?.lugares.map((l) => l.contadoAlAbrir)).toEqual(["300.00", "300.00"]);
    expect(await pantallaFondos(sql, e.dir, e.codigo)).not.toBeNull();
    expect(await listaRetiros(sql, e.dir, e.codigo)).not.toBeNull();
    expect((await reporteTurnos(sql, e.dir, e.codigo))?.sucursales.map((x) => x.codigo)).toEqual([e.codigo]);
    expect(await reporteVisitas(sql, e.dir, { codigo: e.codigo })).not.toBeNull();
    expect(await listaDiferencias(sql, e.dir, e.codigo)).not.toBeNull();
    const p = await pantallaRecoleccion(sql, e.dir, e.codigo, "pruebas");
    expect(p.ok && p.recolecciones[0]).toMatchObject({ recogido: "3470.00", saldo: "3470.00" });
    // Otra sucursal (Tenango) no: solo las asignadas.
    expect(await estadoTurno(sql, e.dir, "TEN")).toBeNull();
    expect(await pantallaFondos(sql, e.dir, "TEN")).toBeNull();
    expect(await listaRetiros(sql, e.dir, "TEN")).toBeNull();
    expect(await reporteTurnos(sql, e.dir, "TEN")).toBeNull();
    expect(await pantallaRecoleccion(sql, e.dir, "TEN", "pruebas")).toEqual({ ok: false, error: "no_encontrada" });
  });

  it("si la custodia es otra persona, confirma desde su cuenta y verifica también los sobres que ya estaban en la caja", async () => {
    const e = await escenario();
    await cerrarYo(e, e.vespertina);
    await abrir(e, e.matutina);
    const p = await prepararCierre(sql, e.matutina, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
    if (!p.ok) throw new Error(p.error);
    const r = await cerrarDia(sql, e.matutina, e.codigo, {
      turnoId: e.turnoId, conteo: { bolsa: "720", cajon: "3350" }, fondos: { bolsa: "300", cajon: "300" }, custodio: e.vespertina, nota: "", apoyo: NADIE,
    }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const pend = (await custodiasPorConfirmar(sql, e.vespertina, e.codigo))!;
    expect(pend.cierre?.entregaId).toBe(r.entregaId);
    expect(pend.caja).toHaveLength(2);
    expect(await confirmarCustodia(sql, e.vespertina, e.codigo, { entregaId: r.entregaId, ubicacion: "Caja con llave de recepción", sobres: correctos(pend.cierre!.sobres) }, PRUEBAS))
      .toEqual({ ok: false, error: "sobres" });
    expect(await confirmarCustodia(sql, e.vespertina, e.codigo, {
      entregaId: r.entregaId, ubicacion: "Caja con llave de recepción", sobres: correctos([...pend.cierre!.sobres, ...pend.caja]), llave: LLAVE,
    }, PRUEBAS)).toEqual({ ok: false, error: "motivo_llave_caja" });
    expect(await confirmarCustodia(sql, e.vespertina, e.codigo, {
      entregaId: r.entregaId, ubicacion: "Caja con llave de recepción", sobres: correctos([...pend.cierre!.sobres, ...pend.caja]), llave: LLAVE, llaveCaja: LLAVE,
    }, PRUEBAS)).toEqual({ ok: true, incidencias: 0 });
    const [rev] = await sql<{ custodio_id: string; n: number }[]>`
      select r.custodio_id, (select count(*)::int from verificacion_sobre v where v.revision_id = r.id) as n from revision_caja r where r.entrega_id = ${r.entregaId}`;
    expect(rev).toEqual({ custodio_id: e.vespertina, n: 2 });
  });
});

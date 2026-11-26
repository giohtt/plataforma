import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import postgresCliente from "postgres";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { excelCaja, LEYENDA_ANOTADOS, OCULTO, pdfCaja } from "@/lib/archivo-caja";
import { abrirDesdeCierre, cerrarDia, cierrePendiente, configurarCustodia, prepararCierre, sobresEnCaja } from "@/lib/cierres";
import { resolverDiferencia, revisarDiferencia } from "@/lib/diferencias";
import { estadoResolucionSobre, resolverFaltanteRetiro, resolverFaltanteSobre } from "@/lib/resoluciones";
import { diasEntre, lectura, rango, resumirCaja } from "@/lib/resumen-caja";
import { cambiarMontoFondo, confirmarEntradaFondo } from "@/lib/fondos";
import { confirmarRecoleccion, recogerBuzon, registrarDepositoRecoleccion, registrarEntregaSobres, revisarDiferenciaSobre } from "@/lib/recolecciones";
import { detalleCaja, historialDescargas, prepararDescarga, reporteCaja, type ArchivoCaja } from "@/lib/reporte-caja";
import { confirmarRetiro, detalleRetiro, generarFolio, recontarRetiro, registrarDeposito, registrarRetiro, revisarRetiro } from "@/lib/retiros";
import { abrirTurno } from "@/lib/turnos";
import { aplicarCambio, resumenPermisos, type CambioAcceso } from "@/lib/usuarios";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { aplicarMigraciones, DIRECTORIO_MIGRACIONES } from "../../scripts/migrar.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Reporte de caja por sucursal y periodo (aprobado el 21 nov 2026). Solo datos ficticios: dónde está el efectivo al
 * corte (una sola etapa por peso), diferencias y sobres por investigar aparte, conteo a ciegas, saldos anteriores al
 * periodo, corte conservado y permisos individuales de consulta y descarga.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
const u: Record<string, string> = {};
let n = 0;
let k = 0;
const PRUEBAS = { entorno: "pruebas" as const };
const NADIE = { hubo: false as const };
const LLAVE = { estado: "correcta", motivo: "" };
const hoy = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
/** Un corte «ahora». El corte va en milésimas de segundo: se espera un poco para que lo siguiente quede después. */
const reloj = async () => {
  const t = (await sql<{ t: Date }[]>`select clock_timestamp() as t`)[0].t.toISOString();
  await new Promise((r) => setTimeout(r, 3));
  return t;
};
const cambiar = (persona: string, c: CambioAcceso) => aplicarCambio(sql, u["direccion.general"], persona, c, PRUEBAS);
const dar = (persona: string, permiso: string, sucursales: string[] | "todas") => cambiar(persona, {
  tipo: "dar_permiso", permiso, alcance: sucursales === "todas" ? { todas: true } : { todas: false, sucursales }, limite: "", hasta: "", motivo: "Prueba del reporte de caja",
});

async function cuenta(asignaciones: [string, string][], nombre: string) {
  n++;
  const [x] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${`${nombre} ${n}`}, ${`caja${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${x.id}, ${rol}, ${ids[codigo]}, 'Prueba del reporte de caja')`;
  }
  return x.id;
}

/** Hojas de un Excel del reporte: nombre → filas (celdas como texto; la primera fila son los títulos). */
async function hojasExcel(b: Buffer) {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(b as unknown as ArrayBuffer);
  const hojas: Record<string, string[][]> = {};
  for (const h of libro.worksheets) {
    const filas: string[][] = [];
    h.eachRow({ includeEmpty: false }, (r) => {
      const v = r.values as unknown[];
      filas.push(Array.from({ length: h.columnCount }, (_, i) => String(v[i + 1] ?? "")));
    });
    hojas[h.name] = filas;
  }
  return hojas;
}
/** Texto de un Excel del reporte: «[Hoja] celda | celda…», una fila por línea. */
async function textoExcel(b: Buffer) {
  const hojas = await hojasExcel(b);
  return Object.entries(hojas).flatMap(([n, filas]) => filas.map((f) => `[${n}] ${f.join(" | ")}`)).join("\n");
}
/** Filas de una hoja como objetos por título de columna. */
const tablaHoja = (filas: string[][]) => filas.slice(1).map((f) => Object.fromEntries(filas[0].map((t, i) => [t, f[i]])));
/** Texto de un PDF del reporte: descomprime cada flujo y decodifica los textos (la fuente estándar los escribe en hexadecimal). */
function textoPdf(b: Buffer) {
  const crudo = b.toString("latin1");
  const partes: string[] = [];
  // Cada flujo se toma por su longitud declarada (un flujo comprimido puede contener por azar el texto «endstream»).
  for (const m of crudo.matchAll(/\/Length (\d+)[^>]*>>\s*stream\r?\n/g)) {
    const datos = crudo.slice(m.index! + m[0].length, m.index! + m[0].length + Number(m[1]));
    let flujo: string;
    try { flujo = inflateSync(Buffer.from(datos, "latin1")).toString("latin1"); } catch { flujo = datos; }
    for (const t of flujo.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) partes.push(Buffer.from(t[1], "hex").toString("latin1"));
  }
  return partes.join("\n");
}
/** Texto de ambos archivos; en el PDF las líneas se unen con espacios (una celda puede ocupar varias líneas). */
const archivos = async (a: ArchivoCaja) => ({ excel: await textoExcel(await excelCaja(a)), pdf: textoPdf(await pdfCaja(a)).replace(/\n/g, " ") });
/** Si se pide (GUARDAR=carpeta), deja los archivos para revisar su presentación. */
async function guardar(nombre: string, a: ArchivoCaja) {
  if (!process.env.GUARDAR) return;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${process.env.GUARDAR}/${nombre}.xlsx`, await excelCaja(a));
  await writeFile(`${process.env.GUARDAR}/${nombre}.pdf`, await pdfCaja(a));
}

/** Sucursal con buzón (o con caja de sobres), fondos de $300 y $300; la vespertina abre con $420 y $3,050 y recibe los fondos. */
async function escenario({ buzon = true } = {}) {
  k++;
  const codigo = `K${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal caja " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const matutina = await cuenta([["recepcion", codigo]], "Recepción matutina");
  const vespertina = await cuenta([["recepcion", codigo]], "Recepción vespertina");
  const admin = await cuenta([["administracion", codigo]], "Administración");
  const dir = await cuenta([["direccion", codigo]], "Dirección");
  const encargada = await cuenta([["encargada_retiros", codigo]], "Encargada de retiros");
  const t = await abrirTurno(sql, vespertina, codigo, { bolsa: "420.00", cajon: "3050.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const c = await configurarCustodia(sql, dir, codigo, buzon
    ? { lugar: "Buzón de recepción", acceso: [dir], lugarFondos: "Cajón con llave", accesoCajon: [matutina, vespertina], custodias: [matutina, vespertina], buzon: true }
    : { lugar: "Caja con llave de recepción", acceso: [matutina, vespertina], lugarFondos: "Cajón con llave", accesoCajon: [matutina, vespertina], custodias: [matutina, vespertina] },
  PRUEBAS);
  if (!c.ok) throw new Error(c.error);
  for (const lugar of ["bolsa_visitas", "cajon_mensualidades"]) {
    const r = await cambiarMontoFondo(sql, dir, codigo,
      { lugar, monto: "300", origen: "entrega_persona", destino: "", detalleOrigen: "Efectivo ficticio de Dirección", motivo: "Fondo provisional" }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const x = await confirmarEntradaFondo(sql, vespertina, codigo, { entradaId: r.entradaId!, recibido: "300" }, PRUEBAS);
    if (!x.ok) throw new Error(x.error);
  }
  for (const p of [admin, dir]) {
    expect(await dar(p, "reporte.caja", [s.id])).toEqual({ ok: true });
  }
  return { codigo, sucursalId: s.id, matutina, vespertina, admin, dir, encargada, turnoId: t.turnoId };
}
type Esc = Awaited<ReturnType<typeof escenario>>;

/** La vespertina cierra: bolsa $720 (sobre de $420) y cajón $3,350 (sobre de $3,050), los deposita en el buzón (o los deja en la caja). */
async function cerrarDelDia(e: Esc, { conteo = { bolsa: "720", cajon: "3350" }, buzon = true } = {}) {
  const p = await prepararCierre(sql, e.vespertina, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
  if (!p.ok) throw new Error(p.error);
  const caja = buzon ? [] : await sobresEnCaja(sql, e.sucursalId);
  const correctos = [...p.sobres, ...caja].map((x) => ({ sobreId: x.id, estado: "correcto", folioVisto: "", motivo: "" }));
  const r = await cerrarDia(sql, e.vespertina, e.codigo, {
    turnoId: e.turnoId, conteo, fondos: { bolsa: "300", cajon: "300" }, custodio: e.vespertina, nota: "", apoyo: NADIE,
    custodia: buzon ? { ubicacion: "Llavero de recepción", sobres: [], llave: LLAVE }
                    : { ubicacion: "Caja con llave de recepción", sobres: correctos, llave: LLAVE, llaveCaja: LLAVE },
    ...(buzon ? { depositados: p.sobres.map((s) => s.id) } : {}),
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return p.sobres;
}
async function abrir(e: Esc, { buzon = true } = {}) {
  const c = (await cierrePendiente(sql, e.sucursalId))!;
  const sobres = buzon ? [] : (await sobresEnCaja(sql, e.sucursalId)).map((x) => ({ sobreId: x.id, estado: "correcto", folioVisto: "", motivo: "" }));
  const r = await abrirDesdeCierre(sql, e.matutina, e.codigo, {
    entregaId: c.entregaId, version: c.version, sobres, conteo: { bolsa: "300", cajon: "300" }, apoyo: NADIE, llave: LLAVE, ...(buzon ? {} : { llaveCaja: LLAVE }),
  }, PRUEBAS);
  if (!r.ok || r.resultado !== "abierto") throw new Error("no abrió");
  e.turnoId = r.turnoId;
}
const caja = async (quien: string, e: Esc, corte?: string, periodo: { desde?: string; hasta?: string } = {}) => {
  const r = await reporteCaja(sql, quien, { codigo: e.codigo, corte, ...periodo });
  if (!r) throw new Error("sin reporte");
  return { ...r.filas[0], corte: r.corte };
};

describe.skipIf(!URL_ADMIN)("reporte de caja por sucursal y periodo", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
    for (const x of await sql<{ id: string; correo: string }[]>`select id, correo from usuario`) u[x.correo.replace("@prueba.fitnessland.invalid", "")] = x.id;
  });
  afterAll(async () => cerrar?.());

  it("ningún perfil trae los permisos; se dan por persona y descargar exige poder consultar esa sucursal", async () => {
    const roles = await sql`select rol from rol_permiso where permiso in ('reporte.caja', 'reporte.caja_descargar')`;
    expect(roles).toHaveLength(0);
    for (const quien of ["direccion", "direccion.general", "administracion", "encargado.tenango"]) {
      expect(await reporteCaja(sql, u[quien], { codigo: null })).toBeNull();
    }
    const yo = u["administracion"];
    // Descargar sin consultar: no se puede, ni en una sucursal ni en todas.
    expect(await dar(yo, "reporte.caja_descargar", [ids.TEN])).toEqual({ ok: false, error: "sin_consulta" });
    expect(await dar(yo, "reporte.caja", [ids.TEN])).toEqual({ ok: true });
    expect(await dar(yo, "reporte.caja_descargar", [ids.TEN, ids.STG])).toEqual({ ok: false, error: "sin_consulta" });
    expect(await dar(yo, "reporte.caja_descargar", "todas")).toEqual({ ok: false, error: "sin_consulta" });
    expect(await dar(yo, "reporte.caja_descargar", [ids.TEN])).toEqual({ ok: true });
    const r = await reporteCaja(sql, yo, { codigo: null });
    expect(r?.sucursales).toEqual([{ codigo: "TEN", nombre: expect.any(String), descargar: true }]);
    // Una sucursal que no puede consultar: misma respuesta que si no existiera.
    expect(await reporteCaja(sql, yo, { codigo: "STG" })).toBeNull();
    // En todas solo con la consulta en todas (que incluye las futuras).
    expect(await dar(yo, "reporte.caja", "todas")).toEqual({ ok: true });
    expect(await dar(yo, "reporte.caja_descargar", "todas")).toEqual({ ok: true });
    // La base tampoco registra una descarga de quien no puede descargar.
    await expect(sql`insert into descarga_reporte_caja (usuario_id, sucursales, desde, hasta, corte, formato, contenido, con_ocultos, con_anotados_sin_contar)
                     values (${u["direccion"]}, ${[ids.TEN]}::uuid[], current_date, current_date, now(), 'pdf', 'resumen', false, false)`).rejects.toThrow(/consultar y descargar/);
  });

  it("cada peso en una sola etapa al corte; lo recogido cuenta con lo contado y la diferencia va aparte; el corte se conserva", async () => {
    const e = await escenario();
    const antes = await caja(e.admin, e);
    expect(antes.lugares.map((l) => [l.tipo, l.estado, l.importe])).toEqual([["bolsa_visitas", "turno", "720.00"], ["cajon_mensualidades", "turno", "3350.00"]]);
    expect(antes.lugares[1].base).toMatchObject({ importe: "3050.00", momento: "apertura" });

    const sobres = await cerrarDelDia(e);
    const t1 = await reloj();
    await abrir(e);
    const t2 = await reloj();
    const [bolsa, cajon] = sobres;
    const r = await recogerBuzon(sql, e.dir, e.codigo, { sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" },
      { sobreId: cajon.id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
    ], llave: LLAVE }, PRUEBAS);
    expect(r).toMatchObject({ ok: true, recogido: "3420.00", diferencias: 1 });
    const t3 = await reloj();
    const [{ id: rid }] = await sql<{ id: string }[]>`select id from recoleccion where sucursal_id = ${e.sucursalId}`;
    expect(await registrarDepositoRecoleccion(sql, e.dir, e.codigo, { recoleccionId: rid, importe: "1000", fecha: hoy(), referencia: "DEP-PRUEBA-1" }, PRUEBAS)).toMatchObject({ ok: true });
    const t4 = await reloj();
    expect(await registrarDepositoRecoleccion(sql, e.dir, e.codigo, { recoleccionId: rid, importe: "2420", fecha: hoy(), referencia: "DEP-PRUEBA-2" }, PRUEBAS)).toMatchObject({ ok: true });

    // De noche (t1): fondos en el cajón con llave y los dos sobres en el buzón. Administración ve lo anotado.
    const noche = await caja(e.admin, e, t1);
    expect(noche.lugares.map((l) => [l.estado, l.importe])).toEqual([["cerrado", "300.00"], ["cerrado", "300.00"]]);
    expect(noche.sobres.map((s) => [s.folio, s.donde, s.anotado])).toEqual([[bolsa.folio, "buzon", "420.00"], [cajon.folio, "buzon", "3050.00"]]);
    expect(noche).toMatchObject({ visible: "4070.00", ocultos: 0, anotadosSinContar: true });
    expect(noche.corte.toISOString()).toBe(t1);
    // Al abrir (t2): turno con los fondos; los sobres siguen en el buzón.
    const abierta = await caja(e.admin, e, t2);
    expect(abierta.lugares.map((l) => [l.estado, l.importe])).toEqual([["turno", "300.00"], ["turno", "300.00"]]);
    expect(abierta.sobres).toHaveLength(2);
    // Recogido (t3): lo contado ($3,420) por depositar, una sola vez; los −$50 aparte, por revisar.
    const recogida = await caja(e.admin, e, t3);
    expect(recogida.sobres).toHaveLength(0);
    expect(recogida.confirmados).toEqual([expect.objectContaining({ clase: "recoleccion", recogido: "3420.00", depositado: "0.00", saldo: "3420.00" })]);
    expect(recogida.visible).toBe("4020.00");
    expect(recogida.diferencias.map((d) => [d.clase, d.importe, d.estado])).toEqual([["sobre", "-50.00", "Por revisar"]]);
    // Depósito parcial (t4) y completo (ahora): sale de la etapa 4 y aparece en «Depositado».
    const parcial = await caja(e.admin, e, t4);
    expect(parcial.confirmados[0]).toMatchObject({ saldo: "2420.00" });
    expect(parcial.depositos.map((d) => d.importe)).toEqual(["1000.00"]);
    const ahora = await caja(e.admin, e);
    expect(ahora.confirmados).toEqual([]);
    expect(ahora.movimientos.depositado).toEqual({ n: 2, importe: "3420.00" });
    expect(ahora.movimientos.recogido).toEqual({ n: 1, importe: "3420.00" });
    expect(ahora.movimientos.sellados).toEqual({ n: 2, anotado: "3470.00", ocultos: 0 });

    // El detalle conserva el corte: al corte t3 la recolección tenía $3,420 por depositar; lo posterior va marcado.
    const d = await detalleCaja(sql, e.admin, { codigo: e.codigo, tipo: "recoleccion", id: rid, corte: t3 });
    expect(d?.corte.toISOString()).toBe(t3);
    expect(d?.detalle.importeAlCorte).toBe("3420.00");
    expect(d?.detalle.eventos.filter((x) => x.despues).map((x) => x.texto)).toEqual([
      expect.stringContaining("DEP-PRUEBA-1"), expect.stringContaining("DEP-PRUEBA-2"),
    ]);
  });

  it("conteo a ciegas: quien recoge no ve lo anotado de sobres sin contar (subtotal visible), tampoco en el detalle", async () => {
    const e = await escenario();
    const [bolsa] = await cerrarDelDia(e);
    await abrir(e);
    const dir = await caja(e.dir, e);
    expect(dir.recogedor).toBe(true);
    expect(dir.sobres.map((s) => [s.anotado, s.oculto])).toEqual([[null, true], [null, true]]);
    expect(dir).toMatchObject({ visible: "600.00", ocultos: 2, anotadosSinContar: false });
    expect(dir.movimientos.sellados).toEqual({ n: 2, anotado: null, ocultos: 2 });
    const det = await detalleCaja(sql, e.dir, { codigo: e.codigo, tipo: "sobre", id: bolsa.id });
    expect(det?.detalle).toMatchObject({ oculto: true, importeAlCorte: null, alCorte: "En el buzón, por recoger" });
    expect(det?.detalle.filas[0]).toMatchObject({ etiqueta: "Anotado al cerrar", valor: null });
    expect(det?.detalle.eventos.map((x) => x.texto).join(" | ")).not.toMatch(/\$/);
    // Administración, que no recoge, sí ve los importes (y el archivo llevaría la leyenda).
    const admin = await caja(e.admin, e);
    expect(admin).toMatchObject({ visible: "4070.00", ocultos: 0, anotadosSinContar: true });
  });

  it("retiros: lo entregado y pendiente de confirmar va aparte de lo confirmado; un saldo anterior al periodo sigue apareciendo", async () => {
    const e = await escenario();
    const entregar = async (lugar: "bolsa_visitas" | "cajon_mensualidades", contado: string) => {
      const f = await generarFolio(sql, e.vespertina, e.codigo, { turnoId: e.turnoId, lugar }, PRUEBAS);
      if (!f.ok) throw new Error(f.error);
      const r = await registrarRetiro(sql, e.vespertina, e.codigo, { turnoId: e.turnoId, folioId: f.folioId, contado, cambio: "0", encargada: e.encargada }, PRUEBAS);
      if (!r.ok) throw new Error(r.error);
      return r.retiroId;
    };
    const viejo = await entregar("cajon_mensualidades", "1500");
    expect(await confirmarRetiro(sql, e.encargada, { retiroId: viejo, version: 1, importe: "1500", folioCoincide: true, folioEnSobre: "", motivo: "" }, PRUEBAS))
      .toMatchObject({ ok: true });
    // El retiro «viejo» se entregó y confirmó hace tres días (antes del periodo de hoy).
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update retiro set entregado_en = entregado_en - interval '3 days', habilitado_en = habilitado_en - interval '3 days' where id = ${viejo}`;
    });
    const nuevo = await entregar("bolsa_visitas", "100");
    const hoyMx = hoy();
    const r = await caja(e.admin, e, undefined, { desde: hoyMx, hasta: hoyMx });
    expect(r.pendientes).toEqual([expect.objectContaining({ clase: "retiro", id: nuevo, importe: "100.00", oculto: false, anterior: false })]);
    expect(r.confirmados).toEqual([expect.objectContaining({ clase: "retiro", id: viejo, saldo: "1500.00", aviso: true, anterior: true })]);
    // En «Movimientos» solo lo del periodo: el retiro de hoy.
    expect(r.movimientos.retiros).toMatchObject({ n: 1, importe: "100.00", pendientes: 1, confirmados: 0 });
    // La bolsa y el cajón ya descuentan lo entregado: nada se cuenta dos veces.
    expect(r.lugares.map((l) => l.importe)).toEqual(["620.00", "1850.00"]);
    // Encargada de retiros no ve el importe de un retiro suyo pendiente de confirmar (si tuviera el reporte).
    expect(await dar(e.encargada, "reporte.caja", [e.sucursalId])).toEqual({ ok: true });
    const suya = await caja(e.encargada, e);
    expect(suya.pendientes[0]).toMatchObject({ importe: null, oculto: true });
    expect(suya.ocultos).toBe(1);
  });

  it("descarga: solo con las sucursales que puede descargar, nombra las excluidas y queda en el historial", async () => {
    const e = await escenario();
    const otra = await escenario();
    // Puede consultar las dos, pero descargar solo la primera.
    expect(await dar(e.admin, "reporte.caja", [otra.sucursalId])).toEqual({ ok: true });
    expect(await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "resumen" }, PRUEBAS)).toEqual({ ok: false, error: "sin_descarga" });
    expect(await dar(e.admin, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    expect(await prepararDescarga(sql, e.admin, { codigo: null, formato: "doc", contenido: "resumen" }, PRUEBAS)).toEqual({ ok: false, error: "formato" });
    expect(await prepararDescarga(sql, e.admin, { codigo: null, formato: "pdf", contenido: "resumen" }, { entorno: "produccion" })).toEqual({ ok: false, error: "bloqueado_produccion" });
    const corte = await reloj();
    const d = await prepararDescarga(sql, e.admin, { codigo: null, formato: "pdf", contenido: "detalle", corte }, PRUEBAS);
    if (!d.ok) throw new Error(d.error);
    expect(d.archivo.reporte.filas.map((f) => f.codigo)).toEqual([e.codigo]);
    expect(d.archivo.excluidas).toEqual([`Sucursal caja ${k}`]);
    expect(d.archivo.reporte.corte.toISOString()).toBe(corte);
    expect(d.archivo.detalles.get(e.codigo)?.length).toBeGreaterThan(0);
    const h = await historialDescargas(sql, [e.sucursalId]);
    expect(h[0]).toMatchObject({ formato: "pdf", contenido: "detalle", sucursales: [`Sucursal caja ${k - 1}`], excluidas: [`Sucursal caja ${k}`] });
    expect(h[0].corte.toISOString()).toBe(corte);
    // Si pierde la consulta, la descarga deja de funcionar sola.
    const [f] = await sql<{ id: string }[]>`select id from facultad_otorgada where usuario_id = ${e.admin} and permiso = 'reporte.caja' and sucursal_id = ${e.sucursalId}`;
    expect(await cambiar(e.admin, { tipo: "quitar_permiso", id: f.id, motivo: "Prueba: deja de consultar" })).toEqual({ ok: true });
    expect(await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "resumen" }, PRUEBAS)).toEqual({ ok: false, error: "no_encontrada" });
    // Y su resumen ya no muestra la descarga en esa sucursal (sin consulta no tiene efecto).
    const resumen = await resumenPermisos(sql, e.admin);
    expect(resumen.permisos.find((p) => p.clave === "reporte.caja_descargar")).toBeUndefined();
  });

  it("la diferencia de un cierre muestra su estado AL CORTE en el reporte, su detalle, el Excel y el PDF", async () => {
    const e = await escenario();
    // Cierra con $20 menos en la bolsa: diferencia contra lo esperado, por revisar.
    await cerrarDelDia(e, { conteo: { bolsa: "700", cajon: "3350" } });
    await abrir(e);
    const t1 = await reloj();
    const [dif] = await sql<{ id: string }[]>`select d.id from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id where l.sucursal_id = ${e.sucursalId}`;
    const encargado = await cuenta([["encargado", e.codigo]], "Encargado");
    expect(await revisarDiferencia(sql, encargado, e.codigo, { diferenciaId: dif.id, resultado: "faltante_confirmado", motivo: "Prueba: faltan 20 pesos" }, PRUEBAS))
      .toMatchObject({ ok: true });
    const antes = await caja(e.admin, e, t1);
    expect(antes.diferencias.map((d) => [d.clase, d.importe, d.estado, d.enlace.tipo])).toEqual([["turno", "-20.00", "Por revisar", "diferencia"]]);
    const ahora = await caja(e.admin, e);
    expect(ahora.diferencias[0].estado).toBe("Faltante confirmado · pendiente para Dirección");
    const d = (await detalleCaja(sql, e.admin, { codigo: e.codigo, tipo: "diferencia", id: dif.id, corte: t1 }))!;
    expect(d.detalle.alCorte).toBe("Estado al corte: Por revisar");
    expect(d.detalle.titulo).toMatch(new RegExp(`^${e.codigo}-D\\d+ · Cierre del .* · contra el esperado$`));
    expect(d.detalle.eventos.filter((x) => x.despues).map((x) => x.texto)).toEqual([expect.stringMatching(/^Revisó: Faltante confirmado/)]);
    expect(d.detalle.eventos.filter((x) => !x.despues).map((x) => x.texto).join(" | ")).not.toMatch(/Revisó/);
    expect(await dar(e.admin, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    const r = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "detalle", corte: t1 }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const { excel, pdf } = await archivos(r.archivo);
    for (const t of [excel, pdf]) {
      expect(t).toContain("Estado al corte: Por revisar");
      expect(t).not.toContain("Revisó");
      expect(t).not.toContain("pendiente para Dirección");
    }
  });

  it("la recolección confirmada después del corte no muestra conteos en su tabla: solo como información posterior, y fuera del archivo", async () => {
    const e = await escenario({ buzon: false });
    const sobres = await cerrarDelDia(e, { buzon: false });
    await abrir(e, { buzon: false });
    const en = await registrarEntregaSobres(sql, e.matutina, e.codigo, { sobres: sobres.map((x) => x.id), recibe: e.dir }, PRUEBAS);
    if (!en.ok) throw new Error(en.error);
    const t1 = await reloj();
    const [{ version }] = await sql<{ version: number }[]>`select version from recoleccion where id = ${en.recoleccionId}`;
    const ok = await confirmarRecoleccion(sql, e.dir, e.codigo, { recoleccionId: en.recoleccionId, version, llave: LLAVE, sobres: [
      { sobreId: sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" },
      { sobreId: sobres[1].id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
    ] }, PRUEBAS);
    expect(ok).toMatchObject({ ok: true, recogido: "3420.00" });
    // Al corte t1 la entrega estaba pendiente de confirmar: así aparece en el reporte.
    const r1 = await caja(e.admin, e, t1);
    expect(r1.pendientes).toEqual([expect.objectContaining({ clase: "entrega_sobres", importe: "3470.00" })]);
    expect(r1.confirmados).toEqual([]);
    const d = (await detalleCaja(sql, e.admin, { codigo: e.codigo, tipo: "recoleccion", id: en.recoleccionId, corte: t1 }))!.detalle;
    expect(d.alCorte).toMatch(/pendiente de confirmar/);
    expect(d.tabla!.columnas).toEqual(["Sobre", "Lugar", "Anotado al cerrar", "Contado al corte"]);
    expect(d.tabla!.filas.map((f) => f.celdas[3])).toEqual(["Sin contar al corte", "Sin contar al corte"]);
    expect(d.filas.map((f) => f.etiqueta).join(" | ")).not.toMatch(/Recogido|contado/i);
    expect(d.eventos.filter((x) => x.despues).map((x) => x.texto)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Confirmó la recepción/), `Sobre ${sobres[1].folio}: contó $3,000.00`,
    ]));
    expect(d.eventos.filter((x) => !x.despues).map((x) => x.texto).join(" | ")).not.toMatch(/contó/);
    // Conteo a ciegas intacto: antes de confirmar, Dirección no veía lo anotado (ni en la tabla).
    expect(await dar(e.admin, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    const r = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "pdf", contenido: "detalle", corte: t1 }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const { excel, pdf } = await archivos(r.archivo);
    for (const t of [excel, pdf]) {
      expect(t).toContain("Sin contar al corte");
      expect(t).not.toMatch(/contó|3000|3,000/);
    }
  });

  it("entradas al fondo pendientes de confirmar: aparte, con estado y personas; no se suman hasta recibirse", async () => {
    const e = await escenario();
    const subir = await cambiarMontoFondo(sql, e.dir, e.codigo,
      { lugar: "bolsa_visitas", monto: "500", origen: "entrega_persona", destino: "", detalleOrigen: "Efectivo ficticio de Dirección", motivo: "Más cambio para el fin de semana" }, PRUEBAS);
    if (!subir.ok) throw new Error(subir.error);
    const t1 = await reloj();
    const pend = await caja(e.admin, e, t1);
    expect(pend.entradas).toEqual([expect.objectContaining({ id: subir.entradaId, tipo: "aumento", lugar: "bolsa_visitas", importe: "200.00", intentos: 0 })]);
    expect(pend.entradas[0].entrega).toMatch(/^Dirección/);
    // No se suma: la bolsa y el total siguen igual.
    expect(pend.lugares[0].importe).toBe("720.00");
    expect(pend.visible).toBe("4070.00");
    // Un intento que no coincide queda a la vista; luego se confirma.
    expect(await confirmarEntradaFondo(sql, e.vespertina, e.codigo, { entradaId: subir.entradaId!, recibido: "150" }, PRUEBAS)).toEqual({ ok: false, error: "no_coincide" });
    expect((await caja(e.admin, e)).entradas[0].intentos).toBe(1);
    expect(await confirmarEntradaFondo(sql, e.vespertina, e.codigo, { entradaId: subir.entradaId!, recibido: "200" }, PRUEBAS)).toEqual({ ok: true });
    const recibida = await caja(e.admin, e);
    expect(recibida.entradas).toEqual([]);
    expect(recibida.lugares[0].importe).toBe("920.00");
    // Con el corte anterior sigue pendiente (no desaparece) y su detalle deja la confirmación como posterior.
    expect((await caja(e.admin, e, t1)).entradas).toHaveLength(1);
    const d = (await detalleCaja(sql, e.admin, { codigo: e.codigo, tipo: "entrada_fondo", id: subir.entradaId!, corte: t1 }))!.detalle;
    expect(d.alCorte).toMatch(/^Pendiente de confirmar: la tiene Dirección/);
    expect(d.eventos.filter((x) => x.despues).map((x) => x.texto)).toEqual([expect.stringMatching(/no coincide/), expect.stringMatching(/^Confirmó lo recibido/)]);
    expect(await dar(e.admin, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    const r = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "detalle", corte: t1 }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    await guardar("entradas-fondo", r.archivo);
    const { excel, pdf } = await archivos(r.archivo);
    for (const t of [excel, pdf]) {
      expect(t).toContain("entrada al fondo sin confirmar");
      expect(t).toMatch(/Pendiente de confirmar: la tiene Dirección/);
      expect(t).not.toContain("Confirmó lo recibido");
    }
  });

  it("sin ningún importe conocido el total dice «Sin datos» (no $0.00); un cero registrado sí es $0.00, en pantalla, Excel y PDF", async () => {
    k++;
    const codigo = `K${k}`;
    const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal sin datos " + k}, ${codigo}) returning id`;
    ids[codigo] = s.id;
    const admin = await cuenta([["administracion", codigo]], "Administración");
    expect(await dar(admin, "reporte.caja", [s.id])).toEqual({ ok: true });
    expect(await dar(admin, "reporte.caja_descargar", [s.id])).toEqual({ ok: true });
    const rep = (await reporteCaja(sql, admin, { codigo }))!;
    const r = rep.filas[0];
    expect(r.lugares.map((l) => [l.estado, l.importe])).toEqual([["sin_datos", null], ["sin_datos", null]]);
    expect(r).toMatchObject({ sinDatos: 2, ocultos: 0 });
    const res = resumirCaja(r, rep.corte);
    expect(res.total).toMatchObject({ tipo: "sin_datos", importe: null });
    expect(res.enSucursal.importe).toBeNull();
    // Sin registros al corte: $0.00 y «0 sobres registrados» (es un dato, no un faltante).
    expect(res.sobres).toMatchObject({ importe: "0.00", nota: "0 sobres registrados" });
    const d = (await detalleCaja(sql, admin, { codigo, tipo: "lugar", id: r.lugares[0].lugarId }))!.detalle;
    expect(d).toMatchObject({ sinDatos: true, importeAlCorte: null });
    const a = await prepararDescarga(sql, admin, { codigo, formato: "xlsx", contenido: "detalle" }, PRUEBAS);
    if (!a.ok) throw new Error(a.error);
    await guardar("sin-datos", a.archivo);
    const resumen = tablaHoja((await hojasExcel(await excelCaja(a.archivo))).Resumen);
    const fila = (concepto: string) => resumen.find((x) => x.Concepto === concepto)!;
    expect(fila("En la sucursal · bolsa de visitas")).toMatchObject({ Importe: "", "Estado del importe": "Sin datos" });
    expect(fila("En la sucursal · cajón de mensualidades")).toMatchObject({ Importe: "", "Estado del importe": "Sin datos" });
    expect(fila("Total al corte")).toMatchObject({ Importe: "", "Estado del importe": "Sin datos" });
    expect(fila("Sobres por recoger")).toMatchObject({ Importe: "0", "Estado del importe": "Sin registros", Limitación: "0 sobres registrados al corte" });
    const { excel, pdf } = await archivos(a.archivo);
    for (const t of [excel, pdf]) {
      expect(t).toContain("no hay ningún importe conocido");
      expect(t).not.toContain("Total registrado al corte");
      expect(t).not.toContain("Subtotal visible");
    }
    expect(pdf).toMatch(/En la sucursal .*No es cero\. Sin datos/);
    expect(pdf).toContain("Sin pendientes: 0 sobres registrados por recoger · 0 entregas por confirmar · nada por depositar.");
    expect(pdf).toContain("Total al corte");
  });

  it("caso B: sin conteos de bolsa y cajón, con dinero confirmado por depositar: subtotal visible y qué falta", async () => {
    const e = await escenario();
    const f = await generarFolio(sql, e.vespertina, e.codigo, { turnoId: e.turnoId, lugar: "cajon_mensualidades" }, PRUEBAS);
    if (!f.ok) throw new Error(f.error);
    const x = await registrarRetiro(sql, e.vespertina, e.codigo, { turnoId: e.turnoId, folioId: f.folioId, contado: "800", cambio: "0", encargada: e.encargada }, PRUEBAS);
    if (!x.ok) throw new Error(x.error);
    expect(await confirmarRetiro(sql, e.encargada, { retiroId: x.retiroId, version: 1, importe: "800", folioCoincide: true, folioEnSobre: "", motivo: "" }, PRUEBAS))
      .toMatchObject({ ok: true });
    // Datos ficticios armados para el caso: el retiro quedó confirmado hace dos días y la sucursal no tenía turnos ni
    // conteos registrados al corte de ayer.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update retiro set entregado_en = entregado_en - interval '2 days', habilitado_en = habilitado_en - interval '2 days' where id = ${x.retiroId}`;
      await tx`update retiro_conteo set en = en - interval '2 days' where retiro_id = ${x.retiroId}`;
    });
    const ayer = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 86_400_000));
    const hace3 = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 3 * 86_400_000));
    const r = await caja(e.admin, e, undefined, { desde: hace3, hasta: ayer });
    expect(r.lugares.map((l) => l.estado)).toEqual(["sin_datos", "sin_datos"]);
    expect(r.confirmados).toEqual([expect.objectContaining({ clase: "retiro", saldo: "800.00" })]);
    const s = resumirCaja(r, r.corte);
    expect(s.total).toMatchObject({ tipo: "subtotal", etiqueta: "Subtotal visible al corte", importe: "800.00", faltan: ["los datos de bolsa y cajón (sin conteos registrados)"] });
    expect(s.total.nota).toBe("No es el total: faltan los datos de bolsa y cajón (sin conteos registrados). Incompleto: faltan las mensualidades de Open Desk.");
    // Lectura rápida: «En la sucursal» sin datos; lo que está en cero, agrupado en una línea.
    const l = lectura(s);
    expect(l.efectivo.map((x) => [x.etiqueta, x.importe])).toEqual([["En la sucursal", null], ["Confirmado, por depositar", "800.00"]]);
    expect(l.ceros).toEqual(["0 sobres registrados por recoger", "0 entregas por confirmar"]);
    expect(s.enSucursal.importe).toBeNull();
    expect(s.sobres).toMatchObject({ importe: "0.00", nota: "0 sobres registrados" });
    expect(s.porDepositar.importe).toBe("800.00");
    expect(await dar(e.admin, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    const a = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "resumen", desde: hace3, hasta: ayer }, PRUEBAS);
    if (!a.ok) throw new Error(a.error);
    await guardar("caso-b-sin-conteos", a.archivo);
    const resumen = tablaHoja((await hojasExcel(await excelCaja(a.archivo))).Resumen);
    expect(resumen.slice(0, 6).map((x) => [x.Concepto, x.Importe, x["Estado del importe"]])).toEqual([
      ["En la sucursal · bolsa de visitas", "", "Sin datos"], ["En la sucursal · cajón de mensualidades", "", "Sin datos"],
      ["Sobres por recoger", "0", "Sin registros"], ["Entregado, pendiente de confirmar", "0", "Sin registros"],
      ["Confirmado, por depositar", "800", "Contado"], ["Subtotal visible al corte", "800", "Subtotal visible"],
    ]);
    expect(resumen[5].Limitación).toContain("No es el total: faltan los datos de bolsa y cajón");
    const { pdf } = await archivos(a.archivo);
    expect(pdf).toContain("Subtotal visible al corte");
    expect(pdf).toContain("No es el total: faltan los datos de bolsa y cajón (sin conteos registrados)");
    expect(pdf).toContain("$800.00");
    expect(pdf).not.toContain("Total registrado al corte");
  });

  it("caso A: depósitos parciales antes y durante el periodo, varios del mismo origen, sin duplicar importes", async () => {
    const e = await escenario();
    const hoyMx = hoy();
    // Recolección: anotado $3,470, contado $3,420 (diferencia −$50). Depósitos: $400 antes del periodo; $1,000 y $1,000 durante.
    const [bolsa, cajon] = await cerrarDelDia(e);
    await abrir(e);
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" },
      { sobreId: cajon.id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
    ], llave: LLAVE }, PRUEBAS)).toMatchObject({ ok: true, recogido: "3420.00" });
    const [{ id: rid }] = await sql<{ id: string }[]>`select id from recoleccion where sucursal_id = ${e.sucursalId}`;
    const depRec = (importe: string, referencia: string) => registrarDepositoRecoleccion(sql, e.dir, e.codigo, { recoleccionId: rid, importe, fecha: hoyMx, referencia }, PRUEBAS);
    expect(await depRec("400", "DEP-ANTES-01")).toMatchObject({ ok: true });
    // Retiro de $280: $100 antes del periodo; $120 y $40 durante; saldo $20.
    const f = await generarFolio(sql, e.matutina, e.codigo, { turnoId: e.turnoId, lugar: "cajon_mensualidades" }, PRUEBAS);
    if (!f.ok) throw new Error(f.error);
    const x = await registrarRetiro(sql, e.matutina, e.codigo, { turnoId: e.turnoId, folioId: f.folioId, contado: "280", cambio: "0", encargada: e.encargada }, PRUEBAS);
    if (!x.ok) throw new Error(x.error);
    expect(await confirmarRetiro(sql, e.encargada, { retiroId: x.retiroId, version: 1, importe: "280", folioCoincide: true, folioEnSobre: "", motivo: "" }, PRUEBAS))
      .toMatchObject({ ok: true });
    const ahoraLocal = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Mexico_City", dateStyle: "short", timeStyle: "short" }).format(new Date()).replace(" ", "T");
    const depRet = (importe: string, referencia: string) =>
      registrarDeposito(sql, e.encargada, { retiroId: x.retiroId, importe, depositadoEn: ahoraLocal(), referencia, corrige: null, motivo: "" }, PRUEBAS);
    expect(await depRet("100", "DEP-ANTES-02")).toMatchObject({ ok: true });
    // Todo lo anterior pasó hace tres días (antes del periodo de hoy).
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recoleccion set creada_en = creada_en - interval '3 days', resuelta_en = resuelta_en - interval '3 days' where id = ${rid}`;
      await tx`update diferencia_sobre set creada_en = creada_en - interval '3 days' where recoleccion_id = ${rid}`;
      await tx`update sobre_cierre set resuelto_en = resuelto_en - interval '3 days' where id in (${bolsa.id}, ${cajon.id})`;
      await tx`update deposito_recoleccion set en = en - interval '3 days', fecha = fecha - 3 where recoleccion_id = ${rid}`;
      await tx`update retiro set entregado_en = entregado_en - interval '3 days', habilitado_en = habilitado_en - interval '3 days' where id = ${x.retiroId}`;
      await tx`update retiro_conteo set en = en - interval '3 days' where retiro_id = ${x.retiroId}`;
      await tx`update deposito_retiro set en = en - interval '3 days', depositado_en = depositado_en - interval '3 days' where retiro_id = ${x.retiroId}`;
    });
    expect(await depRec("1000", "DEP-DURANTE-01")).toMatchObject({ ok: true });
    expect(await depRec("1000", "DEP-DURANTE-02")).toMatchObject({ ok: true });
    expect(await depRet("120", "DEP-DURANTE-03")).toMatchObject({ ok: true });
    expect(await depRet("40", "DEP-DURANTE-04")).toMatchObject({ ok: true });

    const r = await caja(e.admin, e, undefined, { desde: hoyMx, hasta: hoyMx });
    expect(r.origenes.map((o) => [o.clase, o.anterior, o.registrado, o.diferencia, o.contado, o.antes, o.durante, o.saldo])).toEqual([
      ["recoleccion", true, "3470.00", "-50.00", "3420.00", "400.00", "2000.00", "1020.00"],
      ["retiro", true, "280.00", "0.00", "280.00", "100.00", "160.00", "20.00"],
    ]);
    // La diferencia del sobre (anterior, aún por revisar) conserva su clave y se liga a su origen.
    const dif = r.diferencias.find((d) => d.clase === "sobre")!;
    expect(dif).toMatchObject({ importe: "-50.00", anterior: true, abierta: true, referencia: false });
    expect(r.origenes[0].claves).toEqual([dif.clave]);
    // Solo los depósitos del periodo, cada uno una vez: 1,000 + 1,000 + 120 + 40 = 2,160 = «Depositado durante el periodo».
    expect(r.depositos.map((d) => d.referencia).sort()).toEqual(["DEP-DURANTE-01", "DEP-DURANTE-02", "DEP-DURANTE-03", "DEP-DURANTE-04"]);
    const s = resumirCaja(r, r.corte);
    expect(s.depositado).toEqual({ importe: "2160.00", n: 4 });
    // El saldo al corte es «Por depositar»: 1,020 + 20.
    expect(s.porDepositar.importe).toBe("1040.00");
    // Contado = antes + durante + saldo, por fila.
    for (const o of r.origenes) expect(Number(o.antes) + Number(o.durante) + Number(o.saldo)).toBeCloseTo(Number(o.contado), 2);
    // Antigüedad desde que se confirmó: 3 días completos → «3 a 7 días».
    expect(s.porPersona.map((p) => [p.rangos, p.total])).toEqual(expect.arrayContaining([[[0, 102000, 0], 102000], [[0, 2000, 0], 2000]]));

    expect(await dar(e.admin, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    for (const formato of ["xlsx", "pdf"]) {
      const a = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato, contenido: "detalle", desde: hoyMx, hasta: hoyMx }, PRUEBAS);
      if (!a.ok) throw new Error(a.error);
      if (formato === "pdf") {
        await guardar("caso-a-depositos-parciales", a.archivo);
        const { pdf } = await archivos(a.archivo);
        expect(pdf).toContain("Origen y destino del dinero");
        expect(pdf).toContain("$2,160.00");
        expect(pdf).toContain("$1,040.00");
        // Lo depositado antes del periodo solo aparece como referencia del origen y en su historial, nunca como depósito del periodo.
        expect(pdf).toContain("Ya depositado en el periodo, no se suma: $2,160.00 · 4 depósitos");
        continue;
      }
      const h = await hojasExcel(await excelCaja(a.archivo));
      expect(Object.keys(h)).toEqual(["Resumen", "Por persona", "Por folio", "Depositado", "Diferencias", "Movimientos", "Origen y destino", "Historial", "Notas"]);
      const depositado = tablaHoja(h.Depositado);
      expect(depositado.map((x) => x.Referencia).sort()).toEqual(["DEP-DURANTE-01", "DEP-DURANTE-02", "DEP-DURANTE-03", "DEP-DURANTE-04"]);
      expect(depositado.reduce((n, x) => n + Number(x["Importe depositado"]), 0)).toBe(2160);
      expect(depositado.filter((x) => x.Origen === "Retiro").map((x) => [x["Depositado del origen antes del periodo"], x["Saldo del origen al corte"]]))
        .toEqual([["100", "20"], ["100", "20"]]);
      const od = tablaHoja(h["Origen y destino"]);
      expect(od.at(-1)).toMatchObject({ Origen: "Total", "Depositado antes del periodo": "500", "Depositado durante el periodo": "2160", "Saldo al corte": "1040" });
      expect(od[0].Claves).toBe(dif.clave);
      const difs = tablaHoja(h.Diferencias);
      expect(difs.map((x) => [x.Clave, x.Importe, x["Anterior al periodo"]])).toEqual([[dif.clave, "-50", "Sí"]]);
      // «Por folio» solo lleva lo que sigue en custodia: los saldos, no lo depositado.
      const folios = tablaHoja(h["Por folio"]).filter((x) => x["Etapa al corte"].startsWith("Confirmado"));
      expect(folios.map((x) => x.Importe).sort()).toEqual(["1020", "20"]);
      // «Historial»: una fila por evento, sin lo posterior al corte.
      const eventos = tablaHoja(h.Historial).filter((x) => x.Tipo === "Evento");
      expect(eventos.filter((x) => /DEP-DURANTE-01/.test(x.Descripción))).toHaveLength(1);
      expect(eventos.filter((x) => /DEP-ANTES-01/.test(x.Descripción))).toHaveLength(1);
    }
  });

  it("rangos de antigüedad por días completos, sin traslapes", () => {
    const corte = new Date("2026-11-22T23:40:00Z");
    const hace = (h: number) => new Date(corte.getTime() - h * 3_600_000);
    expect([0, 47, 48, 71, 72, 191, 192].map((h) => diasEntre(hace(h), corte))).toEqual([0, 1, 2, 2, 3, 7, 8]);
    expect([0, 1, 2, 3, 7, 8, 30].map(rango)).toEqual([0, 0, 0, 1, 1, 2, 2]);
  });

  it("archivos: quien recoge descarga los importes ocultos y un subtotal; quien no recoge, la leyenda de anotados sin contar", async () => {
    const e = await escenario();
    await cerrarDelDia(e);
    await abrir(e);
    for (const p of [e.admin, e.dir]) expect(await dar(p, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    const leer = textoExcel;
    const dir = await prepararDescarga(sql, e.dir, { codigo: e.codigo, formato: "xlsx", contenido: "detalle" }, PRUEBAS);
    if (!dir.ok) throw new Error(dir.error);
    const tDir = await leer(await excelCaja(dir.archivo));
    expect(tDir).toContain("Subtotal visible al corte");
    expect(tDir).toContain(OCULTO);
    expect(tDir).toContain("mensualidades de Open Desk");
    await guardar("ciegas-direccion", dir.archivo);
    expect(tDir).not.toContain(LEYENDA_ANOTADOS);
    // Ni en el detalle ni en el historial aparece lo anotado de los sobres sin contar.
    expect(tDir).not.toMatch(/3050|3,050|\$420/);
    const admin = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "resumen" }, PRUEBAS);
    if (!admin.ok) throw new Error(admin.error);
    const tAdmin = await leer(await excelCaja(admin.archivo));
    expect(tAdmin).toContain(LEYENDA_ANOTADOS);
    expect(tAdmin).toContain("Total registrado al corte");
    expect(tAdmin).toContain("3050");
    await guardar("anotados-administracion", admin.archivo);
    const pdf = await pdfCaja(admin.archivo);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const h = await historialDescargas(sql, [e.sucursalId]);
    expect(h.slice(0, 2).map((x) => [x.conOcultos, x.conAnotados])).toEqual([[false, true], [true, false]]);
  });

  it("faltantes confirmados de un retiro y de un sobre: pendientes de resolución, por separado; Dirección que no participó los resuelve sin mover efectivo", async () => {
    const e = await escenario();
    const encargado = await cuenta([["encargado", e.codigo]], "Encargado");
    // Sobre: Dirección recoge el buzón (participa en su cadena) y cuenta $50 menos en el cajón; Administración lo confirma.
    const [bolsa, cajon] = await cerrarDelDia(e);
    await abrir(e);
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" },
      { sobreId: cajon.id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
    ], llave: LLAVE }, PRUEBAS)).toMatchObject({ ok: true, recogido: "3420.00" });
    const [difSobre] = await sql<{ id: string }[]>`select d.id from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id where s.sucursal_id = ${e.sucursalId}`;
    expect(await revisarDiferenciaSobre(sql, e.admin, e.codigo, { diferenciaId: difSobre.id, resultado: "faltante_confirmado", motivo: "Prueba: faltan 50 pesos" }, PRUEBAS))
      .toEqual({ ok: true });
    // Retiro: se registran $280; Encargada de retiros cuenta $250, no hay recuento y el Encargado confirma el faltante.
    const f = await generarFolio(sql, e.matutina, e.codigo, { turnoId: e.turnoId, lugar: "cajon_mensualidades" }, PRUEBAS);
    if (!f.ok) throw new Error(f.error);
    const x = await registrarRetiro(sql, e.matutina, e.codigo, { turnoId: e.turnoId, folioId: f.folioId, contado: "280", cambio: "0", encargada: e.encargada }, PRUEBAS);
    if (!x.ok) throw new Error(x.error);
    const version = async () => (await sql<{ version: number }[]>`select version from retiro where id = ${x.retiroId}`)[0].version;
    expect(await confirmarRetiro(sql, e.encargada, { retiroId: x.retiroId, version: await version(), importe: "250", folioCoincide: true, folioEnSobre: "", motivo: "" }, PRUEBAS))
      .toMatchObject({ ok: true, resultado: "recuento" });
    expect(await recontarRetiro(sql, e.encargada, { retiroId: x.retiroId, version: await version(), recontaron: false, importe: null, con: null, motivo: "Prueba: Recepción ya se fue" }, PRUEBAS))
      .toMatchObject({ ok: true });
    expect(await revisarRetiro(sql, encargado, e.codigo, { retiroId: x.retiroId, version: await version(), resultado: "faltante_confirmado", motivo: "Prueba: el sobre trae 250", montoVerificado: "250" }, PRUEBAS))
      .toEqual({ ok: true });
    const t1 = await reloj();

    // Dos casos distintos, cada uno con su importe, en «Pendiente de resolución»; no se suman al efectivo.
    const antes = await caja(e.admin, e);
    const pendientes = antes.diferencias.filter((d) => d.etapa === "pendiente_resolucion");
    expect(pendientes.map((d) => [d.clase, d.importe, d.estado]).sort()).toEqual([
      ["retiro_importe", "-30.00", "Faltante confirmado · pendiente de resolución de Dirección"],
      ["sobre", "-50.00", "Faltante confirmado · pendiente de resolución de Dirección"],
    ]);
    const s = resumirCaja(antes, antes.corte);
    expect(s.atencion.find((a) => a.clave === "pendiente_resolucion")).toMatchObject({ n: 2 });
    expect(s.atencion.find((a) => a.clave === "pendiente_resolucion")!.casos!.map((c) => c.importe).sort()).toEqual(["-30.00", "-50.00"]);
    expect(lectura(s).atencion.map((a) => a.clave)).toContain("pendiente_resolucion");

    // Quien no es Dirección no resuelve.
    expect(await resolverFaltanteRetiro(sql, encargado, e.codigo, { retiroId: x.retiroId, motivo: "Prueba: lo absorbe la sucursal" }, PRUEBAS))
      .toEqual({ ok: false, error: "sin_permiso" });
    // Dirección participó en la cadena del sobre: aun con su autorización para revisar lo propio, no lo resuelve.
    const general = (await sql<{ id: string }[]>`select id from usuario where correo = 'direccion.general@prueba.fitnessland.invalid'`)[0].id;
    const hasta = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() + 30 * 86_400_000));
    expect(await aplicarCambio(sql, general, e.dir, { tipo: "autorrevision", alcance: { todas: false, sucursales: [e.sucursalId] }, hasta, motivo: "Aún no hay personal de Administración" }, PRUEBAS))
      .toEqual({ ok: true });
    expect(await estadoResolucionSobre(sql, e.dir, difSobre.id)).toMatchObject({ pendiente: true, puede: false, participo: true });
    expect(await resolverFaltanteSobre(sql, e.dir, e.codigo, { diferenciaId: difSobre.id, motivo: "Prueba: lo absorbe la sucursal" }, PRUEBAS))
      .toEqual({ ok: false, error: "participaste" });
    await expect(sql`insert into resolucion_diferencia_sobre (diferencia_id, decision, motivo, resuelta_por) values (${difSobre.id}, 'absorbe_sucursal', 'Directo en la base', ${e.dir})`)
      .rejects.toThrow(/no resuelve su faltante/);
    // Motivo obligatorio.
    expect(await resolverFaltanteRetiro(sql, e.dir, e.codigo, { retiroId: x.retiroId, motivo: "no" }, PRUEBAS)).toEqual({ ok: false, error: "motivo" });
    // Dirección no participó en el retiro: lo resuelve. Una sola vez.
    expect(await resolverFaltanteRetiro(sql, e.dir, e.codigo, { retiroId: x.retiroId, motivo: "Prueba: lo absorbe la sucursal" }, PRUEBAS)).toEqual({ ok: true });
    expect(await resolverFaltanteRetiro(sql, e.dir, e.codigo, { retiroId: x.retiroId, motivo: "Prueba: otra vez" }, PRUEBAS)).toEqual({ ok: false, error: "ya_resuelta" });
    // Otra cuenta de Dirección, que no participó en la cadena del sobre, resuelve el sobre.
    const otraDir = await cuenta([["direccion", e.codigo]], "Dirección sin participar");
    expect(await resolverFaltanteSobre(sql, otraDir, e.codigo, { diferenciaId: difSobre.id, motivo: "Prueba: lo absorbe la sucursal" }, PRUEBAS)).toEqual({ ok: true });

    // El efectivo, los saldos y los depósitos no cambian; los casos quedan cerrados con su decisión.
    const despues = await caja(e.admin, e);
    expect(despues.visible).toBe(antes.visible);
    expect(despues.confirmados.map((c) => [c.clase, c.saldo])).toEqual(antes.confirmados.map((c) => [c.clase, c.saldo]));
    expect(despues.diferencias.filter((d) => d.clase === "retiro_importe" || d.clase === "sobre").map((d) => [d.etapa, d.estado])).toEqual([
      ["cerrada", "Resuelta por Dirección · Lo absorbe la sucursal"], ["cerrada", "Resuelta por Dirección · Lo absorbe la sucursal"],
    ]);
    // Con el corte anterior siguen pendientes de resolución.
    expect((await caja(e.admin, e, t1)).diferencias.filter((d) => d.etapa === "pendiente_resolucion")).toHaveLength(2);
    // Historial del retiro y detalle del reporte.
    const det = (await detalleRetiro(sql, e.dir, e.codigo, x.retiroId))!;
    expect(det.resolucion.resolucion).toMatchObject({ decision: "absorbe_sucursal", motivo: "Prueba: lo absorbe la sucursal" });
    expect(det.historial.map((h) => h.que).join(" | ")).toMatch(/Dirección resolvió el faltante: Lo absorbe la sucursal/);
    expect(det.retiro.saldo).toMatchObject({ habilitado: "250.00", depositado: "0.00", sinDestino: "250.00" });
    const enReporte = (await detalleCaja(sql, e.admin, { codigo: e.codigo, tipo: "retiro", id: x.retiroId }))!.detalle;
    expect(enReporte.eventos.map((v) => v.texto)).toEqual(expect.arrayContaining([expect.stringMatching(/^Dirección resolvió el faltante/)]));
    const alCorte = (await detalleCaja(sql, e.admin, { codigo: e.codigo, tipo: "retiro", id: x.retiroId, corte: t1 }))!.detalle;
    expect(alCorte.eventos.filter((v) => v.despues).map((v) => v.texto)).toEqual([expect.stringMatching(/^Dirección resolvió el faltante/)]);
    // No se edita ni se borra.
    await expect(sql`update resolucion_retiro set motivo = 'Otro motivo distinto' where retiro_id = ${x.retiroId}`).rejects.toThrow(/no se edita/);
    await expect(sql`delete from resolucion_diferencia_sobre where diferencia_id = ${difSobre.id}`).rejects.toThrow(/no se edita/);
  });

  it("autorización para resolver lo propio: quien participó resuelve el faltante del sobre con la marca permanente; vencida o terminada no", async () => {
    const e = await escenario();
    const [bolsa, cajon] = await cerrarDelDia(e);
    await abrir(e);
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" },
      { sobreId: cajon.id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
    ], llave: LLAVE }, PRUEBAS)).toMatchObject({ ok: true });
    const [difSobre] = await sql<{ id: string }[]>`select d.id from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id where s.sucursal_id = ${e.sucursalId}`;
    const resolver = (motivo = "Prueba: lo absorbe la sucursal") => resolverFaltanteSobre(sql, e.dir, e.codigo, { diferenciaId: difSobre.id, motivo }, PRUEBAS);
    const general = (await sql<{ id: string }[]>`select id from usuario where correo = 'direccion.general@prueba.fitnessland.invalid'`)[0].id;
    const hasta = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() + 30 * 86_400_000));
    const autorizar = () => aplicarCambio(sql, general, e.dir, { tipo: "autorresolucion", alcance: { todas: false, sucursales: [e.sucursalId] }, hasta, motivo: "Prueba: no hay otra Dirección" }, PRUEBAS);

    // Antes de la revisión previa no se resuelve, aunque tenga la autorización.
    expect(await autorizar()).toEqual({ ok: true });
    expect(await resolver()).toEqual({ ok: false, error: "no_pendiente" });
    const vigente = (await sql<{ id: string }[]>`select id from autorresolucion where usuario_id = ${e.dir} and revocada_en is null`)[0].id;
    // Terminada: se bloquea (también en la base).
    expect(await aplicarCambio(sql, general, e.dir, { tipo: "terminar_autorresolucion", id: vigente, motivo: "Prueba: se termina" }, PRUEBAS)).toEqual({ ok: true });
    expect(await revisarDiferenciaSobre(sql, e.admin, e.codigo, { diferenciaId: difSobre.id, resultado: "faltante_confirmado", motivo: "Prueba: faltan 50 pesos" }, PRUEBAS))
      .toEqual({ ok: true });
    expect(await estadoResolucionSobre(sql, e.dir, difSobre.id)).toMatchObject({ pendiente: true, puede: false, participo: true, autorizacionHasta: null });
    expect(await resolver()).toEqual({ ok: false, error: "participaste" });
    await expect(sql`insert into resolucion_diferencia_sobre (diferencia_id, decision, motivo, resuelta_por, autorresolucion_id)
                     values (${difSobre.id}, 'absorbe_sucursal', 'Directo en la base', ${e.dir}, ${vigente})`).rejects.toThrow(/sin autorización vigente/);
    // Vencida: tampoco.
    await sql`insert into autorresolucion (usuario_id, sucursal_id, vigente_desde, vigente_hasta, otorgada_por, motivo)
              values (${e.dir}, ${e.sucursalId}, now() - interval '20 days', now() - interval '1 day', ${general}, 'Prueba: ya vencida')`;
    expect(await resolver()).toEqual({ ok: false, error: "participaste" });
    // La de revisar lo propio no sirve para resolver.
    expect(await aplicarCambio(sql, general, e.dir, { tipo: "autorrevision", alcance: { todas: false, sucursales: [e.sucursalId] }, hasta, motivo: "Aún no hay personal de Administración" }, PRUEBAS))
      .toEqual({ ok: true });
    expect(await resolver()).toEqual({ ok: false, error: "participaste" });
    // Sin el permiso de resolver (restringido) tampoco, aunque esté vigente la autorización.
    expect(await autorizar()).toEqual({ ok: true });
    expect(await estadoResolucionSobre(sql, e.dir, difSobre.id)).toMatchObject({ puede: true, participo: true, autorizacionHasta: expect.any(Date) });
    expect(await aplicarCambio(sql, general, e.dir, { tipo: "restringir", permiso: "diferencia.resolver", alcance: { todas: false, sucursales: [e.sucursalId] }, hasta: "", motivo: "Prueba: sin resolver" }, PRUEBAS))
      .toEqual({ ok: true });
    expect(await resolver()).toEqual({ ok: false, error: "sin_permiso" });
    const restriccion = (await sql<{ id: string }[]>`select id from restriccion_permiso where usuario_id = ${e.dir} and revocada_en is null`)[0].id;
    expect(await aplicarCambio(sql, general, e.dir, { tipo: "quitar_restriccion", id: restriccion, motivo: "Prueba: vuelve a resolver" }, PRUEBAS)).toEqual({ ok: true });

    // Vigente, con Dirección y el permiso: resuelve, marcada para siempre. No cambia el efectivo.
    const antes = await caja(e.admin, e);
    expect(await resolver()).toEqual({ ok: true });
    const despues = await caja(e.admin, e);
    expect(despues.visible).toBe(antes.visible);
    expect(despues.confirmados.map((c) => [c.clase, c.saldo])).toEqual(antes.confirmados.map((c) => [c.clase, c.saldo]));
    const d = despues.diferencias.find((x) => x.clase === "sobre")!;
    expect(d).toMatchObject({ etapa: "cerrada", resueltaPropia: true, revisadaPropia: false,
      estado: "Resuelta por Dirección · Lo absorbe la sucursal · Resuelta por quien participó" });
    const [x] = await sql<{ autorresolucion_id: string | null }[]>`select autorresolucion_id from resolucion_diferencia_sobre where diferencia_id = ${difSobre.id}`;
    expect(x.autorresolucion_id).not.toBeNull();
    const [hist] = await sql<{ cambios: { propia: boolean } }[]>`select cambios from historial_cambio where entidad = 'diferencia_sobre' and entidad_id = ${difSobre.id} and accion = 'resolver_faltante'`;
    expect(hist.cambios.propia).toBe(true);
    // Al terminarla después, la marca y el historial se conservan.
    const nueva = (await sql<{ id: string }[]>`select id from autorresolucion where usuario_id = ${e.dir} and revocada_en is null and vigente_hasta > now()`)[0].id;
    expect(await aplicarCambio(sql, general, e.dir, { tipo: "terminar_autorresolucion", id: nueva, motivo: "Prueba: ya se resolvió" }, PRUEBAS)).toEqual({ ok: true });
    expect((await caja(e.admin, e)).diferencias.find((x) => x.clase === "sobre")).toMatchObject({ resueltaPropia: true });
    const det = (await detalleCaja(sql, e.admin, { codigo: e.codigo, tipo: d.enlace.tipo, id: d.enlace.id }))!.detalle;
    expect(det.eventos.map((v) => v.texto)).toEqual(expect.arrayContaining([expect.stringMatching(/Lo absorbe la sucursal · Resuelta por quien participó/)]));
    // En el Excel, la columna de la marca.
    expect(await dar(e.admin, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    const r = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "detalle" }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const texto = await textoExcel(await excelCaja(r.archivo));
    expect(texto).toContain("Resuelta por quien participó");
    await guardar("resuelta-propia", r.archivo);
  });

  it("historial de la recolección en Excel y PDF: resolución del faltante del sobre y su clave, una vez y solo hasta el corte", async () => {
    const e = await escenario();
    const [bolsa, cajon] = await cerrarDelDia(e);
    await abrir(e);
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" },
      { sobreId: cajon.id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
    ], llave: LLAVE }, PRUEBAS)).toMatchObject({ ok: true });
    const [dif] = await sql<{ id: string; folio: string }[]>`
      select d.id, s.folio from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id where s.sucursal_id = ${e.sucursalId}`;
    const [{ clave }] = await sql<{ clave: string }[]>`select clave from clave_diferencia where clase = 'sobre' and caso_id = ${dif.id}`;
    expect(await revisarDiferenciaSobre(sql, e.admin, e.codigo, { diferenciaId: dif.id, resultado: "faltante_confirmado", motivo: "Prueba: faltan 50 pesos" }, PRUEBAS))
      .toEqual({ ok: true });
    const antes = await reloj();
    // Dirección participó (recogió el buzón): resuelve con su autorización personal, con la marca.
    const general = (await sql<{ id: string }[]>`select id from usuario where correo = 'direccion.general@prueba.fitnessland.invalid'`)[0].id;
    const hasta = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() + 30 * 86_400_000));
    expect(await aplicarCambio(sql, general, e.dir, { tipo: "autorresolucion", alcance: { todas: false, sucursales: [e.sucursalId] }, hasta, motivo: "Prueba: no hay otra Dirección" }, PRUEBAS))
      .toEqual({ ok: true });
    expect(await resolverFaltanteSobre(sql, e.dir, e.codigo, { diferenciaId: dif.id, motivo: "Prueba: lo absorbe la sucursal" }, PRUEBAS)).toEqual({ ok: true });
    expect(await dar(e.admin, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    const RESUELTA = `Dirección resolvió el faltante de ${dif.folio}: Lo absorbe la sucursal · Resuelta por quien participó · «Prueba: lo absorbe la sucursal»`;
    const CLAVE = `Clave asignada: ${clave}`;
    const veces = (texto: string, buscado: string) => texto.split(buscado).length - 1;
    const archivos = async (corte?: string) => {
      const x = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "detalle", corte }, PRUEBAS);
      if (!x.ok) throw new Error(x.error);
      const hojas = await hojasExcel(await excelCaja(x.archivo));
      return { historial: hojas["Historial"].map((f) => f.join(" | ")).join("\n"), pdf: textoPdf(await pdfCaja(x.archivo)) };
    };
    // Al corte actual: la resolución con su marca y la clave, cada una una sola vez, en Excel y PDF.
    const ahora = await archivos();
    expect(veces(ahora.historial, RESUELTA)).toBe(1);
    expect(veces(ahora.historial, CLAVE)).toBe(1);
    expect(ahora.historial).toMatch(new RegExp(`Recolección del buzón[^\n]*${RESUELTA.replace(/[.*+?^${}()|[\]\\«»]/g, "\\$&")}`));
    expect(veces(ahora.pdf.replace(/\s+/g, " "), "Resuelta por quien participó · «Prueba: lo absorbe la sucursal»")).toBe(1);
    expect(veces(ahora.pdf, CLAVE)).toBe(1);
    // Con un corte anterior a la resolución: la clave (ya asignada) sí; la resolución no.
    const previo = await archivos(antes);
    expect(veces(previo.historial, CLAVE)).toBe(1);
    expect(previo.historial).not.toContain("Dirección resolvió el faltante");
    expect(previo.pdf).not.toContain("resolvió el faltante");
    // En pantalla, el detalle con el corte anterior la marca como posterior al corte.
    const rec = (await sql<{ id: string }[]>`select recoleccion_id as id from diferencia_sobre where id = ${dif.id}`)[0].id;
    const det = (await detalleCaja(sql, e.admin, { codigo: e.codigo, tipo: "recoleccion", id: rec, corte: antes }))!.detalle;
    expect(det.eventos.filter((v) => v.despues).map((v) => v.texto)).toEqual([RESUELTA]);
    // No cambia importes.
    expect((await caja(e.admin, e)).confirmados.find((c) => c.clase === "recoleccion")).toMatchObject({ saldo: "3420.00" });
  });

  it("clave fija por caso: se asigna al registrarse, no cambia con el periodo ni al cerrarse otros casos, y conserva el código original", async () => {
    const e = await escenario();
    const encargado = await cuenta([["encargado", e.codigo]], "Encargado");
    // Caso 1: el cierre con $20 de más (al abrir, contra el esperado). Caso 2: el sobre con $50 menos.
    await cerrarDelDia(e, { conteo: { bolsa: "740", cajon: "3350" } });
    await abrir(e);
    const [bolsa, cajon] = await sql<{ id: string }[]>`select id from sobre_cierre where sucursal_id = ${e.sucursalId} order by folio`;
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" },
      { sobreId: cajon.id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
    ], llave: LLAVE }, PRUEBAS)).toMatchObject({ ok: true });
    // Una clave por caso, numeradas en orden de registro; el sobre es el último.
    const filas = await sql<{ clave: string; numero: number; clase: string; caso_id: string; origen: string }[]>`
      select clave, numero, clase, caso_id, origen from clave_diferencia where sucursal_id = ${e.sucursalId} order by numero`;
    expect(filas.map((f) => f.clave)).toEqual(filas.map((_, i) => `${e.codigo}-D${i + 1}`));
    expect(filas.every((f) => f.origen === "al_registrar")).toBe(true);
    const claveSobre = filas.at(-1)!;
    expect(claveSobre.clase).toBe("sobre");
    const [dif] = await sql<{ id: string }[]>`select d.id from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id
      where l.sucursal_id = ${e.sucursalId} and d.tipo = 'contra_esperado'`;
    const claveTurno = filas.find((f) => f.caso_id === dif.id)!.clave;
    const claveDe = async (corte?: string) => Object.fromEntries((await caja(e.admin, e, corte)).diferencias.map((d) => [d.id, d.clave]));
    const t1 = await reloj();
    expect(await claveDe()).toMatchObject({ [dif.id]: claveTurno, [claveSobre.caso_id]: claveSobre.clave });
    // Se cierra el primero: el sobre conserva su clave; con el corte anterior, también.
    expect(await revisarDiferencia(sql, encargado, e.codigo, { diferenciaId: dif.id, resultado: "aclarada", motivo: "Prueba: error de conteo" }, PRUEBAS)).toMatchObject({ ok: true });
    expect((await claveDe())[claveSobre.caso_id]).toBe(claveSobre.clave);
    expect((await claveDe(t1))[claveSobre.caso_id]).toBe(claveSobre.clave);
    // En la línea de pendientes y en el Excel.
    const s = resumirCaja(await caja(e.admin, e), (await caja(e.admin, e)).corte);
    expect(s.atencion.find((a) => a.clave === "por_revisar")!.casos).toContainEqual({ texto: `${claveSobre.clave} · Faltante del sobre ${(await sql<{ folio: string }[]>`select folio from sobre_cierre where id = ${cajon.id}`)[0].folio}`, importe: "-50.00" });
    expect(await dar(e.admin, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    const r = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "detalle" }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    expect(await textoExcel(await excelCaja(r.archivo))).toContain(claveSobre.clave);
    // En el historial del caso.
    const det = (await detalleCaja(sql, e.admin, { codigo: e.codigo, tipo: "diferencia", id: dif.id }))!.detalle;
    expect(det.titulo.startsWith(`${claveTurno} · `)).toBe(true);
    expect(det.eventos.map((v) => v.texto)).toContain(`Clave asignada: ${claveTurno}`);
    // Si cambiara el código de la sucursal, la clave conserva el original; los nuevos casos usan el nuevo código y siguen la numeración.
    const nuevo = `Z${e.codigo}`;
    await sql`update sucursal set codigo = ${nuevo} where id = ${e.sucursalId}`;
    expect((await sql<{ clave: string }[]>`select clave from clave_diferencia where sucursal_id = ${e.sucursalId} order by numero`).map((f) => f.clave))
      .toEqual(filas.map((f) => f.clave));
    const otra = await sql<{ clave: string }[]>`select asignar_clave_diferencia(${e.sucursalId}, 'turno', gen_random_uuid(), now()) as clave`;
    expect(otra[0].clave).toBe(`${nuevo}-D${filas.length + 1}`);
    await sql`update sucursal set codigo = ${e.codigo} where id = ${e.sucursalId}`;
    // No se edita ni se borra.
    await expect(sql`update clave_diferencia set clave = 'otra' where sucursal_id = ${e.sucursalId}`).rejects.toThrow();
    await expect(sql`delete from clave_diferencia where sucursal_id = ${e.sucursalId}`).rejects.toThrow();
  });

  it("diferencias de turno: «Por revisar», «Pendiente de resolución» y «Corrección pendiente» por separado, sin sumarse", async () => {
    const e = await escenario();
    const encargado = await cuenta([["encargado", e.codigo]], "Encargado");
    // Cierra con $20 de más en la bolsa: sobrante contra el esperado.
    await cerrarDelDia(e, { conteo: { bolsa: "740", cajon: "3350" } });
    await abrir(e);
    const [dif] = await sql<{ id: string }[]>`select d.id from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id where l.sucursal_id = ${e.sucursalId} and d.tipo = 'contra_esperado'`;
    const etapa = async () => (await caja(e.admin, e)).diferencias.find((d) => d.id === dif.id)!;
    expect(await etapa()).toMatchObject({ etapa: "por_revisar", importe: "20.00" });
    expect(await revisarDiferencia(sql, encargado, e.codigo, { diferenciaId: dif.id, resultado: "sobrante_confirmado", motivo: "Prueba: sobran 20 pesos" }, PRUEBAS))
      .toMatchObject({ ok: true });
    expect(await etapa()).toMatchObject({ etapa: "pendiente_resolucion" });
    expect(await resolverDiferencia(sql, e.dir, e.codigo, { diferenciaId: dif.id, decision: "origen_identificado", motivo: "Prueba: se identificó el origen",
      origen: "Un cobro que no se registró", requiereCorreccion: true }, PRUEBAS)).toMatchObject({ ok: true });
    const c = await caja(e.admin, e);
    expect(c.diferencias.find((d) => d.id === dif.id)).toMatchObject({ etapa: "correccion_pendiente", abierta: true });
    const s = resumirCaja(c, c.corte);
    expect(s.atencion.filter((a) => a.n).map((a) => [a.clave, a.n])).toEqual([["correcciones", 1]]);
    expect(s.atencion.find((a) => a.clave === "correcciones")!.casos).toEqual([{ texto: expect.stringMatching(new RegExp(`^${e.codigo}-D\\d+ · Cierre del `)), importe: "20.00" }]);
    expect(lectura(s).atencion.map((a) => a.texto)).toEqual(["Corrección pendiente"]);
    // El efectivo no cambia con ninguna de estas etapas.
    expect(c.visible).toBe("4090.00");
  });
});

/**
 * Los casos que ya existían antes de las claves fijas: una base con las migraciones hasta la 0043, casos registrados y
 * después la 0044. Reciben su clave en orden de registro; se guarda cuándo se asignó y la fecha original no cambia.
 */
describe.skipIf(!URL_ADMIN)("claves fijas para los casos que ya existían", () => {
  let admin: postgres.Sql;
  let nombre: string;
  let previas: string;
  beforeAll(async () => {
    nombre = `prueba_claves_${Date.now()}`;
    admin = postgresCliente(URL_ADMIN!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${nombre}`);
    const url = new URL(URL_ADMIN!);
    url.pathname = `/${nombre}`;
    sql = postgresCliente(url.toString(), { max: 6, prepare: false, onnotice: () => {} });
    previas = await mkdtemp(path.join(tmpdir(), "migraciones-"));
    for (const a of (await readdir(DIRECTORIO_MIGRACIONES)).filter((a) => a < "0044")) await copyFile(path.join(DIRECTORIO_MIGRACIONES, a), path.join(previas, a));
    await aplicarMigraciones(sql, { directorio: previas });
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const x of await sql<{ id: string; correo: string }[]>`select id, correo from usuario`) u[x.correo.replace("@prueba.fitnessland.invalid", "")] = x.id;
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${nombre} with (force)`);
    await admin?.end({ timeout: 5 });
    if (previas) await rm(previas, { recursive: true, force: true });
  });

  it("reciben su clave en orden de registro, con la fecha de asignación aparte", async () => {
    const e = await escenario();
    await cerrarDelDia(e, { conteo: { bolsa: "740", cajon: "3350" } });
    await abrir(e);
    const [bolsa, cajon] = await sql<{ id: string }[]>`select id from sobre_cierre where sucursal_id = ${e.sucursalId} order by folio`;
    expect(await recogerBuzon(sql, e.dir, e.codigo, { sobres: [
      { sobreId: bolsa.id, estado: "correcto", folioVisto: "", motivo: "", contado: "420" },
      { sobreId: cajon.id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
    ], llave: LLAVE }, PRUEBAS)).toMatchObject({ ok: true });
    const f = await generarFolio(sql, e.matutina, e.codigo, { turnoId: e.turnoId, lugar: "cajon_mensualidades" }, PRUEBAS);
    if (!f.ok) throw new Error(f.error);
    const x = await registrarRetiro(sql, e.matutina, e.codigo, { turnoId: e.turnoId, folioId: f.folioId, contado: "280", cambio: "0", encargada: e.encargada }, PRUEBAS);
    if (!x.ok) throw new Error(x.error);
    const version = async () => (await sql<{ version: number }[]>`select version from retiro where id = ${x.retiroId}`)[0].version;
    await confirmarRetiro(sql, e.encargada, { retiroId: x.retiroId, version: await version(), importe: "250", folioCoincide: true, folioEnSobre: "", motivo: "" }, PRUEBAS);
    await recontarRetiro(sql, e.encargada, { retiroId: x.retiroId, version: await version(), recontaron: false, importe: null, con: null, motivo: "Prueba: Recepción ya se fue" }, PRUEBAS);
    const antes = await sql<{ fecha: Date }[]>`
      select registrada_en as fecha from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id where l.sucursal_id = ${e.sucursalId}
      union all select ds.creada_en from diferencia_sobre ds join sobre_cierre s on s.id = ds.sobre_id where s.sucursal_id = ${e.sucursalId}
      union all select reportado_en from retiro where id = ${x.retiroId} order by 1`;
    expect(antes.length).toBeGreaterThanOrEqual(3);

    await aplicarMigraciones(sql);
    const filas = await sql<{ clave: string; clase: string; registrado: Date; asignada_en: Date; origen: string }[]>`
      select clave, clase, registrado, asignada_en, origen from clave_diferencia where sucursal_id = ${e.sucursalId} order by numero`;
    expect(filas.map((k) => k.clave)).toEqual(antes.map((_, i) => `${e.codigo}-D${i + 1}`));
    expect(filas.every((k) => k.origen === "casos_existentes")).toBe(true);
    expect(filas.at(-1)!.clase).toBe("retiro_importe");
    // La fecha original del caso no cambia; la asignación queda aparte.
    expect(filas.map((k) => k.registrado.getTime())).toEqual(antes.map((a) => a.fecha.getTime()));
    for (const k of filas) expect(k.asignada_en.getTime()).toBeGreaterThanOrEqual(k.registrado.getTime());
    const det = (await detalleRetiro(sql, e.admin, e.codigo, x.retiroId))!;
    const ultima = filas.at(-1)!.clave;
    expect(det.claves).toEqual([{ clave: ultima, caso: "importe" }]);
    expect(det.historial.map((h) => h.que)).toContain(`Clave asignada (diferencia de importe): ${ultima} · caso registrado antes de las claves fijas; su fecha original no cambia`);
    // Los casos nuevos siguen la numeración.
    const otra = await sql<{ clave: string }[]>`select asignar_clave_diferencia(${e.sucursalId}, 'turno', gen_random_uuid(), now()) as clave`;
    expect(otra[0].clave).toBe(`${e.codigo}-D${filas.length + 1}`);
  });
});

import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { excelCaja, LEYENDA_ANOTADOS, OCULTO, pdfCaja } from "@/lib/archivo-caja";
import { abrirDesdeCierre, cerrarDia, cierrePendiente, configurarCustodia, prepararCierre } from "@/lib/cierres";
import { cambiarMontoFondo, confirmarEntradaFondo } from "@/lib/fondos";
import { recogerBuzon, registrarDepositoRecoleccion } from "@/lib/recolecciones";
import { detalleCaja, historialDescargas, prepararDescarga, reporteCaja } from "@/lib/reporte-caja";
import { confirmarRetiro, generarFolio, registrarRetiro } from "@/lib/retiros";
import { abrirTurno } from "@/lib/turnos";
import { aplicarCambio, resumenPermisos, type CambioAcceso } from "@/lib/usuarios";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
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
const reloj = async () => (await sql<{ t: Date }[]>`select clock_timestamp() as t`)[0].t.toISOString();
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

/** Sucursal con buzón, fondos de $300 y $300; la vespertina abre con $420 y $3,050 y recibe los fondos. */
async function escenario() {
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
  const c = await configurarCustodia(sql, dir, codigo, {
    lugar: "Buzón de recepción", acceso: [dir], lugarFondos: "Cajón con llave", accesoCajon: [matutina, vespertina], custodias: [matutina, vespertina], buzon: true,
  }, PRUEBAS);
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

/** La vespertina cierra: bolsa $720 (sobre de $420) y cajón $3,350 (sobre de $3,050), los deposita en el buzón. */
async function cerrarDelDia(e: Esc) {
  const p = await prepararCierre(sql, e.vespertina, e.codigo, { turnoId: e.turnoId }, PRUEBAS);
  if (!p.ok) throw new Error(p.error);
  const r = await cerrarDia(sql, e.vespertina, e.codigo, {
    turnoId: e.turnoId, conteo: { bolsa: "720", cajon: "3350" }, fondos: { bolsa: "300", cajon: "300" }, custodio: e.vespertina, nota: "", apoyo: NADIE,
    custodia: { ubicacion: "Llavero de recepción", sobres: [], llave: LLAVE }, depositados: p.sobres.map((s) => s.id),
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return p.sobres;
}
async function abrir(e: Esc) {
  const c = (await cierrePendiente(sql, e.sucursalId))!;
  const r = await abrirDesdeCierre(sql, e.matutina, e.codigo, {
    entregaId: c.entregaId, version: c.version, sobres: [], conteo: { bolsa: "300", cajon: "300" }, apoyo: NADIE, llave: LLAVE,
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

  it("archivos: quien recoge descarga los importes ocultos y un subtotal; quien no recoge, la leyenda de anotados sin contar", async () => {
    const e = await escenario();
    await cerrarDelDia(e);
    await abrir(e);
    for (const p of [e.admin, e.dir]) expect(await dar(p, "reporte.caja_descargar", [e.sucursalId])).toEqual({ ok: true });
    const leer = async (b: Buffer) => {
      const libro = new ExcelJS.Workbook();
      await libro.xlsx.load(b as unknown as ArrayBuffer);
      const filas: string[] = [];
      libro.worksheets[0].eachRow((r) => filas.push((r.values as unknown[]).slice(1).map((v) => String(v ?? "")).join(" | ")));
      return filas.join("\n");
    };
    const dir = await prepararDescarga(sql, e.dir, { codigo: e.codigo, formato: "xlsx", contenido: "detalle" }, PRUEBAS);
    if (!dir.ok) throw new Error(dir.error);
    const tDir = await leer(await excelCaja(dir.archivo));
    expect(tDir).toContain("Subtotal visible al corte");
    expect(tDir).toContain(OCULTO);
    expect(tDir).toContain("faltan mensualidades de Open Desk");
    expect(tDir).not.toContain(LEYENDA_ANOTADOS);
    // Ni en el detalle ni en el historial aparece lo anotado de los sobres sin contar.
    expect(tDir).not.toMatch(/3050|3,050|\$420/);
    const admin = await prepararDescarga(sql, e.admin, { codigo: e.codigo, formato: "xlsx", contenido: "resumen" }, PRUEBAS);
    if (!admin.ok) throw new Error(admin.error);
    const tAdmin = await leer(await excelCaja(admin.archivo));
    expect(tAdmin).toContain(LEYENDA_ANOTADOS);
    expect(tAdmin).toContain("Total registrado al corte");
    expect(tAdmin).toContain("3050");
    const pdf = await pdfCaja(admin.archivo);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const h = await historialDescargas(sql, [e.sucursalId]);
    expect(h.slice(0, 2).map((x) => [x.conOcultos, x.conAnotados])).toEqual([[false, true], [true, false]]);
  });
});

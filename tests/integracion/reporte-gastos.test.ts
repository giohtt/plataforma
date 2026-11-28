import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { excelGastos, pdfGastos } from "@/lib/archivo-gastos";
import {
  comprobarAnticipo, confirmarAnticipo, decidirGasto, entregarAnticipo, registrarComprobante, registrarGastoPagado, registrarPago, solicitarGasto,
} from "@/lib/gastos";
import { excelCaja, pdfCaja } from "@/lib/archivo-caja";
import { prepararDescarga, reporteCaja } from "@/lib/reporte-caja";
import { prepararDescargaGastos, reporteGastos, VISTAS } from "@/lib/reporte-gastos";
import { abrirTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 6, PR 9 (acordado el 28 nov 2026; solo datos ficticios; facultades ficticias solo dentro de la prueba): reporte
 * de gastos y gastos en el reporte de caja. Periodo por la fecha del pago al proveedor; nada después del corte; cada
 * gasto una vez; Gastos sigue a la beneficiada y Caja a la que paga; pagos de turnos cerrados aparte, sin descontarse.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const D = "@prueba.fitnessland.invalid";
const zona = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(d);
const hoy = () => zona(new Date());
const ayer = () => zona(new Date(Date.now() - 86_400_000));
const espera = () => new Promise((r) => setTimeout(r, 30));

let S: { id: string; codigo: string };
let S2: { id: string; codigo: string };
let rec: string, enc: string, adm: string, dir: string;
const claves: Record<string, string> = {};
let t1: Date;

async function sucursal(nombre: string) {
  const codigo = `${nombre[0]}${randomUUID().replace(/[^0-9]/g, "").slice(0, 3)}`;
  const [{ id }] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${`${nombre} ${codigo}`}, ${codigo}) returning id`;
  return { id, codigo };
}
async function cuenta(nombre: string, rol: string | null, sucursalId?: string) {
  const [x] = await sql<{ id: string }[]>`insert into usuario (nombre, correo, es_prueba) values (${nombre}, ${`g-${randomUUID().slice(0, 8)}${D}`}, true) returning id`;
  if (rol && sucursalId) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${x.id}, ${rol}, ${sucursalId}, 'Prueba')`;
  if (!rol) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${x.id}, 'direccion', 'Prueba')`;
  return x.id;
}
async function solicitar(u: string, codigo: string, concepto: string, importe: string, categoria = "prueba_limpieza") {
  const r = await solicitarGasto(sql, u, codigo, { concepto, categoria, importe, proveedor: "", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return r.clave;
}
async function autorizar(clave: string, decision = "autorizado") {
  const d = await decidirGasto(sql, enc, S.codigo, { clave, version: 1, decision, motivo: decision === "rechazado" ? "Prueba: no procede" : "" }, PRUEBAS);
  if (!d.ok) throw new Error(d.error);
}
const pagar = (u: string, clave: string, origen: string, importe: string, x: Record<string, string> = {}) => registrarPago(sql, u, S.codigo, {
  clave, version: 1, origen, importe, aQuien: "", pagadoEl: hoy(), cuenta: origen === "tarjeta" ? "Tarjeta ficticia" : "", referencia: "",
  tipo: "", folio: "", motivoSin: "", ...x }, PRUEBAS);
const reporte = (corte?: Date, desde = ayer(), hasta = hoy()) =>
  reporteGastos(sql, dir, { codigo: S.codigo, desde, hasta, corte: corte?.toISOString() }).then((r) => r!);
const suma = (l: { importe: string }[]) => (l.reduce((n, x) => n + Math.round(Number(x.importe) * 100), 0) / 100).toFixed(2);

describe.skipIf(!URL_ADMIN)("reporte de gastos y gastos en caja", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    S = await sucursal("Reportes");
    S2 = await sucursal("Otra");
    rec = await cuenta("Recepción RG", "recepcion", S.id);
    enc = await cuenta("Encargado RG", "encargado", S.id);
    adm = await cuenta("Administración RG", "administracion", S.id);
    dir = await cuenta("Dirección RG", null);
    await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo)
              values (${enc}, 'autorizacion.gasto', ${S.id}, 2000, 9000, 'Prueba')`;
    await sql`insert into facultad_otorgada (usuario_id, permiso, todas_las_sucursales, sin_limite, motivo) values (${dir}, 'autorizacion.gasto', true, true, 'Prueba')`;
    for (const s of [S.id, S2.id]) {
      await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, motivo) values (${dir}, 'reporte.caja', ${s}, 'Prueba')`;
      await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, motivo) values (${dir}, 'reporte.caja_descargar', ${s}, 'Prueba')`;
    }
    const t = await abrirTurno(sql, rec, S.codigo, { bolsa: "1000.00", cajon: "0.00" }, PRUEBAS);
    if (!t.ok) throw new Error(t.error);

    // A: de la bolsa, 200; el comprobante llega después del primer corte.
    claves.a = await solicitar(rec, S.codigo, "Garrafones ficticios", "200", "prueba_agua");
    await autorizar(claves.a);
    expect(await pagar(rec, claves.a, "bolsa_visitas", "200")).toEqual({ ok: true });
    await espera();
    t1 = new Date();
    await espera();
    expect(await registrarComprobante(sql, rec, S.codigo, { clave: claves.a, tipo: "ticket", folio: "A-1", motivoSin: "" }, PRUEBAS)).toEqual({ ok: true });
    // B: tarjeta, 300, el mismo día sin hora (no comprobada) y por comprobar: dos pendientes, se suma una vez.
    claves.b = await solicitar(adm, S.codigo, "Focos ficticios", "300");
    await autorizar(claves.b);
    expect(await pagar(adm, claves.b, "tarjeta", "300")).toEqual({ ok: true });
    // C: anticipo de 400; se pagaron 470: excedente de 70 cubierto con dinero personal, autorizado después.
    claves.c = await solicitar(adm, S.codigo, "Pintura ficticia", "400", "prueba_mantenimiento");
    await autorizar(claves.c);
    expect(await entregarAnticipo(sql, rec, S.codigo, { clave: claves.c, version: 1, lugar: "bolsa_visitas", recibe: adm }, PRUEBAS)).toEqual({ ok: true });
    expect(await confirmarAnticipo(sql, adm, S.codigo, { clave: claves.c }, PRUEBAS)).toEqual({ ok: true });
    const k = await comprobarAnticipo(sql, adm, S.codigo, { clave: claves.c, gastado: "470", pagadoEl: hoy(), aQuien: "", envio: randomUUID(), tipo: "nota", folio: "", motivoSin: "" }, PRUEBAS);
    claves.exc = k.ok ? k.excedente! : "";
    await autorizar(claves.exc);
    expect(await pagar(adm, claves.exc, "dinero_personal", "70", { tipo: "nota" })).toEqual({ ok: true });
    // D: ya pagado ayer con dinero personal (registrado hoy).
    const d = await registrarGastoPagado(sql, enc, S.codigo, {
      concepto: "Cloro ficticio", categoria: "prueba_limpieza", importe: "50", proveedor: "", nota: "", pagaId: "", origen: "dinero_personal",
      pagadoPor: enc, pagadoEl: ayer(), turno: "", aQuien: "", cuenta: "", referencia: "", motivoPagado: "Prueba ficticia: urgente", tipo: "ticket", folio: "", motivoSin: "",
      envio: randomUUID() }, PRUEBAS);
    claves.d = d.ok ? d.clave : "";
    // E: anticipo de 100 sin comprobar (fuera de caja; no es gasto todavía).
    claves.e = await solicitar(adm, S.codigo, "Material ficticio por comprar", "100");
    await autorizar(claves.e);
    expect(await entregarAnticipo(sql, rec, S.codigo, { clave: claves.e, version: 1, lugar: "bolsa_visitas", recibe: adm }, PRUEBAS)).toEqual({ ok: true });
    // F: por autorizar; G: rechazado.
    claves.f = await solicitar(rec, S.codigo, "Papel ficticio", "80", "prueba_papeleria");
    claves.g = await solicitar(rec, S.codigo, "Capricho ficticio", "60", "prueba_otros");
    await autorizar(claves.g, "rechazado");
    // H: se carga a S, lo pagó S2 con tarjeta (ya pagado por Dirección).
    const h = await registrarGastoPagado(sql, dir, S.codigo, {
      concepto: "Servicio ficticio pagado por la otra", categoria: "prueba_otros", importe: "30", proveedor: "", nota: "", pagaId: S2.id, origen: "tarjeta",
      pagadoPor: dir, pagadoEl: hoy(), turno: "", aQuien: "", cuenta: "Tarjeta ficticia", referencia: "", motivoPagado: "Prueba ficticia: pagó la otra sucursal",
      tipo: "ticket", folio: "", motivoSin: "", envio: randomUUID() }, PRUEBAS);
    claves.h = h.ok ? h.clave : "";
  });
  afterAll(async () => cerrar?.());

  it("cada gasto una vez por lo pagado; vistas que suman lo mismo; pendientes sin duplicar; aparte no se suma", async () => {
    const r = await reporte();
    const por = Object.fromEntries(r.filas.map((f) => [f.clave, f]));
    expect(Object.keys(por).sort()).toEqual([claves.a, claves.b, claves.c, claves.exc, claves.d, claves.h].sort());
    expect(r.total).toEqual({ n: 6, importe: "1050.00" });
    for (const v of VISTAS) expect(suma(r.vistas[v])).toBe("1050.00");
    expect(r.vistas.estado).toEqual([
      { etiqueta: "Pagado sin autorización previa o no comprobada", n: 4, importe: "450.00" },
      { etiqueta: "Pagado y comprobado", n: 2, importe: "600.00" },
    ]);
    expect(por[claves.b]).toMatchObject({ grupo: "sin_autorizacion", autorizacionPrevia: "no_comprobada", comprobacion: "por_comprobar" });
    expect(por[claves.b].pendientes).toEqual(["Autorización previa no comprobada", "Por comprobar"]);
    expect(por[claves.c]).toMatchObject({ origen: "anticipo", lugar: "bolsa_visitas", importe: "400.00", autorizacionPrevia: "comprobada", grupo: "comprobado" });
    expect(por[claves.c].anticipo?.entregadoEn).toBeInstanceOf(Date);
    expect(por[claves.exc]).toMatchObject({ compraDe: claves.c, origen: "dinero_personal", autorizacionPrevia: "sin_autorizacion_previa", reembolso: "por_decidir" });
    expect(por[claves.d]).toMatchObject({ pagadoEl: ayer(), autorizo: null, autorizacionPrevia: "sin_autorizacion_previa" });
    expect(por[claves.h]).toMatchObject({ pagaOtra: true, beneficiada: `Reportes ${S.codigo}`, paga: `Otra ${S2.codigo}` });
    expect(r.vistas.lugar).toEqual([
      { etiqueta: "Bolsa de visitas", n: 2, importe: "600.00" },
      { etiqueta: "No fue efectivo", n: 4, importe: "450.00" },
    ]);
    expect(r.aparte).toEqual({
      porAutorizar: { n: 1, importe: "80.00" }, autorizadosSinPagar: { n: 0, importe: "0.00" },
      anticiposPorComprobar: { n: 1, importe: "100.00" }, cambioPorDevolver: { n: 0, importe: "0.00" }, rechazados: { n: 1, importe: "60.00" },
    });
    // Anticipos: entrega y comprobación aparte; el excedente y lo cubierto con dinero personal, ligados.
    const ac = r.anticipos.find((x) => x.clave === claves.c)!;
    expect(ac.comprobado).toMatchObject({ gastado: "470.00", pagadoConAnticipo: "400.00", pagadoEl: hoy() });
    expect(ac.excedente).toMatchObject({ clave: claves.exc, importe: "70.00", estado: "Autorizado", cubiertoPersonal: "70.00", reembolso: "por_decidir" });
    expect(r.anticipos.find((x) => x.clave === claves.e)?.estado).toBe("Fuera de caja: entregado, falta que lo confirme quien lo recibe");
    expect(r.reembolsos.map((x) => [x.clave, x.importe, x.estado]).sort()).toEqual([[claves.exc, "70.00", "por_decidir"], [claves.d, "50.00", "por_decidir"]].sort());
  });

  it("periodo por la fecha del pago al proveedor, y nada después del corte", async () => {
    // Solo hoy: el ya pagado de ayer no entra aunque se registró hoy.
    expect((await reporte(undefined, hoy(), hoy())).filas.map((f) => f.clave)).not.toContain(claves.d);
    // Solo ayer: el corte es el fin de ayer, y D se registró hoy (después del corte): no aparece.
    expect((await reporte(undefined, ayer(), ayer())).filas).toEqual([]);
    // Con el corte t1 solo estaba pagado A, y sin comprobante todavía.
    const r1 = await reporte(t1);
    expect(r1.filas.map((f) => [f.clave, f.comprobacion])).toEqual([[claves.a, "por_comprobar"]]);
    expect(r1.total).toEqual({ n: 1, importe: "200.00" });
    expect(r1.aparte.porAutorizar.n).toBe(0);
    expect((await reporte()).filas.find((f) => f.clave === claves.a)?.comprobacion).toBe("comprobado");
  });

  it("visibilidad: Gestión y Encargado su alcance; Recepción no consulta gastos; la beneficiada manda", async () => {
    expect(await reporteGastos(sql, rec, { codigo: null })).toBeNull();
    expect(await reporteGastos(sql, enc, { codigo: S2.codigo })).toBeNull();
    const e = await reporteGastos(sql, enc, { codigo: null, desde: ayer(), hasta: hoy() });
    expect(e?.sucursales.map((s) => s.codigo)).toEqual([S.codigo]);
    expect(e?.total.importe).toBe("1050.00");
    // En S2 (que pagó H) no hay gastos que se le carguen.
    expect((await reporteGastos(sql, dir, { codigo: S2.codigo, desde: ayer(), hasta: hoy() }))?.total).toEqual({ n: 0, importe: "0.00" });
  });

  it("caja: movimientos de gastos ya dentro del efectivo, fuera de caja aparte y pendientes sumados una vez", async () => {
    const c = (await reporteCaja(sql, dir, { codigo: S.codigo, desde: ayer(), hasta: hoy() }))!.filas[0];
    expect(c.gastos.movimientos).toEqual({
      gastos: { n: 1, importe: "-200.00" }, anticipos: { n: 2, importe: "-500.00" }, cambios: { n: 0, importe: "0.00" }, reembolsos: { n: 0, importe: "0.00" },
    });
    // La bolsa ya refleja las salidas una sola vez: 1000 − 200 − 400 − 100.
    expect(c.lugares.find((l) => l.tipo === "bolsa_visitas")?.importe).toBe("300.00");
    expect(c.gastos.fueraDeCaja.anticipos).toEqual({ n: 1, importe: "100.00" });
    const p = Object.fromEntries(c.gastos.pendientes.map((x) => [x.clave, x.lista.map((y) => y.clave).sort()]));
    expect(p.anticipos).toEqual([claves.e]);
    expect(p.sin_autorizacion).toEqual([claves.b, claves.exc, claves.d].sort());
    expect(p.comprobante).toEqual([claves.b]);
    expect(p.reembolsos).toEqual([claves.exc, claves.d].sort());
    // B, el excedente, D y E: cuatro gastos distintos (300 + 70 + 50 + 100), aunque B y el excedente aparecen dos veces.
    expect(c.gastos.totalPendientes).toEqual({ n: 4, importe: "520.00" });
    expect(c.gastos.pendientes.reduce((n, x) => n + x.n, 0)).toBeGreaterThan(4);
    // H lo pagó S2: aparece en la caja de S2, no en la de S.
    const c2 = (await reporteCaja(sql, dir, { codigo: S2.codigo, desde: ayer(), hasta: hoy() }))!.filas[0];
    expect(c2.gastos.pendientes.find((x) => x.clave === "sin_autorizacion")?.lista.map((x) => x.clave)).toEqual([claves.h]);
    // El Excel y el PDF de caja llevan las mismas filas.
    const d = await prepararDescarga(sql, dir, { codigo: S.codigo, desde: ayer(), hasta: hoy(), formato: "xlsx", contenido: "resumen" }, PRUEBAS);
    if (!d.ok) throw new Error(d.error);
    const ExcelJS = (await import("exceljs")).default;
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(await excelCaja(d.archivo) as unknown as ArrayBuffer);
    const col = (hoja: string, n: number) => { const l: string[] = []; libro.getWorksheet(hoja)!.eachRow((f) => l.push(String(f.getCell(n).value ?? ""))); return l; };
    expect(col("Movimientos", 2)).toEqual(expect.arrayContaining(["Gastos pagados de la bolsa o el cajón", "Anticipos entregados", "Cambio de anticipos recibido",
      "Reembolsos pagados de la bolsa o el cajón", "Aparte: pagos de turnos cerrados registrados"]));
    const resumen = col("Resumen", 2);
    expect(resumen).toContain("Fuera de caja: anticipos por comprobar y cambio por devolver");
    expect(resumen).toContain("Gastos con algún pendiente (4)");
    expect(resumen.filter((x) => x.startsWith("Requiere atención · gastos"))).toHaveLength(4);
    expect((await pdfCaja({ ...d.archivo, formato: "pdf" })).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("caja: un pago de turno cerrado va aparte y no se vuelve a descontar", async () => {
    const recZ = await cuenta("Recepción Z", "recepcion", S2.id);
    const t = await abrirTurno(sql, recZ, S2.codigo, { bolsa: "500.00", cajon: "0.00" }, PRUEBAS);
    if (!t.ok) throw new Error(t.error);
    const [{ id: turno }] = await sql<{ id: string }[]>`select id from turno where sucursal_id = ${S2.id} and cerrado_en is null`;
    await sql`update turno set cerrado_en = now() where id = ${turno}`;
    await sql`update responsable_lugar set hasta = now() where turno_id = ${turno}`;
    const t2 = await abrirTurno(sql, recZ, S2.codigo, { bolsa: "500.00", cajon: "0.00" }, PRUEBAS);
    if (!t2.ok) throw new Error(t2.error);
    const r = await registrarGastoPagado(sql, dir, S2.codigo, {
      concepto: "Garrafón ficticio del turno cerrado", categoria: "prueba_agua", importe: "45", proveedor: "", nota: "", pagaId: "", origen: "bolsa_visitas",
      pagadoPor: recZ, pagadoEl: hoy(), turno, aQuien: "", cuenta: "", referencia: "", motivoPagado: "Prueba ficticia: se pagó antes de cerrar", tipo: "ticket", folio: "", motivoSin: "",
      envio: randomUUID() }, PRUEBAS);
    expect(r.ok).toBe(true);
    const c = (await reporteCaja(sql, dir, { codigo: S2.codigo, desde: ayer(), hasta: hoy() }))!.filas[0];
    expect(c.gastos.turnosCerrados).toMatchObject({ n: 1, importe: "45.00" });
    expect(c.gastos.movimientos.gastos).toEqual({ n: 0, importe: "0.00" });
    expect(c.lugares.find((l) => l.tipo === "bolsa_visitas")?.importe).toBe("500.00");
    // En el reporte de gastos de S2 sí cuenta como gasto, una vez.
    expect((await reporteGastos(sql, dir, { codigo: S2.codigo, desde: ayer(), hasta: hoy() }))?.filas.map((f) => [f.importe, f.turnoCerrado])).toEqual([["45.00", true]]);
  });

  it("descarga: cuatro hojas (historial solo con detalle), mismo corte y claves; queda registrada", async () => {
    const resumen = await prepararDescargaGastos(sql, dir, { codigo: S.codigo, desde: ayer(), hasta: hoy(), corte: t1.toISOString(), formato: "xlsx", contenido: "resumen" }, PRUEBAS);
    if (!resumen.ok) throw new Error(resumen.error);
    expect(resumen.archivo.reporte.filas.map((f) => f.clave)).toEqual([claves.a]);
    expect(resumen.archivo.historial).toBeNull();
    const ExcelJS = (await import("exceljs")).default;
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(await excelGastos(resumen.archivo) as unknown as ArrayBuffer);
    expect(libro.worksheets.map((h) => h.name)).toEqual(["Gastos", "Anticipos", "Reembolsos", "Notas"]);
    const detalle = await prepararDescargaGastos(sql, dir, { codigo: S.codigo, desde: ayer(), hasta: hoy(), formato: "xlsx", contenido: "detalle" }, PRUEBAS);
    if (!detalle.ok) throw new Error(detalle.error);
    const libro2 = new ExcelJS.Workbook();
    await libro2.xlsx.load(await excelGastos(detalle.archivo) as unknown as ArrayBuffer);
    expect(libro2.worksheets.map((h) => h.name)).toEqual(["Gastos", "Anticipos", "Reembolsos", "Historial de gastos", "Notas"]);
    const eventos = detalle.archivo.historial!.filter((e) => e.clave === claves.c).map((e) => e.evento.split(" · ")[0]);
    expect(eventos).toEqual(["Solicitud", "Autorizado", "Anticipo entregado", "Confirmó que recibió el anticipo", "Anticipo comprobado", "Pago registrado", "Comprobante"]);
    const textoGastos: string[] = [];
    libro2.getWorksheet("Gastos")!.eachRow((f) => textoGastos.push(String(f.getCell(1).value ?? "")));
    for (const k of [claves.a, claves.b, claves.c, claves.exc, claves.d, claves.h]) expect(textoGastos).toContain(k);
    const pdf = await pdfGastos({ ...detalle.archivo, formato: "pdf" });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from descarga_reporte_gastos where usuario_id = ${dir}`;
    expect(n).toBe(2);
    expect(await prepararDescargaGastos(sql, rec, { codigo: S.codigo, formato: "pdf", contenido: "resumen" }, PRUEBAS)).toEqual({ ok: false, error: "no_encontrada" });
  });
});

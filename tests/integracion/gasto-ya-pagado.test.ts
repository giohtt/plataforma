import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bandejaGastos, comprobarAnticipo, confirmarAnticipo, decidirGasto, decidirReembolso, detalleGasto, entregarAnticipo, gastosPorDecidir,
  opcionesGastoPagado, pagosPosterioresDelTurno, registrarGastoPagado, solicitarGasto,
} from "@/lib/gastos";
import { reporteVisitas } from "@/lib/reporte-visitas";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 6, PR 8 (acordado el 27 nov 2026; solo datos ficticios; facultades ficticias solo dentro de la prueba): gastos
 * que ya se pagaron y pagos de turnos cerrados. Registrar no es aprobar ni autorizar un reembolso; el efectivo de un
 * turno cerrado conserva los registros de ese turno y no se descuenta del actual.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const D = "@prueba.fitnessland.invalid";
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const manana = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() + 86_400_000));

let codigo: string, sucursal: string;
let rec: string, rec2: string, enc: string, adm: string, ges: string, dir: string;
let turno1: string;

async function cuenta(nombre: string, rol: string | null, general = false) {
  const [x] = await sql<{ id: string }[]>`insert into usuario (nombre, correo, es_prueba) values (${nombre}, ${`y-${randomUUID().slice(0, 8)}${D}`}, true) returning id`;
  if (rol) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${x.id}, ${rol}, ${sucursal}, 'Prueba')`;
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${x.id}, 'direccion', 'Prueba')`;
  return x.id;
}
type Datos = Parameters<typeof registrarGastoPagado>[3];
const yaPagado = (u: string, x: Partial<Datos> = {}) => registrarGastoPagado(sql, u, codigo, {
  concepto: "Garrafones ficticios", categoria: "prueba_agua", importe: "120", proveedor: "Agua ficticia", nota: "",
  origen: "bolsa_visitas", pagadoPor: rec, pagadoEl: hoyMx(), turno: turno1, aQuien: "", cuenta: "", referencia: "",
  motivoPagado: "Prueba ficticia: se acabó el agua y no había quién autorizara", tipo: "ticket", folio: "A-1", motivoSin: "",
  envio: randomUUID(), ...x,
}, PRUEBAS);
const bolsa = async () => (await estadoTurno(sql, rec, codigo))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!;

describe.skipIf(!URL_ADMIN)("gastos ya pagados y pagos de turnos cerrados", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    codigo = `Y${randomUUID().replace(/[^0-9]/g, "").slice(0, 3)}`;
    [{ id: sucursal }] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Ya pagados " + codigo}, ${codigo}) returning id`;
    rec = await cuenta("Recepción Y", "recepcion");
    rec2 = await cuenta("Recepción Y2", "recepcion");
    enc = await cuenta("Encargado Y", "encargado");
    adm = await cuenta("Administración Y", "administracion");
    ges = await cuenta("Gestión administrativa Y", "gestion_administrativa");
    dir = await cuenta("Dirección Y", null, true);
    await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo)
              values (${enc}, 'autorizacion.gasto', ${sucursal}, 1000, 9000, 'Prueba')`;
    await sql`insert into facultad_otorgada (usuario_id, permiso, todas_las_sucursales, sin_limite, motivo)
              values (${dir}, 'autorizacion.gasto', true, true, 'Prueba')`;
    // Turno 1 (Recepción Y con la bolsa): se cierra. Turno 2 (Recepción Y2): abierto, con $500 en la bolsa.
    const t1 = await abrirTurno(sql, rec, codigo, { bolsa: "1000.00", cajon: "0.00" }, PRUEBAS);
    if (!t1.ok) throw new Error(t1.error);
    [{ id: turno1 }] = await sql<{ id: string }[]>`select id from turno where sucursal_id = ${sucursal}`;
    await sql`update turno set cerrado_en = now() where id = ${turno1}`;
    await sql`update responsable_lugar set hasta = now() where turno_id = ${turno1}`;
    const t2 = await abrirTurno(sql, rec2, codigo, { bolsa: "500.00", cajon: "0.00" }, PRUEBAS);
    if (!t2.ok) throw new Error(t2.error);
  });
  afterAll(async () => cerrar?.());

  it("efectivo de un turno cerrado: se registra ligado a ese turno, sin salida; el turno actual y el cerrado no cambian", async () => {
    const t2 = (await estadoTurno(sql, rec2, codigo))!.turno!;
    const antes = t2.lugares.find((l) => l.tipo === "bolsa_visitas")!.esperado;
    const movs = async (t: string) => (await sql<{ n: number }[]>`select count(*)::int as n from movimiento_efectivo where turno_id = ${t}`)[0].n;
    const movs1 = await movs(turno1);
    // Quién puede registrarlo: Recepción no (avisa a su Encargado).
    expect(await opcionesGastoPagado(sql, rec, sucursal)).toBeNull();
    expect(await yaPagado(rec)).toEqual({ ok: false, error: "sin_permiso" });
    // Validaciones: turno abierto, quien no fue responsable, fecha futura, sin comprobante ni motivo.
    expect(await yaPagado(enc, { turno: t2.id, pagadoPor: rec2 })).toEqual({ ok: false, error: "turno_abierto" });
    expect(await yaPagado(enc, { pagadoPor: enc })).toEqual({ ok: false, error: "pagado_por" });
    expect(await yaPagado(enc, { pagadoEl: manana() })).toEqual({ ok: false, error: "fecha" });
    expect(await yaPagado(enc, { tipo: "" })).toEqual({ ok: false, error: "comprobante" });
    expect(await yaPagado(enc, { motivoPagado: "x" })).toEqual({ ok: false, error: "motivo_ya_pagado" });
    expect(await yaPagado(enc, { origen: "transferencia", cuenta: "Banco ficticio", referencia: "REF-1" })).toEqual({ ok: false, error: "origen" });

    const r = await yaPagado(enc);
    expect(r.ok).toBe(true);
    const clave = r.ok ? r.clave : "";
    const d = await detalleGasto(sql, enc, codigo, clave);
    expect(d?.gasto).toMatchObject({ estado: "sin_autorizacion_previa", sinAutorizacionPrevia: true, impedimento: "ya_pagado", origenPago: "bolsa_visitas" });
    expect(d?.yaPagado).toMatchObject({ registradoPor: "Encargado Y", motivo: "Prueba ficticia: se acabó el agua y no había quién autorizara" });
    expect(d?.pago).toMatchObject({ posterior: true, pagadoPor: "Recepción Y", registradoPor: "Encargado Y", importe: "120.00" });
    expect(d?.pago?.turnoCerrado?.cerrado).toBeInstanceOf(Date);
    // Registrar no es aprobar: nadie lo decide en la ruta normal; aparece en la bandeja de Dirección.
    expect(await decidirGasto(sql, dir, codigo, { clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS)).toEqual({ ok: false, error: "ya_pagado" });
    expect(await gastosPorDecidir(sql, dir, sucursal)).toBe(0);
    expect((await bandejaGastos(sql, dir, "sin_autorizacion"))!.gastos.map((g) => g.clave)).toContain(clave);
    expect((await bandejaGastos(sql, dir, "por_autorizar"))!.gastos.map((g) => g.clave)).not.toContain(clave);
    // Sin salida de caja: el turno actual no cambia y el cerrado conserva sus registros.
    expect(t2.lugares.find((l) => l.tipo === "bolsa_visitas")!.esperado).toBe(antes);
    expect((await estadoTurno(sql, rec2, codigo))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!.esperado).toBe(antes);
    expect(await movs(turno1)).toBe(movs1);
    const [{ salidas }] = await sql<{ salidas: number }[]>`
      select count(*)::int as salidas from movimiento_efectivo where pago_gasto_id = (select id from pago_gasto where gasto_id = ${d!.gasto.id})`;
    expect(salidas).toBe(0);
    const rv = await reporteVisitas(sql, dir, { codigo, desde: hoyMx(), hasta: hoyMx() });
    expect(rv?.filas[0].turnos.find((t) => t.esperado === "1000.00")).toBeTruthy();
    // Se ve aparte, ligado a ese turno.
    expect((await pagosPosterioresDelTurno(sql, turno1)).map((p) => [p.clave, p.importe, p.pagadoPor])).toEqual([[clave, "120.00", "Recepción Y"]]);
    // Quien pagó lo ve aunque no consulte todos los gastos.
    expect((await detalleGasto(sql, rec, codigo, clave))?.gasto.clave).toBe(clave);
  });

  it("dinero personal: queda pendiente de reembolso de quien puso el dinero; registrar no autoriza el reembolso", async () => {
    const r = await yaPagado(ges, { origen: "dinero_personal", turno: "", pagadoPor: rec2, importe: "85.50", tipo: "sin",
      motivoSin: "Prueba ficticia: el puesto no da nota" });
    expect(r.ok).toBe(true);
    const clave = r.ok ? r.clave : "";
    let d = await detalleGasto(sql, rec2, codigo, clave);
    expect(d?.gasto).toMatchObject({ estado: "sin_autorizacion_previa", reembolso: "por_decidir", comprobacion: "sin_comprobante" });
    expect(d?.pago).toMatchObject({ origen: "dinero_personal", posterior: true, pagadoPor: "Recepción Y2", turnoCerrado: null });
    // Dirección decide el reembolso aparte (y al decidir ve que falta comprobante: exige motivo).
    expect(await decidirReembolso(sql, dir, codigo, { clave, decision: "autorizado", motivo: "" }, PRUEBAS)).toEqual({ ok: false, error: "motivo_sin_comprobante" });
    expect(await decidirReembolso(sql, dir, codigo, { clave, decision: "autorizado", motivo: "Prueba: revisado con Gestión" }, PRUEBAS)).toEqual({ ok: true });
    d = await detalleGasto(sql, rec2, codigo, clave);
    expect(d?.gasto).toMatchObject({ estado: "sin_autorizacion_previa", reembolso: "por_pagar" });
    // El gasto se cuenta una vez: un solo pago por lo pagado.
    const [{ n, total }] = await sql<{ n: number; total: string }[]>`
      select count(*)::int as n, sum(importe)::text as total from pago_gasto where gasto_id = ${d!.gasto.id}`;
    expect({ n, total }).toEqual({ n: 1, total: "85.50" });
  });

  it("transferencia y tarjeta: las registra quien puede, sin tocar efectivo; idempotente por envío", async () => {
    const envio = randomUUID();
    const datos = { origen: "transferencia", turno: "", pagadoPor: adm, cuenta: "Cuenta ficticia", referencia: "TRF-900", importe: "300", envio };
    const r = await yaPagado(adm, datos);
    expect(r.ok).toBe(true);
    expect(await yaPagado(adm, datos)).toEqual(r);
    expect(await yaPagado(adm, { origen: "tarjeta", turno: "", pagadoPor: adm, cuenta: "1234 5678", referencia: "" })).toEqual({ ok: false, error: "cuenta" });
    expect((await yaPagado(enc, { origen: "tarjeta", turno: "", pagadoPor: enc, cuenta: "Tarjeta ficticia", referencia: "" })).ok).toBe(true);
  });

  it("el excedente de un anticipo se marca «Pagado sin autorización previa» (se pagó antes de autorizarse)", async () => {
    const s = await solicitarGasto(sql, rec2, codigo, { concepto: "Material ficticio", categoria: "prueba_limpieza", importe: "100",
      proveedor: "", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
    if (!s.ok) throw new Error(s.error);
    expect(await decidirGasto(sql, enc, codigo, { clave: s.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS)).toEqual({ ok: true });
    expect(await entregarAnticipo(sql, rec2, codigo, { clave: s.clave, version: 1, lugar: "bolsa_visitas", recibe: adm }, PRUEBAS)).toEqual({ ok: true });
    expect(await confirmarAnticipo(sql, adm, codigo, { clave: s.clave }, PRUEBAS)).toEqual({ ok: true });
    const c = await comprobarAnticipo(sql, adm, codigo, { clave: s.clave, gastado: "130", pagadoEl: hoyMx(), aQuien: "", envio: randomUUID(),
      tipo: "nota", folio: "", motivoSin: "" }, PRUEBAS);
    const exc = c.ok ? c.excedente! : "";
    expect((await detalleGasto(sql, adm, codigo, exc))?.gasto).toMatchObject({ estado: "por_autorizar", sinAutorizacionPrevia: true });
    expect((await detalleGasto(sql, adm, codigo, s.clave))?.gasto.sinAutorizacionPrevia).toBe(false);
    expect((await bolsa()).esperado).toBeDefined();
  });

  it("la base lo respalda: sin registro de ya pagado no hay pago posterior; sin decisión; efectivo cerrado sin salida", async () => {
    const r = await yaPagado(adm, { importe: "40" });
    const clave = r.ok ? r.clave : "";
    const [{ id }] = await sql<{ id: string }[]>`select id from gasto where clave = ${clave}`;
    await expect(sql`insert into decision_gasto (gasto_id, version, decision, importe, por, facultad_id, sin_limite)
                     select ${id}, 1, 'autorizado', 40, ${dir}, f.id, true from facultad_otorgada f where f.usuario_id = ${dir}`).rejects.toThrow();
    const [{ pid }] = await sql<{ pid: string }[]>`select id as pid from pago_gasto where gasto_id = ${id}`;
    const [{ lugar }] = await sql<{ lugar: string }[]>`select id as lugar from lugar_efectivo where sucursal_id = ${sucursal} and tipo = 'bolsa_visitas'`;
    const t2 = (await estadoTurno(sql, rec2, codigo))!.turno!;
    await expect(sql`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, pago_gasto_id, responsable_id, registrado_por)
                     values (${lugar}, ${t2.id}, 'salida_pago_gasto', -40, ${pid}, ${rec2}, ${rec2})`).rejects.toThrow(/no tiene salida de caja/);
    // Un pago posterior sin registro de gasto ya pagado, no; ni un gasto ya pagado sin su pago.
    const s = await solicitarGasto(sql, enc, codigo, { concepto: "Otra compra ficticia", categoria: "prueba_otros", importe: "50",
      proveedor: "", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
    const [{ gid }] = await sql<{ gid: string }[]>`select id as gid from gasto where clave = ${s.ok ? s.clave : ""}`;
    await expect(sql`insert into pago_gasto (gasto_id, version, origen, importe, pagado_el, pagado_por, registrado_por, cuenta, posterior)
                     values (${gid}, 1, 'tarjeta', 50, ${hoyMx()}, ${enc}, ${enc}, 'Tarjeta ficticia', true)`).rejects.toThrow(/gasto registrado como ya pagado/);
    await expect(sql`insert into gasto_ya_pagado (gasto_id, motivo, registrado_por) values (${gid}, 'Prueba sin pago', ${enc})`).rejects.toThrow(/con su pago/);
    // Un efectivo posterior sin turno cerrado, no.
    await expect(sql.begin(async (tx) => {
      await tx`insert into gasto_ya_pagado (gasto_id, motivo, registrado_por) values (${gid}, 'Prueba sin turno', ${enc})`;
      await tx`insert into pago_gasto (gasto_id, version, origen, importe, pagado_el, pagado_por, registrado_por, posterior)
               values (${gid}, 1, 'bolsa_visitas', 50, ${hoyMx()}, ${rec}, ${enc}, true)`;
    })).rejects.toThrow(/pago_posterior_efectivo_con_turno/);
    await expect(sql`update gasto_ya_pagado set motivo = 'Cambiado' where gasto_id = ${id}`).rejects.toThrow(/no se edita/);
  });
});

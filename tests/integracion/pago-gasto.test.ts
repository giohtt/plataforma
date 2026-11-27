import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  corregirGasto, decidirGasto, detalleGasto, gastosPorPagar, pedirExcedente, registrarComprobante, registrarPago, solicitarGasto,
} from "@/lib/gastos";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 6, PR 5 (acordado el 27 nov 2026; solo datos ficticios; límites ficticios solo para la prueba): pago y
 * comprobante de gastos autorizados, con cinco orígenes distintos.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const D = "@prueba.fitnessland.invalid";
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const ayerMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 86_400_000));

let codigo: string, sucursal: string;
let rec: string, enc: string, ges: string, adm: string, dir: string;

async function cuenta(nombre: string, rol: string | null, general = false) {
  const [x] = await sql<{ id: string }[]>`insert into usuario (nombre, correo, es_prueba) values (${nombre}, ${`p-${randomUUID().slice(0, 8)}${D}`}, true) returning id`;
  if (rol) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${x.id}, ${rol}, ${sucursal}, 'Prueba')`;
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${x.id}, 'direccion', 'Prueba')`;
  return x.id;
}
async function autorizado(importe: string, por = enc, solicita = rec) {
  const r = await solicitarGasto(sql, solicita, codigo, { concepto: `Compra ficticia ${importe}`, categoria: "prueba_limpieza", importe,
    proveedor: "Proveedor ficticio A", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  const d = await decidirGasto(sql, por, codigo, { clave: r.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS);
  if (!d.ok) throw new Error(d.error);
  return r.clave;
}
const pagar = (u: string, clave: string, x: Partial<Parameters<typeof registrarPago>[3]> = {}) =>
  registrarPago(sql, u, codigo, { clave, version: 1, origen: "bolsa_visitas", importe: "", aQuien: "", pagadoEl: "", cuenta: "", referencia: "",
    tipo: "", folio: "", motivoSin: "", ...x }, PRUEBAS);
const esperado = async () => Object.fromEntries((await estadoTurno(sql, rec, codigo))!.turno!.lugares.map((l) => [l.tipo, l.esperado]));

describe.skipIf(!URL_ADMIN)("pago y comprobante de gastos", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    codigo = `P${randomUUID().replace(/[^0-9]/g, "").slice(0, 3)}`;
    [{ id: sucursal }] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Pagos " + codigo}, ${codigo}) returning id`;
    rec = await cuenta("Recepción P", "recepcion");
    enc = await cuenta("Encargado P", "encargado");
    ges = await cuenta("Gestión administrativa P", "gestion_administrativa");
    adm = await cuenta("Administración P", "administracion");
    dir = await cuenta("Dirección P", null, true);
    await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo)
              values (${enc}, 'autorizacion.gasto', ${sucursal}, 500, 5000, 'Prueba'), (${ges}, 'autorizacion.gasto', ${sucursal}, 2000, 9000, 'Prueba')`;
    const t = await abrirTurno(sql, rec, codigo, { bolsa: "1000.00", cajon: "2000.00" }, PRUEBAS);
    if (!t.ok) throw new Error(t.error);
  });
  afterAll(async () => cerrar?.());

  it("efectivo de la bolsa: lo pagado (no lo autorizado), una sola salida, baja el esperado; ya no se corrige", async () => {
    const a = await autorizado("200");
    expect(await gastosPorPagar(sql, rec, sucursal)).toBe(1);
    // Solo la responsable vigente paga en efectivo.
    expect(await pagar(enc, a, { importe: "180" })).toEqual({ ok: false, error: "autorizo" });
    expect(await pagar(adm, a, { importe: "180" })).toEqual({ ok: false, error: "no_responsable" });
    expect(await pagar(rec, a, { importe: "250" })).toEqual({ ok: false, error: "excede" });
    expect(await pagar(rec, a, { importe: "180", tipo: "ticket", folio: "T-001", aQuien: "Proveedor ficticio A" })).toEqual({ ok: true });
    expect(await pagar(rec, a, { importe: "180" })).toEqual({ ok: false, error: "ya_pagado" });
    expect(await esperado()).toEqual({ bolsa_visitas: "820.00", cajon_mensualidades: null });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from movimiento_efectivo where tipo = 'salida_pago_gasto' and importe = -180`;
    expect(n).toBe(1);
    const d = await detalleGasto(sql, rec, codigo, a);
    expect(d?.pago).toMatchObject({ origen: "bolsa_visitas", importe: "180.00", pagadoEl: hoyMx() });
    expect(d?.gasto.comprobacion).toBe("comprobado");
    expect(d?.comprobantes).toMatchObject([{ tipo: "ticket", folio: "T-001" }]);
    expect(d?.puedeCorregir).toBe(false);
    expect(await corregirGasto(sql, rec, codigo, { concepto: "Otra", categoria: "prueba_limpieza", importe: "150", proveedor: "", nota: "", clave: a, version: 1,
      motivo: "Intento después de pagar" }, PRUEBAS)).toEqual({ ok: false, error: "ya_pagado" });
  });

  it("cajón: la salida se registra, pero su esperado sigue sin calcularse", async () => {
    const b = await autorizado("100");
    expect(await pagar(rec, b, { origen: "cajon_mensualidades", importe: "100" })).toEqual({ ok: true });
    const t = (await estadoTurno(sql, rec, codigo))!.turno!;
    const cajon = t.lugares.find((l) => l.tipo === "cajon_mensualidades")!;
    expect(cajon.esperado).toBeNull();
    expect(cajon.gastos).toBe("-100.00");
    expect(cajon.cantidadGastos).toBe(1);
    expect((await detalleGasto(sql, rec, codigo, b))?.gasto.comprobacion).toBe("por_comprobar");
  });

  it("si costó más: se pide autorización por el excedente, ligada a la misma compra", async () => {
    const c = await autorizado("300");
    expect(await pedirExcedente(sql, rec, codigo, { clave: c, importeReal: "290", envio: randomUUID() }, PRUEBAS)).toEqual({ ok: false, error: "no_excede" });
    const x = await pedirExcedente(sql, rec, codigo, { clave: c, importeReal: "350", envio: randomUUID() }, PRUEBAS);
    expect(x.ok).toBe(true);
    const dx = await detalleGasto(sql, rec, codigo, (x as { clave: string }).clave);
    expect(dx?.gasto).toMatchObject({ importe: "50.00", compraDe: c, estado: "por_autorizar" });
    expect(await pagar(rec, c, { importe: "300" })).toEqual({ ok: true });
  });

  it("transferencia: la registra Administración, Gestión administrativa o Dirección, que no la haya autorizado; nombre corto sin números", async () => {
    const t = await autorizado("400", ges);
    expect(await pagar(rec, t, { origen: "transferencia", importe: "400", cuenta: "Cuenta ficticia 1", referencia: "TRF-0001", pagadoEl: hoyMx() }))
      .toEqual({ ok: false, error: "origen" });
    expect(await pagar(ges, t, { origen: "transferencia", importe: "400", cuenta: "Cuenta ficticia 1", referencia: "TRF-0001", pagadoEl: hoyMx() }))
      .toEqual({ ok: false, error: "autorizo" });
    expect(await pagar(adm, t, { origen: "transferencia", importe: "400", cuenta: "Banco 1234", referencia: "TRF-0001", pagadoEl: hoyMx() }))
      .toEqual({ ok: false, error: "cuenta" });
    expect(await pagar(adm, t, { origen: "transferencia", importe: "400", cuenta: "Cuenta ficticia 1", referencia: "", pagadoEl: hoyMx() }))
      .toEqual({ ok: false, error: "referencia" });
    expect(await pagar(adm, t, { origen: "transferencia", importe: "400", cuenta: "Cuenta ficticia 1", referencia: "TRF-0001", pagadoEl: ayerMx() }))
      .toEqual({ ok: false, error: "fecha" });
    expect(await pagar(adm, t, { origen: "transferencia", importe: "400", cuenta: "Cuenta ficticia 1", referencia: "TRF-0001", pagadoEl: hoyMx() }))
      .toEqual({ ok: true });
    expect((await detalleGasto(sql, adm, codigo, t))?.pago).toMatchObject({ origen: "transferencia", cuenta: "Cuenta ficticia 1", referencia: "TRF-0001" });
    // No toca efectivo.
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from movimiento_efectivo m join pago_gasto p on p.id = m.pago_gasto_id
                                               join gasto g on g.id = p.gasto_id where g.clave = ${t}`;
    expect(n).toBe(0);
  });

  it("tarjeta y dinero personal: no tocan efectivo; el dinero personal queda pendiente de reembolso", async () => {
    const t = await autorizado("120");
    expect(await pagar(enc, t, { origen: "tarjeta", importe: "120", cuenta: "Tarjeta ficticia 1", pagadoEl: hoyMx() })).toEqual({ ok: false, error: "autorizo" });
    expect(await pagar(ges, t, { origen: "tarjeta", importe: "120", cuenta: "Tarjeta ficticia 1", pagadoEl: hoyMx() })).toEqual({ ok: true });
    const p = await autorizado("80", ges);
    expect(await pagar(enc, p, { origen: "dinero_personal", importe: "80", pagadoEl: hoyMx(), tipo: "nota" })).toEqual({ ok: true });
    const d = await detalleGasto(sql, enc, codigo, p);
    expect(d?.pago).toMatchObject({ origen: "dinero_personal", pagadoPor: "Encargado P" });
    expect(d?.gasto.origenPago).toBe("dinero_personal");
    expect(await esperado()).toEqual({ bolsa_visitas: "520.00", cajon_mensualidades: null });
  });

  it("sin autorizar no se paga; Dirección sí paga lo que ella autorizó", async () => {
    const r = await solicitarGasto(sql, rec, codigo, { concepto: "Sin autorizar", categoria: "prueba_otros", importe: "10", proveedor: "", nota: "",
      pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
    expect(await pagar(adm, (r as { clave: string }).clave, { origen: "tarjeta", importe: "10", cuenta: "Tarjeta ficticia 1", pagadoEl: hoyMx() }))
      .toEqual({ ok: false, error: "no_autorizado" });
    await sql`insert into facultad_otorgada (usuario_id, permiso, todas_las_sucursales, sin_limite, motivo) values (${dir}, 'autorizacion.gasto', true, true, 'Prueba')`;
    const x = await autorizado("60", dir);
    expect(await pagar(dir, x, { origen: "transferencia", importe: "60", cuenta: "Cuenta ficticia 1", referencia: "TRF-0002", pagadoEl: hoyMx() })).toEqual({ ok: true });
  });

  it("comprobantes: después del pago, de quien pagó o quien solicitó; «sin comprobante» con motivo queda para Dirección", async () => {
    const a = await autorizado("50");
    expect(await registrarComprobante(sql, rec, codigo, { clave: a, tipo: "ticket", folio: "", motivoSin: "" }, PRUEBAS)).toEqual({ ok: false, error: "no_autorizado" });
    expect(await pagar(rec, a, { importe: "50" })).toEqual({ ok: true });
    expect(await registrarComprobante(sql, enc, codigo, { clave: a, tipo: "ticket", folio: "", motivoSin: "" }, PRUEBAS)).toEqual({ ok: false, error: "sin_permiso" });
    expect(await registrarComprobante(sql, rec, codigo, { clave: a, tipo: "sin", folio: "", motivoSin: "x" }, PRUEBAS)).toEqual({ ok: false, error: "motivo" });
    expect(await registrarComprobante(sql, rec, codigo, { clave: a, tipo: "sin", folio: "", motivoSin: "El proveedor no entrega nota" }, PRUEBAS)).toEqual({ ok: true });
    expect((await detalleGasto(sql, rec, codigo, a))?.gasto.comprobacion).toBe("sin_comprobante");
    expect(await registrarComprobante(sql, rec, codigo, { clave: a, tipo: "factura", folio: "F-1", motivoSin: "" }, PRUEBAS)).toEqual({ ok: false, error: "comprobante" });
    const b = await autorizado("30");
    expect(await pagar(rec, b, { importe: "30", tipo: "factura", folio: "F-9" })).toEqual({ ok: true });
    expect(await registrarComprobante(sql, rec, codigo, { clave: b, tipo: "nota", folio: "", motivoSin: "" }, PRUEBAS)).toEqual({ ok: true });
    expect((await detalleGasto(sql, rec, codigo, b))?.comprobantes.map((c) => c.tipo)).toEqual(["factura", "nota"]);
  });

  it("la base respalda: salida sin pago, pago en efectivo sin su salida y cambios se rechazan", async () => {
    const [l] = await sql<{ id: string; turno: string }[]>`select l.id, t.id as turno from lugar_efectivo l join turno t on t.sucursal_id = l.sucursal_id and t.cerrado_en is null
                                                            where l.sucursal_id = ${sucursal} and l.tipo = 'bolsa_visitas'`;
    await expect(sql`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, responsable_id, registrado_por)
                     values (${l.id}, ${l.turno}, 'salida_pago_gasto', -5, ${rec}, ${rec})`).rejects.toThrow();
    const a = await autorizado("5");
    const [g] = await sql<{ id: string }[]>`select id from gasto where clave = ${a}`;
    await expect(sql`insert into pago_gasto (gasto_id, version, origen, importe, pagado_el, pagado_por, registrado_por)
                     values (${g.id}, 1, 'bolsa_visitas', 5, ${hoyMx()}, ${rec}, ${rec})`).rejects.toThrow(/registra su salida/);
    await expect(sql`insert into pago_gasto (gasto_id, version, origen, importe, pagado_el, pagado_por, registrado_por)
                     values (${g.id}, 1, 'tarjeta', 6, ${hoyMx()}, ${rec}, ${rec})`).rejects.toThrow();
    expect(await pagar(rec, a, { importe: "5" })).toEqual({ ok: true });
    await expect(sql`update pago_gasto set importe = 1 where gasto_id = ${g.id}`).rejects.toThrow(/no se edita/);
    await expect(sql`delete from comprobante_gasto`).rejects.toThrow();
  });
});

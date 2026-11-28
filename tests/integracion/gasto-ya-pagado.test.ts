import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registrarPago, bandejaGastos, comprobarAnticipo, confirmarAnticipo, decidirGasto, decidirReembolso, detalleGasto, entregarAnticipo, gastosPorDecidir,
  opcionesGastoPagado, pagosPosterioresDelTurno, registrarGastoPagado, solicitarGasto,
} from "@/lib/gastos";
import { reporteVisitas } from "@/lib/reporte-visitas";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 6, PR 8 (acordado el 27 nov 2026; precisiones de las 22:22; solo datos ficticios; facultades ficticias solo
 * dentro de la prueba): gastos que ya se pagaron. Registrar no es aprobar ni autorizar un reembolso. Efectivo del turno
 * abierto: una sola salida al registrarlo; de un turno cerrado: sin salida, ligado a ese turno. Registrar o revisar el
 * gasto no vuelve a descontar el dinero. La sucursal que paga y la beneficiada siguen separadas.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const D = "@prueba.fitnessland.invalid";
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const manana = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() + 86_400_000));

let codigo: string, sucursal: string, codigo2: string, sucursal2: string;
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
  pagaId: "", origen: "bolsa_visitas", pagadoPor: rec, pagadoEl: hoyMx(), turno: turno1, aQuien: "", cuenta: "", referencia: "",
  motivoPagado: "Prueba ficticia: se acabó el agua y no había quién autorizara", tipo: "ticket", folio: "A-1", motivoSin: "",
  envio: randomUUID(), ...x,
}, PRUEBAS);
const bolsa = async () => (await estadoTurno(sql, rec2, codigo))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!;
const movimientos = async () => (await sql<{ n: number; neto: string }[]>`
  select count(*)::int as n, coalesce(sum(me.importe), 0)::text as neto from movimiento_efectivo me join turno t on t.id = me.turno_id
  where t.sucursal_id = ${sucursal}`)[0];

describe.skipIf(!URL_ADMIN)("gastos ya pagados y pagos de turnos cerrados", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    codigo = `Y${randomUUID().replace(/[^0-9]/g, "").slice(0, 3)}`;
    [{ id: sucursal }] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Ya pagados " + codigo}, ${codigo}) returning id`;
    codigo2 = `Z${randomUUID().replace(/[^0-9]/g, "").slice(0, 3)}`;
    [{ id: sucursal2 }] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Paga " + codigo2}, ${codigo2}) returning id`;
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
    expect(await yaPagado(enc, { pagadoPor: enc })).toEqual({ ok: false, error: "pagado_por" });
    expect(await yaPagado(enc, { pagadoEl: manana() })).toEqual({ ok: false, error: "fecha" });
    expect(await yaPagado(enc, { tipo: "" })).toEqual({ ok: false, error: "comprobante" });
    expect(await yaPagado(enc, { motivoPagado: "x" })).toEqual({ ok: false, error: "motivo_ya_pagado" });
    expect(await yaPagado(enc, { origen: "transferencia", cuenta: "Banco ficticio", referencia: "REF-1" })).toEqual({ ok: false, error: "origen" });
    expect(await yaPagado(enc, { pagaId: sucursal2 })).toEqual({ ok: false, error: "sucursal_paga" });

    const r = await yaPagado(enc);
    expect(r.ok).toBe(true);
    const clave = r.ok ? r.clave : "";
    const d = await detalleGasto(sql, enc, codigo, clave);
    expect(d?.gasto).toMatchObject({ estado: "sin_autorizacion_previa", autorizacionPrevia: "sin_autorizacion_previa", impedimento: "ya_pagado", origenPago: "bolsa_visitas" });
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

  it("efectivo del turno abierto: una sola salida al registrarlo; registrar de nuevo o revisar no vuelve a descontar", async () => {
    const t2 = (await estadoTurno(sql, rec2, codigo))!.turno!;
    const antes = Number((await bolsa()).esperado);
    const m0 = await movimientos();
    const envio = randomUUID();
    const datos = { turno: t2.id, pagadoPor: enc, importe: "75", concepto: "Foco ficticio", motivoPagado: "Prueba ficticia: se fundió el foco de la entrada", envio };
    expect(await yaPagado(enc, { ...datos, pagadoEl: manana() })).toEqual({ ok: false, error: "fecha" });
    const r = await yaPagado(enc, datos);
    expect(r.ok).toBe(true);
    const clave = r.ok ? r.clave : "";
    // Baja el esperado una sola vez, en el turno abierto, con la responsable vigente del lugar.
    expect(Number((await bolsa()).esperado)).toBe(antes - 75);
    expect(await bolsa()).toMatchObject({ cantidadGastos: 1 });
    const [m] = await sql<{ n: number; responsable: string; registro: string; importe: string; turno: string }[]>`
      select count(*) over ()::int as n, me.responsable_id as responsable, me.registrado_por as registro, me.importe::text, me.turno_id as turno
      from movimiento_efectivo me join pago_gasto p on p.id = me.pago_gasto_id join gasto g on g.id = p.gasto_id where g.clave = ${clave}`;
    expect(m).toEqual({ n: 1, responsable: rec2, registro: enc, importe: "-75.00", turno: t2.id });
    const d = await detalleGasto(sql, enc, codigo, clave);
    expect(d?.gasto).toMatchObject({ estado: "sin_autorizacion_previa", autorizacionPrevia: "sin_autorizacion_previa" });
    expect(d?.pago).toMatchObject({ posterior: true, turnoCerrado: null, salidaResponsable: "Recepción Y2", pagadoPor: "Encargado Y" });
    // Reenviar el mismo formulario, consultar, verlo en la bandeja o intentar autorizarlo no vuelve a descontar.
    expect(await yaPagado(enc, datos)).toEqual(r);
    await detalleGasto(sql, dir, codigo, clave);
    await bandejaGastos(sql, dir, "sin_autorizacion");
    expect(await decidirGasto(sql, dir, codigo, { clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS)).toEqual({ ok: false, error: "ya_pagado" });
    expect(Number((await bolsa()).esperado)).toBe(antes - 75);
    const m1 = await movimientos();
    expect(m1.n).toBe(m0.n + 1);
    expect(Number(m1.neto)).toBe(Number(m0.neto) - 75);
    // Un segundo pago o una segunda salida del mismo gasto, no.
    const [{ gid, pid }] = await sql<{ gid: string; pid: string }[]>`select g.id as gid, p.id as pid from gasto g join pago_gasto p on p.gasto_id = g.id where g.clave = ${clave}`;
    const [{ lugar }] = await sql<{ lugar: string }[]>`select id as lugar from lugar_efectivo where sucursal_id = ${sucursal} and tipo = 'bolsa_visitas'`;
    await expect(sql`insert into pago_gasto (gasto_id, version, origen, importe, pagado_el, pagado_por, registrado_por, posterior)
                     values (${gid}, 1, 'dinero_personal', 75, ${hoyMx()}, ${enc}, ${enc}, true)`).rejects.toThrow(/duplicate|unique/);
    await expect(sql`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, pago_gasto_id, responsable_id, registrado_por)
                     values (${lugar}, ${t2.id}, 'salida_pago_gasto', -75, ${pid}, ${rec2}, ${enc})`).rejects.toThrow(/duplicate|unique/);
    expect(Number((await bolsa()).esperado)).toBe(antes - 75);
  });

  it("sucursal que paga y beneficiada separadas: la clave es de la beneficiada; el efectivo sale del turno de la que paga", async () => {
    // Gestión administrativa con alcance en ambas sucursales (ficticio).
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${ges}, 'gestion_administrativa', ${sucursal2}, 'Prueba')`;
    const recZ = await cuenta("Recepción Z", null);
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${recZ}, 'recepcion', ${sucursal2}, 'Prueba')`;
    const tz = await abrirTurno(sql, recZ, codigo2, { bolsa: "800.00", cajon: "0.00" }, PRUEBAS);
    if (!tz.ok) throw new Error(tz.error);
    const op = await opcionesGastoPagado(sql, ges, sucursal, sucursal2);
    expect(op?.pagaId).toBe(sucursal2);
    expect(op?.sucursalesPaga.map((x) => x.id).sort()).toEqual([sucursal, sucursal2].sort());
    const turnoZ = op!.turnos.find((t) => t.cerrado === null)!;
    const antesY = Number((await bolsa()).esperado);
    const r = await yaPagado(ges, { pagaId: sucursal2, turno: turnoZ.id, pagadoPor: recZ, importe: "60", concepto: "Material para Y pagado en Z" });
    expect(r.ok).toBe(true);
    const clave = r.ok ? r.clave : "";
    expect(clave.startsWith(`${codigo}-G`)).toBe(true);
    const d = await detalleGasto(sql, ges, codigo, clave);
    expect(d?.gasto).toMatchObject({ beneficiada: `Ya pagados ${codigo}`, paga: `Paga ${codigo2}`, pagaOtra: true });
    expect(Number((await bolsa()).esperado)).toBe(antesY);
    const z = (await estadoTurno(sql, recZ, codigo2))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!;
    expect(z.esperado).toBe("740.00");
    // Se consulta igual desde la sucursal que pagó, con la misma clave.
    expect((await detalleGasto(sql, ges, codigo2, clave))?.gasto.clave).toBe(clave);
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

  it("autorización previa por fecha y hora: excedente pendiente y luego sin autorización previa; mismo día sin hora, no comprobada", async () => {
    const autorizar = async (importe: string) => {
      const r = await solicitarGasto(sql, adm, codigo, { concepto: `Material ficticio ${importe}`, categoria: "prueba_limpieza", importe,
        proveedor: "", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
      if (!r.ok) throw new Error(r.error);
      expect(await decidirGasto(sql, enc, codigo, { clave: r.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS)).toEqual({ ok: true });
      return r.clave;
    };
    const previa = async (clave: string) => (await detalleGasto(sql, dir, codigo, clave))?.gasto.autorizacionPrevia;

    // Excedente de un anticipo: el proveedor se pagó antes de comprobar; mientras no se autorice, queda pendiente.
    const a = await autorizar("100");
    expect(await previa(a)).toBeNull();
    expect(await entregarAnticipo(sql, rec2, codigo, { clave: a, version: 1, lugar: "bolsa_visitas", recibe: adm }, PRUEBAS)).toEqual({ ok: true });
    expect(await confirmarAnticipo(sql, adm, codigo, { clave: a }, PRUEBAS)).toEqual({ ok: true });
    const c = await comprobarAnticipo(sql, adm, codigo, { clave: a, gastado: "130", pagadoEl: hoyMx(), aQuien: "", envio: randomUUID(),
      tipo: "nota", folio: "", motivoSin: "" }, PRUEBAS);
    const exc = c.ok ? c.excedente! : "";
    expect(await previa(exc)).toBe("pendiente");
    expect((await bandejaGastos(sql, dir, "sin_autorizacion"))!.gastos.map((g) => g.clave)).toContain(exc);
    // Se autoriza el mismo día, pero después de la comprobación (cuando ya se había pagado): no fue autorización previa.
    expect(await decidirGasto(sql, enc, codigo, { clave: exc, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS)).toEqual({ ok: true });
    expect(await previa(exc)).toBe("sin_autorizacion_previa");
    const [orden] = await sql<{ comprobado: Date; autorizado: Date }[]>`
      select k.en as comprobado, d.en as autorizado from anticipo_comprobado k join gasto x on x.id = k.excedente_gasto_id
      join decision_gasto d on d.gasto_id = x.id where x.clave = ${exc}`;
    expect(orden.comprobado.getTime()).toBeLessThan(orden.autorizado.getTime());
    // El anticipo mismo se entregó después de autorizar: comprobada.
    expect(await previa(a)).toBe("comprobada");

    // Efectivo del turno abierto: el registro es la hora del pago, después de autorizar: comprobada.
    const b = await autorizar("40");
    expect(await registrarPago(sql, rec2, codigo, { clave: b, version: 1, origen: "bolsa_visitas", importe: "40", aQuien: "", pagadoEl: "",
      cuenta: "", referencia: "", tipo: "ticket", folio: "", motivoSin: "" }, PRUEBAS)).toEqual({ ok: true });
    expect(await previa(b)).toBe("comprobada");

    // Tarjeta con solo el día del pago, el mismo de la autorización: no se puede comprobar el orden.
    const t = await autorizar("55");
    expect(await registrarPago(sql, adm, codigo, { clave: t, version: 1, origen: "tarjeta", importe: "55", aQuien: "", pagadoEl: hoyMx(),
      cuenta: "Tarjeta ficticia", referencia: "", tipo: "ticket", folio: "", motivoSin: "" }, PRUEBAS)).toEqual({ ok: true });
    expect(await previa(t)).toBe("no_comprobada");
    expect((await bandejaGastos(sql, dir, "sin_autorizacion"))!.gastos.map((g) => g.clave)).toContain(t);
    expect((await bandejaGastos(sql, dir, "sin_autorizacion"))!.gastos.map((g) => g.clave)).not.toContain(b);
    // Si el día del pago es anterior al de la autorización (se simula la fecha en la base de prueba): sin autorización previa.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update pago_gasto set pagado_el = pagado_el - 1 where gasto_id = (select id from gasto where clave = ${t})`;
    });
    expect(await previa(t)).toBe("sin_autorizacion_previa");
  });

  it("hora del pago declarada (opcional): con hora se comparan fecha y hora; sin hora y el mismo día, no comprobada", async () => {
    const r = await solicitarGasto(sql, adm, codigo, { concepto: "Servicio ficticio", categoria: "prueba_otros", importe: "90",
      proveedor: "", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    expect(await decidirGasto(sql, enc, codigo, { clave: r.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS)).toEqual({ ok: true });
    const pago = (x: Record<string, string>) => registrarPago(sql, adm, codigo, { clave: r.clave, version: 1, origen: "transferencia", importe: "90",
      aQuien: "", pagadoEl: hoyMx(), cuenta: "Cuenta ficticia", referencia: "TRF-77", tipo: "ticket", folio: "", motivoSin: "", ...x }, PRUEBAS);
    // Validaciones: formato, futura, y solo en transferencia, tarjeta o dinero personal.
    expect(await pago({ hora: "25:00" })).toEqual({ ok: false, error: "hora" });
    expect(await pago({ hora: "23:59", pagadoEl: manana() })).toEqual({ ok: false, error: "fecha" });
    expect(await pago({ hora: "10:00", origen: "bolsa_visitas" })).toEqual({ ok: false, error: "hora" });
    const ahora = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    if (ahora < "23:58") {
      const [h, m] = ahora.split(":").map(Number);
      const futura = `${String(m >= 58 ? h + 1 : h).padStart(2, "0")}:${String((m + 2) % 60).padStart(2, "0")}`;
      expect(await pago({ hora: futura })).toEqual({ ok: false, error: "hora" });
    }
    // Sin hora, el mismo día de la autorización: no comprobada.
    expect(await pago({ hora: "" })).toEqual({ ok: true });
    expect((await detalleGasto(sql, dir, codigo, r.clave))?.gasto.autorizacionPrevia).toBe("no_comprobada");
    // Con hora declarada (se fija la autorización a las 12:00 de ese día en la base de prueba): antes, sin autorización
    // previa; después, comprobada. La hora declarada y el registro automático se guardan aparte.
    const ajustar = (hora: string) => sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const [{ gid }] = await tx<{ gid: string }[]>`select id as gid from gasto where clave = ${r.clave}`;
      await tx`update decision_gasto d set en = (p.pagado_el + time '12:00') at time zone 'America/Mexico_City'
               from pago_gasto p where p.gasto_id = ${gid} and d.gasto_id = ${gid}`;
      await tx`update pago_gasto set hora_declarada = ${hora}::time where gasto_id = ${gid}`;
    });
    await ajustar("11:59");
    expect((await detalleGasto(sql, dir, codigo, r.clave))?.gasto.autorizacionPrevia).toBe("sin_autorizacion_previa");
    await ajustar("12:01");
    const d = await detalleGasto(sql, dir, codigo, r.clave);
    expect(d?.gasto.autorizacionPrevia).toBe("comprobada");
    expect(d?.pago).toMatchObject({ horaDeclarada: "12:01", pagadoEl: hoyMx() });
    expect(d?.pago?.en).toBeInstanceOf(Date);
    // En un gasto ya pagado también se puede declarar; en efectivo, no.
    const y = await yaPagado(enc, { origen: "tarjeta", turno: "", pagadoPor: enc, cuenta: "Tarjeta ficticia", referencia: "", hora: "00:00" });
    expect(y.ok).toBe(true);
    expect((await detalleGasto(sql, enc, codigo, y.ok ? y.clave : ""))?.pago?.horaDeclarada).toBe("00:00");
    expect(await yaPagado(enc, { hora: "00:00" })).toEqual({ ok: false, error: "hora" });
    await expect(sql`update pago_gasto set hora_declarada = '10:00' where gasto_id = (select id from gasto where clave = ${r.clave})`).rejects.toThrow(/no se edita/);
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
    // Un efectivo posterior sin turno cerrado ni salida en el turno abierto, no.
    await expect(sql.begin(async (tx) => {
      await tx`insert into gasto_ya_pagado (gasto_id, motivo, registrado_por) values (${gid}, 'Prueba sin turno', ${enc})`;
      await tx`insert into pago_gasto (gasto_id, version, origen, importe, pagado_el, pagado_por, registrado_por, posterior)
               values (${gid}, 1, 'bolsa_visitas', 50, ${hoyMx()}, ${rec}, ${enc}, true)`;
    })).rejects.toThrow(/registra su salida/);
    await expect(sql`update gasto_ya_pagado set motivo = 'Cambiado' where gasto_id = ${id}`).rejects.toThrow(/no se edita/);
  });
});

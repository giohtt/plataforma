import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  comprobarAnticipo, confirmarAnticipo, confirmarReembolso, decidirGasto, decidirReembolso, detalleGasto, entregarAnticipo, pagarReembolso,
  presentarReembolso, reembolsosPendientes, registrarComprobante, registrarPago, solicitarGasto, bandejaGastos,
} from "@/lib/gastos";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 6, PR 7 (acordado el 27 nov 2026; solo datos ficticios; facultades ficticias solo dentro de la prueba):
 * reembolsos de lo pagado con dinero personal. Lo decide Dirección; se paga una vez, por lo pagado, ligado a ese pago;
 * quien lo recibe lo confirma. No es un gasto nuevo: al proveedor se suma una sola vez.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const D = "@prueba.fitnessland.invalid";
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());

let codigo: string, sucursal: string;
let rec: string, enc: string, adm: string, ges: string, dir: string;

async function cuenta(nombre: string, rol: string | null, general = false) {
  const [x] = await sql<{ id: string }[]>`insert into usuario (nombre, correo, es_prueba) values (${nombre}, ${`r-${randomUUID().slice(0, 8)}${D}`}, true) returning id`;
  if (rol) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${x.id}, ${rol}, ${sucursal}, 'Prueba')`;
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${x.id}, 'direccion', 'Prueba')`;
  return x.id;
}
async function autorizado(importe: string) {
  const r = await solicitarGasto(sql, rec, codigo, { concepto: `Compra ficticia ${importe}`, categoria: "prueba_limpieza", importe,
    proveedor: "Ferretería ficticia", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  const d = await decidirGasto(sql, enc, codigo, { clave: r.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS);
  if (!d.ok) throw new Error(d.error);
  return r.clave;
}
const personal = (u: string, clave: string, importe: string, tipo = "ticket") => registrarPago(sql, u, codigo, { clave, version: 1, origen: "dinero_personal", importe,
  aQuien: "", pagadoEl: hoyMx(), cuenta: "", referencia: "", tipo, folio: "", motivoSin: "" }, PRUEBAS);
const autorizadoHoy = async (u: string) => (await sql<{ v: string }[]>`select autorizado_hoy(${u}, ${sucursal})::text as v`)[0].v;
const decidir = (u: string, clave: string, decision: string, motivo = "") => decidirReembolso(sql, u, codigo, { clave, decision, motivo }, PRUEBAS);
const pagar = (u: string, clave: string, origen = "bolsa_visitas", cuenta = "", referencia = "") =>
  pagarReembolso(sql, u, codigo, { clave, origen, cuenta, referencia }, PRUEBAS);
const bolsa = async () => Number((await estadoTurno(sql, rec, codigo))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!.esperado);
const idDe = async (clave: string) => (await sql<{ id: string }[]>`select id from gasto where clave = ${clave}`)[0].id;
const pagadoCompra = async (clave: string) => (await sql<{ total: string }[]>`
  select coalesce(sum(p.importe), 0)::numeric(12, 2)::text as total from gasto x join pago_gasto p on p.gasto_id = x.id
  where coalesce(x.compra_de, x.id) = (select coalesce(compra_de, id) from gasto where clave = ${clave})`)[0].total;

describe.skipIf(!URL_ADMIN)("reembolsos", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    codigo = `R${randomUUID().replace(/[^0-9]/g, "").slice(0, 3)}`;
    [{ id: sucursal }] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Reembolsos " + codigo}, ${codigo}) returning id`;
    rec = await cuenta("Recepción R", "recepcion");
    enc = await cuenta("Encargado R", "encargado");
    adm = await cuenta("Administración R", "administracion");
    ges = await cuenta("Gestión administrativa R", "gestion_administrativa");
    dir = await cuenta("Dirección R", null, true);
    await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo)
              values (${enc}, 'autorizacion.gasto', ${sucursal}, 1000, 9000, 'Prueba'), (${ges}, 'autorizacion.gasto', ${sucursal}, 2000, 9000, 'Prueba')`;
    await sql`insert into facultad_otorgada (usuario_id, permiso, todas_las_sucursales, sin_limite, motivo)
              values (${dir}, 'autorizacion.gasto', true, true, 'Prueba')`;
    const t = await abrirTurno(sql, rec, codigo, { bolsa: "1000.00", cajon: "0.00" }, PRUEBAS);
    if (!t.ok) throw new Error(t.error);
  });
  afterAll(async () => cerrar?.());

  it("los $70 que se adelantaron con un anticipo: un solo reembolso, ligado a ese pago, que lo liquida; al proveedor $470 una vez", async () => {
    // Anticipo de $400 de la bolsa; se pagaron $470 al proveedor; los $70 los puso Administración de su dinero.
    const a = await autorizado("400");
    const inicio = await bolsa();
    expect(await entregarAnticipo(sql, rec, codigo, { clave: a, version: 1, lugar: "bolsa_visitas", recibe: adm }, PRUEBAS)).toEqual({ ok: true });
    expect(await confirmarAnticipo(sql, adm, codigo, { clave: a }, PRUEBAS)).toEqual({ ok: true });
    const c = await comprobarAnticipo(sql, adm, codigo, { clave: a, gastado: "470", pagadoEl: hoyMx(), aQuien: "", envio: randomUUID(),
      tipo: "ticket", folio: "", motivoSin: "" }, PRUEBAS);
    const exc = c.ok ? c.excedente! : "";
    expect(await decidirGasto(sql, enc, codigo, { clave: exc, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS)).toEqual({ ok: true });
    expect(await personal(adm, exc, "70")).toEqual({ ok: true });
    expect(await bolsa()).toBe(inicio - 400);
    let d = await detalleGasto(sql, adm, codigo, exc);
    expect(d?.gasto.reembolso).toBe("por_decidir");
    expect(d?.reembolsoDetalle).toMatchObject({ estado: "por_decidir", importe: "70.00", beneficiario: "Administración R" });

    // Registrar el pago no autoriza el reembolso: lo decide Dirección (no el Encargado ni Gestión administrativa).
    expect(await pagar(rec, exc)).toEqual({ ok: false, error: "reembolso_no_autorizado" });
    expect(await decidir(enc, exc, "autorizado")).toEqual({ ok: false, error: "no_direccion" });
    expect(await decidir(ges, exc, "autorizado")).toEqual({ ok: false, error: "no_direccion" });
    expect(await reembolsosPendientes(sql, dir, sucursal)).toMatchObject({ porDecidir: 1 });
    expect((await bandejaGastos(sql, dir, "reembolsos"))?.gastos.map((g) => g.clave)).toContain(exc);
    // Lo que Dirección revisa: gasto original, quién puso el dinero y cuánto, su autorización y sus comprobantes.
    expect((await detalleGasto(sql, dir, codigo, exc))?.reembolsoDetalle?.revision).toMatchObject({
      clave: exc, compraDe: a, deAnticipo: a, autorizadoPor: "Encargado R", autorizadoImporte: "70.00", pagadoEl: hoyMx(), comprobantes: [{ tipo: "ticket" }],
    });
    // Decidir el reembolso no consume el acumulado diario: el gasto ya se autorizó una vez.
    const hoyDir = await autorizadoHoy(dir);
    const hoyEnc = await autorizadoHoy(enc);
    expect(await decidir(dir, exc, "autorizado")).toEqual({ ok: true });
    expect(await autorizadoHoy(dir)).toBe(hoyDir);
    expect(await autorizadoHoy(enc)).toBe(hoyEnc);
    const [{ decisiones }] = await sql<{ decisiones: number }[]>`select count(*)::int as decisiones from decision_gasto where gasto_id = ${await idDe(exc)}`;
    expect(decisiones).toBe(1);
    expect(await decidir(dir, exc, "rechazado", "Ya se decidió antes")).toEqual({ ok: false, error: "reembolso_decidido" });

    // Se paga una sola vez, por lo pagado, a otra persona; en efectivo por la responsable vigente.
    expect(await pagar(adm, exc)).toEqual({ ok: false, error: "propio_reembolso" });
    expect(await pagar(enc, exc)).toEqual({ ok: false, error: "no_responsable" });
    expect(await reembolsosPendientes(sql, rec, sucursal)).toMatchObject({ porPagar: 1 });
    expect((await detalleGasto(sql, rec, codigo, exc))?.origenesReembolso).toEqual(["bolsa_visitas", "cajon_mensualidades"]);
    expect(await pagar(rec, exc)).toEqual({ ok: true });
    expect(await pagar(rec, exc)).toEqual({ ok: false, error: "ya_reembolsado" });
    expect(await pagar(ges, exc, "transferencia", "Cuenta ficticia", "REF-1")).toEqual({ ok: false, error: "ya_reembolsado" });
    // Tampoco se puede volver a registrar el pago de los $70.
    expect(await personal(adm, exc, "70")).toEqual({ ok: false, error: "ya_pagado" });

    // Quien lo recibió lo confirma; queda liquidado.
    expect(await confirmarReembolso(sql, rec, codigo, { clave: exc }, PRUEBAS)).toEqual({ ok: false, error: "no_recibe" });
    expect(await reembolsosPendientes(sql, adm, sucursal)).toMatchObject({ porConfirmar: 1 });
    expect(await confirmarReembolso(sql, adm, codigo, { clave: exc }, PRUEBAS)).toEqual({ ok: true });
    d = await detalleGasto(sql, adm, codigo, exc);
    expect(d?.reembolsoDetalle).toMatchObject({ estado: "recibido", pago: { origen: "bolsa_visitas", importe: "70.00", pagadoPor: "Recepción R" } });
    expect(await reembolsosPendientes(sql, adm, sucursal)).toEqual({ porDecidir: 0, porPagar: 0, porConfirmar: 0 });

    // Al proveedor: $470 una sola vez (el reembolso no es un gasto). Caja: −400 (anticipo) −70 (reembolso) = −470.
    expect(await pagadoCompra(a)).toBe("470.00");
    expect(await bolsa()).toBe(inicio - 470);
    const t = (await estadoTurno(sql, rec, codigo))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!;
    expect(t).toMatchObject({ reembolsos: "-70.00", cantidadReembolsos: 1, gastos: "0.00" });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from reembolso_gasto r join pago_gasto p on p.id = r.pago_id where p.gasto_id = ${await idDe(exc)}`;
    expect(n).toBe(1);
  });

  it("falta comprobante: queda señalado y autorizar exige motivo; un rechazo se presenta de nuevo sin duplicar el pendiente", async () => {
    const s1 = await autorizado("90");
    expect(await personal(adm, s1, "90", "")).toEqual({ ok: true });
    let d = await detalleGasto(sql, dir, codigo, s1);
    expect(d?.reembolsoDetalle?.revision.comprobantes).toEqual([]);
    expect(await decidir(dir, s1, "autorizado")).toEqual({ ok: false, error: "motivo_sin_comprobante" });
    expect(await decidir(dir, s1, "autorizado", "Prueba ficticia: lo autorizo aunque falte el ticket")).toEqual({ ok: true });
    d = await detalleGasto(sql, dir, codigo, s1);
    expect(d?.reembolsoDetalle?.decision).toMatchObject({ decision: "autorizado", sinComprobante: true, ronda: 1 });

    // Rechazado: quien puso el dinero lo presenta de nuevo con lo corregido; el rechazo se conserva y hay un solo pendiente.
    const s2 = await autorizado("95");
    expect(await personal(adm, s2, "95", "")).toEqual({ ok: true });
    expect(await decidir(dir, s2, "rechazado", "Prueba ficticia: falta el ticket")).toEqual({ ok: true });
    expect((await detalleGasto(sql, adm, codigo, s2))?.reembolsoDetalle?.estado).toBe("rechazado");
    expect(await decidir(dir, s2, "autorizado", "Sin que lo presenten de nuevo")).toEqual({ ok: false, error: "reembolso_decidido" });
    expect(await pagar(rec, s2)).toEqual({ ok: false, error: "reembolso_no_autorizado" });
    expect(await presentarReembolso(sql, rec, codigo, { clave: s2, nota: "Lo presenta otra persona" }, PRUEBAS)).toEqual({ ok: false, error: "no_recibe" });
    expect(await presentarReembolso(sql, adm, codigo, { clave: s2, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "nota" });
    expect(await registrarComprobante(sql, adm, codigo, { clave: s2, tipo: "ticket", folio: "T-95", motivoSin: "" }, PRUEBAS)).toEqual({ ok: true });
    expect(await presentarReembolso(sql, adm, codigo, { clave: s2, nota: "Agregué el ticket T-95 que faltaba" }, PRUEBAS)).toEqual({ ok: true });
    expect(await presentarReembolso(sql, adm, codigo, { clave: s2, nota: "Otra vez lo mismo" }, PRUEBAS)).toEqual({ ok: false, error: "no_rechazado" });
    d = await detalleGasto(sql, dir, codigo, s2);
    expect(d?.reembolsoDetalle?.estado).toBe("presentado_de_nuevo");
    expect(d?.puedeDecidirReembolso).toBe(true);
    expect((await bandejaGastos(sql, dir, "reembolsos"))?.gastos.filter((g) => g.clave === s2)).toHaveLength(1);
    expect(await decidir(dir, s2, "autorizado")).toEqual({ ok: true });
    d = await detalleGasto(sql, dir, codigo, s2);
    expect(d?.reembolsoDetalle?.rondas.map((x) => [x.tipo, x.ronda, x.decision])).toEqual([["decision", 1, "rechazado"], ["reenvio", 2, null], ["decision", 2, "autorizado"]]);
    expect(d?.reembolsoDetalle?.estado).toBe("por_pagar");

    // Pagado una vez, no se vuelve a pagar aunque falte confirmar; solo confirma quien puso el dinero.
    expect(await pagar(rec, s2)).toEqual({ ok: true });
    expect((await detalleGasto(sql, adm, codigo, s2))?.reembolsoDetalle?.estado).toBe("pagado");
    expect(await pagar(rec, s2)).toEqual({ ok: false, error: "ya_reembolsado" });
    expect(await pagar(ges, s2, "transferencia", "Cuenta ficticia", "REF-95")).toEqual({ ok: false, error: "ya_reembolsado" });
    const [{ rid }] = await sql<{ rid: string }[]>`select r.id as rid from reembolso_gasto r join pago_gasto p on p.id = r.pago_id where p.gasto_id = ${await idDe(s2)}`;
    await expect(sql`insert into reembolso_recibido (reembolso_id, por) values (${rid}, ${rec})`).rejects.toThrow(/Solo quien puso el dinero/);
    expect(await confirmarReembolso(sql, rec, codigo, { clave: s2 }, PRUEBAS)).toEqual({ ok: false, error: "no_recibe" });
    expect(await confirmarReembolso(sql, adm, codigo, { clave: s2 }, PRUEBAS)).toEqual({ ok: true });
  });

  it("rechazo con motivo: no se paga; transferencia sin salida de caja; un pago que no es personal no lleva reembolso", async () => {
    const x = await autorizado("50");
    expect(await personal(adm, x, "50")).toEqual({ ok: true });
    expect(await decidir(dir, x, "rechazado")).toEqual({ ok: false, error: "motivo" });
    expect(await decidir(dir, x, "rechazado", "Prueba ficticia: no corresponde")).toEqual({ ok: true });
    expect((await detalleGasto(sql, adm, codigo, x))?.reembolsoDetalle).toMatchObject({ estado: "rechazado", decision: { motivo: "Prueba ficticia: no corresponde" } });
    expect(await pagar(rec, x)).toEqual({ ok: false, error: "reembolso_no_autorizado" });

    const y = await autorizado("80");
    expect(await personal(rec, y, "80")).toEqual({ ok: true });
    expect(await decidir(dir, y, "autorizado")).toEqual({ ok: true });
    const antes = await bolsa();
    expect(await pagar(adm, y, "transferencia", "Cuenta ficticia", "REF-80")).toEqual({ ok: true });
    expect(await bolsa()).toBe(antes);
    expect((await detalleGasto(sql, rec, codigo, y))?.reembolsoDetalle?.pago).toMatchObject({ origen: "transferencia", cuenta: "Cuenta ficticia" });
    expect(await confirmarReembolso(sql, rec, codigo, { clave: y }, PRUEBAS)).toEqual({ ok: true });

    const z = await autorizado("30");
    expect(await registrarPago(sql, rec, codigo, { clave: z, version: 1, origen: "bolsa_visitas", importe: "30", aQuien: "", pagadoEl: "", cuenta: "",
      referencia: "", tipo: "", folio: "", motivoSin: "" }, PRUEBAS)).toEqual({ ok: true });
    expect(await decidir(dir, z, "autorizado")).toEqual({ ok: false, error: "sin_reembolso" });
    expect((await detalleGasto(sql, rec, codigo, z))?.reembolsoDetalle).toBeNull();
  });

  it("la base lo respalda: solo Dirección decide, por lo pagado, con su salida, una vez; nada se edita", async () => {
    const w = await autorizado("60");
    expect(await personal(adm, w, "60")).toEqual({ ok: true });
    const [{ pid }] = await sql<{ pid: string }[]>`select id as pid from pago_gasto where gasto_id = ${await idDe(w)}`;
    await expect(sql`insert into decision_reembolso (pago_id, decision, por) values (${pid}, 'autorizado', ${ges})`).rejects.toThrow(/lo decide Dirección/);
    await expect(sql`insert into decision_reembolso (pago_id, ronda, decision, por) values (${pid}, 2, 'autorizado', ${dir})`).rejects.toThrow(/ya se decidió en esa ronda/);
    await sql`insert into decision_reembolso (pago_id, decision, por) values (${pid}, 'autorizado', ${dir})`;
    await expect(sql`insert into reenvio_reembolso (pago_id, ronda, nota, por) values (${pid}, 2, 'No estaba rechazado', ${adm})`).rejects.toThrow(/reembolso rechazado/);
    await expect(sql`insert into reembolso_gasto (pago_id, origen, importe, pagado_por, cuenta) values (${pid}, 'transferencia', 50, ${ges}, 'Cuenta ficticia')`)
      .rejects.toThrow(/por lo pagado/);
    await expect(sql`insert into reembolso_gasto (pago_id, origen, importe, pagado_por) values (${pid}, 'bolsa_visitas', 60, ${rec})`)
      .rejects.toThrow(/registra su salida/);
    await expect(sql`insert into reembolso_gasto (pago_id, origen, importe, pagado_por, cuenta) values (${pid}, 'transferencia', 60, ${adm}, 'Cuenta ficticia')`)
      .rejects.toThrow(/no se lo paga a sí misma/);
    await sql`insert into reembolso_gasto (pago_id, origen, importe, pagado_por, cuenta) values (${pid}, 'transferencia', 60, ${ges}, 'Cuenta ficticia')`;
    await expect(sql`insert into reembolso_gasto (pago_id, origen, importe, pagado_por, cuenta) values (${pid}, 'transferencia', 60, ${ges}, 'Cuenta ficticia')`)
      .rejects.toThrow(/reembolso_gasto_pago_id_key/);
    await expect(sql`update decision_reembolso set decision = 'rechazado', motivo = 'Cambio de opinión' where pago_id = ${pid}`).rejects.toThrow(/no se edita/);
    await expect(sql`update reembolso_gasto set importe = 1 where pago_id = ${pid}`).rejects.toThrow(/no se edita/);
  });
});

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anticiposPendientes, comprobarAnticipo, confirmarAnticipo, corregirGasto, decidirGasto, detalleGasto, entregarAnticipo, gastosPorPagar,
  pedirExcedente, recibirCambioAnticipo, registrarPago, solicitarGasto,
} from "@/lib/gastos";
import { reporteVisitas } from "@/lib/reporte-visitas";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 6, PR 6 (acordado el 27 nov 2026; solo datos ficticios; límites ficticios solo para la prueba): anticipos para
 * compras. Sale de caja al entregarse, queda a cargo de quien lo recibe, se comprueba por lo pagado al proveedor; el
 * cambio vuelve a caja por el importe exacto y el excedente es otra solicitud de la misma compra. Cada peso se cuenta
 * una sola vez.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const D = "@prueba.fitnessland.invalid";
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());

let codigo: string, sucursal: string;
let rec: string, enc: string, adm: string, ges: string;

async function cuenta(nombre: string, rol: string) {
  const [x] = await sql<{ id: string }[]>`insert into usuario (nombre, correo, es_prueba) values (${nombre}, ${`a-${randomUUID().slice(0, 8)}${D}`}, true) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${x.id}, ${rol}, ${sucursal}, 'Prueba')`;
  return x.id;
}
async function autorizado(importe: string, compraDe = "") {
  const r = await solicitarGasto(sql, rec, codigo, { concepto: `Compra ficticia ${importe}`, categoria: "prueba_limpieza", importe,
    proveedor: "Ferretería ficticia", nota: "", pagaId: "", compraDe, envio: randomUUID() }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  const d = await decidirGasto(sql, enc, codigo, { clave: r.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS);
  if (!d.ok) throw new Error(d.error);
  return r.clave;
}
const entregar = (u: string, clave: string, recibe: string, lugar = "bolsa_visitas") =>
  entregarAnticipo(sql, u, codigo, { clave, version: 1, lugar, recibe }, PRUEBAS);
const comprobar = (u: string, clave: string, gastado: string, x: Partial<Parameters<typeof comprobarAnticipo>[3]> = {}) =>
  comprobarAnticipo(sql, u, codigo, { clave, gastado, pagadoEl: hoyMx(), aQuien: "Ferretería ficticia", envio: randomUUID(),
    tipo: "ticket", folio: "", motivoSin: "", ...x }, PRUEBAS);
const bolsa = async () => (await estadoTurno(sql, rec, codigo))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!;
const idDe = async (clave: string) => (await sql<{ id: string }[]>`select id from gasto where clave = ${clave}`)[0].id;
/** Lo realmente pagado de la compra: la suma de sus pagos, cada uno una vez. */
const pagadoCompra = async (clave: string) => (await sql<{ total: string }[]>`
  select coalesce(sum(p.importe), 0)::numeric(12, 2)::text as total from gasto x join pago_gasto p on p.gasto_id = x.id
  where coalesce(x.compra_de, x.id) = (select coalesce(compra_de, id) from gasto where clave = ${clave})`)[0].total;

describe.skipIf(!URL_ADMIN)("anticipos para compras", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    codigo = `A${randomUUID().replace(/[^0-9]/g, "").slice(0, 3)}`;
    [{ id: sucursal }] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Anticipos " + codigo}, ${codigo}) returning id`;
    rec = await cuenta("Recepción A", "recepcion");
    enc = await cuenta("Encargado A", "encargado");
    adm = await cuenta("Administración A", "administracion");
    ges = await cuenta("Gestión administrativa A", "gestion_administrativa");
    await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo)
              values (${enc}, 'autorizacion.gasto', ${sucursal}, 1000, 9000, 'Prueba')`;
    const t = await abrirTurno(sql, rec, codigo, { bolsa: "1000.00", cajon: "0.00" }, PRUEBAS);
    if (!t.ok) throw new Error(t.error);
  });
  afterAll(async () => cerrar?.());

  it("gastó menos: sale de caja al entregar, se comprueba por lo pagado y el cambio vuelve exacto; la bolsa baja solo lo pagado", async () => {
    const a = await autorizado("300");
    // Solo la responsable vigente entrega, por lo autorizado, a otra persona que paga en la sucursal (no a quien autorizó).
    expect(await entregar(adm, a, ges)).toEqual({ ok: false, error: "no_responsable" });
    expect(await entregar(rec, a, rec)).toEqual({ ok: false, error: "recibe" });
    expect(await entregar(rec, a, enc)).toEqual({ ok: false, error: "recibe" });
    expect(await entregar(rec, a, adm)).toEqual({ ok: true });
    expect(await entregar(rec, a, adm)).toEqual({ ok: false, error: "con_anticipo" });
    expect((await bolsa()).esperado).toBe("700.00");
    expect(await bolsa()).toMatchObject({ anticipos: "-300.00", cantidadAnticipos: 1 });
    // Con anticipo ya no se paga aparte ni se corrige; no cuenta como «por pagar».
    expect(await registrarPago(sql, rec, codigo, { clave: a, version: 1, origen: "bolsa_visitas", importe: "300", aQuien: "", pagadoEl: "", cuenta: "",
      referencia: "", tipo: "", folio: "", motivoSin: "" }, PRUEBAS)).toEqual({ ok: false, error: "con_anticipo" });
    expect(await corregirGasto(sql, rec, codigo, { concepto: "Otra", categoria: "prueba_limpieza", importe: "200", proveedor: "", nota: "", clave: a, version: 1,
      motivo: "Intento con anticipo" }, PRUEBAS)).toEqual({ ok: false, error: "con_anticipo" });
    expect(await pedirExcedente(sql, rec, codigo, { clave: a, importeReal: "400", envio: randomUUID() }, PRUEBAS)).toEqual({ ok: false, error: "no_autorizado" });
    expect(await gastosPorPagar(sql, rec, sucursal)).toBe(0);
    expect(await anticiposPendientes(sql, adm, sucursal)).toEqual({ aTuCargo: 1, cambioPorRecibir: 0 });

    // Quien lo recibió lo confirma desde su cuenta; antes no se comprueba.
    expect(await comprobar(adm, a, "260")).toEqual({ ok: false, error: "anticipo_estado" });
    expect(await confirmarAnticipo(sql, rec, codigo, { clave: a }, PRUEBAS)).toEqual({ ok: false, error: "no_recibe" });
    expect(await confirmarAnticipo(sql, adm, codigo, { clave: a }, PRUEBAS)).toEqual({ ok: true });
    let d = await detalleGasto(sql, adm, codigo, a);
    expect(d?.anticipo).toMatchObject({ importe: "300.00", lugar: "bolsa_visitas", comprobado: null });
    expect(d?.puedeComprobarAnticipo).toBe(true);
    expect(await comprobar(rec, a, "260")).toEqual({ ok: false, error: "no_recibe" });
    expect(await comprobar(adm, a, "260", { tipo: "" })).toEqual({ ok: false, error: "comprobante" });
    expect(await comprobar(adm, a, "260", { folio: "T-77" })).toEqual({ ok: true, cambio: "40.00", excedente: null });
    expect(await comprobar(adm, a, "260")).toEqual({ ok: false, error: "anticipo_estado" });

    // El pago es por lo pagado al proveedor, con origen «anticipo»: sin otra salida de caja.
    d = await detalleGasto(sql, adm, codigo, a);
    expect(d?.pago).toMatchObject({ origen: "anticipo", importe: "260.00", pagadoEl: hoyMx() });
    expect(d?.gasto.comprobacion).toBe("comprobado");
    expect((await bolsa()).esperado).toBe("700.00");
    expect(await anticiposPendientes(sql, rec, sucursal)).toEqual({ aTuCargo: 0, cambioPorRecibir: 1 });

    // El cambio lo cuenta y lo recibe la responsable vigente, por el importe exacto.
    expect(await recibirCambioAnticipo(sql, adm, codigo, { clave: a, importe: "40" }, PRUEBAS)).toEqual({ ok: false, error: "devuelve" });
    expect(await recibirCambioAnticipo(sql, enc, codigo, { clave: a, importe: "40" }, PRUEBAS)).toEqual({ ok: false, error: "no_responsable" });
    expect(await recibirCambioAnticipo(sql, rec, codigo, { clave: a, importe: "30" }, PRUEBAS)).toEqual({ ok: false, error: "cambio" });
    expect((await detalleGasto(sql, rec, codigo, a))?.puedeRecibirCambio).toBe(true);
    expect(await recibirCambioAnticipo(sql, rec, codigo, { clave: a, importe: "40" }, PRUEBAS)).toEqual({ ok: true });
    expect(await recibirCambioAnticipo(sql, rec, codigo, { clave: a, importe: "40" }, PRUEBAS)).toEqual({ ok: false, error: "anticipo_estado" });

    // Bolsa: 1000 − 300 + 40 = 1000 − 260 (lo realmente pagado), una sola vez.
    expect(await bolsa()).toMatchObject({ esperado: "740.00", anticipos: "-300.00", cambiosAnticipo: "40.00", cantidadCambiosAnticipo: 1 });
    expect(await pagadoCompra(a)).toBe("260.00");
    const [mov] = await sql<{ n: number; neto: string }[]>`
      select count(*)::int as n, sum(importe)::text as neto from movimiento_efectivo where anticipo_id = (select id from anticipo_gasto where gasto_id = ${await idDe(a)})`;
    expect(mov).toEqual({ n: 2, neto: "-260.00" });
    const [{ salidas }] = await sql<{ salidas: number }[]>`
      select count(*)::int as salidas from movimiento_efectivo where pago_gasto_id = (select id from pago_gasto where gasto_id = ${await idDe(a)})`;
    expect(salidas).toBe(0);
    // El reporte de visitas usa el mismo esperado.
    const r = await reporteVisitas(sql, enc, { codigo, desde: hoyMx(), hasta: hoyMx() });
    expect(r?.filas[0].turnos[0].esperado).toBe("740.00");
  });

  it("necesitó más: el excedente es otra solicitud de la misma compra y se paga aparte; lo pagado suma lo real sin duplicar", async () => {
    const raiz = await autorizado("100");
    const parte = await autorizado("400", await idDe(raiz));
    const antes = Number((await bolsa()).esperado);
    expect(await entregar(rec, parte, adm)).toEqual({ ok: true });
    expect(await confirmarAnticipo(sql, adm, codigo, { clave: parte }, PRUEBAS)).toEqual({ ok: true });
    const c = await comprobar(adm, parte, "470", { tipo: "sin", motivoSin: "Prueba ficticia: sin nota del proveedor" });
    expect(c.ok).toBe(true);
    const exc = c.ok ? c.excedente! : "";
    // El excedente conserva el vínculo con la compra original (la raíz, aunque se compruebe una parte), por la diferencia.
    const e = await detalleGasto(sql, adm, codigo, exc);
    expect(e?.gasto).toMatchObject({ compraDe: raiz, importe: "70.00", estado: "por_autorizar", propia: true });
    expect(e?.gasto.concepto).toMatch(new RegExp(`^Excedente de ${parte}:`));
    expect((await detalleGasto(sql, adm, codigo, parte))?.anticipo?.comprobado).toMatchObject({ gastado: "470.00", cambio: "0.00", excedente: "70.00", excedenteClave: exc });
    expect((await detalleGasto(sql, adm, codigo, raiz))?.gasto.partes.map((p) => p.clave)).toEqual([parte, exc]);
    // Con el anticipo se pagaron 400 (lo entregado); no hay cambio. La bolsa bajó 400 una vez.
    expect((await detalleGasto(sql, adm, codigo, parte))?.pago).toMatchObject({ origen: "anticipo", importe: "400.00" });
    expect(Number((await bolsa()).esperado)).toBe(antes - 400);
    expect(await pagadoCompra(raiz)).toBe("400.00");

    // El excedente se autoriza (contra el total de la compra) y se paga con su propio pago.
    expect(await decidirGasto(sql, enc, codigo, { clave: exc, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS)).toEqual({ ok: true });
    expect(await registrarPago(sql, adm, codigo, { clave: exc, version: 1, origen: "dinero_personal", importe: "70", aQuien: "", pagadoEl: hoyMx(),
      cuenta: "", referencia: "", tipo: "sin", folio: "", motivoSin: "Prueba ficticia: ya va en la comprobación" }, PRUEBAS)).toEqual({ ok: true });
    // Lo pagado de la parte: 400 (anticipo) + 70 (excedente) = 470, lo realmente gastado. La raíz aún no se paga.
    expect(await pagadoCompra(raiz)).toBe("470.00");
    const dr = await detalleGasto(sql, adm, codigo, raiz);
    expect(dr?.pagosCompra.map((p) => [p.clave, p.origen, p.importe])).toEqual([[parte, "anticipo", "400.00"], [exc, "dinero_personal", "70.00"]]);
    expect(dr?.totalPagadoCompra).toBe("470.00");
    // El dinero personal no toca caja: la bolsa sigue igual.
    expect(Number((await bolsa()).esperado)).toBe(antes - 400);
  });

  it("justo lo entregado: sin cambio ni excedente", async () => {
    const a = await autorizado("150");
    expect(await entregar(rec, a, ges)).toEqual({ ok: true });
    expect(await confirmarAnticipo(sql, ges, codigo, { clave: a }, PRUEBAS)).toEqual({ ok: true });
    expect(await comprobar(ges, a, "150", { tipo: "nota" })).toEqual({ ok: true, cambio: "0.00", excedente: null });
    expect(await recibirCambioAnticipo(sql, rec, codigo, { clave: a, importe: "1" }, PRUEBAS)).toEqual({ ok: false, error: "anticipo_estado" });
    expect(await pagadoCompra(a)).toBe("150.00");
  });

  it("la base lo respalda: por lo autorizado, sin pago aparte, sin cambio inventado, nada se edita", async () => {
    const a = await autorizado("200");
    const id = await idDe(a);
    const t = (await estadoTurno(sql, rec, codigo))!.turno!;
    const lugar = (await sql<{ id: string }[]>`select id from lugar_efectivo where sucursal_id = ${sucursal} and tipo = 'bolsa_visitas'`)[0].id;
    // Por otra cantidad que la autorizada, no.
    await expect(sql.begin(async (tx) => {
      const [x] = await tx<{ id: string }[]>`insert into anticipo_gasto (gasto_id, version, lugar, importe, entregado_por, recibe)
                                            values (${id}, 1, 'bolsa_visitas', 150, ${rec}, ${adm}) returning id`;
      await tx`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, anticipo_id, responsable_id, registrado_por)
               values (${lugar}, ${t.id}, 'salida_anticipo_gasto', -150, ${x.id}, ${rec}, ${rec})`;
    })).rejects.toThrow(/por lo autorizado/);
    // Sin su salida de caja, no.
    await expect(sql`insert into anticipo_gasto (gasto_id, version, lugar, importe, entregado_por, recibe)
                     values (${id}, 1, 'bolsa_visitas', 200, ${rec}, ${adm})`).rejects.toThrow(/salida del lugar/);
    // Un pago «anticipo» sin anticipo, no.
    await expect(sql`insert into pago_gasto (gasto_id, version, origen, importe, pagado_el, pagado_por, registrado_por)
                     values (${id}, 1, 'anticipo', 200, ${hoyMx()}, ${adm}, ${adm})`).rejects.toThrow(/con anticipo/);
    expect(await entregar(rec, a, adm)).toEqual({ ok: true });
    const [{ aid }] = await sql<{ aid: string }[]>`select id as aid from anticipo_gasto where gasto_id = ${id}`;
    // Ni pago en efectivo aparte, ni otra salida, ni cambio antes de comprobar, ni editar.
    await expect(sql`insert into pago_gasto (gasto_id, version, origen, importe, pagado_el, pagado_por, registrado_por)
                     values (${id}, 1, 'tarjeta', 200, ${hoyMx()}, ${adm}, ${adm})`).rejects.toThrow(/se paga con el anticipo|cuenta/);
    await expect(sql`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, anticipo_id, responsable_id, registrado_por)
                     values (${lugar}, ${t.id}, 'salida_anticipo_gasto', -200, ${aid}, ${rec}, ${rec})`).rejects.toThrow(/movimiento_anticipo_unico/);
    await expect(sql`insert into anticipo_cambio (anticipo_id, importe, recibido_por) values (${aid}, 10, ${rec})`).rejects.toThrow(/importe exacto/);
    await expect(sql`update anticipo_gasto set importe = 100 where id = ${aid}`).rejects.toThrow(/no se edita/);
    await expect(sql`delete from anticipo_gasto where id = ${aid}`).rejects.toThrow(/no se edita/);
  });
});

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { marcarNoLocalizado, verificarAbono } from "@/lib/abonos";
import { resolverCancelacion, solicitarCancelacion } from "@/lib/cancelaciones";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { ventasDelTurno } from "@/lib/ventas";
import { cobrosDelTurno, confirmarVisita, detalleCobro, pantallaCobro, type CobroDelTurno } from "@/lib/visitas";
type FormaPago = CobroDelTurno["formaPago"];
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const ids: Record<string, string> = {};
let n = 0;
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());

async function cuenta(rol: string, codigo: string) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Ventas " + n}, ${`ventas${n}@prueba.fitnessland.invalid`}, true) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de ventas')`;
  return u.id;
}
async function fichas(k: number) {
  const r: string[] = [];
  for (let i = 0; i < k; i++) {
    const [v] = await sql<{ id: string }[]>`
      insert into visitante (nombre, telefono, sucursal_alta_id) values (${"Visitante " + randomUUID().slice(0, 6)}, '0000000401', ${ids.TEN}) returning id`;
    r.push(v.id);
  }
  return r;
}
async function cobrar(u: string, visitantes: string[], formaPago: FormaPago = "efectivo", referencia: string | null = null) {
  const p = await pantallaCobro(sql, u, "TEN", "pruebas");
  if (!p.ok) throw new Error(p.error);
  const r = await confirmarVisita(sql, u, "TEN", {
    clave: randomUUID(), turnoId: p.turnoId, visitanteIds: visitantes, formaPago, recibido: null, cambio: null,
    autorizacion: formaPago === "tarjeta" ? "AUT123" : null,
    referencia, tipoReferencia: referencia ? "clave_rastreo" : null, otraVenta: false,
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return r.operacionId;
}
const cobroDe = async (operacionId: string) =>
  (await sql<{ id: string; version: number; estado: string }[]>`select id, version, estado from cobro_visita where operacion_id = ${operacionId}`)[0];

describe.skipIf(!URL_ADMIN)("ventas del turno: total confirmado con transferencias verificadas", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("turno como el de Tenango: $450 + $50 + $50 = $550 confirmado; $100 no localizados aparte; la bolsa sigue en $450; al verificar, el mismo cobro suma una vez", async () => {
    const recep = await cuenta("recepcion", "TEN");
    const adm = await cuenta("administracion", "TEN");
    const t = await abrirTurno(sql, recep, "TEN", { bolsa: "0.00", cajon: "0.00" }, PRUEBAS);
    if (!t.ok) throw new Error(t.error);

    // Efectivo: $50, $50 (Diego), $150 (3) y $200 (4) = $450 en 4 cobros; más un duplicado de Diego que se cancela.
    const [diego] = await fichas(1);
    await cobrar(recep, [diego]);
    const correcto = await cobrar(recep, [diego]);
    await cobrar(recep, await fichas(3));
    await cobrar(recep, await fichas(4));
    const duplicado = await cobrar(recep, [diego]);
    const s = await solicitarCancelacion(sql, recep, "TEN", duplicado,
      { conservaOperacionId: correcto, explicacion: "Se registró dos veces el mismo pago", sinDinero: true }, PRUEBAS);
    if (!s.ok) throw new Error(s.error);
    const [dir] = await sql<{ id: string }[]>`select id from usuario where correo = 'direccion@prueba.fitnessland.invalid'`;
    expect(await resolverCancelacion(sql, dir.id, "TEN", s.cancelacionId, { version: 1, decision: "aprobar" }, PRUEBAS)).toEqual({ ok: true });

    // Tarjeta $50; transferencia $50 verificada; transferencia $100 (2 personas) no localizada.
    await cobrar(recep, await fichas(1), "tarjeta");
    const verificada = await cobrar(recep, await fichas(1), "transferencia", "CLAVEVENTAS0001");
    const v = await cobroDe(verificada);
    expect(await verificarAbono(sql, adm, "TEN", v.id, { version: v.version, fecha: hoyMx(), importe: "50.00" }, PRUEBAS)).toEqual({ ok: true });
    const noLocalizada = await cobrar(recep, await fichas(2), "transferencia", "CLAVEVENTAS0002");
    const nl = await cobroDe(noLocalizada);
    expect(await marcarNoLocalizado(sql, adm, "TEN", nl.id, { version: nl.version, motivo: "No aparece en el estado de cuenta" }, PRUEBAS)).toEqual({ ok: true });

    const ventas = async () => ventasDelTurno(await cobrosDelTurno(sql, t.turnoId));
    const bolsa = async () => (await estadoTurno(sql, recep, "TEN"))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!.esperado;

    expect(await ventas()).toEqual({
      efectivo: { cobros: 4, visitas: 9, importe: "450.00" },
      tarjeta: { cobros: 1, visitas: 1, importe: "50.00" },
      transferenciaVerificada: { cobros: 1, visitas: 1, importe: "50.00" },
      totalConfirmado: { cobros: 6, visitas: 11, importe: "550.00" },
      transferenciaPendiente: { cobros: 0, visitas: 0, importe: "0.00" },
      transferenciaNoLocalizada: { cobros: 1, visitas: 2, importe: "100.00" },
      cancelados: { cobros: 1, visitas: 1, importe: "50.00" },
    });
    expect(await bolsa()).toBe("450.00");

    // Se localiza el abono: el MISMO cobro pasa a verificado y suma una sola vez.
    const antes = await cobroDe(noLocalizada);
    expect(await verificarAbono(sql, adm, "TEN", antes.id, { version: antes.version, fecha: hoyMx(), importe: "100.00" }, PRUEBAS)).toEqual({ ok: true });
    expect(await verificarAbono(sql, adm, "TEN", antes.id, { version: antes.version + 1, fecha: hoyMx(), importe: "100.00" }, PRUEBAS))
      .toMatchObject({ ok: false });
    const despues = await cobroDe(noLocalizada);
    expect(despues).toMatchObject({ id: antes.id, estado: "abono_verificado", version: antes.version + 1 });

    const r = await ventas();
    expect(r.transferenciaVerificada).toEqual({ cobros: 2, visitas: 3, importe: "150.00" });
    expect(r.transferenciaNoLocalizada).toEqual({ cobros: 0, visitas: 0, importe: "0.00" });
    expect(r.totalConfirmado).toEqual({ cobros: 7, visitas: 13, importe: "650.00" });
    expect(await bolsa()).toBe("450.00");
    const [{ total }] = await sql<{ total: number }[]>`select count(*)::int as total from cobro_visita c join operacion_visita o on o.id = c.operacion_id where o.turno_id = ${t.turnoId}`;
    expect(total).toBe(8);

    // El historial conserva ambos cambios.
    const d = await detalleCobro(sql, recep, "TEN", noLocalizada);
    expect(d?.cambios.map((c) => [c.de, c.a])).toEqual([["pendiente_abono", "no_localizado"], ["no_localizado", "abono_verificado"]]);
  });

  it("una transferencia pendiente no suma hasta verificarse", () => {
    const base = { registradaEn: new Date(), conciliacion: null, cancelacionSolicitada: false };
    const r = ventasDelTurno([
      { ...base, id: "a", personas: 1, total: "50.00", formaPago: "transferencia", estado: "pendiente_abono" },
      { ...base, id: "b", personas: 1, total: "0.10", formaPago: "efectivo", estado: "confirmado" },
      { ...base, id: "c", personas: 1, total: "0.20", formaPago: "efectivo", estado: "confirmado" },
    ]);
    expect(r.transferenciaPendiente).toEqual({ cobros: 1, visitas: 1, importe: "50.00" });
    expect(r.totalConfirmado).toEqual({ cobros: 2, visitas: 2, importe: "0.30" });
  });
});

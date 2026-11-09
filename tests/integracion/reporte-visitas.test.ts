import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { marcarNoLocalizado, verificarAbono } from "@/lib/abonos";
import { resolverCancelacion, solicitarCancelacion } from "@/lib/cancelaciones";
import { periodo, reporteVisitas } from "@/lib/reporte-visitas";
import { abrirTurno } from "@/lib/turnos";
import { confirmarVisita, pantallaCobro, type CobroDelTurno } from "@/lib/visitas";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

type FormaPago = CobroDelTurno["formaPago"];
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const ids: Record<string, string> = {};
let n = 0;
let hoy = "";
const g = (cobros: number, visitas: number, importe: string) => ({ cobros, visitas, importe });

async function cuenta(asignaciones: [string, string][]) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Reporte " + n}, ${`reporte${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba del reporte')`;
  }
  return u.id;
}
async function fichas(k: number) {
  const r: string[] = [];
  for (let i = 0; i < k; i++) {
    const [v] = await sql<{ id: string }[]>`
      insert into visitante (nombre, telefono, sucursal_alta_id) values (${"Visitante " + randomUUID().slice(0, 6)}, '0000000501', ${ids.TEN}) returning id`;
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
  (await sql<{ id: string; version: number }[]>`select id, version from cobro_visita where operacion_id = ${operacionId}`)[0];

describe.skipIf(!URL_ADMIN)("reporte «Visitas y cobros»", () => {
  let encargado: string, admin: string, recep: string, noLocalizada: string;

  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
    [{ hoy }] = await sql<{ hoy: string }[]>`select (now() at time zone 'America/Mexico_City')::date::text as hoy`;

    // El turno de prueba de Tenango: $450 + $50 + $50 confirmados, $100 no localizados, $50 cancelados, bolsa en $450.
    recep = await cuenta([["recepcion", "TEN"]]);
    encargado = await cuenta([["encargado", "TEN"]]);
    admin = await cuenta([["administracion", "TEN"], ["administracion", "STG"]]);
    const t = await abrirTurno(sql, recep, "TEN", { bolsa: "0.00", cajon: "1200.00" }, PRUEBAS);
    if (!t.ok) throw new Error(t.error);
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
    await cobrar(recep, await fichas(1), "tarjeta");
    const v = await cobroDe(await cobrar(recep, await fichas(1), "transferencia", "CLAVEREPORTE0001"));
    expect(await verificarAbono(sql, admin, "TEN", v.id, { version: v.version, fecha: hoy, importe: "50.00" }, PRUEBAS)).toEqual({ ok: true });
    noLocalizada = await cobrar(recep, await fichas(2), "transferencia", "CLAVEREPORTE0002");
    const nl = await cobroDe(noLocalizada);
    expect(await marcarNoLocalizado(sql, admin, "TEN", nl.id, { version: nl.version, motivo: "No aparece en el estado de cuenta" }, PRUEBAS)).toEqual({ ok: true });
  });
  afterAll(async () => cerrar?.());

  it("Tenango: 6 cobros y 11 pases confirmados por $550; $100 no localizados; $50 cancelados; 8 cobros y 14 pases registrados; bolsa en $450", async () => {
    const r = await reporteVisitas(sql, encargado, { codigo: "TEN", desde: hoy, hasta: hoy });
    expect(r).not.toBeNull();
    expect(r!.sucursales.map((s) => s.codigo)).toEqual(["TEN"]);
    const [s] = r!.filas;
    expect(s.ventas).toEqual({
      efectivo: g(4, 9, "450.00"),
      tarjeta: g(1, 1, "50.00"),
      transferenciaVerificada: g(1, 1, "50.00"),
      totalConfirmado: g(6, 11, "550.00"),
      transferenciaPendiente: g(0, 0, "0.00"),
      transferenciaNoLocalizada: g(1, 2, "100.00"),
      cancelados: g(1, 1, "50.00"),
    });
    expect(s.registrados).toEqual({ cobros: 8, visitas: 14 });
    expect(s.turnos).toHaveLength(1);
    expect(s.turnos[0]).toMatchObject({
      cerradoEn: null, contadoAlAbrir: "0.00", entradas: "500.00", cantidadEntradas: 5, ajustes: "-50.00", cantidadAjustes: 1, esperado: "450.00",
    });
  });

  it("el periodo cuenta por la fecha de registro (hora de la Ciudad de México); el saldo es del turno completo", async () => {
    const ayer = new Date(Date.parse(`${hoy}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const r = await reporteVisitas(sql, encargado, { codigo: "TEN", desde: ayer, hasta: ayer });
    // Ayer no hubo cobros, pero el turno abierto hoy no se traslapa con ayer: no aparece.
    expect(r!.filas[0].registrados).toEqual({ cobros: 0, visitas: 0 });
    expect(r!.filas[0].turnos).toHaveLength(0);
    // Un periodo que incluye hoy muestra el turno con su saldo completo.
    const semana = await reporteVisitas(sql, encargado, { codigo: "TEN", desde: ayer, hasta: hoy });
    expect(semana!.filas[0].turnos.map((t) => t.esperado)).toEqual(["450.00"]);

    // Un cobro registrado a las 11:30 p.m. de hoy (hora de México) cuenta hoy, aunque en UTC ya sea mañana.
    await sql`alter table operacion_visita disable trigger operacion_visita_inmutable`;
    try {
      await sql`update operacion_visita set registrada_en = (${hoy}::date + time '23:30') at time zone 'America/Mexico_City' where id = ${noLocalizada}`;
    } finally {
      await sql`alter table operacion_visita enable trigger operacion_visita_inmutable`;
    }
    const manana = new Date(Date.parse(`${hoy}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect((await reporteVisitas(sql, encargado, { codigo: "TEN", desde: hoy, hasta: hoy }))!.filas[0].registrados).toEqual({ cobros: 8, visitas: 14 });
    expect((await reporteVisitas(sql, encargado, { codigo: "TEN", desde: manana, hasta: manana }))!.filas[0].registrados).toEqual({ cobros: 0, visitas: 0 });
  });

  it("varias sucursales: una fila por sucursal; Santiago sin cobros ni turnos", async () => {
    const r = await reporteVisitas(sql, admin, { codigo: null, desde: hoy, hasta: hoy });
    expect(r!.codigo).toBeNull();
    expect(r!.filas.map((s) => [s.codigo, s.ventas.totalConfirmado.importe, s.ventas.transferenciaNoLocalizada.importe, s.turnos.length]))
      .toEqual([["STG", "0.00", "0.00", 0], ["TEN", "550.00", "100.00", 1]]);
    expect((await reporteVisitas(sql, admin, { codigo: "STG", desde: hoy, hasta: hoy }))!.filas.map((s) => s.codigo)).toEqual(["STG"]);
  });

  it("solo sus sucursales autorizadas, también por enlace directo; Recepción no tiene el reporte", async () => {
    expect(await reporteVisitas(sql, encargado, { codigo: "STG" })).toBeNull();
    expect(await reporteVisitas(sql, encargado, { codigo: "XYZ" })).toBeNull();
    expect(await reporteVisitas(sql, encargado, { codigo: "ten' or 1=1" })).toBeNull();
    // Sin elegir sucursal, Encargado de Tenango solo ve Tenango.
    expect((await reporteVisitas(sql, encargado, { codigo: null }))!.filas.map((s) => s.codigo)).toEqual(["TEN"]);
    expect(await reporteVisitas(sql, recep, { codigo: "TEN" })).toBeNull();
    expect(await reporteVisitas(sql, recep, { codigo: null })).toBeNull();
    const [r] = await sql<{ id: string }[]>`select id from usuario where correo = 'recepcion.tenango@prueba.fitnessland.invalid'`;
    expect(await reporteVisitas(sql, r.id, { codigo: "TEN" })).toBeNull();
    // Dirección de Tenango (asignada solo ahí) no ve Santiago.
    const [d] = await sql<{ id: string }[]>`select id from usuario where correo = 'direccion@prueba.fitnessland.invalid'`;
    expect(await reporteVisitas(sql, d.id, { codigo: "STG" })).toBeNull();
    expect((await reporteVisitas(sql, d.id, { codigo: "TEN" }))!.filas.map((s) => s.codigo)).toEqual(["TEN"]);
  });

  it("el estado es el actual al consultar: si la no localizada se verifica, pasa a confirmados una sola vez", async () => {
    const nl = await cobroDe(noLocalizada);
    expect(await verificarAbono(sql, admin, "TEN", nl.id, { version: nl.version, fecha: hoy, importe: "100.00" }, PRUEBAS)).toEqual({ ok: true });
    const [s] = (await reporteVisitas(sql, encargado, { codigo: "TEN", desde: hoy, hasta: hoy }))!.filas;
    expect(s.ventas.totalConfirmado).toEqual(g(7, 13, "650.00"));
    expect(s.ventas.transferenciaNoLocalizada).toEqual(g(0, 0, "0.00"));
    expect(s.registrados).toEqual({ cobros: 8, visitas: 14 });
    expect(s.turnos[0].esperado).toBe("450.00");
  });

  it("periodo: últimos 7 días por omisión; uno no válido avisa y usa los últimos 7 días", () => {
    expect(periodo(undefined, undefined, "2026-11-09")).toEqual({ desde: "2026-11-03", hasta: "2026-11-09", invalido: false });
    expect(periodo("2026-11-03", "2026-11-09", "2026-11-09")).toEqual({ desde: "2026-11-03", hasta: "2026-11-09", invalido: false });
    for (const [d, h] of [["2026-11-10", "2026-11-09"], ["2026-02-30", "2026-03-01"], ["", "2026-11-09"], ["2026-11-01", undefined], ["2024-01-01", "2026-11-09"], ["9-11-2026", "2026-11-09"]]) {
      expect(periodo(d, h, "2026-11-09"), `${d} → ${h}`).toEqual({ desde: "2026-11-03", hasta: "2026-11-09", invalido: true });
    }
  });
});

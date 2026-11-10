import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pedirAutorizacion, registrarAcceso, resolverAutorizacion } from "@/lib/accesos";
import { historialVisitante, registrarCobertura, resumenesHistorial } from "@/lib/historial";
import { abrirTurno } from "@/lib/turnos";
import { confirmarVisita, pantallaCobro, type CobroDelTurno } from "@/lib/visitas";
import { interpretarConsulta } from "@/lib/datos-visitante";
import { buscarVisitantes } from "@/lib/visitantes";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

type FormaPago = CobroDelTurno["formaPago"];
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const ids: Record<string, string> = {};
let n = 0;

async function cuenta(asignaciones: [string, string][]) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Historial " + n}, ${`historial${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba del historial')`;
  }
  return u.id;
}
async function ficha(nombre: string) {
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, telefono, sucursal_alta_id) values (${nombre}, '0000000457', ${ids.STG}) returning id`;
  return v.id;
}
async function cobrar(u: string, codigo: string, visitantes: string[], formaPago: FormaPago = "efectivo", referencia?: string) {
  const p = await pantallaCobro(sql, u, codigo, "pruebas");
  if (!p.ok) throw new Error(p.error);
  const r = await confirmarVisita(sql, u, codigo, {
    clave: randomUUID(), turnoId: p.turnoId, visitanteIds: visitantes, formaPago, recibido: null, cambio: null,
    autorizacion: formaPago === "tarjeta" ? "AUT777" : null,
    referencia: referencia ?? null, tipoReferencia: referencia ? "clave_rastreo" : null, otraVenta: false,
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return r.operacionId;
}
/** Mueve un cobro (y sus pases) a otra fecha, como si se hubiera registrado ese día. */
async function fechar(operacionId: string, dias: number) {
  await sql`alter table pase_visita disable trigger pase_visita_inmutable`;
  await sql`alter table operacion_visita disable trigger operacion_visita_inmutable`;
  try {
    await sql`update pase_visita set creado_en = creado_en - make_interval(days => ${dias}) where operacion_id = ${operacionId}`;
    await sql`update operacion_visita set registrada_en = registrada_en - make_interval(days => ${dias}) where id = ${operacionId}`;
  } finally {
    await sql`alter table pase_visita enable trigger pase_visita_inmutable`;
    await sql`alter table operacion_visita enable trigger operacion_visita_inmutable`;
  }
}

describe.skipIf(!URL_ADMIN)("historial del visitante entre sucursales", () => {
  let mariela: string, recepTen: string, recepStg: string, encargadoTen: string, adminTen: string, adminAmbas: string, direccion: string;

  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
    recepTen = await cuenta([["recepcion", "TEN"]]);
    recepStg = await cuenta([["recepcion", "STG"]]);
    encargadoTen = await cuenta([["encargado", "TEN"]]);
    adminTen = await cuenta([["administracion", "TEN"]]);
    adminAmbas = await cuenta([["administracion", "TEN"], ["administracion", "STG"]]);
    [{ id: direccion }] = await sql<{ id: string }[]>`select id from usuario where correo = 'direccion@prueba.fitnessland.invalid'`;
    for (const [u, c] of [[recepTen, "TEN"], [recepStg, "STG"]] as const) {
      const t = await abrirTurno(sql, u, c, { bolsa: "0.00", cajon: "0.00" }, PRUEBAS);
      if (!t.ok) throw new Error(t.error);
    }
    // Mariela: Tenango hace 5 días (grupo de 3 en efectivo) y hoy por transferencia pendiente, con entrada autorizada;
    // Santiago hace 3 días con tarjeta y hoy, más tarde, en un grupo de 2 en efectivo.
    mariela = await ficha("Mariela Ficticia Ruiz");
    const [o1, o2] = [await ficha("Acompañante Uno"), await ficha("Acompañante Dos")];
    await fechar(await cobrar(recepTen, "TEN", [mariela, o1, o2]), 5);
    await fechar(await cobrar(recepStg, "STG", [mariela], "tarjeta"), 3);
    const transferencia = await cobrar(recepTen, "TEN", [mariela], "transferencia", "PRUEBAHISTORIAL001");
    const [pase] = await sql<{ id: string }[]>`select id from pase_visita where operacion_id = ${transferencia}`;
    const s = await pedirAutorizacion(sql, recepTen, "TEN", { tipo: "transferencia_pendiente", paseId: pase.id, nota: "Muestra comprobante ficticio" }, PRUEBAS);
    if (!s.ok) throw new Error(s.error);
    expect(await resolverAutorizacion(sql, encargadoTen, "TEN", s.autorizacionId, { version: 1, decision: "aprobar", motivo: "Revisé el comprobante" }, PRUEBAS)).toEqual({ ok: true });
    expect(await registrarAcceso(sql, recepTen, "TEN", { clave: randomUUID(), paseId: pase.id, tipo: "entrada" }, PRUEBAS)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 20));
    await cobrar(recepStg, "STG", [mariela, await ficha("Acompañante Tres")]);
  });
  afterAll(async () => cerrar?.());

  it("Recepción Tenango: 4 visitas registradas, última en Santiago; detalle solo de Tenango; de Santiago solo conteo y última", async () => {
    const h = await historialVisitante(sql, recepTen, "TEN", mariela);
    expect(h!.resumen).toMatchObject({ visitas: 4, ultima: { sucursal: "Santiago" }, incompleto: true });
    expect(h!.conDetalle.map((s) => [s.codigo, s.visitas])).toEqual([["TEN", 2]]);
    const ten = h!.conDetalle[0];
    expect(ten.detalle.map((v) => [v.estadoPago, v.formaPago, v.totalCobro, v.personasCobro, v.estadoPase])).toEqual([
      ["pendiente_abono", "transferencia", "50.00", 1, "vigente_hoy"],
      ["pagado_efectivo", "efectivo", "150.00", 3, "vencido"],
    ]);
    expect(ten.primera).not.toBeNull();
    expect(ten.aperturas).toMatchObject([{ tipo: "entrada", autorizo: expect.any(String), motivoAutorizacion: "Revisé el comprobante" }]);
    // De Santiago: solo nombre, conteo y última; nada más viaja al navegador.
    expect(h!.otras).toHaveLength(1);
    expect(Object.keys(h!.otras[0]).sort()).toEqual(["nombre", "ultima", "visitas"]);
    expect(h!.otras[0]).toMatchObject({ nombre: "Santiago", visitas: 2 });
    expect(JSON.stringify(h)).not.toContain("tarjeta");
    expect(JSON.stringify(h)).not.toContain("100.00");
    // Encargado Tenango ve lo mismo.
    const e = await historialVisitante(sql, encargadoTen, "TEN", mariela);
    expect(e!.resumen.visitas).toBe(4);
    expect(e!.conDetalle.map((s) => s.codigo)).toEqual(["TEN"]);
    expect(e!.otras.map((s) => s.nombre)).toEqual(["Santiago"]);
  });

  it("Administración con acceso solo a Tenango: vista y totales solo de Tenango, sin Santiago", async () => {
    const h = await historialVisitante(sql, adminTen, "TEN", mariela);
    expect(h!.resumen).toMatchObject({ visitas: 2, ultima: { sucursal: "Tenango" } });
    expect(h!.conDetalle.map((s) => [s.codigo, s.visitas])).toEqual([["TEN", 2]]);
    expect(h!.otras).toEqual([]);
    expect(h!.cobertura.map((c) => c.sucursal)).toEqual(["Tenango"]);
    expect(JSON.stringify(h)).not.toContain("Santiago");
  });

  it("Administración con Tenango y Santiago: detalle de ambas", async () => {
    const h = await historialVisitante(sql, adminAmbas, "TEN", mariela);
    expect(h!.resumen).toMatchObject({ visitas: 4, ultima: { sucursal: "Santiago" } });
    expect(h!.conDetalle.map((s) => [s.codigo, s.visitas])).toEqual([["STG", 2], ["TEN", 2]]);
    expect(h!.conDetalle.find((s) => s.codigo === "STG")!.detalle.map((v) => v.estadoPago).sort()).toEqual(["pagado_efectivo", "pagado_tarjeta"]);
    expect(h!.otras).toEqual([]);
  });

  it("la búsqueda trae el resumen con el alcance de cada cuenta", async () => {
    const consulta = interpretarConsulta("mariela ficticia");
    const r = await buscarVisitantes(sql, recepTen, "TEN", consulta);
    if (!r.ok) throw new Error(r.error);
    expect(r.resultados[0].historial).toMatchObject({ visitas: 4, ultima: { sucursal: "Santiago" }, incompleto: true });
    const a = await buscarVisitantes(sql, adminTen, "TEN", consulta);
    if (!a.ok) throw new Error(a.error);
    expect(a.resultados[0].historial).toMatchObject({ visitas: 2, ultima: { sucursal: "Tenango" } });
  });

  it("cobertura: la registra solo Dirección; incompleto mientras falte alguna sucursal del alcance o el inicio", async () => {
    expect(await registrarCobertura(sql, adminTen, "TEN", { desde: "2026-11-04", desdeInicio: true, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "no_encontrada" });
    expect(await registrarCobertura(sql, recepTen, "TEN", { desde: "2026-11-04", desdeInicio: true, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "no_encontrada" });
    expect(await registrarCobertura(sql, direccion, "TEN", { desde: "2026-02-30", desdeInicio: false, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "fecha" });
    expect(await registrarCobertura(sql, direccion, "TEN", { desde: "2999-01-01", desdeInicio: false, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "fecha" });
    expect(await registrarCobertura(sql, direccion, "STG", { desde: "2026-11-04", desdeInicio: false, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "no_encontrada" });
    expect(await registrarCobertura(sql, direccion, "TEN", { desde: "2026-11-04", desdeInicio: true, nota: "" }, { entorno: "produccion" })).toEqual({ ok: false, error: "bloqueado_produccion" });

    // Sin cobertura: incompleto. Con Tenango desde una fecha, pero sin cubrir desde el inicio: sigue incompleto.
    expect((await historialVisitante(sql, adminTen, "TEN", mariela))!.resumen.incompleto).toBe(true);
    expect(await registrarCobertura(sql, direccion, "TEN", { desde: "2026-11-04", desdeInicio: false, nota: "Primer turno del piloto" }, PRUEBAS)).toEqual({ ok: true });
    expect((await historialVisitante(sql, adminTen, "TEN", mariela))!.resumen.incompleto).toBe(true);
    expect((await historialVisitante(sql, adminTen, "TEN", mariela))!.cobertura).toMatchObject([{ sucursal: "Tenango", desde: "2026-11-04", desdeInicio: false }]);
    // Desde el inicio de operaciones: completo para quien solo ve Tenango; incompleto para Recepción (otras sucursales).
    expect(await registrarCobertura(sql, direccion, "TEN", { desde: "2026-11-04", desdeInicio: true, nota: "" }, PRUEBAS)).toEqual({ ok: true });
    expect((await historialVisitante(sql, adminTen, "TEN", mariela))!.resumen.incompleto).toBe(false);
    expect((await historialVisitante(sql, recepTen, "TEN", mariela))!.resumen.incompleto).toBe(true);
    // El primer turno no fija cobertura: Santiago sigue sin fecha.
    expect((await historialVisitante(sql, adminAmbas, "TEN", mariela))!.cobertura.find((c) => c.sucursal === "Santiago")).toMatchObject({ desde: null });
    // La cobertura no se edita ni se borra.
    await expect(sql`update cobertura_historial set desde = '2020-01-01'`).rejects.toThrow(/no se permite update/);
    await expect(sql`delete from cobertura_historial`).rejects.toThrow(/no se permite delete/);
  });

  it("sin permiso de consultar expedientes en la sucursal: null; ficha unida cuenta como la misma persona; cancelados no cuentan", async () => {
    expect(await historialVisitante(sql, adminTen, "STG", mariela)).toBeNull();
    expect(await historialVisitante(sql, recepTen, "TEN", randomUUID())).toBeNull();
    expect(await historialVisitante(sql, recepTen, "TEN", "no-es-id")).toBeNull();
    const otra = await ficha("Mariela Ficticia Ruiz (ficha nueva)");
    await sql`update visitante set fusionado_en = now(), fusionado_en_id = ${otra} where id = ${mariela}`;
    expect((await historialVisitante(sql, recepTen, "TEN", otra))!.resumen.visitas).toBe(4);
    const r = await sql.begin((tx) => resumenesHistorial(tx, adminTen, [otra]));
    expect(r.get(otra)!.visitas).toBe(2);
  });
});

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cobrosParaOrigen, detalleDiferencias, devolucionesDeVisitante, devolucionesPendientes, registrarDevolucion, resolverDiferencia, revisarDiferencia,
} from "@/lib/diferencias";
import { entregaEnCurso, recibirTurno, registrarEntrega } from "@/lib/entregas";
import { reporteCaja } from "@/lib/reporte-caja";
import { resumirCaja } from "@/lib/resumen-caja";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { aplicarCambio } from "@/lib/usuarios";
import { confirmarVisita, pantallaCobro } from "@/lib/visitas";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Cambio mal entregado (aprobado el 26 nov 2026; solo datos ficticios): visita de $50 pagada con $100, cambio registrado
 * $50, entregado $30. Sobran $20 que son de la persona visitante.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;
let k = 0;
const PRUEBAS = { entorno: "pruebas" as const };
const NADIE = { hubo: false as const };

async function cuenta(asignaciones: [string, string][]) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Devolución " + n}, ${`devolucion${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de devolución')`;
  }
  return u.id;
}
async function visitante(codigo: string, nombre = "Visitante ficticio A") {
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, sucursal_alta_id) values (${`${nombre} ${randomUUID().slice(0, 4)}`}, ${ids[codigo]}) returning id`;
  return v.id;
}
async function cobrar(u: string, codigo: string, visitantes: string[], recibido: string | null) {
  const p = await pantallaCobro(sql, u, codigo, "pruebas");
  if (!p.ok) throw new Error(p.error);
  const total = 50 * visitantes.length;
  const r = await confirmarVisita(sql, u, codigo, {
    clave: randomUUID(), turnoId: p.turnoId, visitanteIds: visitantes, formaPago: "efectivo",
    recibido, cambio: recibido === null ? null : (Number(recibido) - total).toFixed(2),
    autorizacion: null, referencia: null, tipoReferencia: null, otraVenta: false,
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  const [c] = await sql<{ id: string }[]>`select id from cobro_visita where operacion_id = ${r.operacionId}`;
  return c.id;
}

/** Abre con $400 en la bolsa; cobra la visita de Visitante ficticio A con $100 (cambio $50) y una visita grupal de 2. Espera $550. */
async function escenario() {
  k++;
  const codigo = `V${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal devoluciones " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const sale = await cuenta([["recepcion", codigo]]);
  const entra = await cuenta([["recepcion", codigo]]);
  const encargado = await cuenta([["encargado", codigo]]);
  const dir = await cuenta([["direccion", codigo]]);
  const [general] = await sql<{ id: string }[]>`select id from usuario where correo = 'direccion.general@prueba.fitnessland.invalid'`;
  const p = await aplicarCambio(sql, general.id, dir, { tipo: "dar_permiso", permiso: "reporte.caja", alcance: { todas: false, sucursales: [s.id] }, limite: "", hasta: "", motivo: "Prueba de devolución" }, PRUEBAS);
  if (!p.ok) throw new Error(p.error);
  const t = await abrirTurno(sql, sale, codigo, { bolsa: "400.00", cajon: "1000.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const a = await visitante(codigo);
  const cobroA = await cobrar(sale, codigo, [a], "100.00");
  const grupal = await cobrar(sale, codigo, [await visitante(codigo, "Grupo B"), await visitante(codigo, "Grupo C")], "200.00");
  return { codigo, sucursalId: s.id, sale, entra, encargado, dir, turnoId: t.turnoId, a, cobroA, grupal };
}
type Esc = Awaited<ReturnType<typeof escenario>>;

/** Cambio de turno: entrega la bolsa con lo contado; quien recibe cuenta lo mismo. */
async function cambio(e: Esc, entregado: string) {
  const r = await registrarEntrega(sql, e.sale, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: entregado, cajon: "1000" }, recibe: e.entra, nota: "", apoyo: NADIE }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  const x = (await entregaEnCurso(sql, e.turnoId))!;
  const ok = await recibirTurno(sql, e.entra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: entregado, cajon: "1000" }, aclaracion: "", apoyo: NADIE }, PRUEBAS);
  if (!ok.ok || ok.resultado !== "confirmada") throw new Error(JSON.stringify(ok));
  const [d] = await sql<{ id: string }[]>`select id from diferencia_efectivo where entrega_id = ${r.entregaId} and tipo = 'contra_esperado'`;
  return { entregaId: r.entregaId, turnoNuevo: ok.turnoId, difId: d.id };
}

const revisar = (e: Esc, difId: string, origen: { cobroId: string; cambioEntregado: string } | null, resultado = "sobrante_confirmado") =>
  revisarDiferencia(sql, e.encargado, e.codigo, { diferenciaId: difId, resultado, motivo: "Prueba ficticia: pagó con $100 y se le dieron $30", origenCambio: origen }, PRUEBAS);
const autorizar = (e: Esc, difId: string, usuario = e.dir) =>
  resolverDiferencia(sql, usuario, e.codigo, { diferenciaId: difId, decision: "devolver_visitante", motivo: "Prueba ficticia: se le devuelve el cambio" }, PRUEBAS);

describe.skipIf(!URL_ADMIN)("cambio mal entregado: origen, autorización y devolución", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("recorrido completo: el ingreso no cambia, los $20 se desglosan y salen una sola vez", async () => {
    const e = await escenario();
    const c = await cambio(e, "570");
    // Solo se ofrece el cobro individual con «Recibido» (no el grupal).
    expect((await cobrosParaOrigen(sql, c.difId)).map((x) => x.cobroId)).toEqual([e.cobroA]);

    // Revisión con origen: coincidencia exacta.
    expect(await revisar(e, c.difId, { cobroId: e.cobroA, cambioEntregado: "35" })).toEqual({ ok: false, error: "no_coincide" });
    expect(await revisar(e, c.difId, { cobroId: e.cobroA, cambioEntregado: "50" })).toEqual({ ok: false, error: "cambio_entregado" });
    expect(await revisar(e, c.difId, { cobroId: e.grupal, cambioEntregado: "80" })).toEqual({ ok: false, error: "origen_cambio" });
    expect(await revisar(e, c.difId, { cobroId: e.cobroA, cambioEntregado: "30" }, "aclarada")).toEqual({ ok: false, error: "origen_cambio" });
    expect(await revisar(e, c.difId, { cobroId: e.cobroA, cambioEntregado: "30" })).toMatchObject({ ok: true });
    let d = (await detalleDiferencias(sql, e.dir, e.codigo, c.entregaId))!.diferencias.find((x) => x.id === c.difId)!;
    expect(d.revision!.origenCambio).toMatchObject({ cambioRegistrado: "50.00", cambioEntregado: "30.00", porDevolver: "20.00", recibido: "100.00", importeCobro: "50.00" });

    // Autoriza Dirección que no participó; Recepción no; Dirección que participó tampoco (no aplica la autorización personal).
    expect(await autorizar(e, c.difId, e.entra)).toEqual({ ok: false, error: "no_encontrada" });
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${e.entra}, 'direccion', ${e.sucursalId}, 'Prueba: Dirección que participó')`;
    expect(await autorizar(e, c.difId, e.entra)).toEqual({ ok: false, error: "participaste" });
    expect(await autorizar(e, c.difId)).toMatchObject({ ok: true });
    d = (await detalleDiferencias(sql, e.dir, e.codigo, c.entregaId))!.diferencias.find((x) => x.id === c.difId)!;
    expect(d).toMatchObject({ estado: "devolucion_pendiente", resolucion: { decision: "devolver_visitante", devolucion: { importe: "20.00", recordatorio: false, entregada: null } } });

    // Caja: los $20 siguen dentro del efectivo, desglosados; el caso, en «Devolución pendiente».
    const rep = await reporteCaja(sql, e.dir, { codigo: e.codigo });
    const caja = rep!.filas[0];
    expect(caja.porDevolver).toEqual({ n: 1, importe: "20.00" });
    expect(caja.lugares.find((l) => l.tipo === "bolsa_visitas")!.importe).toBe("570.00");
    expect(caja.diferencias.find((x) => x.id === c.difId)).toMatchObject({ etapa: "devolucion_pendiente", estado: "Autorizada por Dirección · por devolver a la persona visitante" });
    const s = resumirCaja(caja, rep!.corte);
    expect(s.atencion.find((a) => a.clave === "por_devolver")).toMatchObject({ n: 1, importe: "20.00" });
    expect(s.porDevolver).toEqual({ n: 1, importe: "20.00" });

    // La ficha: en otra sucursal no se puede; en la del cobro, solo quien tiene la bolsa del turno abierto.
    expect(await devolucionesDeVisitante(sql, e.entra, "TEN", e.a)).toMatchObject([{ puedeEntregar: false, motivoNoPuede: expect.stringMatching(/solo en/) }]);
    expect(await devolucionesDeVisitante(sql, e.entra, e.codigo, e.a)).toMatchObject([{ importe: "20.00", puedeEntregar: true }]);
    expect(await devolucionesDeVisitante(sql, e.sale, e.codigo, e.a)).toMatchObject([{ puedeEntregar: false }]);
    const [{ id: devolucionId }] = await sql<{ id: string }[]>`select id from devolucion_cambio where diferencia_id = ${c.difId}`;
    expect(await registrarDevolucion(sql, e.entra, "TEN", { devolucionId, recibio: true, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "otra_sucursal" });
    expect(await registrarDevolucion(sql, e.sale, e.codigo, { devolucionId, recibio: true, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "no_responsable" });
    expect(await registrarDevolucion(sql, e.entra, e.codigo, { devolucionId, recibio: false, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "confirmar" });

    const antes = (await estadoTurno(sql, e.entra, e.codigo))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!;
    expect(antes.esperado).toBe("570.00");
    expect(await registrarDevolucion(sql, e.entra, e.codigo, { devolucionId, recibio: true, nota: "Se entregó en recepción" }, PRUEBAS)).toEqual({ ok: true, visitanteId: e.a });
    expect(await registrarDevolucion(sql, e.entra, e.codigo, { devolucionId, recibio: true, nota: "" }, PRUEBAS)).toEqual({ ok: false, error: "ya_entregada" });

    // Sale una sola vez: baja el esperado $20; el ingreso de visitas no cambia; el caso se cierra.
    const despues = (await estadoTurno(sql, e.entra, e.codigo))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!;
    expect(despues).toMatchObject({ esperado: "550.00", devoluciones: "-20.00", cantidadDevoluciones: 1, entradas: "0.00" });
    const [{ ingreso }] = await sql<{ ingreso: string }[]>`
      select coalesce(sum(cv.importe), 0)::text as ingreso from cobro_visita cv join operacion_visita o on o.id = cv.operacion_id where o.sucursal_id = ${e.sucursalId}`;
    expect(ingreso).toBe("150.00");
    expect((await sql`select 1 from movimiento_efectivo where devolucion_id = ${devolucionId}`).length).toBe(1);
    d = (await detalleDiferencias(sql, e.dir, e.codigo, c.entregaId))!.diferencias.find((x) => x.id === c.difId)!;
    expect(d).toMatchObject({ estado: "resuelta", resolucion: { devolucion: { entregada: { nota: "Se entregó en recepción" } } } });
    const h = (await detalleDiferencias(sql, e.dir, e.codigo, c.entregaId))!.historial.map((x) => x.que).join("\n");
    expect(h).toMatch(/origen: cambio mal entregado/);
    expect(h).toMatch(/Por devolver a la persona visitante: \$20\.00/);
    expect(h).toMatch(/Devolución entregada .*\$20\.00/);
    const caja2 = (await reporteCaja(sql, e.dir, { codigo: e.codigo }))!.filas[0];
    expect(caja2.porDevolver).toEqual({ n: 0, importe: "0.00" });
    expect(caja2.movimientos.devoluciones).toEqual({ n: 1, importe: "-20.00" });
    expect(caja2.diferencias.find((x) => x.id === c.difId)).toMatchObject({ etapa: "cerrada", estado: "Resuelta por Dirección · Devuelta a la persona visitante" });
    expect(await devolucionesDeVisitante(sql, e.entra, e.codigo, e.a)).toEqual([]);

    // Nada se edita ni se borra.
    await expect(sql`update devolucion_cambio set importe = 25 where id = ${devolucionId}`).rejects.toThrow(/no se edita/);
    await expect(sql`delete from devolucion_entregada where devolucion_id = ${devolucionId}`).rejects.toThrow(/no se edita/);
  });

  it("un mismo cobro no autoriza dos devoluciones; sin origen no se autoriza; recordatorio a los 30 días desde la autorización", async () => {
    const e = await escenario();
    const c = await cambio(e, "570");
    // Sin origen registrado no se puede autorizar la devolución.
    expect(await revisar(e, c.difId, null)).toMatchObject({ ok: true });
    expect(await autorizar(e, c.difId)).toEqual({ ok: false, error: "sin_origen_cambio" });

    // Otro caso con su origen y su devolución autorizada.
    const e2 = await escenario();
    const c2 = await cambio(e2, "570");
    expect(await revisar(e2, c2.difId, { cobroId: e2.cobroA, cambioEntregado: "30" })).toMatchObject({ ok: true });
    expect(await autorizar(e2, c2.difId)).toMatchObject({ ok: true });
    // Si otro caso apuntara al mismo cobro (solo se puede forzar saltando las reglas), la autorización se rechaza…
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into origen_cambio_mal_entregado (diferencia_id, cobro_id, visitante_id, cambio_registrado, cambio_entregado, por_devolver, registrado_por)
               values (${c.difId}, ${e2.cobroA}, ${e2.a}, 50, 30, 20, ${e.encargado})`;
    });
    expect(await resolverDiferencia(sql, e.dir, e.codigo, { diferenciaId: c.difId, decision: "devolver_visitante", motivo: "Prueba: mismo cobro" }, PRUEBAS))
      .toEqual({ ok: false, error: "cobro_ya_usado" });
    // …y la base tampoco lo permite (índice único por cobro), aun saltando las demás reglas.
    await expect(sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const [x] = await tx<{ id: string }[]>`
        insert into resolucion_diferencia (diferencia_id, decision, motivo, resuelta_por) values (${c.difId}, 'devolver_visitante', 'Prueba: mismo cobro', ${e.dir}) returning id`;
      await tx`insert into devolucion_cambio (diferencia_id, resolucion_id, cobro_id, visitante_id, sucursal_id, importe, autorizada_por)
               values (${c.difId}, ${x.id}, ${e2.cobroA}, ${e2.a}, ${e2.sucursalId}, 20, ${e.dir})`;
    })).rejects.toThrow(/devolucion_cambio_cobro_id_key/);

    // Recordatorio: a los 30 días desde la autorización (se simula moviendo la fecha de autorización), sin cerrar el caso.
    expect(await devolucionesPendientes(sql, e2.dir, e2.sucursalId)).toMatchObject({ n: 1, vencidas: 0 });
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update devolucion_cambio set autorizada_en = now() - interval '31 days' where diferencia_id = ${c2.difId}`;
    });
    expect(await devolucionesPendientes(sql, e2.dir, e2.sucursalId)).toMatchObject({ n: 1, vencidas: 1 });
    expect(await devolucionesPendientes(sql, e2.entra, e2.sucursalId)).toBeNull();
    const d = (await detalleDiferencias(sql, e2.dir, e2.codigo, c2.entregaId))!.diferencias.find((x) => x.id === c2.difId)!;
    expect(d).toMatchObject({ estado: "devolucion_pendiente", resolucion: { devolucion: { recordatorio: true, entregada: null } } });
    expect((await devolucionesDeVisitante(sql, e2.entra, e2.codigo, e2.a))[0]).toMatchObject({ recordatorio: true });
  });

  it("la base exige la coincidencia exacta y el cobro de esa bolsa y ese turno", async () => {
    const e = await escenario();
    const c = await cambio(e, "570");
    expect(await revisar(e, c.difId, null)).toMatchObject({ ok: true });
    await expect(sql`insert into origen_cambio_mal_entregado (diferencia_id, cobro_id, visitante_id, cambio_registrado, cambio_entregado, por_devolver, registrado_por)
                     values (${c.difId}, ${e.cobroA}, ${e.a}, 50, 35, 15, ${e.encargado})`).rejects.toThrow(/coincidir exactamente/);
    const otra = await escenario();
    await expect(sql`insert into origen_cambio_mal_entregado (diferencia_id, cobro_id, visitante_id, cambio_registrado, cambio_entregado, por_devolver, registrado_por)
                     values (${c.difId}, ${otra.cobroA}, ${otra.a}, 50, 30, 20, ${e.encargado})`).rejects.toThrow(/de esa bolsa y ese turno/);
  });
});

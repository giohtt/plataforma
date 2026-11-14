import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detalleDiferencias } from "@/lib/diferencias";
import { entregaEnCurso, recibirTurno, registrarEntrega } from "@/lib/entregas";
import {
  bandejaEncargada, confirmarRetiro, detalleRetiro, listaRetiros, pantallaRetiro, recontarRetiro, registrarDeposito,
  registrarRetiro, retirosDelTurno, retirosPorConfirmar, retirosPorRevisar, revisarRetiro,
} from "@/lib/retiros";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;
let k = 0;
const PRUEBAS = { entorno: "pruebas" as const };
const NADIE = { hubo: false as const };

async function cuenta(asignaciones: [string, string][], nombre = "Retiros") {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${`${nombre} ${n}`}, ${`retiros${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de retiros')`;
  }
  return u.id;
}

/** Sucursal nueva: Recepción abre con $900 en la bolsa (esperado $900) y $2,300 en el cajón. */
async function escenario() {
  k++;
  const codigo = `R${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal retiros " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const recepcion = await cuenta([["recepcion", codigo]], "Recepción");
  const otraRecepcion = await cuenta([["recepcion", codigo]], "Recepción vespertina");
  const encargada = await cuenta([["encargada_retiros", codigo]], "Encargada de retiros");
  const otraEncargada = await cuenta([["encargada_retiros", codigo]], "Otra Encargada de retiros");
  const encargado = await cuenta([["encargado", codigo]], "Encargado");
  const admin = await cuenta([["administracion", codigo]], "Administración");
  const dir = await cuenta([["direccion", codigo]], "Dirección");
  const t = await abrirTurno(sql, recepcion, codigo, { bolsa: "900.00", cajon: "2300.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  return { codigo, sucursalId: s.id, recepcion, otraRecepcion, encargada, otraEncargada, encargado, admin, dir, turnoId: t.turnoId };
}
type Esc = Awaited<ReturnType<typeof escenario>>;

async function retirar(e: Esc, lugar: "bolsa_visitas" | "cajon_mensualidades", contado: string, cambio: string, folio: string) {
  const r = await registrarRetiro(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, lugar, contado, cambio, folio, encargada: e.encargada }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return r.retiroId;
}
const version = async (id: string) => (await sql<{ version: number }[]>`select version from retiro where id = ${id}`)[0].version;
const confirmar = async (e: Esc, id: string, importe: string, folioCoincide = true, motivo = "") =>
  confirmarRetiro(sql, e.encargada, { retiroId: id, version: await version(id), importe, folioCoincide, motivo }, PRUEBAS);
const depositar = (e: Esc, id: string, importe: string, referencia = "DEP-FICTICIO-0001", corrige: string | null = null, motivo = "") =>
  registrarDeposito(sql, e.encargada, { retiroId: id, importe, depositadoEn: ahoraLocal(), referencia, corrige, motivo }, PRUEBAS);
/** Hora de México de hace un minuto, como la escribe el formulario. */
function ahoraLocal() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(Date.now() - 60_000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

describe.skipIf(!URL_ADMIN)("retiros a Encargada de retiros", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("Recepción entrega la bolsa y el cajón, cada uno con su folio: la salida se descuenta al entregar y queda pendiente", async () => {
    const e = await escenario();
    const p = await pantallaRetiro(sql, e.recepcion, e.codigo, "pruebas");
    expect(p).toMatchObject({ ok: true, lugares: [{ tipo: "bolsa_visitas", esperado: "900.00" }, { tipo: "cajon_mensualidades", esperado: null }] });
    expect(p.ok && p.encargadas.map((x) => x.id).sort()).toEqual([e.encargada, e.otraEncargada].sort());
    const bolsa = await retirar(e, "bolsa_visitas", "900", "100", "ten-1113-01");
    await retirar(e, "cajon_mensualidades", "2300", "0", "TEN-1113-02");
    const t = (await estadoTurno(sql, e.recepcion, e.codigo))!.turno!;
    expect(t.lugares[0]).toMatchObject({ retiros: "-800.00", cantidadRetiros: 1, esperado: "100.00" });
    expect(t.lugares[1]).toMatchObject({ retiros: "-2300.00", cantidadRetiros: 1, esperado: null });
    expect(await retirosDelTurno(sql, e.turnoId)).toMatchObject([
      { folio: "TEN-1113-01", contado: "900.00", cambio: "100.00", importe: "800.00", textoEstado: "Pendiente de confirmar por Encargada de retiros" },
      { folio: "TEN-1113-02", importe: "2300.00", textoEstado: "Pendiente de confirmar por Encargada de retiros" },
    ]);
    const [m] = await sql`select tipo, importe::text from movimiento_efectivo where retiro_id = ${bolsa}`;
    expect(m).toEqual({ tipo: "salida_retiro", importe: "-800.00" });
    expect(await retirosPorConfirmar(sql, e.encargada, e.sucursalId)).toBe(2);
    // Recepción ve el estado en su turno, no el detalle.
    expect(await detalleRetiro(sql, e.recepcion, e.codigo, bolsa)).toBeNull();
  });

  it("conteo a ciegas: la bandeja y el detalle no le muestran lo registrado mientras está pendiente", async () => {
    const e = await escenario();
    const id = await retirar(e, "cajon_mensualidades", "2300", "0", "C-1");
    const b = (await bandejaEncargada(sql, e.encargada))!;
    expect(b.porConfirmar).toHaveLength(1);
    expect(JSON.stringify(b.porConfirmar[0])).not.toMatch(/2300/);
    const d = (await detalleRetiro(sql, e.encargada, e.codigo, id))!;
    expect(d.registrado).toBeNull();
    expect(JSON.stringify(d)).not.toMatch(/2300/);
    // Otra Encargada de retiros no lo ve ni lo confirma.
    expect((await bandejaEncargada(sql, e.otraEncargada))!.porConfirmar).toHaveLength(0);
    const r = await confirmarRetiro(sql, e.otraEncargada, { retiroId: id, version: 1, importe: "2300", folioCoincide: true, motivo: "" }, PRUEBAS);
    expect(r).toEqual({ ok: false, error: "no_encontrado" });
    // Administración sí ve lo registrado.
    expect((await detalleRetiro(sql, e.admin, e.codigo, id))!.registrado).toMatchObject({ importe: "2300.00" });
  });

  it("si coincide, se confirma y se habilitan depósitos parciales por folio hasta cubrir el saldo, nunca más", async () => {
    const e = await escenario();
    const id = await retirar(e, "cajon_mensualidades", "2300", "0", "C-2");
    expect(await confirmar(e, id, "2300")).toEqual({ ok: true, resultado: "confirmado" });
    expect(await depositar(e, id, "2000", "DEP-FICTICIO-004512")).toMatchObject({ ok: true });
    let b = (await bandejaEncargada(sql, e.encargada))!;
    expect(b.retiros[0].saldo).toMatchObject({ habilitado: "2300.00", depositado: "2000.00", sinDestino: "300.00" });
    expect(b.total.sinDestino).toBe("300.00");
    expect(await depositar(e, id, "300.01")).toEqual({ ok: false, error: "excede" });
    // La base lo respalda aunque se salte el servidor.
    await expect(sql`insert into deposito_retiro (retiro_id, importe, depositado_en, referencia, registrado_por)
                     values (${id}, 301, now(), 'DEP-DIRECTO', ${e.encargada})`).rejects.toThrow(/superarían/);
    expect(await depositar(e, id, "300")).toMatchObject({ ok: true });
    b = (await bandejaEncargada(sql, e.encargada))!;
    expect(b.retiros[0].saldo.sinDestino).toBe("0.00");
    // Sin referencia no se registra.
    expect(await depositar(e, id, "1", "  ")).toEqual({ ok: false, error: "referencia" });
  });

  it("una corrección de depósito es un registro nuevo con motivo; el anterior se conserva", async () => {
    const e = await escenario();
    const id = await retirar(e, "bolsa_visitas", "900", "100", "B-3");
    await confirmar(e, id, "800");
    const d1 = await depositar(e, id, "500", "DEP-MAL");
    if (!d1.ok) throw new Error(d1.error);
    expect(await depositar(e, id, "300", "DEP-BIEN", d1.depositoId, "")).toEqual({ ok: false, error: "motivo" });
    expect(await depositar(e, id, "300", "DEP-BIEN", d1.depositoId, "Prueba ficticia: se capturó mal el importe")).toMatchObject({ ok: true });
    // Ya no se corrige el reemplazado.
    expect(await depositar(e, id, "100", "DEP-OTRA", d1.depositoId, "Prueba ficticia: otra corrección")).toEqual({ ok: false, error: "corrige" });
    const d = (await detalleRetiro(sql, e.encargada, e.codigo, id))!;
    expect(d.depositos.map((x) => [x.importe, x.vigente])).toEqual([["500.00", false], ["300.00", true]]);
    expect(d.retiro.saldo).toMatchObject({ depositado: "300.00", sinDestino: "500.00" });
    expect(d.historial.map((h) => h.que).join("\n")).toMatch(/Corrección de depósito: ahora \$300\.00.*Motivo: «Prueba ficticia: se capturó mal el importe»/);
    await expect(sql`update deposito_retiro set importe = 1 where id = ${d1.depositoId}`).rejects.toThrow();
  });

  it("$2,300 registrados y $2,250 contados: sin recuento, «No coincide» con motivo; solo ese folio en pausa y los $50 fuera de su saldo", async () => {
    const e = await escenario();
    const bolsa = await retirar(e, "bolsa_visitas", "900", "100", "B-4");
    const cajon = await retirar(e, "cajon_mensualidades", "2300", "0", "C-4");
    await confirmar(e, bolsa, "800");
    expect(await confirmar(e, cajon, "2250")).toEqual({ ok: true, resultado: "recuento" });
    let b = (await bandejaEncargada(sql, e.encargada))!;
    expect(b.porRecontar).toMatchObject([{ folio: "C-4", registrado: "2300.00", inicial: "2250.00" }]);
    // Sin recuento y sin motivo no se registra.
    expect(await recontarRetiro(sql, e.encargada, { retiroId: cajon, version: await version(cajon), recontaron: false, importe: null, con: null, motivo: "" }, PRUEBAS))
      .toEqual({ ok: false, error: "motivo" });
    expect(await recontarRetiro(sql, e.encargada, {
      retiroId: cajon, version: await version(cajon), recontaron: false, importe: null, con: null, motivo: "Prueba ficticia: Recepción ya se había ido",
    }, PRUEBAS)).toEqual({ ok: true, resultado: "por_revisar" });

    b = (await bandejaEncargada(sql, e.encargada))!;
    const c = b.retiros.find((r) => r.folio === "C-4")!;
    expect(c).toMatchObject({ estado: "por_revisar", textoEstado: "No coincide · Por revisar", saldo: { habilitado: null, sinDestino: "0.00", enPausa: "2250.00", porAclarar: "-50.00" } });
    expect(c.avisos.revision).toMatchObject({ masDe48: false });
    // El saldo bajo su responsabilidad no suma los $50 ni lo que está en pausa.
    expect(b.total).toEqual({ sinDestino: "800.00", enPausa: "2250.00", porAclarar: "-50.00" });
    // Solo ese folio queda en pausa: el de la bolsa se deposita normalmente.
    expect(await depositar(e, cajon, "100")).toEqual({ ok: false, error: "en_pausa" });
    expect(await depositar(e, bolsa, "800")).toMatchObject({ ok: true });
    await expect(sql`insert into deposito_retiro (retiro_id, importe, depositado_en, referencia, registrado_por)
                     values (${cajon}, 1, now(), 'DEP-DIRECTO', ${e.encargada})`).rejects.toThrow(/en pausa/);
    // Recepción ve solo el estado; la salida original no cambia.
    expect((await retirosDelTurno(sql, e.turnoId)).find((r) => r.folio === "C-4")).toMatchObject({ importe: "2300.00", textoEstado: "No coincide · Por revisar" });
    expect((await estadoTurno(sql, e.recepcion, e.codigo))!.turno!.lugares[1].retiros).toBe("-2300.00");
    // Administración ve el saldo de la Encargada de retiros y lo por aclarar aparte.
    const l = (await listaRetiros(sql, e.admin, e.codigo))!;
    expect(l.porEncargada).toEqual([{ encargada: expect.stringContaining("Encargada de retiros"), sinDestino: "0.00", enPausa: "2250.00", porAclarar: "-50.00", faltanteDireccion: "0.00", avisos48: 0 }]);
  });

  it("revisa Encargado (no participó): «Faltante confirmado» con monto verificado habilita depósitos por $2,250 y deja $50 para Dirección", async () => {
    const e = await escenario();
    const cajon = await retirar(e, "cajon_mensualidades", "2300", "0", "C-5");
    await confirmar(e, cajon, "2250");
    await recontarRetiro(sql, e.encargada, {
      retiroId: cajon, version: await version(cajon), recontaron: true, importe: "2250", con: e.otraRecepcion, motivo: "Prueba ficticia: recontamos y siguen $2,250",
    }, PRUEBAS);
    expect(await retirosPorRevisar(sql, e.encargado, e.sucursalId)).toBe(1);
    // Encargado ve solo lo que le toca; la Encargada de retiros no revisa (participó).
    expect((await listaRetiros(sql, e.encargado, e.codigo))!.retiros.map((r) => r.folio)).toEqual(["C-5"]);
    const d = (await detalleRetiro(sql, e.encargado, e.codigo, cajon))!;
    expect(d).toMatchObject({ nivel: "encargado", puedeRevisar: true, conteos: { inicial: { importe: "2250.00" }, recuento: { importe: "2250.00" } } });
    const v = await version(cajon);
    expect(await revisarRetiro(sql, e.admin, e.codigo, { retiroId: cajon, version: v, resultado: "aclarada", motivo: "Prueba ficticia", montoVerificado: "2250" }, PRUEBAS))
      .toEqual({ ok: false, error: "otro_nivel" });
    expect(await revisarRetiro(sql, e.encargado, e.codigo, { retiroId: cajon, version: v, resultado: "faltante_confirmado", motivo: "Prueba ficticia: el sobre tiene $2,300", montoVerificado: "2300" }, PRUEBAS))
      .toEqual({ ok: false, error: "monto" });
    expect(await revisarRetiro(sql, e.encargado, e.codigo, {
      retiroId: cajon, version: v, resultado: "faltante_confirmado", motivo: "Prueba ficticia: el sobre correcto tiene $2,250", montoVerificado: "2250",
    }, PRUEBAS)).toEqual({ ok: true });
    const x = (await detalleRetiro(sql, e.encargada, e.codigo, cajon))!;
    expect(x.retiro).toMatchObject({ estado: "revisado", textoEstado: "Revisado · faltante confirmado, pendiente para Dirección",
      saldo: { habilitado: "2250.00", sinDestino: "2250.00", enPausa: "0.00", porAclarar: "0.00", faltanteDireccion: "50.00" } });
    expect(x.puedeDepositar).toBe(true);
    // Los depósitos no superan el monto verificado.
    expect(await depositar(e, cajon, "2300")).toEqual({ ok: false, error: "excede" });
    expect(await depositar(e, cajon, "2250")).toMatchObject({ ok: true });
    // Se conservan la salida original y ambos conteos en el historial.
    const h = x.historial.map((y) => y.que).join("\n");
    expect(h).toMatch(/se lleva \$2,300\.00/);
    expect(h).toMatch(/Conteo de Encargada de retiros: \$2,250\.00/);
    expect(h).toMatch(/Recuento en persona con Recepción vespertina \d+: \$2,250\.00/);
    expect(h).toMatch(/Faltante confirmado · monto verificado \$2,250\.00 · faltante \$50\.00 pendiente para Dirección/);
    expect((await listaRetiros(sql, e.dir, e.codigo))!.porEncargada[0]).toMatchObject({ faltanteDireccion: "50.00", sinDestino: "0.00" });
  });

  it("si recontó con alguien con perfil de Encargado, revisa Administración; Encargado no", async () => {
    const e = await escenario();
    const cajon = await retirar(e, "cajon_mensualidades", "2300", "0", "C-6");
    await confirmar(e, cajon, "2250");
    await recontarRetiro(sql, e.encargada, {
      retiroId: cajon, version: await version(cajon), recontaron: true, importe: "2280", con: e.encargado, motivo: "Prueba ficticia: tras recontar faltan $20",
    }, PRUEBAS);
    expect((await detalleRetiro(sql, e.admin, e.codigo, cajon))!).toMatchObject({ nivel: "administracion", puedeRevisar: true,
      retiro: { saldo: { enPausa: "2280.00", porAclarar: "-20.00" } } });
    expect(await retirosPorRevisar(sql, e.encargado, e.sucursalId)).toBe(0);
    expect(await detalleRetiro(sql, e.encargado, e.codigo, cajon)).toBeNull();
    const v = await version(cajon);
    expect(await revisarRetiro(sql, e.encargado, e.codigo, { retiroId: cajon, version: v, resultado: "aclarada", motivo: "Prueba ficticia", montoVerificado: "2300" }, PRUEBAS))
      .toEqual({ ok: false, error: "participaste" });
    expect(await revisarRetiro(sql, e.admin, e.codigo, { retiroId: cajon, version: v, resultado: "aclarada", motivo: "Prueba ficticia: error de conteo, hay $2,300", montoVerificado: "2300" }, PRUEBAS))
      .toEqual({ ok: true });
    expect((await detalleRetiro(sql, e.encargada, e.codigo, cajon))!.retiro.saldo).toMatchObject({ habilitado: "2300.00", sinDestino: "2300.00", faltanteDireccion: "0.00" });
  });

  it("si el recuento coincide, se confirma; se conservan el conteo inicial y con quién recontó", async () => {
    const e = await escenario();
    const id = await retirar(e, "bolsa_visitas", "900", "100", "B-7");
    await confirmar(e, id, "750");
    expect(await recontarRetiro(sql, e.encargada, { retiroId: id, version: await version(id), recontaron: true, importe: "800", con: e.recepcion, motivo: "" }, PRUEBAS))
      .toEqual({ ok: true, resultado: "confirmado" });
    const d = (await detalleRetiro(sql, e.encargada, e.codigo, id))!;
    expect(d.retiro.saldo).toMatchObject({ habilitado: "800.00", porAclarar: "0.00" });
    expect(d.conteos).toMatchObject({ inicial: { importe: "750.00" }, recuento: { importe: "800.00" } });
  });

  it("si el folio no coincide, queda por revisar y en pausa hasta verificar a qué sobre corresponde", async () => {
    const e = await escenario();
    const id = await retirar(e, "cajon_mensualidades", "2300", "0", "C-8");
    expect(await confirmar(e, id, "2300", false, "")).toEqual({ ok: false, error: "motivo" });
    expect(await confirmar(e, id, "2300", false, "Prueba ficticia: el sobre dice C-9")).toEqual({ ok: true, resultado: "por_revisar" });
    const d = (await detalleRetiro(sql, e.encargado, e.codigo, id))!;
    expect(d).toMatchObject({ retiro: { discrepancia: "folio", saldo: { enPausa: "2300.00", porAclarar: "0.00", habilitado: null } }, puedeRevisar: true });
    expect(await depositar(e, id, "100")).toEqual({ ok: false, error: "en_pausa" });
    expect(await revisarRetiro(sql, e.encargado, e.codigo, {
      retiroId: id, version: await version(id), resultado: "aclarada", motivo: "Prueba ficticia: se verificó que el sobre es el C-8", montoVerificado: "2300",
    }, PRUEBAS)).toEqual({ ok: true });
    expect(await depositar(e, id, "2300")).toMatchObject({ ok: true });
  });

  it("avisos: «48 horas o más en revisión» desde que se reportó, y saldo sin destino 48 horas después de habilitar, aunque haya un depósito parcial", async () => {
    const e = await escenario();
    const bolsa = await retirar(e, "bolsa_visitas", "900", "100", "B-9");
    const cajon = await retirar(e, "cajon_mensualidades", "2300", "0", "C-9");
    await confirmar(e, bolsa, "800");
    await depositar(e, bolsa, "500");
    await confirmar(e, cajon, "2250");
    await recontarRetiro(sql, e.encargada, { retiroId: cajon, version: await version(cajon), recontaron: false, importe: null, con: null, motivo: "Prueba ficticia: sin recuento" }, PRUEBAS);
    const en47 = new Date(Date.now() + 47 * 3_600_000);
    const en49 = new Date(Date.now() + 49 * 3_600_000);
    let b = (await bandejaEncargada(sql, e.encargada, en47))!;
    expect(b.retiros.find((r) => r.folio === "B-9")!.avisos.sinDestino).toMatchObject({ masDe48: false });
    expect(b.retiros.find((r) => r.folio === "C-9")!.avisos).toMatchObject({ revision: { texto: "1 día 23 h", masDe48: false }, sinDestino: null });
    b = (await bandejaEncargada(sql, e.encargada, en49))!;
    expect(b.retiros.find((r) => r.folio === "B-9")!.avisos.sinDestino).toMatchObject({ masDe48: true });
    expect(b.retiros.find((r) => r.folio === "C-9")!.avisos.revision).toMatchObject({ masDe48: true });
    // El de la bolsa, ya completo, no avisa.
    await depositar(e, bolsa, "300");
    b = (await bandejaEncargada(sql, e.encargada, en49))!;
    expect(b.retiros.find((r) => r.folio === "B-9")!.avisos.sinDestino).toBeNull();
    expect((await listaRetiros(sql, e.admin, e.codigo, en49))!.porEncargada[0].avisos48).toBe(1);
  });

  it("valida en el servidor: responsable vigente, folio único (reintento idéntico no duplica), cambio menor que lo contado, Encargada autorizada", async () => {
    const e = await escenario();
    const base = { turnoId: e.turnoId, lugar: "bolsa_visitas", contado: "900", cambio: "100", folio: "B-10", encargada: e.encargada };
    expect(await registrarRetiro(sql, e.otraRecepcion, e.codigo, base, PRUEBAS)).toEqual({ ok: false, error: "no_responsable" });
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, { ...base, cambio: "900" }, PRUEBAS)).toEqual({ ok: false, error: "cambio_mayor" });
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, { ...base, folio: "x" }, PRUEBAS)).toEqual({ ok: false, error: "folio" });
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, { ...base, encargada: e.encargado }, PRUEBAS)).toEqual({ ok: false, error: "encargada" });
    const a = await registrarRetiro(sql, e.recepcion, e.codigo, base, PRUEBAS);
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, base, PRUEBAS)).toEqual(a);
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, { ...base, lugar: "cajon_mensualidades", contado: "2300", cambio: "0" }, PRUEBAS))
      .toEqual({ ok: false, error: "folio_repetido" });
    expect((await sql`select count(*)::int as n from movimiento_efectivo where tipo = 'salida_retiro' and turno_id = ${e.turnoId}`)[0].n).toBe(1);
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, { ...base, folio: "B-11" }, { entorno: "produccion" })).toEqual({ ok: false, error: "bloqueado_produccion" });
    // La Encargada de retiros de otra sucursal no aparece ni puede recibir.
    const otra = await cuenta([["encargada_retiros", "TEN"]], "Encargada de retiros Tenango");
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, { ...base, folio: "B-12", encargada: otra }, PRUEBAS)).toEqual({ ok: false, error: "encargada" });
    await expect(sql`insert into retiro (sucursal_id, turno_id, lugar_id, folio, contado, cambio, importe, entregado_por, encargada_id)
      select ${e.sucursalId}, ${e.turnoId}, id, 'B-13', 10, 0, 10, ${e.recepcion}, ${otra} from lugar_efectivo where sucursal_id = ${e.sucursalId} limit 1`)
      .rejects.toThrow(/Encargada de retiros autorizada/);
  });

  it("con un cambio de turno en curso no se retira; el esperado de la entrega y el desglose incluyen el retiro", async () => {
    const e = await escenario();
    await retirar(e, "bolsa_visitas", "900", "100", "B-14");
    const r = await registrarEntrega(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "100", cajon: "2300" }, recibe: e.otraRecepcion, nota: "", apoyo: NADIE }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    expect(await registrarRetiro(sql, e.recepcion, e.codigo, { turnoId: e.turnoId, lugar: "cajon_mensualidades", contado: "2300", cambio: "0", folio: "C-14", encargada: e.encargada }, PRUEBAS))
      .toEqual({ ok: false, error: "entrega_en_curso" });
    const x = (await entregaEnCurso(sql, e.turnoId))!;
    const ok = await recibirTurno(sql, e.otraRecepcion, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "100", cajon: "2300" }, aclaracion: "", apoyo: NADIE }, PRUEBAS);
    expect(ok).toMatchObject({ ok: true, resultado: "confirmada" });
    const d = (await detalleDiferencias(sql, e.admin, e.codigo, r.entregaId))!;
    expect(d.lugares.bolsa_visitas.esperado).toBe("100.00");
    expect(d.desglose).toMatchObject({ retiros: { cuantos: 1, importe: "-800.00" }, calculado: "100.00" });
    expect(d.diferencias).toHaveLength(0);
  });

  it("dos depósitos al mismo tiempo no superan el saldo del folio", async () => {
    const e = await escenario();
    const id = await retirar(e, "bolsa_visitas", "900", "100", "B-15");
    await confirmar(e, id, "800");
    const [a, b] = await Promise.all([depositar(e, id, "500", "DEP-A"), depositar(e, id, "500", "DEP-B")]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toEqual({ ok: false, error: "excede" });
    expect((await sql`select sum(importe)::text as s from deposito_retiro where retiro_id = ${id}`)[0].s).toBe("500.00");
  });

  it("los registros no se editan ni se borran", async () => {
    const e = await escenario();
    const id = await retirar(e, "bolsa_visitas", "900", "100", "B-16");
    await expect(sql`update retiro set importe = 1 where id = ${id}`).rejects.toThrow(/cambio no permitido/);
    await expect(sql`delete from retiro where id = ${id}`).rejects.toThrow();
    await confirmar(e, id, "800");
    await expect(sql`update retiro_conteo set importe = 1 where retiro_id = ${id}`).rejects.toThrow();
    await expect(sql`update retiro set estado = 'pendiente', version = version + 1 where id = ${id}`).rejects.toThrow(/cambio no permitido/);
  });
});

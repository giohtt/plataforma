import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolverCancelacion, solicitarCancelacion } from "@/lib/cancelaciones";
import { detalleDiferencias, listaDiferencias, pendientesDeRevision, registrarCorreccion, resolverDiferencia, revisarDiferencia } from "@/lib/diferencias";
import { confirmarApoyo, entregaEnCurso, recibirTurno, registrarEntrega, type DeclaracionApoyo } from "@/lib/entregas";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { confirmarVisita, pantallaCobro } from "@/lib/visitas";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";
import { duplicarCobro } from "./duplicado";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;
let k = 0;
const PRUEBAS = { entorno: "pruebas" as const };
const NADIE = { hubo: false as const };

async function cuenta(asignaciones: [string, string][], facultad?: string) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Revisa " + n}, ${`revisa${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de diferencias')`;
  }
  if (facultad) {
    await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, todas_las_sucursales, limite_monto, motivo)
              values (${u.id}, 'autorizacion.devolucion', ${ids[facultad]}, false, 500, 'Prueba de diferencias (ficticia)')`;
  }
  return u.id;
}
async function cobrar(u: string, codigo: string) {
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, sucursal_alta_id) values (${"Ana Diferencia " + randomUUID().slice(0, 6)}, ${ids[codigo]}) returning id`;
  const p = await pantallaCobro(sql, u, codigo, "pruebas");
  if (!p.ok) throw new Error(p.error);
  const r = await confirmarVisita(sql, u, codigo, {
    clave: randomUUID(), turnoId: p.turnoId, visitanteIds: [v.id], formaPago: "efectivo", recibido: null, cambio: null,
    autorizacion: null, referencia: null, tipoReferencia: null, otraVenta: false,
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return r.operacionId;
}

/**
 * Sucursal nueva: abre con $200 en la bolsa y $1,200 en el cajón, cobra 3 visitas ($150), aparece un duplicado de $50
 * y Dirección aprueba su cancelación (−$50). La bolsa espera $350.
 */
async function escenario() {
  k++;
  const codigo = `D${k}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Sucursal diferencias " + k}, ${codigo}) returning id`;
  ids[codigo] = s.id;
  const sale = await cuenta([["recepcion", codigo]]);
  const entra = await cuenta([["recepcion", codigo]]);
  const encargado = await cuenta([["encargado", codigo]]);
  const admin = await cuenta([["administracion", codigo]]);
  const dir = await cuenta([["direccion", codigo]], codigo);
  const t = await abrirTurno(sql, sale, codigo, { bolsa: "200.00", cajon: "1200.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const ops = [await cobrar(sale, codigo), await cobrar(sale, codigo), await cobrar(sale, codigo)];
  const dup = await duplicarCobro(sql, ops[0]);
  const x = await solicitarCancelacion(sql, sale, codigo, dup, { conservaOperacionId: ops[0], explicacion: "Se capturó dos veces", sinDinero: true }, PRUEBAS);
  if (!x.ok) throw new Error(x.error);
  const [{ version }] = await sql<{ version: number }[]>`select version from cancelacion_cobro where id = ${x.cancelacionId}`;
  const a = await resolverCancelacion(sql, dir, codigo, x.cancelacionId, { version, decision: "aprobar" }, PRUEBAS);
  if (!a.ok) throw new Error(a.error);
  return { codigo, sale, entra, encargado, admin, dir, turnoId: t.turnoId };
}
type Esc = Awaited<ReturnType<typeof escenario>>;

async function cambio(e: Esc, entregado: string, inicial: string, final = inicial) {
  const r = await registrarEntrega(sql, e.sale, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: entregado, cajon: "1200" }, recibe: e.entra, nota: "", apoyo: NADIE }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  let x = (await entregaEnCurso(sql, e.turnoId))!;
  let ok = await recibirTurno(sql, e.entra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: inicial, cajon: "1200" }, aclaracion: "", apoyo: NADIE }, PRUEBAS);
  if (ok.ok && ok.resultado === "recuento") {
    x = (await entregaEnCurso(sql, e.turnoId))!;
    ok = await recibirTurno(sql, e.entra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: final, cajon: "1200" }, aclaracion: "Recontamos juntas", apoyo: NADIE }, PRUEBAS);
  }
  if (!ok.ok || ok.resultado !== "confirmada") throw new Error(JSON.stringify(ok));
  return { entregaId: r.entregaId, turnoNuevo: ok.turnoId };
}

describe.skipIf(!URL_ADMIN)("diferencias de efectivo: lista y desglose del saldo esperado", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("caso como el de Tenango: esperado, entregado y recibido por separado, −$50 contra el esperado y $0 entre personas", async () => {
    const e = await escenario();
    const { entregaId, turnoNuevo } = await cambio(e, "300", "300");
    const d = await detalleDiferencias(sql, e.encargado, e.codigo, entregaId);
    expect(d).toMatchObject({
      participaste: false,
      lugares: {
        bolsa_visitas: { esperado: "350.00", entregado: "300.00", inicial: "300.00", confirmado: "300.00" },
        cajon_mensualidades: { esperado: null, entregado: "1200.00", confirmado: "1200.00" },
      },
      diferencias: [{ lugar: "bolsa_visitas", tipo: "contra_esperado", importe: "-50.00", estado: "por_revisar", revision: null }],
      desglose: {
        contadoAlAbrir: "200.00", cobros: { cuantos: 4, visitas: 4, importe: "200.00" },
        cancelaciones: { cuantas: 1, importe: "-50.00" }, calculado: "350.00",
      },
    });
    // Lo que no entra a la bolsa se muestra aparte (aquí no hay tarjeta ni transferencias).
    expect(d!.fueraDeLaBolsa.tarjeta.importe).toBe("0.00");
    // Consultar no cambia nada: el turno siguiente sigue abriendo con lo que confirmó la entrante.
    expect((await estadoTurno(sql, e.entra, e.codigo))!.turno).toMatchObject({ id: turnoNuevo, lugares: [{ contadoAlAbrir: "300.00" }, { contadoAlAbrir: "1200.00" }] });
  });

  it("tres cantidades distintas: −$30 contra el esperado y −$20 entre personas, cada una aparte; la lista pone primero los casos por revisar", async () => {
    const e = await escenario();
    const sinDif = await cambio(e, "350", "350");
    // Segundo cambio, ya del turno de la entrante: entrega $320 de $350 y la siguiente confirma $300 tras recontar.
    const otra = await cuenta([["recepcion", e.codigo]]);
    const t2 = (await estadoTurno(sql, e.entra, e.codigo))!.turno!.id;
    const r = await registrarEntrega(sql, e.entra, e.codigo, { turnoId: t2, conteo: { bolsa: "320", cajon: "1200" }, recibe: otra, nota: "", apoyo: NADIE }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    let x = (await entregaEnCurso(sql, t2))!;
    await recibirTurno(sql, otra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "300", cajon: "1200" }, aclaracion: "", apoyo: NADIE }, PRUEBAS);
    x = (await entregaEnCurso(sql, t2))!;
    await recibirTurno(sql, otra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "300", cajon: "1200" }, aclaracion: "Recontamos juntas", apoyo: NADIE }, PRUEBAS);

    const d = await detalleDiferencias(sql, e.admin, e.codigo, r.entregaId);
    expect(d).toMatchObject({
      lugares: { bolsa_visitas: { esperado: "350.00", entregado: "320.00", inicial: "300.00", confirmado: "300.00" } },
      diferencias: [
        { lugar: "bolsa_visitas", tipo: "contra_esperado", importe: "-30.00" },
        { lugar: "bolsa_visitas", tipo: "entre_personas", importe: "-20.00" },
      ],
      desglose: { contadoAlAbrir: "350.00", cobros: { cuantos: 0 }, calculado: "350.00" },
    });
    const l = await listaDiferencias(sql, e.encargado, e.codigo);
    expect(l!.casos.map((c) => [c.entregaId, c.pendientes])).toEqual([[r.entregaId, 2], [sinDif.entregaId, 0]]);
    expect(await pendientesDeRevision(sql, e.encargado, ids[e.codigo])).toBe(2);
  });

  it("consultan Encargado, Administración y Dirección de la sucursal; Recepción y otras sucursales no; se avisa a quien participó", async () => {
    const e = await escenario();
    const otra = await escenario();
    const { entregaId } = await cambio(e, "300", "300");
    for (const u of [e.encargado, e.admin, e.dir]) expect(await detalleDiferencias(sql, u, e.codigo, entregaId)).not.toBeNull();
    for (const u of [e.sale, e.entra, otra.encargado, otra.admin]) {
      expect(await detalleDiferencias(sql, u, e.codigo, entregaId)).toBeNull();
      expect(await listaDiferencias(sql, u, e.codigo)).toBeNull();
    }
    expect(await pendientesDeRevision(sql, e.sale, ids[e.codigo])).toBeNull();
    // Una entrega de otra sucursal no se ve con el código de esta.
    expect(await detalleDiferencias(sql, otra.encargado, otra.codigo, entregaId)).toBeNull();
    expect(await detalleDiferencias(sql, e.encargado, e.codigo, "no-es-un-id")).toBeNull();

    // Quien también es Encargado y participó en la entrega ve el aviso.
    const ambos = await escenario();
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${ambos.sale}, 'encargado', ${ids[ambos.codigo]}, 'Prueba de participación')`;
    const c = await cambio(ambos, "350", "350");
    expect(await detalleDiferencias(sql, ambos.sale, ambos.codigo, c.entregaId)).toMatchObject({ participaste: true });
  });

  const revisar = (u: string, codigo: string, diferenciaId: string, resultado: string, motivo = "Diferencia simulada a propósito en la prueba") =>
    revisarDiferencia(sql, u, codigo, { diferenciaId, resultado, motivo }, PRUEBAS);
  const difsDe = async (u: string, codigo: string, entregaId: string) => (await detalleDiferencias(sql, u, codigo, entregaId))!.diferencias;

  describe("resultado de la revisión", () => {
    it("Encargado aclara el −$50 con motivo: queda en el historial con cuenta, fecha y hora, y no cambia ningún importe", async () => {
      const e = await escenario();
      const { entregaId, turnoNuevo } = await cambio(e, "300", "300");
      const [d] = await difsDe(e.encargado, e.codigo, entregaId);
      expect(await revisar(e.encargado, e.codigo, d.id, "aclarada", "no")).toEqual({ ok: false, error: "motivo" });
      expect(await revisar(e.encargado, e.codigo, d.id, "sobrante_confirmado")).toEqual({ ok: false, error: "resultado" });
      expect(await revisar(e.encargado, e.codigo, d.id, "aclarada", "Diferencia simulada a propósito en la prueba del 11 de noviembre")).toEqual({ ok: true, entregaId });
      const c = (await detalleDiferencias(sql, e.admin, e.codigo, entregaId))!;
      const [{ nombre }] = await sql<{ nombre: string }[]>`select nombre from usuario where id = ${e.encargado}`;
      expect(c.diferencias[0]).toMatchObject({
        importe: "-50.00", estado: "aclarada",
        revision: { resultado: "aclarada", nivel: "encargado", motivo: "Diferencia simulada a propósito en la prueba del 11 de noviembre", revisadaPor: nombre },
      });
      expect(c.diferencias[0].revision!.en).toBeInstanceOf(Date);
      expect(c.historial.at(-1)).toMatchObject({ cuenta: nombre, que: expect.stringContaining("Aclarada") });
      // Los importes y el saldo de apertura del turno siguiente se conservan.
      expect(c.lugares.bolsa_visitas).toEqual({ esperado: "350.00", entregado: "300.00", inicial: "300.00", confirmado: "300.00" });
      expect((await estadoTurno(sql, e.entra, e.codigo))!.turno).toMatchObject({ id: turnoNuevo, lugares: [{ contadoAlAbrir: "300.00" }, { contadoAlAbrir: "1200.00" }] });
      // No se revisa dos veces.
      expect(await revisar(e.encargado, e.codigo, d.id, "faltante_confirmado")).toEqual({ ok: false, error: "ya_revisada" });
      expect(await pendientesDeRevision(sql, e.encargado, ids[e.codigo])).toBe(0);
    });

    it("−$30 contra el esperado y +$30 en la entrega: neto $0, pero dos diferencias pendientes que se revisan por separado", async () => {
      const e = await escenario();
      const { entregaId } = await cambio(e, "320", "330", "350");
      const l = await listaDiferencias(sql, e.encargado, e.codigo);
      expect(l!.casos[0]).toMatchObject({ entregaId, pendientes: 2, paraDireccion: 0, neto: "0.00" });
      const difs = await difsDe(e.encargado, e.codigo, entregaId);
      expect(difs.map((d) => [d.tipo, d.importe, d.estado])).toEqual([
        ["contra_esperado", "-30.00", "por_revisar"], ["entre_personas", "30.00", "por_revisar"],
      ]);
      // Faltante: Aclarada o Faltante confirmado. Sobrante: Aclarada o Sobrante confirmado.
      const [falta, sobra] = difs;
      expect(await revisar(e.encargado, e.codigo, sobra.id, "faltante_confirmado")).toEqual({ ok: false, error: "resultado" });
      expect(await revisar(e.encargado, e.codigo, falta.id, "faltante_confirmado", "Faltan $30 del turno; no se encontró el origen")).toMatchObject({ ok: true });
      expect((await listaDiferencias(sql, e.encargado, e.codigo))!.casos[0]).toMatchObject({ pendientes: 1, paraDireccion: 1 });
      expect(await revisar(e.encargado, e.codigo, sobra.id, "sobrante_confirmado", "Sobran $30 en la entrega; queda para Dirección")).toMatchObject({ ok: true });
      const despues = await difsDe(e.encargado, e.codigo, entregaId);
      expect(despues.map((d) => d.estado)).toEqual(["faltante_confirmado", "sobrante_confirmado"]);
      expect((await listaDiferencias(sql, e.encargado, e.codigo))!.casos[0]).toMatchObject({ pendientes: 0, paraDireccion: 2 });
      // El turno siguiente abre con lo que confirmó la entrante ($350), no con lo entregado.
      expect((await estadoTurno(sql, e.entra, e.codigo))!.turno!.lugares[0].contadoAlAbrir).toBe("350.00");
    });

    it("quién revisa según su participación: Encargado; si participó un Encargado, Administración; si participó Administración, Dirección", async () => {
      // Sin Encargado ni Administración entre quienes participaron: revisa Encargado; Administración y Dirección, no.
      const a = await escenario();
      const ca = await cambio(a, "300", "300");
      const [da] = await difsDe(a.encargado, a.codigo, ca.entregaId);
      expect(await detalleDiferencias(sql, a.encargado, a.codigo, ca.entregaId)).toMatchObject({ nivel: "encargado", puedeRevisar: true });
      expect(await revisar(a.admin, a.codigo, da.id, "aclarada")).toEqual({ ok: false, error: "otro_nivel" });
      expect(await revisar(a.dir, a.codigo, da.id, "aclarada")).toEqual({ ok: false, error: "otro_nivel" });
      expect(await revisar(a.sale, a.codigo, da.id, "aclarada")).toEqual({ ok: false, error: "no_encontrada" });

      // Quien entregó también es Encargado: revisa Administración; el otro Encargado, no; quien participó, nunca.
      const b = await escenario();
      await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${b.sale}, 'encargado', ${ids[b.codigo]}, 'Prueba de participación')`;
      const cb = await cambio(b, "300", "300");
      const [db] = await difsDe(b.admin, b.codigo, cb.entregaId);
      expect(await detalleDiferencias(sql, b.encargado, b.codigo, cb.entregaId)).toMatchObject({ nivel: "administracion", puedeRevisar: false });
      expect(await revisar(b.sale, b.codigo, db.id, "aclarada")).toEqual({ ok: false, error: "participaste" });
      expect(await revisar(b.encargado, b.codigo, db.id, "aclarada")).toEqual({ ok: false, error: "otro_nivel" });
      expect(await revisar(b.admin, b.codigo, db.id, "aclarada")).toMatchObject({ ok: true });

      // Quien recibió también es Administración: revisa Dirección.
      const c = await escenario();
      await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${c.entra}, 'administracion', ${ids[c.codigo]}, 'Prueba de participación')`;
      const cc = await cambio(c, "300", "300");
      const [dc] = await difsDe(c.dir, c.codigo, cc.entregaId);
      expect(await revisar(c.admin, c.codigo, dc.id, "aclarada")).toEqual({ ok: false, error: "otro_nivel" });
      expect(await revisar(c.entra, c.codigo, dc.id, "aclarada")).toEqual({ ok: false, error: "participaste" });
      expect(await revisar(c.dir, c.codigo, dc.id, "faltante_confirmado")).toMatchObject({ ok: true });
      expect((await difsDe(c.dir, c.codigo, cc.entregaId))[0]).toMatchObject({ estado: "faltante_confirmado", revision: { nivel: "direccion" } });
    });

    it("dos revisiones simultáneas: solo una queda; la base respalda las reglas y no deja editar ni borrar una revisión", async () => {
      const e = await escenario();
      const { entregaId } = await cambio(e, "300", "300");
      const otroEncargado = await cuenta([["encargado", e.codigo]]);
      const [d] = await difsDe(e.encargado, e.codigo, entregaId);
      const [x, y] = await Promise.all([revisar(e.encargado, e.codigo, d.id, "aclarada"), revisar(otroEncargado, e.codigo, d.id, "faltante_confirmado")]);
      expect([x, y].filter((r) => r.ok)).toHaveLength(1);
      expect([x, y].find((r) => !r.ok)).toEqual({ ok: false, error: "ya_revisada" });
      await expect(sql`update revision_diferencia set motivo = 'Otro motivo de prueba' where diferencia_id = ${d.id}`).rejects.toThrow();
      await expect(sql`delete from revision_diferencia where diferencia_id = ${d.id}`).rejects.toThrow();
      // Directo en la base: nivel equivocado, o quien participó, se rechazan.
      const f = await escenario();
      const cf = await cambio(f, "300", "300");
      const [df] = await difsDe(f.encargado, f.codigo, cf.entregaId);
      await expect(sql`insert into revision_diferencia (diferencia_id, resultado, motivo, nivel, revisada_por)
                       values (${df.id}, 'aclarada', 'Intento de prueba', 'administracion', ${f.admin})`).rejects.toThrow(/otro perfil/);
      await expect(sql`insert into revision_diferencia (diferencia_id, resultado, motivo, nivel, revisada_por)
                       values (${df.id}, 'aclarada', 'Intento de prueba', 'encargado', ${f.sale})`).rejects.toThrow(/participó/);
      expect(await revisarDiferencia(sql, f.encargado, f.codigo, { diferenciaId: df.id, resultado: "aclarada", motivo: "Prueba ficticia" }, { entorno: "produccion" }))
        .toEqual({ ok: false, error: "bloqueado_produccion" });
    });
  });

  describe("apoyo en el conteo y el recuento (opción B)", () => {
    /** Cambio con recuento: la saliente entrega $320 de $350, la entrante cuenta $300, recuentan y confirma $300. */
    async function cambioConRecuento(e: Esc, apoyos: { entrega?: DeclaracionApoyo; recepcion?: DeclaracionApoyo; recuento?: DeclaracionApoyo } = {}) {
      const r = await registrarEntrega(sql, e.sale, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "320", cajon: "1200" }, recibe: e.entra, nota: "", apoyo: apoyos.entrega ?? NADIE }, PRUEBAS);
      if (!r.ok) throw new Error(r.error);
      let x = (await entregaEnCurso(sql, e.turnoId))!;
      const a = await recibirTurno(sql, e.entra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "300", cajon: "1200" }, aclaracion: "", apoyo: apoyos.recepcion ?? NADIE }, PRUEBAS);
      expect(a).toEqual({ ok: true, resultado: "recuento" });
      x = (await entregaEnCurso(sql, e.turnoId))!;
      const b = await recibirTurno(sql, e.entra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "300", cajon: "1200" }, aclaracion: "Recontamos con ayuda", apoyo: apoyos.recuento ?? NADIE }, PRUEBAS);
      if (!b.ok || b.resultado !== "confirmada") throw new Error(JSON.stringify(b));
      return { entregaId: r.entregaId, turnoNuevo: b.turnoId };
    }
    const nombre = async (id: string) => (await sql<{ nombre: string }[]>`select nombre from usuario where id = ${id}`)[0].nombre;

    it("una Encargada declarada como apoyo en el recuento queda bloqueada antes y después de confirmar, y el caso pasa a Administración", async () => {
      const e = await escenario();
      const otraEncargada = await cuenta([["encargado", e.codigo]]);
      const { entregaId, turnoNuevo } = await cambioConRecuento(e, { recuento: { hubo: true, personas: [e.encargado] } });
      // La entrega se completó y el turno siguiente abrió con lo que confirmó la entrante, aunque el apoyo siga pendiente.
      expect((await estadoTurno(sql, e.entra, e.codigo))!.turno).toMatchObject({ id: turnoNuevo, lugares: [{ contadoAlAbrir: "300.00" }, { contadoAlAbrir: "1200.00" }] });

      const difs = await difsDe(e.admin, e.codigo, entregaId);
      expect(difs.map((d) => [d.tipo, d.importe])).toEqual([["contra_esperado", "-30.00"], ["entre_personas", "-20.00"]]);
      const antes = (await detalleDiferencias(sql, e.encargado, e.codigo, entregaId))!;
      expect(antes).toMatchObject({ participaste: true, nivel: "administracion", puedeRevisar: false });
      expect(antes.apoyos).toEqual([
        expect.objectContaining({ etapa: "conteo_entrega", estado: "nadie" }),
        expect.objectContaining({ etapa: "conteo_recepcion", estado: "nadie" }),
        expect.objectContaining({ etapa: "recuento", estado: "con_apoyo", declaradoPor: await nombre(e.entra), personas: [{ nombre: await nombre(e.encargado), confirmadoEn: null }] }),
      ]);
      // Antes de confirmar: la Encargada declarada no revisa; la otra Encargada tampoco (le toca a Administración).
      expect(await revisar(e.encargado, e.codigo, difs[0].id, "aclarada")).toEqual({ ok: false, error: "participaste" });
      expect(await revisar(otraEncargada, e.codigo, difs[0].id, "aclarada")).toEqual({ ok: false, error: "otro_nivel" });

      // Confirma desde su propia cuenta; nadie más puede confirmar por ella.
      const [apoyo] = await sql<{ id: string }[]>`select id from apoyo_conteo where entrega_id = ${entregaId}`;
      expect(await confirmarApoyo(sql, otraEncargada, e.codigo, apoyo.id, PRUEBAS)).toEqual({ ok: false, error: "no_encontrada" });
      expect(await confirmarApoyo(sql, e.encargado, e.codigo, apoyo.id, PRUEBAS)).toEqual({ ok: true });
      expect(await confirmarApoyo(sql, e.encargado, e.codigo, apoyo.id, PRUEBAS)).toEqual({ ok: false, error: "ya_confirmado" });

      // Después de confirmar: sigue bloqueada; revisa Administración.
      expect(await revisar(e.encargado, e.codigo, difs[0].id, "aclarada")).toEqual({ ok: false, error: "participaste" });
      expect(await revisar(otraEncargada, e.codigo, difs[0].id, "aclarada")).toEqual({ ok: false, error: "otro_nivel" });
      expect(await revisar(e.admin, e.codigo, difs[0].id, "aclarada", "La Encargada ayudó a recontar; se encontró el faltante")).toMatchObject({ ok: true });
      const despues = (await detalleDiferencias(sql, e.admin, e.codigo, entregaId))!;
      expect(despues.apoyos[2].personas[0].confirmadoEn).toBeInstanceOf(Date);
      // Historial: quién declaró, a quién, en qué etapa, cuándo se declaró y cuándo confirmó.
      const textos = despues.historial.map((h) => `${h.que} · ${h.cuenta}`);
      expect(textos).toEqual(expect.arrayContaining([
        `Apoyo declarado en el recuento: ${await nombre(e.encargado)} · ${await nombre(e.entra)}`,
        `Apoyo confirmado en el recuento · ${await nombre(e.encargado)}`,
      ]));
      // Revisar y confirmar no cambiaron importes ni el saldo de apertura.
      expect(despues.lugares.bolsa_visitas).toEqual({ esperado: "350.00", entregado: "320.00", inicial: "300.00", confirmado: "300.00" });
      expect((await estadoTurno(sql, e.entra, e.codigo))!.turno!.lugares[0].contadoAlAbrir).toBe("300.00");
    });

    it("una Encargada ajena al conteo revisa un caso que le corresponde a su nivel («nadie más participó»)", async () => {
      const e = await escenario();
      const { entregaId } = await cambioConRecuento(e);
      const c = (await detalleDiferencias(sql, e.encargado, e.codigo, entregaId))!;
      expect(c).toMatchObject({ participaste: false, nivel: "encargado", puedeRevisar: true });
      expect(c.apoyos.map((a) => a.estado)).toEqual(["nadie", "nadie", "nadie"]);
      expect(await revisar(e.encargado, e.codigo, c.diferencias[0].id, "aclarada")).toMatchObject({ ok: true });
    });

    it("el apoyo debe ser de la sucursal y no puede ser quien entrega o recibe; si es inválido no se guarda nada", async () => {
      const e = await escenario();
      const otra = await escenario();
      const entregar = (apoyo: DeclaracionApoyo) =>
        registrarEntrega(sql, e.sale, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: "350", cajon: "1200" }, recibe: e.entra, nota: "", apoyo }, PRUEBAS);
      expect(await entregar({ hubo: true, personas: [] })).toEqual({ ok: false, error: "apoyo" });
      expect(await entregar({ hubo: true, personas: [otra.encargado] })).toEqual({ ok: false, error: "apoyo" });
      expect(await entregar({ hubo: true, personas: [e.entra] })).toEqual({ ok: false, error: "apoyo" });
      expect(await entregar({ hubo: true, personas: [e.sale] })).toEqual({ ok: false, error: "apoyo" });
      expect(await entregaEnCurso(sql, e.turnoId)).toBeNull();
      expect(await entregar({ hubo: true, personas: [e.encargado, e.admin] })).toMatchObject({ ok: true });
      // Administración declarada como apoyo: el caso pasa a Dirección.
      const x = (await entregaEnCurso(sql, e.turnoId))!;
      await recibirTurno(sql, e.entra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "350", cajon: "1200" }, aclaracion: "", apoyo: NADIE }, PRUEBAS);
      expect(await detalleDiferencias(sql, e.dir, e.codigo, x.id)).toMatchObject({ nivel: "direccion", participaste: false });
      expect(await detalleDiferencias(sql, e.admin, e.codigo, x.id)).toMatchObject({ participaste: true });
      // La base no deja deshacer una confirmación ni borrar un apoyo.
      const [a] = await sql<{ id: string }[]>`select id from apoyo_conteo where entrega_id = ${x.id} and usuario_id = ${e.encargado}`;
      await confirmarApoyo(sql, e.encargado, e.codigo, a.id, PRUEBAS);
      await expect(sql`update apoyo_conteo set confirmado_en = null where id = ${a.id}`).rejects.toThrow();
      await expect(sql`delete from apoyo_conteo where id = ${a.id}`).rejects.toThrow();
    });

    it("entregas anteriores a este registro: «sin registro de apoyo», distinto de «nadie más participó»", async () => {
      const e = await escenario();
      const { entregaId } = await cambio(e, "300", "300");
      // Simula una entrega de antes de la migración 0023: sin declaraciones (solo posible quitando la protección en la prueba).
      await sql.begin(async (tx) => {
        await tx`alter table declaracion_apoyo disable trigger declaracion_apoyo_inmutable`;
        await tx`delete from declaracion_apoyo where entrega_id = ${entregaId}`;
        await tx`alter table declaracion_apoyo enable trigger declaracion_apoyo_inmutable`;
      });
      const c = (await detalleDiferencias(sql, e.encargado, e.codigo, entregaId))!;
      expect(c.apoyos.map((a) => a.estado)).toEqual(["sin_registro", "sin_registro"]);
      expect(c).toMatchObject({ nivel: "encargado", puedeRevisar: true });
      const otro = await escenario();
      const d = await cambio(otro, "300", "300");
      expect((await detalleDiferencias(sql, otro.encargado, otro.codigo, d.entregaId))!.apoyos.map((a) => a.estado)).toEqual(["nadie", "nadie"]);
    });
  });

  describe("resolución de Dirección", () => {
    const resolver = (u: string, codigo: string, diferenciaId: string, decision: string, extra: { motivo?: string; origen?: string; requiereCorreccion?: boolean } = {}) =>
      resolverDiferencia(sql, u, codigo, { diferenciaId, decision, motivo: extra.motivo ?? "Decisión de Dirección en la prueba", origen: extra.origen, requiereCorreccion: extra.requiereCorreccion }, PRUEBAS);

    it("faltante confirmado: «Lo absorbe la sucursal» con motivo cierra el seguimiento; importes y apertura se conservan", async () => {
      const e = await escenario();
      const { entregaId, turnoNuevo } = await cambio(e, "300", "300");
      const [d] = await difsDe(e.encargado, e.codigo, entregaId);
      // Antes de confirmar el faltante, Dirección no resuelve.
      expect(await resolver(e.dir, e.codigo, d.id, "absorbe_sucursal")).toEqual({ ok: false, error: "no_pendiente" });
      await revisar(e.encargado, e.codigo, d.id, "faltante_confirmado", "No apareció tras recontar");
      expect((await difsDe(e.dir, e.codigo, entregaId))[0]).toMatchObject({ estado: "faltante_confirmado", pendienteDireccionDesde: expect.any(Date) });
      expect(await pendientesDeRevision(sql, e.dir, ids[e.codigo])).toBe(1);
      expect(await pendientesDeRevision(sql, e.encargado, ids[e.codigo])).toBe(0);
      // Solo Dirección; motivo obligatorio; decisión acorde al faltante.
      expect(await resolver(e.admin, e.codigo, d.id, "absorbe_sucursal")).toEqual({ ok: false, error: "sin_permiso" });
      expect(await resolver(e.dir, e.codigo, d.id, "absorbe_sucursal", { motivo: "no" })).toEqual({ ok: false, error: "motivo" });
      expect(await resolver(e.dir, e.codigo, d.id, "queda_en_bolsa")).toEqual({ ok: false, error: "decision" });
      expect(await resolver(e.dir, e.codigo, d.id, "absorbe_sucursal", { motivo: "Monto menor; se absorbe como pérdida de la sucursal" })).toEqual({ ok: true, entregaId });
      expect(await resolver(e.dir, e.codigo, d.id, "absorbe_sucursal")).toEqual({ ok: false, error: "ya_resuelta" });
      const c = (await detalleDiferencias(sql, e.dir, e.codigo, entregaId))!;
      const nombreDir = (await sql<{ nombre: string }[]>`select nombre from usuario where id = ${e.dir}`)[0].nombre;
      expect(c.diferencias[0]).toMatchObject({
        estado: "resuelta", pendienteDireccionDesde: null,
        resolucion: { decision: "absorbe_sucursal", motivo: "Monto menor; se absorbe como pérdida de la sucursal", resueltaPor: nombreDir, correccion: null },
      });
      expect(c.historial.map((h) => h.que)).toEqual(expect.arrayContaining([
        expect.stringContaining("Resolución de Dirección (bolsa, −$50.00 contra el esperado): Lo absorbe la sucursal"),
        "Seguimiento cerrado (bolsa, −$50.00 contra el esperado)",
      ]));
      expect(c.lugares.bolsa_visitas).toEqual({ esperado: "350.00", entregado: "300.00", inicial: "300.00", confirmado: "300.00" });
      expect((await estadoTurno(sql, e.entra, e.codigo))!.turno).toMatchObject({ id: turnoNuevo, lugares: [{ contadoAlAbrir: "300.00" }, { contadoAlAbrir: "1200.00" }] });
      expect(await pendientesDeRevision(sql, e.dir, ids[e.codigo])).toBe(0);
      expect((await listaDiferencias(sql, e.dir, e.codigo))!.casos[0]).toMatchObject({ pendientes: 0, paraDireccion: 0 });
    });

    it("sobrante confirmado: «Se queda en la bolsa» cierra; «Origen identificado» cierra sin corrección o queda abierto hasta registrarla", async () => {
      const sobrante = async () => {
        const e = await escenario();
        const { entregaId } = await cambio(e, "400", "400");
        const [d] = await difsDe(e.encargado, e.codigo, entregaId);
        expect(d.importe).toBe("50.00");
        await revisar(e.encargado, e.codigo, d.id, "sobrante_confirmado", "No se encontró de dónde salió");
        return { e, entregaId, d };
      };
      const a = await sobrante();
      expect(await resolver(a.e.dir, a.e.codigo, a.d.id, "absorbe_sucursal")).toEqual({ ok: false, error: "decision" });
      expect(await resolver(a.e.dir, a.e.codigo, a.d.id, "queda_en_bolsa")).toMatchObject({ ok: true });
      expect((await difsDe(a.e.dir, a.e.codigo, a.entregaId))[0].estado).toBe("resuelta");

      const b = await sobrante();
      expect(await resolver(b.e.dir, b.e.codigo, b.d.id, "origen_identificado")).toEqual({ ok: false, error: "origen" });
      expect(await resolver(b.e.dir, b.e.codigo, b.d.id, "origen_identificado", { origen: "Propina de un visitante guardada en la bolsa", requiereCorreccion: false })).toMatchObject({ ok: true });
      expect((await difsDe(b.e.dir, b.e.codigo, b.entregaId))[0]).toMatchObject({ estado: "resuelta", resolucion: { origen: "Propina de un visitante guardada en la bolsa", requiereCorreccion: false } });
      expect(await registrarCorreccion(sql, b.e.dir, b.e.codigo, { diferenciaId: b.d.id, correccion: "No aplica en esta prueba" }, PRUEBAS)).toEqual({ ok: false, error: "no_pendiente" });

      const c = await sobrante();
      expect(await resolver(c.e.dir, c.e.codigo, c.d.id, "origen_identificado", { origen: "Una visita cobrada sin registrar", requiereCorreccion: true })).toMatchObject({ ok: true });
      let x = (await difsDe(c.e.dir, c.e.codigo, c.entregaId))[0];
      expect(x).toMatchObject({ estado: "correccion_pendiente", pendienteDireccionDesde: expect.any(Date) });
      expect(await pendientesDeRevision(sql, c.e.dir, ids[c.e.codigo])).toBe(1);
      expect(await registrarCorreccion(sql, c.e.admin, c.e.codigo, { diferenciaId: c.d.id, correccion: "Cobro regularizado en la prueba" }, PRUEBAS)).toEqual({ ok: false, error: "sin_permiso" });
      expect(await registrarCorreccion(sql, c.e.dir, c.e.codigo, { diferenciaId: c.d.id, correccion: "no" }, PRUEBAS)).toEqual({ ok: false, error: "correccion" });
      expect(await registrarCorreccion(sql, c.e.dir, c.e.codigo, { diferenciaId: c.d.id, correccion: "Visita registrada a la ficha ficticia; cobro regularizado" }, PRUEBAS)).toMatchObject({ ok: true });
      x = (await difsDe(c.e.dir, c.e.codigo, c.entregaId))[0];
      expect(x).toMatchObject({ estado: "resuelta", resolucion: { correccion: { texto: "Visita registrada a la ficha ficticia; cobro regularizado" } } });
      const h = (await detalleDiferencias(sql, c.e.dir, c.e.codigo, c.entregaId))!.historial.map((e) => e.que);
      expect(h.slice(-3)).toEqual([
        expect.stringContaining("Origen identificado. Origen: «Una visita cobrada sin registrar» · corrección pendiente"),
        "Corrección registrada (bolsa, +$50.00 contra el esperado): «Visita registrada a la ficha ficticia; cobro regularizado»",
        "Seguimiento cerrado (bolsa, +$50.00 contra el esperado)",
      ]);
      // La base no deja cambiar la decisión ni borrar la resolución.
      await expect(sql`update resolucion_diferencia set motivo = 'Otro motivo' where diferencia_id = ${c.d.id}`).rejects.toThrow();
      await expect(sql`delete from resolucion_diferencia where diferencia_id = ${c.d.id}`).rejects.toThrow();
    });

    it("tiempo pendiente: más de 48 horas se marca; quien participó no resuelve; en producción no se registra", async () => {
      const e = await escenario();
      const { entregaId } = await cambio(e, "300", "300");
      const [d] = await difsDe(e.encargado, e.codigo, entregaId);
      await revisar(e.encargado, e.codigo, d.id, "faltante_confirmado");
      // Simula una revisión de hace 49 horas (solo posible quitando la protección en la prueba).
      await sql.begin(async (tx) => {
        await tx`alter table revision_diferencia disable trigger revision_diferencia_inmutable`;
        await tx`update revision_diferencia set en = now() - interval '49 hours' where diferencia_id = ${d.id}`;
        await tx`alter table revision_diferencia enable trigger revision_diferencia_inmutable`;
      });
      const { tiempoPendiente } = await import("@/lib/datos-diferencia");
      const x = (await difsDe(e.dir, e.codigo, entregaId))[0];
      expect(tiempoPendiente(x.pendienteDireccionDesde!)).toEqual({ texto: "2 días 1 h", masDe48: true });
      expect(tiempoPendiente(new Date(Date.now() - 47 * 3_600_000))).toEqual({ texto: "1 día 23 h", masDe48: false });
      // Dirección que participó en la entrega no resuelve.
      await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${e.entra}, 'direccion', ${ids[e.codigo]}, 'Prueba de participación')`;
      expect(await resolver(e.entra, e.codigo, d.id, "absorbe_sucursal")).toEqual({ ok: false, error: "participaste" });
      expect(await resolverDiferencia(sql, e.dir, e.codigo, { diferenciaId: d.id, decision: "absorbe_sucursal", motivo: "Prueba ficticia" }, { entorno: "produccion" }))
        .toEqual({ ok: false, error: "bloqueado_produccion" });
    });
  });
});

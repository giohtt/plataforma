import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolverCancelacion, solicitarCancelacion } from "@/lib/cancelaciones";
import { detalleDiferencias, listaDiferencias, pendientesDeRevision, revisarDiferencia } from "@/lib/diferencias";
import { entregaEnCurso, recibirTurno, registrarEntrega } from "@/lib/entregas";
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
  const r = await registrarEntrega(sql, e.sale, e.codigo, { turnoId: e.turnoId, conteo: { bolsa: entregado, cajon: "1200" }, recibe: e.entra, nota: "" }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  let x = (await entregaEnCurso(sql, e.turnoId))!;
  let ok = await recibirTurno(sql, e.entra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: inicial, cajon: "1200" }, aclaracion: "" }, PRUEBAS);
  if (ok.ok && ok.resultado === "recuento") {
    x = (await entregaEnCurso(sql, e.turnoId))!;
    ok = await recibirTurno(sql, e.entra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: final, cajon: "1200" }, aclaracion: "Recontamos juntas" }, PRUEBAS);
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
    const r = await registrarEntrega(sql, e.entra, e.codigo, { turnoId: t2, conteo: { bolsa: "320", cajon: "1200" }, recibe: otra, nota: "" }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    let x = (await entregaEnCurso(sql, t2))!;
    await recibirTurno(sql, otra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "300", cajon: "1200" }, aclaracion: "" }, PRUEBAS);
    x = (await entregaEnCurso(sql, t2))!;
    await recibirTurno(sql, otra, e.codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "300", cajon: "1200" }, aclaracion: "Recontamos juntas" }, PRUEBAS);

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
});

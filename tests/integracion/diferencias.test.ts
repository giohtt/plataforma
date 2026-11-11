import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolverCancelacion, solicitarCancelacion } from "@/lib/cancelaciones";
import { detalleDiferencias, listaDiferencias, pendientesDeRevision } from "@/lib/diferencias";
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
      diferencias: [{ lugar: "bolsa_visitas", tipo: "contra_esperado", importe: "-50.00", estado: "por_revisar" }],
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
});

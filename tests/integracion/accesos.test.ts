import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accesosDelCobro, completarMotivo, pantallaAccesos, pedirAutorizacion, registrarAcceso, registrarSinPase, resolverAutorizacion,
  revisionAccesos,
} from "@/lib/accesos";
import { marcarNoLocalizado } from "@/lib/abonos";
import { abrirTurno, estadoTurno } from "@/lib/turnos";
import { ventasDelTurno } from "@/lib/ventas";
import { cobrosDelTurno, confirmarVisita, pantallaCobro, visitasDeHoy, type CobroDelTurno } from "@/lib/visitas";
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
    insert into usuario (nombre, correo, es_prueba) values (${"Accesos " + n}, ${`accesos${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de accesos')`;
  }
  return u.id;
}
async function fichas(k: number) {
  const r: string[] = [];
  for (let i = 0; i < k; i++) {
    const [v] = await sql<{ id: string }[]>`
      insert into visitante (nombre, telefono, sucursal_alta_id) values (${"Visitante " + randomUUID().slice(0, 6)}, '0000000601', ${ids.TEN}) returning id`;
    r.push(v.id);
  }
  return r;
}
let referencias = 0;
async function cobrar(u: string, codigo: string, visitantes: string[], formaPago: FormaPago = "efectivo") {
  const p = await pantallaCobro(sql, u, codigo, "pruebas");
  if (!p.ok) throw new Error(p.error);
  const r = await confirmarVisita(sql, u, codigo, {
    clave: randomUUID(), turnoId: p.turnoId, visitanteIds: visitantes, formaPago, recibido: null, cambio: null,
    autorizacion: formaPago === "tarjeta" ? "AUT123" : null,
    referencia: formaPago === "transferencia" ? `CLAVEACCESO${String(++referencias).padStart(4, "0")}` : null,
    tipoReferencia: formaPago === "transferencia" ? "clave_rastreo" : null, otraVenta: false,
  }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  return r.operacionId;
}
const pases = async (operacionId: string) =>
  (await sql<{ id: string }[]>`select id from pase_visita where operacion_id = ${operacionId} order by orden`).map((p) => p.id);
const entrar = (u: string, paseId: string, tipo: "entrada" | "reingreso" = "entrada", clave = randomUUID(), codigo = "TEN") =>
  registrarAcceso(sql, u, codigo, { clave, paseId, tipo }, PRUEBAS);
const aprobar = (u: string, id: string, version = 1, motivo = "Revisé el comprobante: misma clave e importe") =>
  resolverAutorizacion(sql, u, "TEN", id, { version, decision: "aprobar", motivo }, PRUEBAS);

describe.skipIf(!URL_ADMIN)("registro de accesos del piloto de Tenango", () => {
  let recep: string, recep2: string, encargado: string, admin: string, direccion: string, turnoId: string;

  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 6 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
    recep = await cuenta([["recepcion", "TEN"]]);
    recep2 = await cuenta([["recepcion", "TEN"]]);
    encargado = await cuenta([["encargado", "TEN"]]);
    admin = await cuenta([["administracion", "TEN"]]);
    [{ id: direccion }] = await sql<{ id: string }[]>`select id from usuario where correo = 'direccion@prueba.fitnessland.invalid'`;
    const t = await abrirTurno(sql, recep, "TEN", { bolsa: "0.00", cajon: "0.00" }, PRUEBAS);
    if (!t.ok) throw new Error(t.error);
    turnoId = t.turnoId;
  });
  afterAll(async () => cerrar?.());

  describe("con pase pagado", () => {
    it("cobro grupal: una entrada por persona, registrada por cualquier cuenta de Recepción; el cobro y la bolsa no cambian", async () => {
      const op = await cobrar(recep, "TEN", await fichas(3));
      const [p1, p2, p3] = await pases(op);
      const bolsaAntes = (await estadoTurno(sql, recep, "TEN"))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!.esperado;
      const ventasAntes = ventasDelTurno(await cobrosDelTurno(sql, turnoId)).totalConfirmado;

      const c = await accesosDelCobro(sql, recep2, "TEN", op);
      expect(c?.puedeRegistrar).toBe(true);
      expect(c?.pases.map((p) => p.accion)).toEqual(["entrada", "entrada", "entrada"]);

      // recep2 no es la responsable de la bolsa y sí registra.
      const clave = randomUUID();
      const a = await entrar(recep2, p1, "entrada", clave);
      expect(a).toMatchObject({ ok: true, repetido: false });
      expect(await entrar(recep2, p1, "entrada", clave)).toMatchObject({ ok: true, repetido: true });
      expect(await entrar(recep, p1)).toEqual({ ok: false, error: "ya_entro" });
      expect(await entrar(recep, p2, "reingreso")).toEqual({ ok: false, error: "sin_entrada" });
      expect(await entrar(recep, p2)).toMatchObject({ ok: true });

      const [fila] = await sql<{ registrado_por: string; turno_id: string; tipo: string }[]>`
        select registrado_por, turno_id, tipo from acceso where pase_id = ${p1}`;
      expect(fila).toEqual({ registrado_por: recep2, turno_id: turnoId, tipo: "entrada" });

      const d = await accesosDelCobro(sql, recep, "TEN", op);
      expect(d?.pases.map((p) => p.accion)).toEqual(["reingreso", "reingreso", "entrada"]);
      expect(d?.pases[2].paseId).toBe(p3);

      expect((await estadoTurno(sql, recep, "TEN"))!.turno!.lugares.find((l) => l.tipo === "bolsa_visitas")!.esperado).toBe(bolsaAntes);
      expect(ventasDelTurno(await cobrosDelTurno(sql, turnoId)).totalConfirmado).toEqual(ventasAntes);
    });

    it("reingreso el mismo día con el mismo pase, sin cobrar; la búsqueda indica el pase de hoy", async () => {
      const [ana] = await fichas(1);
      const op = await cobrar(recep, "TEN", [ana]);
      const [p] = await pases(op);
      expect(await visitasDeHoy(sql, recep, "TEN", [ana])).toEqual([{ id: ana, visitasHoy: 1, enEstaSucursal: true, paseAqui: { operacionId: op, entro: false } }]);
      expect(await entrar(recep, p)).toMatchObject({ ok: true });
      expect((await visitasDeHoy(sql, recep, "TEN", [ana]))![0].paseAqui).toEqual({ operacionId: op, entro: true });
      expect(await entrar(recep2, p, "reingreso")).toMatchObject({ ok: true });
      expect(await entrar(recep, p, "reingreso")).toMatchObject({ ok: true });
      const [{ cobros }] = await sql<{ cobros: number }[]>`
        select count(*)::int as cobros from pase_visita where visitante_id = ${ana}`;
      expect(cobros).toBe(1);
      const tipos = (await accesosDelCobro(sql, recep, "TEN", op))!.pases[0].accesos.map((a) => a.tipo);
      expect(tipos).toEqual(["entrada", "reingreso", "reingreso"]);
    });

    it("en otra sucursal necesita un pase nuevo; un pase de otro día ya no sirve", async () => {
      const [luis] = await fichas(1);
      const op = await cobrar(recep, "TEN", [luis]);
      const [p] = await pases(op);
      const recepStg = await cuenta([["recepcion", "STG"]]);
      const t = await abrirTurno(sql, recepStg, "STG", { bolsa: "0.00", cajon: "0.00" }, PRUEBAS);
      if (!t.ok) throw new Error(t.error);
      expect(await entrar(recepStg, p, "entrada", randomUUID(), "STG")).toEqual({ ok: false, error: "otra_sucursal" });
      expect(await entrar(recepStg, p, "entrada", randomUUID(), "TEN")).toEqual({ ok: false, error: "no_encontrada" });
      expect((await visitasDeHoy(sql, recepStg, "STG", [luis]))![0]).toMatchObject({ visitasHoy: 1, enEstaSucursal: false, paseAqui: null });
      // La base también lo impide.
      await expect(sql`insert into acceso (clave, sucursal_id, turno_id, tipo, pase_id, registrado_por)
        values (${randomUUID()}, ${ids.STG}, ${t.turnoId}, 'entrada', ${p}, ${recepStg})`).rejects.toThrow(/otra sucursal/);

      // Pase de ayer (simulado).
      await sql`alter table pase_visita disable trigger pase_visita_inmutable`;
      try {
        await sql`update pase_visita set creado_en = creado_en - interval '1 day' where id = ${p}`;
      } finally {
        await sql`alter table pase_visita enable trigger pase_visita_inmutable`;
      }
      expect(await entrar(recep, p)).toEqual({ ok: false, error: "otro_dia" });
      expect((await accesosDelCobro(sql, recep, "TEN", op))!.pases[0].accion).toBe("otro_dia");
      await expect(sql`insert into acceso (clave, sucursal_id, turno_id, tipo, pase_id, registrado_por)
        values (${randomUUID()}, ${ids.TEN}, ${turnoId}, 'entrada', ${p}, ${recep})`).rejects.toThrow(/día del cobro/);
    });

    it("sin permiso o en producción no se registra", async () => {
      const op = await cobrar(recep, "TEN", await fichas(1));
      const [p] = await pases(op);
      expect(await entrar(encargado, p)).toEqual({ ok: false, error: "sin_permiso" });
      expect(await entrar(await cuenta([["recepcion", "STG"]]), p)).toEqual({ ok: false, error: "no_encontrada" });
      expect(await registrarAcceso(sql, recep, "TEN", { clave: randomUUID(), paseId: p, tipo: "entrada" }, { entorno: "produccion" }))
        .toEqual({ ok: false, error: "bloqueado_produccion" });
      expect(await entrar(recep, "no-es-id")).toEqual({ ok: false, error: "pase_invalido" });
    });
  });

  describe("transferencia con abono pendiente", () => {
    it("pide autorización; Encargado la aprueba desde su sesión con motivo; entra; el cobro sigue pendiente y fuera del total", async () => {
      const op = await cobrar(recep, "TEN", await fichas(1), "transferencia");
      const [p] = await pases(op);
      expect(await entrar(recep, p)).toEqual({ ok: false, error: "requiere_autorizacion" });
      await expect(sql`insert into acceso (clave, sucursal_id, turno_id, tipo, pase_id, registrado_por)
        values (${randomUUID()}, ${ids.TEN}, ${turnoId}, 'entrada', ${p}, ${recep})`).rejects.toThrow(/necesita autorización/);
      expect((await accesosDelCobro(sql, recep, "TEN", op))!.pases[0].accion).toBe("pedir_autorizacion");

      expect(await pedirAutorizacion(sql, recep2, "TEN", { tipo: "transferencia_pendiente", paseId: p, nota: "ok" }, PRUEBAS))
        .toEqual({ ok: false, error: "nota" });
      const s = await pedirAutorizacion(sql, recep2, "TEN", { tipo: "transferencia_pendiente", paseId: p, nota: "Muestra el comprobante con la misma clave" }, PRUEBAS);
      expect(s).toMatchObject({ ok: true, repetida: false });
      if (!s.ok) return;
      expect(await pedirAutorizacion(sql, recep, "TEN", { tipo: "transferencia_pendiente", paseId: p, nota: "Otra vez la misma solicitud" }, PRUEBAS))
        .toEqual({ ok: true, autorizacionId: s.autorizacionId, repetida: true });
      expect((await accesosDelCobro(sql, recep, "TEN", op))!.pases[0]).toMatchObject({ accion: "esperando_autorizacion", autorizacion: { estado: "solicitada" } });

      // Bandeja de Encargado.
      const r = await revisionAccesos(sql, encargado, "TEN");
      expect(r?.porAutorizar.map((x) => [x.id, x.tipo, x.importe, x.impedimento])).toEqual([[s.autorizacionId, "transferencia_pendiente", "50.00", null]]);
      // Sin el permiso de autorizar: Recepción y Administración no la resuelven.
      expect(await aprobar(recep, s.autorizacionId)).toEqual({ ok: false, error: "no_encontrada" });
      expect(await aprobar(admin, s.autorizacionId)).toEqual({ ok: false, error: "no_encontrada" });
      expect(await aprobar(encargado, s.autorizacionId, 1, "ok")).toEqual({ ok: false, error: "motivo" });
      expect(await aprobar(encargado, s.autorizacionId)).toEqual({ ok: true });
      expect(await aprobar(encargado, s.autorizacionId)).toEqual({ ok: false, error: "cambio" });

      const tras = (await accesosDelCobro(sql, recep, "TEN", op))!.pases[0];
      expect(tras).toMatchObject({ accion: "entrada", autorizacion: { estado: "aprobada", motivo: "Revisé el comprobante: misma clave e importe" } });
      expect(await entrar(recep, p)).toMatchObject({ ok: true });
      const [acc] = await sql<{ autorizacion_id: string }[]>`select autorizacion_id from acceso where pase_id = ${p} and tipo = 'entrada'`;
      expect(acc.autorizacion_id).toBe(s.autorizacionId);
      expect(await entrar(recep, p, "reingreso")).toMatchObject({ ok: true });

      const [cobro] = await sql<{ estado: string }[]>`select estado from cobro_visita where operacion_id = ${op}`;
      expect(cobro.estado).toBe("pendiente_abono");
      const v = ventasDelTurno(await cobrosDelTurno(sql, turnoId));
      expect(v.transferenciaPendiente.cobros).toBeGreaterThanOrEqual(1);
      expect(v.transferenciaVerificada.cobros).toBe(0);
    });

    it("no la aprueba quien la pidió ni quien registró el cobro; Recepción ve el rechazo y puede pedir otra", async () => {
      // recep tiene además el rol de Encargado; registró el cobro.
      await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${recep}, 'encargado', ${ids.TEN}, 'Prueba de accesos')`;
      try {
        const op = await cobrar(recep, "TEN", await fichas(1), "transferencia");
        const [p] = await pases(op);
        const s = await pedirAutorizacion(sql, recep2, "TEN", { tipo: "transferencia_pendiente", paseId: p, nota: "Muestra el comprobante en su celular" }, PRUEBAS);
        if (!s.ok) throw new Error(s.error);
        expect(await aprobar(recep, s.autorizacionId)).toEqual({ ok: false, error: "registro_propio" });
        expect((await revisionAccesos(sql, recep, "TEN"))!.porAutorizar.find((x) => x.id === s.autorizacionId)?.impedimento).toBe("registro_propio");
        await expect(sql`update autorizacion_acceso set estado = 'aprobada', resuelta_por = ${recep}, resuelta_en = now(),
          motivo_resolucion = 'Prueba directa', version = version + 1 where id = ${s.autorizacionId}`).rejects.toThrow(/Quien registró el cobro/);

        // Quien la pidió (recep, con rol de Encargado) tampoco.
        const op2 = await cobrar(recep, "TEN", await fichas(1), "transferencia");
        const [p2] = await pases(op2);
        const s2 = await pedirAutorizacion(sql, recep, "TEN", { tipo: "visita_sin_cobro", nota: "Invitado de la dueña, sin cobro" }, PRUEBAS);
        if (!s2.ok) throw new Error(s2.error);
        expect(await aprobar(recep, s2.autorizacionId)).toEqual({ ok: false, error: "propia" });
        void p2;

        // Encargado rechaza con motivo: Recepción lo ve y puede volver a pedir.
        expect(await resolverAutorizacion(sql, encargado, "TEN", s.autorizacionId, { version: 1, decision: "rechazar", motivo: "La clave no coincide" }, PRUEBAS))
          .toEqual({ ok: true });
        const tras = (await accesosDelCobro(sql, recep2, "TEN", op))!.pases[0];
        expect(tras).toMatchObject({ accion: "pedir_autorizacion", autorizacion: { estado: "rechazada", motivo: "La clave no coincide" } });
        expect(await entrar(recep2, p)).toEqual({ ok: false, error: "requiere_autorizacion" });
        expect(await pedirAutorizacion(sql, recep2, "TEN", { tipo: "transferencia_pendiente", paseId: p, nota: "Trae otro comprobante" }, PRUEBAS))
          .toMatchObject({ ok: true, repetida: false });
      } finally {
        await sql`update asignacion set revocada_en = now() where usuario_id = ${recep} and rol = 'encargado'`;
      }
    });

    it("Dirección autoriza solo con el permiso explícito en la sucursal; Administración solo revisa", async () => {
      const op = await cobrar(recep, "TEN", await fichas(1), "transferencia");
      const [p] = await pases(op);
      const s = await pedirAutorizacion(sql, recep2, "TEN", { tipo: "transferencia_pendiente", paseId: p, nota: "Muestra el comprobante en su celular" }, PRUEBAS);
      if (!s.ok) throw new Error(s.error);
      const dirSinPermiso = await cuenta([["direccion", "TEN"]]);
      expect(await aprobar(dirSinPermiso, s.autorizacionId)).toEqual({ ok: false, error: "no_encontrada" });
      expect((await revisionAccesos(sql, dirSinPermiso, "TEN"))).toMatchObject({ puedeAutorizar: false, puedeConsultar: true, porAutorizar: [] });
      expect((await revisionAccesos(sql, admin, "TEN"))).toMatchObject({ puedeAutorizar: false, puedeConsultar: true, porAutorizar: [] });
      expect(await revisionAccesos(sql, recep2, "TEN")).toBeNull();
      expect((await revisionAccesos(sql, direccion, "TEN"))?.puedeAutorizar).toBe(true);
      expect(await aprobar(direccion, s.autorizacionId)).toEqual({ ok: true });
      // Dirección Tenango no tiene ese permiso en Santiago.
      expect((await revisionAccesos(sql, direccion, "STG"))).toBeNull();
    });

    it("una transferencia no localizada ya no sirve para entrar", async () => {
      const op = await cobrar(recep, "TEN", await fichas(1), "transferencia");
      const [p] = await pases(op);
      const [c] = await sql<{ id: string; version: number }[]>`select id, version from cobro_visita where operacion_id = ${op}`;
      expect(await marcarNoLocalizado(sql, admin, "TEN", c.id, { version: c.version, motivo: "No aparece en el estado de cuenta" }, PRUEBAS)).toEqual({ ok: true });
      expect((await accesosDelCobro(sql, recep, "TEN", op))!.pases[0].accion).toBe("no_vigente");
      expect(await pedirAutorizacion(sql, recep, "TEN", { tipo: "transferencia_pendiente", paseId: p, nota: "Muestra el comprobante" }, PRUEBAS))
        .toEqual({ ok: false, error: "no_vigente" });
    });
  });

  describe("apertura sin pase", () => {
    it("motivos aparte para revisión; «visita que normalmente se cobra» pide autorización y se usa una vez", async () => {
      expect(await registrarSinPase(sql, recep, "TEN", { clave: randomUUID(), motivo: "socio_open_desk", detalle: "" }, PRUEBAS)).toMatchObject({ ok: true });
      expect(await registrarSinPase(sql, recep, "TEN", { clave: randomUUID(), motivo: "otro", detalle: "" }, PRUEBAS)).toEqual({ ok: false, error: "detalle" });
      expect(await registrarSinPase(sql, recep, "TEN", { clave: randomUUID(), motivo: "inventado", detalle: "algo de texto" }, PRUEBAS)).toEqual({ ok: false, error: "motivo" });
      expect(await registrarSinPase(sql, recep, "TEN", { clave: randomUUID(), motivo: "visita_cobrable", detalle: "Invitado de prueba" }, PRUEBAS))
        .toEqual({ ok: false, error: "requiere_autorizacion" });

      const s = await pedirAutorizacion(sql, recep, "TEN", { tipo: "visita_sin_cobro", nota: "Invitado de prueba de la gerencia" }, PRUEBAS);
      if (!s.ok) throw new Error(s.error);
      expect((await pantallaAccesos(sql, recep, "TEN"))!.visitasSinCobro.find((x) => x.id === s.autorizacionId)?.estado).toBe("solicitada");
      expect(await registrarSinPase(sql, recep, "TEN", { clave: randomUUID(), motivo: "visita_cobrable", detalle: "Invitado de prueba", autorizacionId: s.autorizacionId }, PRUEBAS))
        .toEqual({ ok: false, error: "requiere_autorizacion" });
      expect(await aprobar(encargado, s.autorizacionId, 1, "Invitado autorizado por la gerencia")).toEqual({ ok: true });
      expect((await pantallaAccesos(sql, recep, "TEN"))!.visitasSinCobro.find((x) => x.id === s.autorizacionId)).toMatchObject({ estado: "aprobada", usada: false });
      expect(await registrarSinPase(sql, recep2, "TEN", { clave: randomUUID(), motivo: "visita_cobrable", detalle: "Invitado de prueba", autorizacionId: s.autorizacionId }, PRUEBAS))
        .toMatchObject({ ok: true });
      expect(await registrarSinPase(sql, recep2, "TEN", { clave: randomUUID(), motivo: "visita_cobrable", detalle: "Invitado de prueba", autorizacionId: s.autorizacionId }, PRUEBAS))
        .toEqual({ ok: false, error: "requiere_autorizacion" });

      const lista = (await pantallaAccesos(sql, recep, "TEN"))!.delTurno.filter((a) => a.tipo === "sin_pase");
      expect(lista.map((a) => [a.motivo, a.autorizadaPor !== null])).toEqual([["visita_cobrable", true], ["socio_open_desk", false]]);
      // Ni cobro ni visita.
      const v = ventasDelTurno(await cobrosDelTurno(sql, turnoId));
      expect(v.totalConfirmado.cobros + v.transferenciaPendiente.cobros + v.transferenciaNoLocalizada.cobros + v.cancelados.cobros)
        .toBe((await cobrosDelTurno(sql, turnoId)).length);
    });

    it("emergencia: se registra sin motivo; si el turno cierra, queda pendiente ligada al turno original y se completa una vez", async () => {
      const e = await registrarSinPase(sql, recep, "TEN", { clave: randomUUID(), motivo: "emergencia", detalle: "" }, PRUEBAS);
      if (!e.ok) throw new Error(e.error);
      expect((await pantallaAccesos(sql, recep2, "TEN"))!.emergenciasSinMotivo.map((a) => a.id)).toContain(e.accesoId);
      expect(await completarMotivo(sql, recep, "TEN", e.accesoId, { detalle: "ok" }, PRUEBAS)).toEqual({ ok: false, error: "detalle" });

      // Se cierra el turno (simulado: el cierre llega en el bloque 5) sin motivo: no lo impide.
      await sql`update turno set cerrado_en = now() where id = ${turnoId}`;
      const rev = await revisionAccesos(sql, encargado, "TEN");
      expect(rev!.emergenciasSinMotivo.find((a) => a.id === e.accesoId)?.turnoId).toBe(turnoId);
      expect(await entrar(recep, (await pases(await sqlUltimoCobro()))[0])).toEqual({ ok: false, error: "sin_turno" });

      expect(await completarMotivo(sql, recep2, "TEN", e.accesoId, { detalle: "Visitante con mareo; entró personal de apoyo" }, PRUEBAS)).toEqual({ ok: true });
      expect(await completarMotivo(sql, recep, "TEN", e.accesoId, { detalle: "Otro motivo distinto" }, PRUEBAS)).toEqual({ ok: false, error: "ya_completado" });
      const [a] = await sql<{ detalle: string; detalle_por: string; turno_id: string; registrado_por: string }[]>`
        select detalle, detalle_por, turno_id, registrado_por from acceso where id = ${e.accesoId}`;
      expect(a).toEqual({ detalle: "Visitante con mareo; entró personal de apoyo", detalle_por: recep2, turno_id: turnoId, registrado_por: recep });
      expect((await revisionAccesos(sql, encargado, "TEN"))!.emergenciasSinMotivo.map((x) => x.id)).not.toContain(e.accesoId);
      await expect(sql`update acceso set detalle = 'Cambio directo del motivo' where id = ${e.accesoId}`).rejects.toThrow(/cambio no permitido/);
      await expect(sql`delete from acceso where id = ${e.accesoId}`).rejects.toThrow(/no se permite delete/);
    });
  });
});

async function sqlUltimoCobro() {
  const [o] = await sql<{ id: string }[]>`select id from operacion_visita order by registrada_en desc limit 1`;
  return o.id;
}

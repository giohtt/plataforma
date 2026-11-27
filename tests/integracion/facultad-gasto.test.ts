import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tienePermiso } from "@/lib/permisos";
import { aplicarCambio, pantallaPersona, previsualizarCambio, resumenPermisos, textoDonde, type CambioAcceso } from "@/lib/usuarios";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/**
 * Bloque 6, PR 2 (acordado el 27 nov 2026; solo datos ficticios): cargo «Gestión administrativa» y facultad para
 * autorizar gastos con límite por gasto y acumulado diario; «sin límite» explícito y solo para Dirección.
 * Nadie autoriza gastos por omisión.
 */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const u: Record<string, string> = {};
const s: Record<string, string> = {};
const D = "@prueba.fitnessland.invalid";
const masDias = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() + n * 86_400_000));
const cambiar = (persona: string, c: CambioAcceso) => aplicarCambio(sql, u["direccion.general"], persona, c, PRUEBAS);
const gasto = (alcance: CambioAcceso extends never ? never : { todas: true } | { todas: false; sucursales: string[] }, limite: string, diario: string,
  extra: Partial<{ sinLimite: boolean; hasta: string; motivo: string }> = {}): CambioAcceso =>
  ({ tipo: "facultad_gasto", alcance, sinLimite: false, limite, diario, hasta: "", motivo: "Prueba ficticia de límites", ...extra });
const vigente = (persona: string, sucursal: string) =>
  sql<{ sin_limite: boolean; limite_monto: string | null; limite_diario: string | null }[]>`
    select sin_limite, limite_monto::text, limite_diario::text from facultad_gasto(${persona}, ${sucursal})`;

async function cuenta(nombre: string, rol: string | null, codigos: string[]) {
  const [x] = await sql<{ id: string }[]>`insert into usuario (nombre, correo, es_prueba) values (${nombre}, ${`${nombre.replace(/\W/g, "").toLowerCase()}${D}`}, true) returning id`;
  if (rol) for (const c of codigos) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${x.id}, ${rol}, ${s[c]}, 'Prueba')`;
  return x.id;
}

describe.skipIf(!URL_ADMIN)("facultad para autorizar gastos", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const x of await sql<{ id: string; correo: string }[]>`select id, correo from usuario`) u[x.correo.replace(D, "")] = x.id;
    for (const x of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) s[x.codigo] = x.id;
  });
  afterAll(async () => cerrar?.());

  it("nadie autoriza gastos por omisión: ni Dirección general ni ningún perfil", async () => {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from facultad_otorgada where permiso = 'autorizacion.gasto'`;
    expect(n).toBe(0);
    for (const c of Object.keys(u)) expect(await tienePermiso(sql, u[c], "autorizacion.gasto", s.TEN)).toBe(false);
    expect(await vigente(u["direccion.general"], s.TEN)).toEqual([]);
  });

  it("el cargo «Gestión administrativa» existe y por sí solo no autoriza nada", async () => {
    const [r] = await sql<{ nombre: string }[]>`select nombre from rol where clave = 'gestion_administrativa'`;
    expect(r.nombre).toBe("Gestión administrativa");
    const g = await cuenta("Gestión administrativa (prueba F)", "gestion_administrativa", ["TEN"]);
    expect(await tienePermiso(sql, g, "sucursal.consultar", s.TEN)).toBe(true);
    expect(await tienePermiso(sql, g, "autorizacion.gasto", s.TEN)).toBe(false);
    // Una facultad de autorización nunca forma parte de un perfil.
    await expect(sql`insert into rol_permiso (rol, permiso) values ('gestion_administrativa', 'autorizacion.gasto')`).rejects.toThrow(/se otorga expresamente/);
  });

  it("límite por gasto y acumulado diario, con vista previa; validaciones", async () => {
    const e = await cuenta("Encargado límites (prueba)", "encargado", ["TEN", "STG"]);
    const solo = { todas: false as const, sucursales: [s.TEN] };
    expect(await cambiar(e, gasto(solo, "", "500"))).toEqual({ ok: false, error: "limite" });
    expect(await cambiar(e, gasto(solo, "0", "500"))).toEqual({ ok: false, error: "limite" });
    expect(await cambiar(e, gasto(solo, "300", ""))).toEqual({ ok: false, error: "diario" });
    expect(await cambiar(e, gasto(solo, "300", "200"))).toEqual({ ok: false, error: "diario" });
    expect(await cambiar(e, gasto({ todas: false, sucursales: [] }, "300", "500"))).toEqual({ ok: false, error: "sucursales" });
    expect(await cambiar(e, gasto(solo, "300", "500", { motivo: "x" }))).toEqual({ ok: false, error: "motivo" });
    // «Sin límite» no lleva montos y es solo para Dirección.
    expect(await cambiar(e, gasto(solo, "300", "", { sinLimite: true }))).toEqual({ ok: false, error: "sin_limite_montos" });
    expect(await cambiar(e, gasto(solo, "", "", { sinLimite: true }))).toEqual({ ok: false, error: "no_direccion" });
    // Por «Dar un permiso» ya no se otorga: lleva acumulado diario.
    expect(await cambiar(e, { tipo: "dar_permiso", permiso: "autorizacion.gasto", alcance: solo, limite: "300", hasta: "", motivo: "Por la vía anterior" }))
      .toEqual({ ok: false, error: "usar_facultad_gasto" });

    const v = await previsualizarCambio(sql, u["direccion.general"], e, gasto(solo, "300", "500"), PRUEBAS);
    expect(v.ok && v.detalle).toMatch(/^Autorizar gastos en Tenango · hasta \$300\.00 por gasto y \$500\.00 en total por día\./);
    expect(v.ok && v.vista.gana.map((g) => [g.clave, g.despues])).toEqual([["autorizacion.gasto", "Tenango · límite $300.00 por gasto y $500.00 al día en Tenango"]]);
    // La vista previa no guarda nada.
    expect(await vigente(e, s.TEN)).toEqual([]);

    expect(await cambiar(e, gasto(solo, "300", "500", { hasta: masDias(30) }))).toEqual({ ok: true });
    expect(await vigente(e, s.TEN)).toEqual([{ sin_limite: false, limite_monto: "300.00", limite_diario: "500.00" }]);
    expect(await vigente(e, s.STG)).toEqual([]);
    // Una sola facultad de gastos vigente por lugar: para cambiar límites se quita la anterior.
    expect(await cambiar(e, gasto(solo, "400", "800"))).toEqual({ ok: false, error: "ya_tiene_gasto" });
    expect(await cambiar(e, gasto({ todas: true }, "400", "800"))).toEqual({ ok: false, error: "ya_tiene_gasto" });

    const ficha = await pantallaPersona(sql, u["direccion.general"], e);
    expect(ficha?.permisos.filter((x) => x.permiso === "autorizacion.gasto").map((x) => [x.sucursal, x.limite, x.diario, x.sinLimite]))
      .toEqual([["Tenango", "300.00", "500.00", false]]);
    expect(textoDonde(ficha!.resumen.permisos.find((x) => x.clave === "autorizacion.gasto"))).toBe("Tenango · límite $300.00 por gasto y $500.00 al día en Tenango");
    expect(ficha?.historial[0]).toMatchObject({ accion: "Dio la facultad para autorizar gastos" });
    expect(ficha?.historial[0].detalle).toMatch(/Lo que pase de ahí se escala; nunca se aprueba en parte/);

    // Quitarla la revoca (el historial la conserva) y ya se puede otorgar otra.
    const id = ficha!.permisos.find((x) => x.permiso === "autorizacion.gasto")!.id;
    expect(await cambiar(e, { tipo: "quitar_permiso", id, motivo: "Cambio de límites ficticios" })).toEqual({ ok: true });
    expect(await vigente(e, s.TEN)).toEqual([]);
    expect(await cambiar(e, gasto(solo, "400", "800"))).toEqual({ ok: true });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from facultad_otorgada where usuario_id = ${e} and permiso = 'autorizacion.gasto'`;
    expect(n).toBe(2);
  });

  it("«sin límite» solo para Dirección, explícito; en todas exige Dirección en todas", async () => {
    const d = await cuenta("Dirección local (prueba F)", "direccion", ["TEN"]);
    expect(await cambiar(d, gasto({ todas: false, sucursales: [s.TEN, s.STG] }, "", "", { sinLimite: true }))).toEqual({ ok: false, error: "no_direccion" });
    expect(await cambiar(d, gasto({ todas: true }, "", "", { sinLimite: true }))).toEqual({ ok: false, error: "no_direccion" });
    expect(await cambiar(d, gasto({ todas: false, sucursales: [s.TEN] }, "", "", { sinLimite: true }))).toEqual({ ok: true });
    expect(await vigente(d, s.TEN)).toEqual([{ sin_limite: true, limite_monto: null, limite_diario: null }]);

    // Dirección general (alcance en todas): sin límite en todas, incluidas las futuras.
    const g = u["direccion.general"];
    expect(await cambiar(g, gasto({ todas: true }, "", "", { sinLimite: true }))).toEqual({ ok: true });
    const [nueva] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values ('Futura gastos', 'FGA') returning id`;
    expect(await vigente(g, nueva.id)).toEqual([{ sin_limite: true, limite_monto: null, limite_diario: null }]);
    expect(textoDonde((await resumenPermisos(sql, g)).permisos.find((x) => x.clave === "autorizacion.gasto"))).toMatch(/sin límite en todas$/);

    // Si deja de tener Dirección ahí, la facultad sin límite deja de aplicar (aunque siga en el historial).
    await sql`update asignacion set revocada_en = now() where usuario_id = ${d} and rol = 'direccion'`;
    expect(await vigente(d, s.TEN)).toEqual([]);
  });

  it("la base respalda las reglas aunque se intente escribir directo", async () => {
    const e = await cuenta("Encargado base (prueba)", "encargado", ["TEN"]);
    const ins = (cols: postgres.Helper<Record<string, unknown>>) => sql`insert into facultad_otorgada ${cols}`;
    const base = { usuario_id: e, permiso: "autorizacion.gasto", sucursal_id: s.TEN, motivo: "Directo" };
    await expect(ins(sql({ ...base }))).rejects.toThrow(/límite de monto/);
    await expect(ins(sql({ ...base, limite_monto: 100 }))).rejects.toThrow(/acumulado diario/);
    await expect(ins(sql({ ...base, limite_monto: 100, limite_diario: 50 }))).rejects.toThrow(/facultad_diario_cubre_gasto/);
    await expect(ins(sql({ ...base, sin_limite: true }))).rejects.toThrow(/solo para una cuenta con Dirección/);
    await expect(ins(sql({ ...base, usuario_id: u["direccion"], sin_limite: true, limite_monto: 100 }))).rejects.toThrow(/facultad_sin_limite_sin_montos/);
    await expect(ins(sql({ ...base, permiso: "autorizacion.devolucion", limite_monto: 100, limite_diario: 200 }))).rejects.toThrow(/facultad_campos_de_gasto/);
  });

  it("una facultad de gastos anterior sin acumulado diario queda incompleta: se ve, pero no autoriza", async () => {
    const e = await cuenta("Encargado anterior (prueba)", "encargado", ["TEN"]);
    // Simula un registro anterior a esta regla (la base ya no permite crearlo así).
    await sql.begin(async (tx) => {
      await tx`alter table facultad_otorgada disable trigger facultad_autorizacion_con_limite`;
      await tx`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, motivo) values (${e}, 'autorizacion.gasto', ${s.TEN}, 1000, 'Anterior')`;
      await tx`alter table facultad_otorgada enable trigger facultad_autorizacion_con_limite`;
    });
    expect(await tienePermiso(sql, e, "autorizacion.gasto", s.TEN)).toBe(true);
    expect(await vigente(e, s.TEN)).toEqual([]);
    const r = await resumenPermisos(sql, e);
    expect(textoDonde(r.permisos.find((x) => x.clave === "autorizacion.gasto"))).toBe("Tenango · incompleta, sin acumulado diario: no autoriza gastos en Tenango");
    // Para completarla se quita y se otorga de nuevo; no se edita.
    expect(await cambiar(e, gasto({ todas: false, sucursales: [s.TEN] }, "300", "500"))).toEqual({ ok: false, error: "ya_tiene_gasto" });
    // Y quitarla sigue funcionando (revocar no vuelve a exigir el acumulado).
    const [f] = await sql<{ id: string }[]>`select id from facultad_otorgada where usuario_id = ${e}`;
    expect(await cambiar(e, { tipo: "quitar_permiso", id: f.id, motivo: "Quitar la anterior" })).toEqual({ ok: true });
  });

  it("restringida o con la cuenta desactivada, no aplica", async () => {
    const e = await cuenta("Encargado restringido (prueba)", "encargado", ["TEN"]);
    expect(await cambiar(e, gasto({ todas: false, sucursales: [s.TEN] }, "300", "500"))).toEqual({ ok: true });
    expect(await cambiar(e, { tipo: "restringir", permiso: "autorizacion.gasto", alcance: { todas: false, sucursales: [s.TEN] }, hasta: "", motivo: "Sin autorizar gastos" }))
      .toEqual({ ok: true });
    expect(await vigente(e, s.TEN)).toEqual([]);
    const e2 = await cuenta("Encargado inactivo (prueba)", "encargado", ["TEN"]);
    expect(await cambiar(e2, gasto({ todas: false, sucursales: [s.TEN] }, "300", "500"))).toEqual({ ok: true });
    await sql`update usuario set activo = false where id = ${e2}`;
    expect(await vigente(e2, s.TEN)).toEqual([]);
  });

  it("solo quien administra accesos otorga la facultad", async () => {
    const e = await cuenta("Encargado sin permiso (prueba)", "encargado", ["TEN"]);
    expect(await aplicarCambio(sql, u["direccion"], e, gasto({ todas: false, sucursales: [s.TEN] }, "300", "500"), PRUEBAS))
      .toEqual({ ok: false, error: "sin_permiso" });
    expect(await aplicarCambio(sql, u["direccion.general"], e, gasto({ todas: false, sucursales: [s.TEN] }, "300", "500"), { entorno: "produccion" }))
      .toEqual({ ok: false, error: "bloqueado_produccion" });
  });
});

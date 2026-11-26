import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consultarEnlace, establecerContrasena, solicitarEnlace } from "@/lib/autenticacion";
import { tienePermiso } from "@/lib/permisos";
import {
  aplicarCambio, cambiarEstadoPersona, crearPersona, editarPersona, historialAccesos, invitarPersona, pantallaPersona, pantallaPersonas,
  previsualizarCambio, resumenPermisos, textoDonde, type CambioAcceso,
} from "@/lib/usuarios";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

/** Sección «Usuarios, roles y permisos» (19 nov 2026, 16:22). Solo datos ficticios. */
let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const PRUEBAS = { entorno: "pruebas" as const };
const u: Record<string, string> = {};
const s: Record<string, string> = {};
const D = "@prueba.fitnessland.invalid";
const CLAVE = "Prueba-Segura-2026!";

const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const masDias = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() + n * 86_400_000));
const cambiar = (actor: string, persona: string, c: CambioAcceso) => aplicarCambio(sql, actor, persona, c, PRUEBAS);

describe.skipIf(!URL_ADMIN)("usuarios, roles y permisos", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const x of await sql<{ id: string; correo: string }[]>`select id, correo from usuario`) u[x.correo.replace(D, "")] = x.id;
    for (const x of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) s[x.codigo] = x.id;
  });
  afterAll(async () => cerrar?.());

  it("el historial traduce también las acciones que registraron los datos de prueba (sin claves internas)", async () => {
    const h = await historialAccesos(sql, null, 1000);
    const acciones = new Set(h.map((x) => x.accion));
    expect(acciones).toContain("Dio un perfil");
    expect(acciones).toContain("Dio un permiso");
    for (const a of acciones) expect(a).not.toMatch(/^[a-z_]+$/);
  });

  it("solo quien administra accesos (con alcance en todas) entra a la sección", async () => {
    expect(await pantallaPersonas(sql, u["recepcion.tenango"], )).toBeNull();
    expect(await pantallaPersonas(sql, u["administracion"])).toBeNull();
    // Dirección (prueba) tiene Dirección solo en Tenango: los permisos de cuentas son generales.
    expect(await pantallaPersonas(sql, u["direccion"])).toBeNull();
    const p = await pantallaPersonas(sql, u["direccion.general"]);
    expect(p?.facultades).toEqual({ crear: true, editar: true, asignar: true, restablecer: true });
    // Y cada operación lo vuelve a comprobar en el servidor.
    expect(await crearPersona(sql, u["direccion"], { nombre: "Intento", correo: `intento${D}`, puesto: "" }, PRUEBAS)).toEqual({ ok: false, error: "sin_permiso" });
    expect(await cambiar(u["direccion"], u["recepcion.tenango"], { tipo: "restringir", permiso: "caja.retirar", alcance: { todas: true }, hasta: "", motivo: "Prueba sin permiso" }))
      .toEqual({ ok: false, error: "sin_permiso" });
  });

  it("Dirección (prueba) queda como Dirección Administrativa y Financiera con Dirección y Administración en todas; vista previa antes de guardar", async () => {
    const g = u["direccion.general"];
    const yo = u["direccion"];
    expect(await editarPersona(sql, g, { id: yo, nombre: "Dirección (prueba)", puesto: "Dirección Administrativa y Financiera" }, PRUEBAS)).toEqual({ ok: true });
    const dar = (rol: string): CambioAcceso => ({ tipo: "dar_perfil", rol, alcance: { todas: true }, hasta: "", motivo: "Puesto de Dirección Administrativa y Financiera" });
    // Vista previa: no guarda nada y muestra que «todas» incluye las futuras.
    const v = await previsualizarCambio(sql, g, yo, dar("direccion"), PRUEBAS);
    if (!v.ok) throw new Error(v.error);
    expect(v.vista.sucursalesAntes).toBe("Tenango");
    expect(v.vista.sucursalesDespues).toBe("Todas (incluidas las que se abran después)");
    expect(v.vista.gana.map((x) => x.clave)).toContain("usuario.asignar");
    expect(v.vista.cambia.find((x) => x.clave === "sobre.recoger")).toMatchObject({ antes: "Tenango", despues: "Todas (incluidas las futuras)" });
    expect(await sql`select 1 from alcance_general where usuario_id = ${yo}`).toHaveLength(0);
    // Guardar.
    expect(await cambiar(g, yo, dar("direccion"))).toEqual({ ok: true });
    expect(await cambiar(g, yo, dar("administracion"))).toEqual({ ok: true });
    expect(await cambiar(g, yo, dar("direccion"))).toEqual({ ok: false, error: "ya_tiene" });
    // Una sucursal futura también queda cubierta.
    const [nueva] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values ('Sucursal futura', 'FUT') returning id`;
    expect(await tienePermiso(sql, yo, "sobre.recoger", nueva.id)).toBe(true);
    expect(await tienePermiso(sql, yo, "diferencia.revisar", nueva.id)).toBe(true);
    const ficha = await pantallaPersona(sql, yo, yo);
    expect(ficha?.persona.puesto).toBe("Dirección Administrativa y Financiera");
    expect(ficha?.resumen.todasLasSucursales).toBe(true);
    expect(ficha?.alcances.map((a) => a.rol).sort()).toEqual(["administracion", "direccion"]);
    // Historial: quién, cuándo, qué cambió (antes y después) y motivo.
    const h = await historialAccesos(sql, yo);
    expect(h.map((x) => x.accion)).toEqual(expect.arrayContaining(["Cambió nombre o puesto", "Dio un perfil"]));
    const [fila] = await sql<{ cambios: { sucursales: { antes: string; despues: string } }; motivo: string; usuario_id: string }[]>`
      select cambios, motivo, usuario_id from historial_cambio where entidad = 'usuario' and entidad_id = ${yo} and accion = 'dar_perfil' order by id limit 1`;
    expect(fila).toMatchObject({ motivo: "Puesto de Dirección Administrativa y Financiera", usuario_id: g,
      cambios: { sucursales: { antes: "Tenango", despues: "Todas (incluidas las que se abran después)" } } });
  });

  it("una restricción individual prevalece sobre sus perfiles y sobre un permiso sumado", async () => {
    const yo = u["direccion"];
    const r = u["recepcion.tenango"];
    expect(await tienePermiso(sql, r, "caja.retirar", s.TEN)).toBe(true);
    const v = await previsualizarCambio(sql, yo, r, { tipo: "restringir", permiso: "caja.retirar", alcance: { todas: false, sucursales: [s.TEN] }, hasta: "", motivo: "Sin retiros por ahora" }, PRUEBAS);
    if (!v.ok) throw new Error(v.error);
    expect(v.vista.pierde.map((x) => x.clave)).toEqual(["caja.retirar"]);
    expect(await cambiar(yo, r, { tipo: "restringir", permiso: "caja.retirar", alcance: { todas: false, sucursales: [s.TEN] }, hasta: "", motivo: "Sin retiros por ahora" })).toEqual({ ok: true });
    expect(await tienePermiso(sql, r, "caja.retirar", s.TEN)).toBe(false);
    // Aunque se le sume como permiso individual, la restricción prevalece.
    expect(await cambiar(yo, r, { tipo: "dar_permiso", permiso: "caja.retirar", alcance: { todas: true }, limite: "", hasta: "", motivo: "Prueba de prevalencia" })).toEqual({ ok: true });
    expect(await tienePermiso(sql, r, "caja.retirar", s.TEN)).toBe(false);
    expect(await tienePermiso(sql, r, "caja.retirar", s.STG)).toBe(true);
    // Permisos de autorizar: límite obligatorio; los demás no llevan límite; los generales solo en todas.
    expect(await cambiar(yo, r, { tipo: "dar_permiso", permiso: "autorizacion.devolucion", alcance: { todas: false, sucursales: [s.TEN] }, limite: "", hasta: "", motivo: "Autoriza devoluciones" }))
      .toEqual({ ok: false, error: "limite" });
    expect(await cambiar(yo, r, { tipo: "dar_permiso", permiso: "visita.consultar", alcance: { todas: true }, limite: "100", hasta: "", motivo: "Sin límite" }))
      .toEqual({ ok: false, error: "sin_limite" });
    expect(await cambiar(yo, r, { tipo: "dar_permiso", permiso: "usuario.crear", alcance: { todas: false, sucursales: [s.TEN] }, limite: "", hasta: "", motivo: "General en una" }))
      .toEqual({ ok: false, error: "alcance" });
    expect(await cambiar(yo, r, { tipo: "dar_permiso", permiso: "autorizacion.devolucion", alcance: { todas: false, sucursales: [s.TEN] }, limite: "120", hasta: masDias(10), motivo: "Autoriza devoluciones" }))
      .toEqual({ ok: true });
    // Una restricción también le gana a la facultad de autorizar.
    expect(await cambiar(yo, r, { tipo: "restringir", permiso: "autorizacion.devolucion", alcance: { todas: true }, hasta: "", motivo: "Sin autorizar devoluciones" })).toEqual({ ok: true });
    expect(await tienePermiso(sql, r, "autorizacion.devolucion", s.TEN)).toBe(false);
    // Quitar la restricción devuelve lo que dan sus perfiles.
    const ficha = (await pantallaPersona(sql, yo, r))!;
    const id = ficha.restricciones.find((x) => x.permiso === "caja.retirar")!.id;
    expect(await cambiar(yo, r, { tipo: "quitar_restriccion", id, motivo: "Ya puede registrar retiros" })).toEqual({ ok: true });
    expect(await tienePermiso(sql, r, "caja.retirar", s.TEN)).toBe(true);
  });

  it("crear, invitar por 48 horas (otra invalida la anterior), desactivar y activar", async () => {
    const yo = u["direccion"];
    const c = await crearPersona(sql, yo, { nombre: "Nueva recepcionista (prueba)", correo: `Nueva.Recepcion${D}`, puesto: "Recepcionista matutina" }, PRUEBAS);
    if (!c.ok) throw new Error(c.error);
    expect(await crearPersona(sql, yo, { nombre: "Otra", correo: `nueva.recepcion${D}`, puesto: "" }, PRUEBAS)).toEqual({ ok: false, error: "correo_repetido" });
    const ficha = (await pantallaPersona(sql, yo, c.id))!;
    expect(ficha.resumen.permisos).toEqual([]);
    expect(ficha.persona).toMatchObject({ correo: `nueva.recepcion${D}`, sinContrasena: true, esPrueba: true });
    const i1 = await invitarPersona(sql, yo, { id: c.id }, { ...PRUEBAS, urlBase: "https://pruebas" });
    if (!i1.ok) throw new Error(i1.error);
    const horas = (i1.expira.getTime() - Date.now()) / 3_600_000;
    expect(horas).toBeGreaterThan(47.9);
    expect(horas).toBeLessThanOrEqual(48);
    const i2 = await invitarPersona(sql, yo, { id: c.id }, { ...PRUEBAS, urlBase: "https://pruebas" });
    if (!i2.ok) throw new Error(i2.error);
    const t1 = i1.enlace.split("/").pop()!;
    const t2 = i2.enlace.split("/").pop()!;
    expect(await consultarEnlace(sql, t1)).toEqual({ estado: "invalidado" });
    expect(await consultarEnlace(sql, t2)).toEqual({ estado: "valido", correo: `nueva.recepcion${D}` });
    expect(await establecerContrasena(sql, t2, CLAVE, CLAVE)).toEqual({ ok: true });
    expect(await consultarEnlace(sql, t2)).toEqual({ estado: "usado" });
    // La recuperación sigue en 30 minutos.
    await solicitarEnlace(sql, `nueva.recepcion${D}`, { ...PRUEBAS, urlBase: "https://pruebas" });
    const [rec] = await sql<{ minutos: number }[]>`
      select extract(epoch from expira_en - creado_en) / 60 as minutos from enlace_recuperacion where usuario_id = ${c.id} and tipo = 'recuperacion'`;
    expect(Number(rec.minutos)).toBe(30);
    // La base no acepta invitaciones de más de 48 horas.
    await expect(sql`insert into enlace_recuperacion (token_hash, usuario_id, expira_en, tipo, generado_por)
                     values (${"a".repeat(64)}, ${c.id}, now() + interval '49 hours', 'invitacion', ${yo})`).rejects.toThrow(/enlace_tipo_duracion/);
    // Desactivar exige motivo, no aplica a la propia cuenta y quita todos los permisos al instante.
    expect(await cambiar(yo, c.id, { tipo: "dar_perfil", rol: "recepcion", alcance: { todas: false, sucursales: [s.TEN] }, hasta: "", motivo: "Contratación" })).toEqual({ ok: true });
    expect(await tienePermiso(sql, c.id, "visita.registrar", s.TEN)).toBe(true);
    expect(await cambiarEstadoPersona(sql, yo, { id: c.id, activo: false, motivo: "" }, PRUEBAS)).toEqual({ ok: false, error: "motivo" });
    expect(await cambiarEstadoPersona(sql, yo, { id: yo, activo: false, motivo: "Prueba propia" }, PRUEBAS)).toEqual({ ok: false, error: "propia" });
    expect(await cambiarEstadoPersona(sql, yo, { id: c.id, activo: false, motivo: "Ya no labora" }, PRUEBAS)).toEqual({ ok: true });
    expect(await tienePermiso(sql, c.id, "visita.registrar", s.TEN)).toBe(false);
    expect(await cambiarEstadoPersona(sql, yo, { id: c.id, activo: true, motivo: "Regresa a laborar" }, PRUEBAS)).toEqual({ ok: true });
    expect(await tienePermiso(sql, c.id, "visita.registrar", s.TEN)).toBe(true);
  });

  it("autorización para revisar lo propio: máximo 90 días, solo Dirección, renovable y con historial", async () => {
    const yo = u["direccion"];
    const auto = (hasta: string): CambioAcceso => ({ tipo: "autorrevision", alcance: { todas: true }, hasta, motivo: "Aún no hay personal de Administración" });
    expect(await cambiar(yo, yo, auto(masDias(91)))).toEqual({ ok: false, error: "hasta" });
    expect(await cambiar(yo, u["recepcion.tenango"], { ...auto(masDias(30)) })).toEqual({ ok: false, error: "no_direccion" });
    expect(await cambiar(yo, yo, auto(masDias(90)))).toEqual({ ok: true });
    const [a] = await sql<{ dias: number; desde: Date; hasta: Date }[]>`
      select extract(epoch from vigente_hasta - vigente_desde) / 86400 as dias, vigente_desde as desde, vigente_hasta as hasta
      from autorrevision where usuario_id = ${yo} and revocada_en is null`;
    expect(Number(a.dias)).toBeLessThanOrEqual(90);
    // Renovar termina la anterior y empieza otra de hasta 90 días.
    expect(await cambiar(yo, yo, auto(masDias(60)))).toEqual({ ok: true });
    const filas = await sql<{ revocada: boolean; renueva: boolean }[]>`
      select revocada_en is not null as revocada, renueva_a is not null as renueva from autorrevision where usuario_id = ${yo} order by creado_en`;
    expect(filas).toEqual([{ revocada: true, renueva: false }, { revocada: false, renueva: true }]);
    // En la base: más de 90 días no se acepta.
    await expect(sql`insert into autorrevision (usuario_id, todas_las_sucursales, vigente_desde, vigente_hasta, otorgada_por, motivo)
                     values (${u["direccion.general"]}, true, now(), now() + interval '91 days', ${yo}, 'Prueba de límite')`).rejects.toThrow(/autorrevision_maximo_90_dias/);
    const h = await historialAccesos(sql, yo);
    expect(h.map((x) => x.accion)).toEqual(expect.arrayContaining(["Autorizó revisar lo propio", "Renovó la autorización para revisar lo propio"]));
    expect(hoyMx()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("autorización para resolver lo propio: aparte de la de revisar, quien administra accesos se la otorga a sí misma con vista previa, máximo 90 días, renovable a mano y con historial", async () => {
    const yo = u["direccion"];
    const res = (hasta: string): CambioAcceso => ({ tipo: "autorresolucion", alcance: { todas: true }, hasta, motivo: "Aún no hay otra Dirección que resuelva" });
    // Vista previa: no guarda nada.
    const vista = await previsualizarCambio(sql, yo, yo, res(masDias(30)), PRUEBAS);
    expect(vista).toMatchObject({ ok: true, detalle: expect.stringMatching(/faltantes ya confirmados de retiros y sobres en los que participó.*«Resuelta por quien participó»/) });
    expect((await sql`select 1 from autorresolucion where usuario_id = ${yo}`).length).toBe(0);
    expect(await cambiar(yo, yo, res(masDias(91)))).toEqual({ ok: false, error: "hasta" });
    expect(await cambiar(yo, u["recepcion.tenango"], res(masDias(30)))).toEqual({ ok: false, error: "no_direccion" });
    // Sin usuario.asignar no se otorga.
    expect(await cambiar(u["recepcion.tenango"], yo, res(masDias(30)))).toEqual({ ok: false, error: "sin_permiso" });
    // Es aparte: no crea, renueva ni termina la de revisar lo propio.
    const revisar = () => sql<{ id: string; revocada: boolean }[]>`select id, revocada_en is not null as revocada from autorrevision where usuario_id = ${yo} order by creado_en`;
    if (!(await revisar()).some((x) => !x.revocada)) {
      expect(await cambiar(yo, yo, { tipo: "autorrevision", alcance: { todas: true }, hasta: masDias(30), motivo: "Aún no hay personal de Administración" })).toEqual({ ok: true });
    }
    const antesRevisar = await revisar();
    expect(await cambiar(yo, yo, res(masDias(90)))).toEqual({ ok: true });
    expect(await cambiar(yo, yo, res(masDias(60)))).toEqual({ ok: true });
    expect(await revisar()).toEqual(antesRevisar);
    const filas = await sql<{ revocada: boolean; renueva: boolean }[]>`
      select revocada_en is not null as revocada, renueva_a is not null as renueva from autorresolucion where usuario_id = ${yo} order by creado_en`;
    expect(filas).toEqual([{ revocada: true, renueva: false }, { revocada: false, renueva: true }]);
    const ficha = (await pantallaPersona(sql, yo, yo))!;
    expect(ficha.autorresolucion).toMatchObject({ todas: true, motivo: "Aún no hay otra Dirección que resuelva" });
    expect(ficha.autorrevision).not.toBeNull();
    // Terminar: queda en el historial; la de revisar sigue.
    expect(await cambiar(yo, yo, { tipo: "terminar_autorresolucion", id: ficha.autorresolucion!.id, motivo: "Ya hay otra Dirección" })).toEqual({ ok: true });
    expect((await pantallaPersona(sql, yo, yo))!).toMatchObject({ autorresolucion: null, autorrevision: expect.anything() });
    // En la base: más de 90 días, editar o borrar no se acepta.
    await expect(sql`insert into autorresolucion (usuario_id, todas_las_sucursales, vigente_desde, vigente_hasta, otorgada_por, motivo)
                     values (${u["direccion.general"]}, true, now(), now() + interval '91 days', ${yo}, 'Prueba de límite')`).rejects.toThrow(/autorresolucion_maximo_90_dias/);
    await expect(sql`update autorresolucion set vigente_hasta = vigente_hasta + interval '1 day' where usuario_id = ${yo}`).rejects.toThrow(/solo se puede terminar/);
    await expect(sql`delete from autorresolucion where usuario_id = ${yo}`).rejects.toThrow(/no se borra/);
    const h = await historialAccesos(sql, yo);
    expect(h.map((x) => x.accion)).toEqual(expect.arrayContaining([
      "Autorizó resolver faltantes en los que participó", "Renovó la autorización para resolver faltantes en los que participó",
      "Terminó la autorización para resolver faltantes en los que participó",
    ]));
  });

  it("siempre queda una cuenta que administra accesos sin vencimiento (desactivar, quitar, restringir o vencer)", async () => {
    const yo = u["direccion"];
    const g = u["direccion.general"];
    // Hoy administran las dos (Dirección general y Dirección (prueba) con Dirección en todas).
    const ficha = (await pantallaPersona(sql, yo, g))!;
    const alcanceG = ficha.alcances.find((x) => x.rol === "direccion")!.id;
    expect(await cambiar(yo, g, { tipo: "quitar_perfil", id: alcanceG, general: true, motivo: "Prueba: queda Dirección (prueba)" })).toEqual({ ok: true });
    // Ahora Dirección (prueba) es la última: no puede quitarse Dirección, ni restringirse, ni la pueden desactivar.
    const mia = (await pantallaPersona(sql, yo, yo))!.alcances.find((x) => x.rol === "direccion")!.id;
    expect(await previsualizarCambio(sql, yo, yo, { tipo: "quitar_perfil", id: mia, general: true, motivo: "Intento" }, PRUEBAS)).toEqual({ ok: false, error: "ultimo_administrador" });
    expect(await cambiar(yo, yo, { tipo: "quitar_perfil", id: mia, general: true, motivo: "Intento" })).toEqual({ ok: false, error: "ultimo_administrador" });
    expect(await cambiar(yo, yo, { tipo: "restringir", permiso: "usuario.asignar", alcance: { todas: true }, hasta: masDias(5), motivo: "Intento" })).toEqual({ ok: false, error: "ultimo_administrador" });
    await expect(sql`update usuario set activo = false where id = ${yo}`).rejects.toThrow(/al menos una cuenta activa/);
    // Un acceso con vencimiento no cuenta como permanente.
    expect(await cambiar(yo, g, { tipo: "dar_perfil", rol: "direccion", alcance: { todas: true }, hasta: masDias(30), motivo: "Temporal" })).toEqual({ ok: true });
    expect(await cambiar(yo, yo, { tipo: "quitar_perfil", id: mia, general: true, motivo: "Intento" })).toEqual({ ok: false, error: "ultimo_administrador" });
    // Con otra cuenta permanente, sí.
    const temporal = (await pantallaPersona(sql, yo, g))!.alcances.find((x) => x.rol === "direccion")!.id;
    expect(await cambiar(yo, g, { tipo: "quitar_perfil", id: temporal, general: true, motivo: "Se cambia por permanente" })).toEqual({ ok: true });
    expect(await cambiar(yo, g, { tipo: "dar_perfil", rol: "direccion", alcance: { todas: true }, hasta: "", motivo: "Se conserva como cuenta de prueba" })).toEqual({ ok: true });
    expect(await previsualizarCambio(sql, yo, yo, { tipo: "restringir", permiso: "usuario.asignar", alcance: { todas: true }, hasta: "", motivo: "Ahora sí" }, PRUEBAS))
      .toMatchObject({ ok: true });
  });

  it("todo o nada: si falla una de varias sucursales no queda nada guardado ni sin historial", async () => {
    const yo = u["direccion"];
    const c = await crearPersona(sql, yo, { nombre: "Persona atómica (prueba)", correo: `atomica${D}`, puesto: "" }, PRUEBAS);
    if (!c.ok) throw new Error(c.error);
    const cuenta = async () => (await sql<{ a: number; h: number }[]>`
      select (select count(*)::int from asignacion where usuario_id = ${c.id}) as a,
             (select count(*)::int from historial_cambio where entidad = 'usuario' and entidad_id = ${c.id} and accion = 'dar_perfil') as h`)[0];
    // Ya tiene Recepción en Santiago: pedir Tenango y Santiago no guarda Tenango a medias.
    expect(await cambiar(yo, c.id, { tipo: "dar_perfil", rol: "recepcion", alcance: { todas: false, sucursales: [s.STG] }, hasta: "", motivo: "Primera sucursal" })).toEqual({ ok: true });
    expect(await cuenta()).toEqual({ a: 1, h: 1 });
    expect(await cambiar(yo, c.id, { tipo: "dar_perfil", rol: "recepcion", alcance: { todas: false, sucursales: [s.TEN, s.STG] }, hasta: "", motivo: "Dos sucursales" }))
      .toEqual({ ok: false, error: "ya_tiene" });
    expect(await cuenta()).toEqual({ a: 1, h: 1 });
    // Una falla de la base a la mitad (simulada en la segunda sucursal) deshace también la primera y no deja historial.
    await sql.unsafe(`create function falla_prueba() returns trigger language plpgsql as $$ begin
      if new.sucursal_id = '${s.STG}' and new.usuario_id = '${c.id}' then raise exception 'falla simulada'; end if; return new; end; $$`);
    await sql.unsafe(`create trigger falla_prueba before insert on asignacion for each row execute function falla_prueba()`);
    try {
      await expect(cambiar(yo, c.id, { tipo: "dar_perfil", rol: "encargado", alcance: { todas: false, sucursales: [s.TEN, s.STG] }, hasta: "", motivo: "Dos sucursales" }))
        .rejects.toThrow(/falla simulada/);
    } finally {
      await sql.unsafe(`drop trigger falla_prueba on asignacion; drop function falla_prueba()`);
    }
    expect(await cuenta()).toEqual({ a: 1, h: 1 });
    expect(await tienePermiso(sql, c.id, "turno.consultar", s.TEN)).toBe(false);
    // Igual con restricciones en varias sucursales.
    expect(await cambiar(yo, c.id, { tipo: "restringir", permiso: "caja.retirar", alcance: { todas: false, sucursales: [s.STG] }, hasta: "", motivo: "Sin retiros" })).toEqual({ ok: true });
    expect(await cambiar(yo, c.id, { tipo: "restringir", permiso: "caja.retirar", alcance: { todas: false, sucursales: [s.TEN, s.STG] }, hasta: "", motivo: "Sin retiros" }))
      .toEqual({ ok: false, error: "ya_tiene" });
    expect((await sql`select 1 from restriccion_permiso where usuario_id = ${c.id}`).length).toBe(1);
  });

  it("vista previa y resumen muestran las excepciones por sucursal y el límite que aplica en cada una", async () => {
    const yo = u["direccion"];
    const c = await crearPersona(sql, yo, { nombre: "Persona por sucursal (prueba)", correo: `por.sucursal${D}`, puesto: "" }, PRUEBAS);
    if (!c.ok) throw new Error(c.error);
    expect(await cambiar(yo, c.id, { tipo: "dar_perfil", rol: "administracion", alcance: { todas: true }, hasta: "", motivo: "Todas las sucursales" })).toEqual({ ok: true });
    // Quitar un permiso solo en Tenango: la vista previa lo dice antes de guardar.
    const r: CambioAcceso = { tipo: "restringir", permiso: "diferencia.revisar", alcance: { todas: false, sucursales: [s.TEN] }, hasta: "", motivo: "No revisa en Tenango" };
    const v = await previsualizarCambio(sql, yo, c.id, r, PRUEBAS);
    if (!v.ok) throw new Error(v.error);
    expect(v.vista.cambia.find((x) => x.clave === "diferencia.revisar")).toMatchObject({
      antes: "Todas (incluidas las futuras)", despues: "Todas (incluidas las futuras), excepto Tenango",
    });
    expect(await cambiar(yo, c.id, r)).toEqual({ ok: true });
    // Límites: $1,000 en todas y $1,500 en Tenango; en Santiago no puede (restricción). Se aplica el mayor que cubre cada sucursal.
    const dar = (alcance: CambioAcceso extends never ? never : { todas: true } | { todas: false; sucursales: string[] }, limite: string): CambioAcceso =>
      ({ tipo: "dar_permiso", permiso: "autorizacion.devolucion", alcance, limite, hasta: "", motivo: "Autoriza devoluciones" });
    expect(await cambiar(yo, c.id, dar({ todas: true }, "1000"))).toEqual({ ok: true });
    const v2 = await previsualizarCambio(sql, yo, c.id, dar({ todas: false, sucursales: [s.TEN] }, "1500"), PRUEBAS);
    if (!v2.ok) throw new Error(v2.error);
    const cambio = v2.vista.cambia.find((x) => x.clave === "autorizacion.devolucion")!;
    expect(cambio.antes).toBe("Todas (incluidas las futuras) · límite $1,000.00 en todas");
    expect(cambio.despues).toMatch(/^Todas \(incluidas las futuras\) · límite \$1,000\.00 en .*Santiago.* y las futuras · límite \$1,500\.00 en Tenango$/);
    expect(await cambiar(yo, c.id, dar({ todas: false, sucursales: [s.TEN] }, "1500"))).toEqual({ ok: true });
    expect(await cambiar(yo, c.id, { tipo: "restringir", permiso: "autorizacion.devolucion", alcance: { todas: false, sucursales: [s.STG] }, hasta: "", motivo: "Sin devoluciones en Santiago" }))
      .toEqual({ ok: true });
    const res = await resumenPermisos(sql, c.id);
    const dev = res.permisos.find((x) => x.clave === "autorizacion.devolucion")!;
    expect(dev.excepto).toEqual(["Santiago"]);
    expect(dev.limites.find((l) => l.limite === "1500.00")).toMatchObject({ sucursales: ["Tenango"], futuras: false });
    expect(dev.limites.find((l) => l.limite === "1000.00")?.sucursales).not.toContain("Santiago");
    expect(dev.limites.find((l) => l.limite === "1000.00")?.futuras).toBe(true);
    expect(textoDonde(dev)).toContain("excepto Santiago");
    const rev = res.permisos.find((x) => x.clave === "diferencia.revisar")!;
    expect(textoDonde(rev)).toBe("Todas (incluidas las futuras), excepto Tenango");
    // Lo mismo en la ficha.
    const ficha = (await pantallaPersona(sql, yo, c.id))!;
    expect(textoDonde(ficha.resumen.permisos.find((x) => x.clave === "diferencia.revisar"))).toBe("Todas (incluidas las futuras), excepto Tenango");
  });

  it("dos cambios simultáneos no dejan la plataforma sin quien administre accesos", async () => {
    // Solo dos cuentas administran de forma permanente: A y B. Cada transacción quita una.
    const yo = u["direccion"];
    const a = await crearPersona(sql, yo, { nombre: "Admin A (prueba)", correo: `admin.a${D}`, puesto: "" }, PRUEBAS);
    const b = await crearPersona(sql, yo, { nombre: "Admin B (prueba)", correo: `admin.b${D}`, puesto: "" }, PRUEBAS);
    if (!a.ok || !b.ok) throw new Error("crear");
    for (const x of [a.id, b.id]) {
      expect(await cambiar(yo, x, { tipo: "dar_perfil", rol: "direccion", alcance: { todas: true }, hasta: "", motivo: "Administra accesos" })).toEqual({ ok: true });
    }
    await sql`update alcance_general set revocado_en = now(), revocado_por = ${yo} where rol = 'direccion' and usuario_id not in (${a.id}, ${b.id}) and revocado_en is null`;
    const otros = await sql`select 1 from usuario u where u.activo and administracion_permanente() and u.id not in (${a.id}, ${b.id})
                            and permiso_general_permanente(u.id, 'usuario.asignar')`;
    expect(otros).toHaveLength(0);

    // Intercalado controlado: la primera comprueba (y retiene el candado) antes de confirmar; la segunda intenta mientras tanto.
    let soltar!: () => void;
    const espera = new Promise<void>((r) => { soltar = r; });
    let primeraComprobo!: () => void;
    const comprobo = new Promise<void>((r) => { primeraComprobo = r; });
    const primera = sql.begin(async (tx) => {
      await tx`update alcance_general set revocado_en = now(), revocado_por = ${b.id} where usuario_id = ${a.id} and revocado_en is null`;
      await tx`set constraints all immediate`;
      primeraComprobo();
      await espera;
    });
    await comprobo;
    const segunda = sql.begin(async (tx) => {
      await tx`update alcance_general set revocado_en = now(), revocado_por = ${a.id} where usuario_id = ${b.id} and revocado_en is null`;
      await tx`set constraints all immediate`;
    }).then(() => "ok", (e: Error) => e.message);
    // La segunda queda esperando el candado; se suelta la primera.
    await new Promise((r) => setTimeout(r, 300));
    soltar();
    await primera;
    expect(await segunda).toMatch(/al menos una cuenta activa que administre accesos/);
    const [{ quedan }] = await sql<{ quedan: boolean }[]>`select administracion_permanente() as quedan`;
    expect(quedan).toBe(true);

    // También por la aplicación: dos cuentas se quitan a la vez el acceso una a la otra; solo una lo consigue.
    expect(await cambiar(b.id, a.id, { tipo: "dar_perfil", rol: "direccion", alcance: { todas: true }, hasta: "", motivo: "Vuelve a administrar" })).toEqual({ ok: true });
    const idDe = async (x: string) => (await sql<{ id: string }[]>`select id from alcance_general where usuario_id = ${x} and rol = 'direccion' and revocado_en is null`)[0].id;
    const [ia, ib] = [await idDe(a.id), await idDe(b.id)];
    const resultados = await Promise.all([
      cambiar(a.id, b.id, { tipo: "quitar_perfil", id: ib, general: true, motivo: "Al mismo tiempo" }),
      cambiar(b.id, a.id, { tipo: "quitar_perfil", id: ia, general: true, motivo: "Al mismo tiempo" }),
    ]);
    expect(resultados.filter((x) => x.ok)).toHaveLength(1);
    expect(resultados.filter((x) => !x.ok).map((x) => (x as { error: string }).error)).toEqual([expect.stringMatching(/ultimo_administrador|sin_permiso/)]);
    expect((await sql<{ quedan: boolean }[]>`select administracion_permanente() as quedan`)[0].quedan).toBe(true);
  });
});

import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consultarEnlace, establecerContrasena, solicitarEnlace } from "@/lib/autenticacion";
import { tienePermiso } from "@/lib/permisos";
import {
  aplicarCambio, cambiarEstadoPersona, crearPersona, editarPersona, historialAccesos, invitarPersona, pantallaPersona, pantallaPersonas,
  previsualizarCambio, type CambioAcceso,
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
});

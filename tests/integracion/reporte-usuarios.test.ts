import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reporteUsuariosSucursal, sucursalesConReporte } from "@/lib/reporte-usuarios";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;

async function usuario(nombre: string) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${nombre}, ${`reporte${n}@prueba.fitnessland.invalid`}, true) returning id`;
  return u.id;
}
async function asignar(u: string, rol: string, codigo: string) {
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u}, ${rol}, ${ids[codigo]}, 'Prueba de reporte')`;
}
const de = async (correo: string) =>
  (await sql<{ id: string }[]>`select id from usuario where correo = ${correo + "@prueba.fitnessland.invalid"}`)[0].id;

describe.skipIf(!URL_ADMIN)("reporte de usuarios y asignaciones por sucursal", () => {
  let lector: string; // Encargado de RPT y de Tenango: puede consultar usuarios ahí.
  let otorgante: string;

  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal());
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    await sql`insert into sucursal (nombre, codigo, estado_operativo) values ('Reporte prueba', 'RPT', 'activa')`;
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;

    lector = await usuario("Lectora Encargada");
    await asignar(lector, "encargado", "RPT");
    await asignar(lector, "encargado", "TEN");
    otorgante = await usuario("Otorgante Dirección");

    // Escenario controlado en RPT.
    const ana = await usuario("Ana Vigente");
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo, otorgada_por) values (${ana}, 'recepcion', ${ids.RPT}, 'Prueba', ${otorgante})`;
    const beto = await usuario("Beto Dos Vías"); // local + general: cuenta una vez
    await asignar(beto, "administracion", "RPT");
    await sql`insert into alcance_general (usuario_id, rol, motivo) values (${beto}, 'administracion', 'Prueba')`;
    const caro = await usuario("Caro Vencida");
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, vigente_desde, vigente_hasta, motivo)
              values (${caro}, 'recepcion', ${ids.RPT}, now() - interval '10 days', now() - interval '1 day', 'Prueba')`;
    const dani = await usuario("Dani Revocada");
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo, revocada_en, revocada_por)
              values (${dani}, 'recepcion', ${ids.RPT}, 'Prueba', now(), ${otorgante})`;
    const eli = await usuario("Eli Programada");
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, vigente_desde, motivo)
              values (${eli}, 'recepcion', ${ids.RPT}, now() + interval '3 days', 'Prueba')`;
    const fer = await usuario("Fer Desactivada");
    await asignar(fer, "recepcion", "RPT");
    await sql`update usuario set activo = false where id = ${fer}`;
    const gabi = await usuario("Gabi Facultad Santiago"); // facultad solo de Santiago: no aparece en RPT
    await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, motivo)
              values (${gabi}, 'autorizacion.gasto', ${ids.STG}, 300, 'Prueba')`;
    const hugo = await usuario("Hugo Facultad Local"); // facultad de RPT con límite
    await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, motivo, otorgada_por)
              values (${hugo}, 'autorizacion.gasto', ${ids.RPT}, 250, 'Prueba', ${otorgante})`;
  });
  afterAll(async () => cerrar?.());

  it("Recepción no puede abrir el reporte de ninguna sucursal, ni la suya", async () => {
    const recepcion = await de("recepcion.tenango");
    expect(await sucursalesConReporte(sql, recepcion)).toEqual([]);
    for (const codigo of ["TEN", "STG", "RPT"]) {
      expect(await reporteUsuariosSucursal(sql, recepcion, codigo, { anteriores: false }), codigo).toBeNull();
      expect(await reporteUsuariosSucursal(sql, recepcion, codigo, { anteriores: true }), codigo).toBeNull();
    }
  });

  it("Encargado de Tenango consulta Tenango, pero no Santiago; inexistente o mal formado responde igual", async () => {
    const encargado = await de("encargado.tenango");
    expect((await sucursalesConReporte(sql, encargado)).map((s) => s.codigo)).toEqual(["TEN"]);
    expect((await reporteUsuariosSucursal(sql, encargado, "TEN", { anteriores: false }))?.sucursal.codigo).toBe("TEN");
    for (const codigo of ["STG", "RPT", "ZZZ", "ten", "TEN'--", ""]) {
      expect(await reporteUsuariosSucursal(sql, encargado, codigo, { anteriores: true }), codigo).toBeNull();
    }
  });

  it("una cuenta desactivada ya no puede consultar el reporte", async () => {
    const u = await usuario("Encargada que se va");
    await asignar(u, "encargado", "TEN");
    expect(await reporteUsuariosSucursal(sql, u, "TEN", { anteriores: false })).not.toBeNull();
    await sql`update usuario set activo = false where id = ${u}`;
    expect(await reporteUsuariosSucursal(sql, u, "TEN", { anteriores: false })).toBeNull();
  });

  it("por defecto muestra solo accesos vigentes, separando asignación local, acceso general y facultades", async () => {
    const r = (await reporteUsuariosSucursal(sql, lector, "RPT", { anteriores: false }))!;
    expect(r.locales.map((a) => [a.nombre, a.rol, a.estado])).toEqual([
      ["Ana Vigente", "recepcion", "vigente"],
      ["Beto Dos Vías", "administracion", "vigente"],
      ["Lectora Encargada", "encargado", "vigente"],
    ]);
    // El acceso general cubre RPT aunque no se haya otorgado para RPT.
    expect(r.generales.map((g) => [g.nombre, g.rol])).toEqual([
      ["Beto Dos Vías", "administracion"],
      ["Dirección general (prueba)", "direccion"],
    ]);
    // Solo facultades de RPT o de todas; la de Santiago no aparece.
    expect(r.facultades.map((f) => [f.nombre, f.permiso, f.todas, f.limite])).toEqual([
      ["Dirección general (prueba)", "autorizacion.gasto", true, "1000.00"],
      ["Hugo Facultad Local", "autorizacion.gasto", false, "250.00"],
    ]);
    expect(r.incluyeAnteriores).toBe(false);
  });

  it("quien tiene acceso por dos vías cuenta una sola vez en el total de personas", async () => {
    const r = (await reporteUsuariosSucursal(sql, lector, "RPT", { anteriores: false }))!;
    // Ana, Beto (local y general), Lectora, Dirección general (general y facultad), Hugo.
    expect(r.totalPersonas).toBe(5);
    expect(r.locales.length + r.generales.length + r.facultades.length).toBe(7);
  });

  it("muestra quién otorgó el acceso solo cuando está registrado", async () => {
    const r = (await reporteUsuariosSucursal(sql, lector, "RPT", { anteriores: true }))!;
    const por = Object.fromEntries(r.locales.map((a) => [a.nombre, a.otorgadoPor]));
    expect(por["Ana Vigente"]).toBe("Otorgante Dirección");
    expect(por["Beto Dos Vías"]).toBeNull();
    expect(r.locales.find((a) => a.nombre === "Dani Revocada")).toMatchObject({ revocadoPor: "Otorgante Dirección" });
    expect(r.facultades.find((f) => f.nombre === "Hugo Facultad Local")?.otorgadoPor).toBe("Otorgante Dirección");
  });

  it("«Incluir anteriores» agrega vencidas, revocadas, programadas y de cuentas desactivadas, sin cambiar el total", async () => {
    const r = (await reporteUsuariosSucursal(sql, lector, "RPT", { anteriores: true }))!;
    const estado = Object.fromEntries(r.locales.map((a) => [a.nombre, a.estado]));
    expect(estado).toMatchObject({
      "Caro Vencida": "vencida",
      "Dani Revocada": "revocada",
      "Eli Programada": "programada",
      "Fer Desactivada": "cuenta_desactivada",
    });
    expect(r.totalPersonas).toBe(5);
    expect(r.facultades.some((f) => f.nombre === "Gabi Facultad Santiago")).toBe(false);
  });

  it("el total cuadra con los permisos que la base calcula para cada persona", async () => {
    for (const codigo of ["TEN", "RPT", "STG"]) {
      const lectorGeneral = await de("direccion.general");
      const r = (await reporteUsuariosSucursal(sql, lectorGeneral, codigo, { anteriores: false }))!;
      const [{ total }] = await sql<{ total: number }[]>`
        select count(*)::int as total from usuario u
        where u.activo and (
          exists (select 1 from perfiles_en_sucursal(u.id, ${ids[codigo]}))
          or exists (select 1 from facultad_otorgada f
                     where f.usuario_id = u.id and (f.sucursal_id = ${ids[codigo]} or f.todas_las_sucursales)
                       and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en)))`;
      expect(r.totalPersonas, codigo).toBe(total);
    }
  });

  it("Tenango con los datos ficticios: la cuenta vencida solo aparece al incluir anteriores", async () => {
    const encargado = await de("encargado.tenango");
    const vigentes = (await reporteUsuariosSucursal(sql, encargado, "TEN", { anteriores: false }))!;
    expect(vigentes.locales.some((a) => a.nombre.includes("vencida"))).toBe(false);
    const todos = (await reporteUsuariosSucursal(sql, encargado, "TEN", { anteriores: true }))!;
    expect(todos.locales.find((a) => a.nombre.toLowerCase().includes("vencida"))?.estado).toBe("vencida");
    // Dirección general tiene asignación en Tenango y acceso general: aparece en ambas listas, cuenta una vez.
    const dg = "Dirección general (prueba)";
    expect(vigentes.locales.some((a) => a.nombre === dg) && vigentes.generales.some((g) => g.nombre === dg)).toBe(true);
    const personas = new Set([...vigentes.locales, ...vigentes.generales, ...vigentes.facultades].map((x) => x.usuarioId));
    expect(vigentes.totalPersonas).toBe(personas.size);
  });

  it("el reporte no modifica nada", async () => {
    const antes = await sql`select (select count(*) from asignacion) a, (select count(*) from historial_cambio) h, (select count(*) from alcance_general) g`;
    await reporteUsuariosSucursal(sql, lector, "RPT", { anteriores: true });
    expect(await sql`select (select count(*) from asignacion) a, (select count(*) from historial_cambio) h, (select count(*) from alcance_general) g`).toEqual(antes);
  });
});

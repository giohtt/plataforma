import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { correccionesDeVisitante, corregirVisitante, expedienteParaCorregir } from "@/lib/correccion-visitantes";
import { validarCorreccion, type DatosCorreccion } from "@/lib/datos-visitante";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;

async function cuenta(asignaciones: [string, string][], { general }: { general?: string } = {}) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Corrige " + n}, ${`corrige${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de corrección')`;
  }
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${general}, 'Prueba')`;
  return u.id;
}
async function visitante(nombre: string, codigo: string, telefono: string | null = null, estado: string | null = null) {
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id) values (${nombre}, ${telefono}, ${estado}, ${ids[codigo]}) returning id`;
  return v.id;
}
/** Nombre sin parecido con ningún otro, para que la búsqueda aproximada no lo confunda. */
const letras = (k: number) => Array.from({ length: k }, () => "bcdfghjklmnpqrstvwxyz"[Math.floor(Math.random() * 21)]).join("");
const unico = () => `${letras(8)} ${letras(8)} ${letras(8)}`;
const version = async (id: string) => (await sql<{ version: number }[]>`select version from visitante where id = ${id}`)[0].version;
const fila = async (id: string) =>
  (await sql<{ nombre: string; telefono: string | null; estado_procedencia: string | null }[]>`
    select nombre, telefono, estado_procedencia from visitante where id = ${id}`)[0];
const datos = (extra: Partial<DatosCorreccion> & { nombre: string }): DatosCorreccion => ({
  telefono: { accion: "mantener" },
  estadoProcedencia: null,
  ...extra,
});
const corregir = async (u: string, codigo: string, id: string, d: DatosCorreccion, motivo = "Corrección de prueba", vistas: string[] = []) =>
  corregirVisitante(sql, u, codigo, id, await version(id), d, motivo, { entorno: "pruebas", coincidenciasVistas: vistas });

describe.skipIf(!URL_ADMIN)("corrección de expedientes", () => {
  let encargadoTen: string;

  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal());
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
    encargadoTen = await cuenta([["encargado", "TEN"]]);
  });
  afterAll(async () => cerrar?.());

  describe("quién puede corregir", () => {
    it("Encargado de Tenango corrige un expediente creado en Tenango: guarda anterior, nuevo, motivo, quién, desde dónde y cuándo", async () => {
      const id = await visitante("Rosa Ficticia Uno", "TEN", "0000000601", "Puebla");
      const v0 = await version(id);
      const r = await corregir(encargadoTen, "TEN", id, datos({ nombre: "Rosa Ficticia Unos", estadoProcedencia: "Hidalgo" }), "Error de escritura");
      expect(r).toEqual({ ok: true });
      expect(await fila(id)).toEqual({ nombre: "Rosa Ficticia Unos", telefono: "0000000601", estado_procedencia: "Hidalgo" });
      expect(await version(id)).toBe(v0 + 1);
      const cambios = await sql`
        select campo, valor_anterior, valor_nuevo, motivo, usuario_id, sucursal_id, en from visitante_cambio where visitante_id = ${id} order by campo`;
      expect(cambios.map((c) => [c.campo, c.valor_anterior, c.valor_nuevo])).toEqual([
        ["estado_procedencia", "Puebla", "Hidalgo"],
        ["nombre", "Rosa Ficticia Uno", "Rosa Ficticia Unos"],
      ]);
      expect(cambios.every((c) => c.motivo === "Error de escritura" && c.usuario_id === encargadoTen && c.sucursal_id === ids.TEN && c.en)).toBe(true);
    });

    it("Encargado de Tenango ve, pero no corrige, un expediente creado en Santiago", async () => {
      const id = await visitante("Expediente De Santiago", "STG");
      expect((await expedienteParaCorregir(sql, encargadoTen, "TEN", id))?.puedeCorregir).toBe(false);
      expect(await corregir(encargadoTen, "TEN", id, datos({ nombre: "Cambio No Permitido" }))).toEqual({ ok: false, error: "sin_permiso" });
      expect((await fila(id)).nombre).toBe("Expediente De Santiago");
    });

    it("Dirección de una sola sucursal corrige solo las de su sucursal; Dirección general, todas", async () => {
      const deStg = await visitante("Otro Expediente Santiago", "STG");
      const dirTen = await cuenta([["direccion", "TEN"]]);
      expect(await corregir(dirTen, "TEN", deStg, datos({ nombre: "Intento Dirección" }))).toEqual({ ok: false, error: "sin_permiso" });
      const general = await cuenta([], { general: "direccion" });
      expect(await corregir(general, "TEN", deStg, datos({ nombre: "Corregido Por Dirección General" }))).toEqual({ ok: true });
    });

    it("Recepción y Administración no pueden guardar cambios; una cuenta sin permiso en la sucursal recibe «no encontrada»", async () => {
      const id = await visitante("Sin Edición Ficticia", "TEN", "0000000602");
      for (const rol of ["recepcion", "administracion"]) {
        const u = await cuenta([[rol, "TEN"]]);
        expect((await expedienteParaCorregir(sql, u, "TEN", id))?.puedeCorregir, rol).toBe(false);
        expect(await corregir(u, "TEN", id, datos({ nombre: "Intento " + rol })), rol).toEqual({ ok: false, error: "sin_permiso" });
      }
      for (const u of [await cuenta([]), await cuenta([["encargado", "STG"]])]) {
        expect(await corregir(u, "TEN", id, datos({ nombre: "Intento Sin Permiso" }))).toEqual({ ok: false, error: "no_encontrada" });
      }
      // Encargado de Santiago tampoco, aunque envíe la corrección «desde» Santiago: el expediente es de Tenango.
      const encStg = await cuenta([["encargado", "STG"]]);
      expect(await corregir(encStg, "STG", id, datos({ nombre: "Intento Desde Santiago" }))).toEqual({ ok: false, error: "sin_permiso" });
      expect((await fila(id)).nombre).toBe("Sin Edición Ficticia");
      expect(await sql`select 1 from visitante_cambio where visitante_id = ${id}`).toHaveLength(0);
    });

    it("identificador malo o inexistente: no encontrada, sin error; en producción está bloqueado", async () => {
      for (const id of ["-".repeat(36), "abc", "00000000-0000-0000-0000-000000000000"]) {
        expect(await corregirVisitante(sql, encargadoTen, "TEN", id, 1, datos({ nombre: "X Y Z" }), "Motivo válido", { entorno: "pruebas" }))
          .toEqual({ ok: false, error: "no_encontrada" });
      }
      const id = await visitante("Producción Bloqueada", "TEN");
      expect(await corregirVisitante(sql, encargadoTen, "TEN", id, 1, datos({ nombre: "Otro" }), "Motivo válido", { entorno: "produccion" }))
        .toEqual({ ok: false, error: "bloqueado_produccion" });
    });
  });

  describe("reglas del cambio", () => {
    it("el motivo es obligatorio", async () => {
      const id = await visitante("Motivo Obligatorio", "TEN");
      for (const motivo of ["", "   ", "abc"]) {
        expect(await corregir(encargadoTen, "TEN", id, datos({ nombre: "Motivo Cambiado" }), motivo)).toEqual({ ok: false, error: "motivo" });
      }
    });

    it("sin cambios no escribe nada; si otra persona corrigió antes, se rechaza", async () => {
      const original = unico();
      const id = await visitante(original, "TEN");
      expect(await corregir(encargadoTen, "TEN", id, datos({ nombre: original }))).toEqual({ ok: false, error: "sin_cambios" });
      const vieja = await version(id);
      const primera = unico();
      expect(await corregir(encargadoTen, "TEN", id, datos({ nombre: primera }))).toEqual({ ok: true });
      expect(await corregirVisitante(sql, encargadoTen, "TEN", id, vieja, datos({ nombre: unico() }), "Motivo válido", { entorno: "pruebas" }))
        .toEqual({ ok: false, error: "modificada" });
      expect((await fila(id)).nombre).toBe(primera);
    });

    it("el teléfono se cambia o se quita; el historial guarda el dato completo pero lo muestra enmascarado", async () => {
      const id = await visitante("Telefono Corregible", "TEN", "0000000611");
      expect(await corregir(encargadoTen, "TEN", id, datos({ nombre: "Telefono Corregible", telefono: { accion: "cambiar", telefono: "0000000612" } }))).toEqual({ ok: true });
      expect(await corregir(encargadoTen, "TEN", id, datos({ nombre: "Telefono Corregible", telefono: { accion: "quitar" } }))).toEqual({ ok: true });
      expect((await fila(id)).telefono).toBeNull();
      const guardado = await sql`select valor_anterior, valor_nuevo from visitante_cambio where visitante_id = ${id} order by id`;
      expect(guardado.map((g) => [g.valor_anterior, g.valor_nuevo])).toEqual([["0000000611", "0000000612"], ["0000000612", null]]);

      const mostrado = (await correccionesDeVisitante(sql, encargadoTen, "TEN", id))!;
      expect(mostrado.map((c) => [c.campo, c.anterior, c.nuevo])).toEqual([
        ["telefono", "•• •••• 0612", null],
        ["telefono", "•• •••• 0611", "•• •••• 0612"],
      ]);
      expect(JSON.stringify(mostrado)).not.toMatch(/000000061[12]/);
      // El historial general solo dice qué campos cambiaron.
      const general = await sql`select cambios from historial_cambio where entidad = 'visitante' and entidad_id = ${id}`;
      expect(JSON.stringify(general)).not.toMatch(/000000061[12]/);
    });

    it("una corrección que produce coincidencias pide confirmar y deja las fichas separadas", async () => {
      const id = await visitante("Persona Por Corregir", "TEN");
      const antes = (await sql`select count(*)::int as n from visitante`)[0].n;
      const d = datos({ nombre: "Luis Martinez Ruiz", telefono: { accion: "cambiar", telefono: "0000000201" } });
      const r = await corregir(encargadoTen, "TEN", id, d);
      if (r.ok || r.error !== "coincidencias") throw new Error("debía avisar");
      expect(r.coincidencias.map((c) => c.nombre).sort()).toEqual(["Ana Martínez Ruiz", "Luis Martínez Ruiz"]);
      expect(r.coincidencias.some((c) => c.id === id)).toBe(false);
      expect((await fila(id)).nombre).toBe("Persona Por Corregir");

      expect(await corregir(encargadoTen, "TEN", id, d, "Corrección confirmada", r.coincidencias.map((c) => c.id))).toEqual({ ok: true });
      expect((await sql`select count(*)::int as n from visitante`)[0].n).toBe(antes);
      const luis = await sql`select count(*)::int as n from visitante where telefono = '0000000201' and nombre_clave = 'luis martinez ruiz'`;
      expect(luis[0].n).toBe(2); // dos fichas separadas: no se fusionan
    });

    it("no vuelve a avisar de quien ya se confirmó como otra persona", async () => {
      const nombre = unico();
      const a = await visitante(nombre, "TEN");
      const b = await visitante(unico(), "TEN");
      await sql`insert into visitante_distinto (visitante_id, distinto_de_id, motivo) values (${b}, ${a}, 'Confirmado antes')`;
      expect(await corregir(encargadoTen, "TEN", b, datos({ nombre }))).toEqual({ ok: true });
    });

    it("la tabla de correcciones no se puede editar ni borrar", async () => {
      const [{ id }] = await sql<{ id: string }[]>`select id::text from visitante_cambio limit 1`;
      await expect(sql`update visitante_cambio set motivo = 'otro motivo' where id = ${id}`).rejects.toThrow();
      await expect(sql`delete from visitante_cambio where id = ${id}`).rejects.toThrow();
    });
  });

  describe("validación del formulario", () => {
    it("teléfono vacío no cambia; con dígitos cambia; la casilla lo quita; no se permiten ambos", () => {
      expect(validarCorreccion({ nombre: "Nombre Valido", telefono: "" })).toMatchObject({ ok: true, datos: { telefono: { accion: "mantener" } } });
      expect(validarCorreccion({ nombre: "Nombre Valido", telefono: "000 000 0699" })).toMatchObject({ ok: true, datos: { telefono: { accion: "cambiar", telefono: "0000000699" } } });
      expect(validarCorreccion({ nombre: "Nombre Valido", quitarTelefono: "si" })).toMatchObject({ ok: true, datos: { telefono: { accion: "quitar" } } });
      expect(validarCorreccion({ nombre: "Nombre Valido", telefono: "0000000699", quitarTelefono: "si" }).ok).toBe(false);
      expect(validarCorreccion({ nombre: "Nombre Valido", telefono: "123" }).ok).toBe(false);
      expect(validarCorreccion({ nombre: "N" }).ok).toBe(false);
    });
  });
});

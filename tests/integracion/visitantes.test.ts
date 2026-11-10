import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { interpretarConsulta, type DatosVisitante } from "@/lib/datos-visitante";
import { buscarVisitantes, consultarVisitante, crearVisitante } from "@/lib/visitantes";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;

async function cuenta(asignaciones: [string, string][]) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Visitantes " + n}, ${`visitantes${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de visitantes')`;
  }
  return u.id;
}
const buscar = (u: string, codigo: string, texto: string) => buscarVisitantes(sql, u, codigo, interpretarConsulta(texto));
const nombres = async (u: string, codigo: string, texto: string) => {
  const r = await buscar(u, codigo, texto);
  if (!r.ok) throw new Error(r.error);
  return r.resultados.map((x) => x.nombre).sort();
};
const alta = (u: string, datos: Partial<DatosVisitante> & { nombre: string }, confirmados: string[] = [], codigo = "TEN") =>
  crearVisitante(sql, u, codigo, { telefono: null, estadoProcedencia: null, ...datos }, confirmados, { entorno: "pruebas" });

describe.skipIf(!URL_ADMIN)("expedientes de visitantes: búsqueda y alta", () => {
  let recepcion: string;

  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 4 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
    recepcion = await cuenta([["recepcion", "TEN"]]);
  });
  afterAll(async () => cerrar?.());

  describe("permisos", () => {
    it("Recepción de Tenango busca desde Tenango, pero no desde otra sucursal", async () => {
      expect((await buscar(recepcion, "TEN", "maria")).ok).toBe(true);
      expect(await buscar(recepcion, "STG", "maria")).toEqual({ ok: false, error: "no_encontrada" });
    });

    it("sin asignaciones, o con una asignación vencida, no se busca ni se crea", async () => {
      const sin = await cuenta([]);
      expect(await buscar(sin, "TEN", "maria")).toEqual({ ok: false, error: "no_encontrada" });
      expect(await alta(sin, { nombre: "Intento Sin Permiso" })).toEqual({ ok: false, error: "no_encontrada" });
      const [{ id: vencida }] = await sql<{ id: string }[]>`select id from usuario where correo = 'recepcion.vencida@prueba.fitnessland.invalid'`;
      expect(await buscar(vencida, "TEN", "maria")).toEqual({ ok: false, error: "no_encontrada" });
    });

    it("Administración busca y consulta, pero no crea expedientes (regla provisional)", async () => {
      const adm = await cuenta([["administracion", "TEN"]]);
      expect((await buscar(adm, "TEN", "maria")).ok).toBe(true);
      expect(await alta(adm, { nombre: "Intento Administración" })).toEqual({ ok: false, error: "sin_permiso" });
    });

    it("en producción el alta está bloqueada hasta aprobar la privacidad del expediente", async () => {
      expect(await crearVisitante(sql, recepcion, "TEN", { nombre: "Real", telefono: null, estadoProcedencia: null }, [], { entorno: "produccion" }))
        .toEqual({ ok: false, error: "bloqueado_produccion" });
    });
  });

  describe("búsqueda", () => {
    it("por nombre ignora acentos, mayúsculas, espacios y orden de las palabras, y cubre todas las sucursales", async () => {
      expect(await nombres(recepcion, "TEN", "maria hernandez")).toEqual(["María Hernández García", "María Hernández García"]);
      expect(await nombres(recepcion, "TEN", "  HERNÁNDEZ   maría ")).toEqual(["María Hernández García", "María Hernández García"]);
      const r = await buscar(recepcion, "TEN", "maria hernandez");
      if (!r.ok) throw new Error();
      // Cubre las fichas de ambas sucursales; la sucursal de alta solo se ve donde hay permiso de detalle (Tenango).
      expect(r.resultados.map((x) => x.sucursalAlta)).toEqual(expect.arrayContaining(["Tenango", null]));
      expect(JSON.stringify(r)).not.toContain("Santiago");
    });

    it("tolera errores de escritura", async () => {
      expect(await nombres(recepcion, "TEN", "Jose Ramires Sanches")).toContain("José Ramírez Sánchez");
    });

    it("por nombre, el teléfono sale enmascarado y el número completo no llega en la respuesta", async () => {
      const r = await buscar(recepcion, "TEN", "maria hernandez");
      if (!r.ok) throw new Error();
      expect(r.resultados.map((x) => x.telefono).sort()).toEqual(["•• •••• 0101", "•• •••• 0102"]);
      expect(JSON.stringify(r)).not.toMatch(/0000000101|0000000102/);
    });

    it("por teléfono completo encuentra a quienes lo comparten y muestra el número que se escribió", async () => {
      expect(await nombres(recepcion, "TEN", "000 000 0201")).toEqual(["Ana Martínez Ruiz", "Luis Martínez Ruiz"]);
      const r = await buscar(recepcion, "TEN", "+52 (000) 000-0201");
      if (!r.ok) throw new Error();
      expect(r.resultados.map((x) => x.telefono)).toEqual(["00 0000 0201", "00 0000 0201"]);
    });

    it("no busca por pedazos de teléfono ni con menos de 3 letras", async () => {
      expect(await buscar(recepcion, "TEN", "0201")).toMatchObject({ ok: false, error: "consulta_invalida" });
      expect(await buscar(recepcion, "TEN", "ma")).toMatchObject({ ok: false, error: "consulta_invalida" });
      expect(await buscar(recepcion, "TEN", "")).toMatchObject({ ok: false, error: "consulta_invalida" });
    });

    it("los comodines de búsqueda se toman como texto, no devuelven todos los expedientes", async () => {
      expect(await nombres(recepcion, "TEN", "%%%%")).toEqual([]);
      expect(await nombres(recepcion, "TEN", "____")).toEqual([]);
    });
  });

  describe("alta", () => {
    it("sin coincidencias crea el expediente; el historial no repite el teléfono", async () => {
      const r = await alta(recepcion, { nombre: "Rodrigo Salinas Vega", telefono: "0000000901", estadoProcedencia: "Puebla" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const [v] = await sql`select nombre, telefono, estado_procedencia, sucursal_alta_id, creado_por from visitante where id = ${r.id}`;
      expect(v).toMatchObject({ nombre: "Rodrigo Salinas Vega", telefono: "0000000901", sucursal_alta_id: ids.TEN, creado_por: recepcion });
      const [h] = await sql<{ cambios: Record<string, unknown> }[]>`select cambios from historial_cambio where entidad = 'visitante' and entidad_id = ${r.id}`;
      expect(h.cambios).toMatchObject({ telefono_capturado: true });
      expect(JSON.stringify(h.cambios)).not.toContain("0000000901");
    });

    it("con homónimos no crea nada hasta que Recepción confirme que es otra persona; la confirmación queda registrada", async () => {
      const datos = { nombre: "Maria Hernandez Garcia", telefono: "0000000103" };
      const primero = await alta(recepcion, datos);
      expect(primero.ok).toBe(false);
      if (primero.ok || primero.error !== "coincidencias") throw new Error();
      expect(primero.coincidencias.map((c) => c.sucursalAlta)).toEqual(expect.arrayContaining(["Tenango", null]));
      expect(primero.coincidencias).toHaveLength(2);
      expect(primero.coincidencias.every((c) => c.motivos.includes("mismo_nombre"))).toBe(true);
      const [{ antes }] = await sql`select count(*)::int as antes from visitante`;

      // Confirmar solo una de las dos no basta.
      expect((await alta(recepcion, datos, [primero.coincidencias[0].id])).ok).toBe(false);
      expect((await sql`select count(*)::int as n from visitante`)[0].n).toBe(antes);

      const r = await alta(recepcion, datos, primero.coincidencias.map((c) => c.id));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const distintos = await sql`select distinto_de_id, confirmado_por, sucursal_id from visitante_distinto where visitante_id = ${r.id}`;
      expect(distintos.map((d) => d.distinto_de_id).sort()).toEqual(primero.coincidencias.map((c) => c.id).sort());
      expect(distintos.every((d) => d.confirmado_por === recepcion && d.sucursal_id === ids.TEN)).toBe(true);
    });

    it("un teléfono compartido aparece como coincidencia aunque el nombre sea otro", async () => {
      const r = await alta(recepcion, { nombre: "Pedro Gómez Díaz", telefono: "0000000201" });
      if (r.ok || r.error !== "coincidencias") throw new Error("debía pedir confirmación");
      expect(r.coincidencias.map((c) => c.nombre).sort()).toEqual(["Ana Martínez Ruiz", "Luis Martínez Ruiz"]);
      expect(r.coincidencias.every((c) => c.motivos.includes("mismo_telefono"))).toBe(true);
    });

    it("si aparece una coincidencia nueva después de confirmar, vuelve a preguntar", async () => {
      const datos = { nombre: "Gabriela Ortiz Mena" };
      const otra = await cuenta([["recepcion", "STG"]]);
      expect((await alta(otra, datos, [], "STG")).ok).toBe(true); // la primera, desde Santiago
      const vista = await alta(recepcion, datos);
      if (vista.ok || vista.error !== "coincidencias") throw new Error();
      // Mientras Recepción de Tenango decide, se crea otra con el mismo nombre en Santiago.
      const confirmada = vista.coincidencias.map((c) => c.id);
      const [{ id: tercera }] = await sql<{ id: string }[]>`
        insert into visitante (nombre, sucursal_alta_id) values ('Gabriela Ortiz Mena', ${ids.STG}) returning id`;
      const r = await alta(recepcion, datos, confirmada);
      if (r.ok || r.error !== "coincidencias") throw new Error("debía volver a preguntar");
      expect(r.coincidencias.map((c) => c.id)).toContain(tercera);
    });

    it("dos altas simultáneas de la misma persona: solo una se crea; la otra recibe la coincidencia", async () => {
      const otra = await cuenta([["recepcion", "TEN"]]);
      const datos = { nombre: "Héctor Simultáneo Prueba", telefono: "0000000999" };
      const [a, b] = await Promise.all([alta(recepcion, datos), alta(otra, datos)]);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      const rechazada = a.ok ? b : a;
      expect(rechazada).toMatchObject({ ok: false, error: "coincidencias" });
      expect((await sql`select count(*)::int as n from visitante where telefono = '0000000999'`)[0].n).toBe(1);
    });

    it("la base exige teléfono de 10 dígitos y no permite borrar expedientes", async () => {
      await expect(sql`insert into visitante (nombre, telefono, sucursal_alta_id) values ('Formato Malo', '123', ${ids.TEN})`).rejects.toThrow();
      const [{ id }] = await sql<{ id: string }[]>`select id from visitante limit 1`;
      await expect(sql`delete from visitante where id = ${id}`).rejects.toThrow();
    });
  });

  describe("consulta del expediente", () => {
    it("muestra el teléfono enmascarado; desde otra sucursal o con un identificador malo no se encuentra", async () => {
      const [{ id }] = await sql<{ id: string }[]>`select id from visitante where telefono = '0000000101'`;
      const e = await consultarVisitante(sql, recepcion, "TEN", id);
      expect(e).toMatchObject({ nombre: "María Hernández García", telefono: "•• •••• 0101", sucursalAlta: "Tenango" });
      expect(await consultarVisitante(sql, recepcion, "STG", id)).toBeNull();
      expect(await consultarVisitante(sql, recepcion, "TEN", "-".repeat(36))).toBeNull();
      expect(await consultarVisitante(sql, recepcion, "TEN", "00000000-0000-0000-0000-000000000000")).toBeNull();
    });
  });
});

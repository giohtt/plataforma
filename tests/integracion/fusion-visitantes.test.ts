import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { correccionesDeVisitante } from "@/lib/correccion-visitantes";
import { interpretarConsulta } from "@/lib/datos-visitante";
import { fichaActiva, fusionarVisitantes, fusionesDeVisitante, prepararFusion, type Eleccion } from "@/lib/fusion-visitantes";
import { buscarVisitantes, crearVisitante } from "@/lib/visitantes";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
const ids: Record<string, string> = {};
let n = 0;

async function cuenta(asignaciones: [string, string][], { general }: { general?: string } = {}) {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Fusiona " + n}, ${`fusiona${n}@prueba.fitnessland.invalid`}, true) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${ids[codigo]}, 'Prueba de fusión')`;
  }
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${general}, 'Prueba')`;
  return u.id;
}
const letras = (k: number) => Array.from({ length: k }, () => "bcdfghjklmnpqrstvwxyz"[Math.floor(Math.random() * 21)]).join("");
const unico = () => `${letras(8)} ${letras(8)} ${letras(8)}`;
async function ficha(codigo: string, { nombre = unico(), telefono = null as string | null, estado = null as string | null } = {}) {
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id) values (${nombre}, ${telefono}, ${estado}, ${ids[codigo]}) returning id`;
  return v.id;
}
const fila = async (id: string) =>
  (await sql<{ nombre: string; telefono: string | null; estado_procedencia: string | null; fusionado_en_id: string | null; version: number }[]>`
    select nombre, telefono, estado_procedencia, fusionado_en_id, version from visitante where id = ${id}`)[0];
async function eleccion(a: string, b: string, extra: Partial<Eleccion> = {}): Promise<Eleccion> {
  return {
    a, b,
    versionA: (await fila(a)).version,
    versionB: (await fila(b)).version,
    activa: "a",
    tomar: { nombre: "a", telefono: "a", estado_procedencia: "a" },
    ...extra,
  };
}
const fusionar = async (u: string, codigo: string, e: Eleccion, motivo = "Duplicado creado por error") =>
  fusionarVisitantes(sql, u, codigo, e, motivo, { entorno: "pruebas" });

describe.skipIf(!URL_ADMIN)("fusión de fichas duplicadas", () => {
  let direccionTen: string;
  let general: string;

  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 3 }));
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
    direccionTen = await cuenta([["direccion", "TEN"]]);
    general = await cuenta([], { general: "direccion" });
  });
  afterAll(async () => cerrar?.());

  describe("los dos casos de prueba cargados", () => {
    it("Valeria, registrada dos veces en Tenango: Dirección de Tenango la puede unir", async () => {
      const [v1, v2] = (await sql<{ id: string }[]>`select id from visitante where telefono = '0000000401' order by nombre desc`).map((r) => r.id);
      const p = await prepararFusion(sql, direccionTen, "TEN", v1, v2);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect([p.a.telefono, p.b.telefono]).toEqual(["•• •••• 0401", "•• •••• 0401"]);
      expect(JSON.stringify(p)).not.toContain("0000000401");

      const r = await fusionar(direccionTen, "TEN", await eleccion(v1, v2, { tomar: { nombre: "a", telefono: "a", estado_procedencia: "a" } }));
      expect(r).toEqual({ ok: true, activaId: v1 });
      expect(await fila(v2)).toMatchObject({ fusionado_en_id: v1 });
      expect((await fila(v1)).nombre).toBe("Valeria Gómez Pineda");
    });

    it("Luis y Ana comparten teléfono y ya se confirmaron como distintos: la fusión se bloquea", async () => {
      const [ana, luis] = (await sql<{ id: string }[]>`select id from visitante where telefono = '0000000201' and creado_por is null order by nombre`).map((r) => r.id);
      expect(await prepararFusion(sql, general, "TEN", ana, luis)).toEqual({ ok: false, error: "confirmados_distintos" });
      expect(await fusionar(general, "TEN", await eleccion(ana, luis))).toEqual({ ok: false, error: "confirmados_distintos" });
      expect((await fila(ana)).fusionado_en_id).toBeNull();
      expect((await fila(luis)).fusionado_en_id).toBeNull();
    });
  });

  describe("quién puede fusionar", () => {
    it("Encargado, Recepción y Administración no pueden, aunque las fichas sean de su sucursal", async () => {
      const a = await ficha("TEN");
      const b = await ficha("TEN");
      for (const rol of ["encargado", "recepcion", "administracion"]) {
        const u = await cuenta([[rol, "TEN"]]);
        expect(await prepararFusion(sql, u, "TEN", a, b), rol).toEqual({ ok: false, error: "sin_permiso" });
        expect(await fusionar(u, "TEN", await eleccion(a, b)), rol).toEqual({ ok: false, error: "sin_permiso" });
      }
      expect((await fila(b)).fusionado_en_id).toBeNull();
    });

    it("fichas de sucursales distintas: hace falta el permiso en ambas", async () => {
      const deTen = await ficha("TEN");
      const deStg = await ficha("STG");
      expect(await fusionar(direccionTen, "TEN", await eleccion(deTen, deStg))).toEqual({ ok: false, error: "sin_permiso" });
      const dirAmbas = await cuenta([["direccion", "TEN"], ["direccion", "STG"]]);
      expect(await fusionar(dirAmbas, "TEN", await eleccion(deTen, deStg))).toEqual({ ok: true, activaId: deTen });
    });

    it("sin permiso en la sucursal desde la que se trabaja, o con identificadores malos: no encontrada", async () => {
      const a = await ficha("TEN");
      const b = await ficha("TEN");
      expect(await fusionar(await cuenta([]), "TEN", await eleccion(a, b))).toEqual({ ok: false, error: "no_encontrada" });
      expect(await fusionar(direccionTen, "STG", await eleccion(a, b))).toEqual({ ok: false, error: "no_encontrada" });
      expect(await prepararFusion(sql, direccionTen, "TEN", a, "-".repeat(36))).toEqual({ ok: false, error: "no_encontrada" });
      expect(await prepararFusion(sql, direccionTen, "TEN", a, a)).toEqual({ ok: false, error: "misma_ficha" });
    });

    it("en producción está bloqueada", async () => {
      const a = await ficha("TEN");
      const b = await ficha("TEN");
      expect(await fusionarVisitantes(sql, direccionTen, "TEN", await eleccion(a, b), "Motivo válido", { entorno: "produccion" }))
        .toEqual({ ok: false, error: "bloqueado_produccion" });
    });
  });

  describe("qué se conserva", () => {
    it("Dirección elige la ficha activa y de dónde sale cada dato; queda registro con motivo, quién, cuándo y qué fichas", async () => {
      const a = await ficha("TEN", { nombre: unico(), telefono: "0000000701", estado: null });
      const nombreB = unico();
      const b = await ficha("TEN", { nombre: nombreB, telefono: null, estado: "Hidalgo" });
      const r = await fusionar(direccionTen, "TEN", await eleccion(a, b, { activa: "b", tomar: { nombre: "b", telefono: "a", estado_procedencia: "b" } }), "Misma persona, segunda ficha por error");
      expect(r).toEqual({ ok: true, activaId: b });
      expect(await fila(b)).toMatchObject({ nombre: nombreB, telefono: "0000000701", estado_procedencia: "Hidalgo", fusionado_en_id: null });
      expect((await fila(a)).fusionado_en_id).toBe(b);

      const [f] = await sql`select activo_id, absorbido_id, campos_tomados, motivo, usuario_id, sucursal_id, en from visitante_fusion where absorbido_id = ${a}`;
      expect(f).toMatchObject({
        activo_id: b,
        absorbido_id: a,
        campos_tomados: { nombre: "activa", telefono: "unida", estado_procedencia: "activa" },
        motivo: "Misma persona, segunda ficha por error",
        usuario_id: direccionTen,
        sucursal_id: ids.TEN,
      });
      expect(f.en).toBeTruthy();
      // El teléfono que la activa tomó de la otra ficha queda como corrección, con el mismo motivo.
      const cambios = await sql`select campo, valor_anterior, valor_nuevo, motivo from visitante_cambio where visitante_id = ${b}`;
      expect(cambios).toEqual([{ campo: "telefono", valor_anterior: null, valor_nuevo: "0000000701", motivo: "Misma persona, segunda ficha por error" }]);
    });

    it("la vista de fusiones y el historial muestran el teléfono enmascarado y solo a quien puede corregir o fusionar", async () => {
      const a = await ficha("TEN", { telefono: "0000000711" });
      const b = await ficha("TEN");
      await sql`insert into visitante_cambio (visitante_id, campo, valor_anterior, valor_nuevo, motivo, usuario_id, sucursal_id)
                values (${a}, 'estado_procedencia', null, 'Puebla', 'Corrección previa en la ficha unida', ${direccionTen}, ${ids.TEN})`;
      expect((await fusionar(direccionTen, "TEN", await eleccion(a, b, { activa: "b" }))).ok).toBe(true);

      const fusiones = (await fusionesDeVisitante(sql, direccionTen, "TEN", b))!;
      expect(fusiones).toHaveLength(1);
      expect(fusiones[0].unida.telefono).toBe("•• •••• 0711");
      expect(JSON.stringify(fusiones)).not.toContain("0000000711");
      // Las correcciones de la ficha unida se conservan y se ven desde la activa.
      const correcciones = (await correccionesDeVisitante(sql, direccionTen, "TEN", b))!;
      expect(correcciones.some((c) => c.deFichaUnida && c.motivo === "Corrección previa en la ficha unida")).toBe(true);

      for (const rol of ["recepcion", "administracion"]) {
        const u = await cuenta([[rol, "TEN"]]);
        expect(await fusionesDeVisitante(sql, u, "TEN", b), rol).toBeNull();
      }
    });

    it("el motivo es obligatorio y una elección inválida se rechaza", async () => {
      const a = await ficha("TEN");
      const b = await ficha("TEN");
      expect(await fusionar(direccionTen, "TEN", await eleccion(a, b), "  ")).toEqual({ ok: false, error: "motivo" });
      const mala = { ...(await eleccion(a, b)), activa: "c" } as unknown as Eleccion;
      expect(await fusionar(direccionTen, "TEN", mala)).toEqual({ ok: false, error: "eleccion_invalida" });
      expect((await fila(b)).fusionado_en_id).toBeNull();
    });

    it("si una ficha cambió después de la vista previa, no se fusiona", async () => {
      const a = await ficha("TEN");
      const b = await ficha("TEN");
      const vieja = await eleccion(a, b);
      await sql`update visitante set nombre = ${unico()}, version = version + 1 where id = ${b}`;
      expect(await fusionar(direccionTen, "TEN", vieja)).toEqual({ ok: false, error: "modificada" });
    });
  });

  describe("la ficha unida", () => {
    it("se conserva, deja de aparecer en la búsqueda y en las coincidencias, y su enlace lleva a la activa", async () => {
      const nombre = unico();
      const a = await ficha("TEN", { nombre, telefono: "0000000721" });
      const b = await ficha("TEN", { nombre: unico() });
      expect((await fusionar(direccionTen, "TEN", await eleccion(a, b, { activa: "b", tomar: { nombre: "b", telefono: "b", estado_procedencia: "b" } }))).ok).toBe(true);

      expect(await fila(a)).toMatchObject({ nombre, telefono: "0000000721" });
      const recep = await cuenta([["recepcion", "TEN"]]);
      const porNombre = await buscarVisitantes(sql, recep, "TEN", interpretarConsulta(nombre));
      expect(porNombre.ok && porNombre.resultados.some((r) => r.id === a)).toBe(false);
      const porTelefono = await buscarVisitantes(sql, recep, "TEN", interpretarConsulta("0000000721"));
      expect(porTelefono.ok && porTelefono.resultados.length).toBe(0);
      // Crear a alguien con ese nombre ya no sugiere la ficha unida.
      const alta = await crearVisitante(sql, recep, "TEN", { nombre, telefono: null, estadoProcedencia: null }, [], { entorno: "pruebas" });
      expect(alta.ok).toBe(true);

      expect(await fichaActiva(sql, a)).toEqual({ activa: b, unida: true });
      expect(await fichaActiva(sql, b)).toEqual({ activa: b, unida: false });
    });

    it("no se puede volver a unir ni corregir; una fusión encadenada lleva a la última ficha activa", async () => {
      const a = await ficha("TEN");
      const b = await ficha("TEN");
      const c = await ficha("TEN");
      expect((await fusionar(direccionTen, "TEN", await eleccion(a, b, { activa: "b" }))).ok).toBe(true);
      expect(await fusionar(direccionTen, "TEN", await eleccion(a, c))).toEqual({ ok: false, error: "ya_unida" });
      // Ahora b se une a c: el enlace de a debe llevar hasta c.
      expect((await fusionar(direccionTen, "TEN", await eleccion(b, c, { activa: "b" }))).ok).toBe(true);
      expect(await fichaActiva(sql, a)).toEqual({ activa: c, unida: true });
      expect(await fichaActiva(sql, b)).toEqual({ activa: c, unida: true });
      expect(await fusionar(direccionTen, "TEN", await eleccion(b, await ficha("TEN")))).toEqual({ ok: false, error: "ya_unida" });
    });

    it("el bloqueo por personas distintas también vale a través de fichas ya unidas", async () => {
      const x = await ficha("TEN");
      const duplicadoDeX = await ficha("TEN");
      const y = await ficha("TEN");
      await sql`insert into visitante_distinto (visitante_id, distinto_de_id, motivo) values (${duplicadoDeX}, ${y}, 'Confirmado antes')`;
      expect((await fusionar(direccionTen, "TEN", await eleccion(x, duplicadoDeX))).ok).toBe(true);
      expect(await fusionar(direccionTen, "TEN", await eleccion(x, y))).toEqual({ ok: false, error: "confirmados_distintos" });
    });

    it("dos fusiones simultáneas de la misma ficha: solo una se guarda", async () => {
      const a = await ficha("TEN");
      const b = await ficha("TEN");
      const c = await ficha("TEN");
      const [r1, r2] = await Promise.all([
        fusionar(direccionTen, "TEN", await eleccion(b, a)),
        fusionar(direccionTen, "TEN", await eleccion(c, a)),
      ]);
      expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
      expect(await sql`select 1 from visitante_fusion where absorbido_id = ${a}`).toHaveLength(1);
    });

    it("los registros de fusión no se pueden editar ni borrar", async () => {
      const [{ id }] = await sql<{ id: string }[]>`select id::text from visitante_fusion limit 1`;
      await expect(sql`update visitante_fusion set motivo = 'otro motivo' where id = ${id}`).rejects.toThrow();
      await expect(sql`delete from visitante_fusion where id = ${id}`).rejects.toThrow();
    });
  });
});

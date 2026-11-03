import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resumenAccesos,
  sucursalAccesiblePorCodigo,
  sucursalAccesiblePorId,
  sucursalesAccesibles,
  tienePermiso,
} from "@/lib/permisos";
import { cargarDatosPrueba } from "../../scripts/datos-prueba.mjs";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
let n = 0;
const ids: Record<string, string> = {};

async function usuario() {
  n++;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba) values (${"Permisos " + n}, ${`permisos${n}@prueba.fitnessland.invalid`}, true)
    returning id`;
  return u.id;
}
async function asignar(u: string, rol: string, codigo: string, extra: { desde?: string; hasta?: string; revocada?: boolean } = {}) {
  await sql`
    insert into asignacion (usuario_id, rol, sucursal_id, vigente_desde, vigente_hasta, revocada_en, motivo)
    values (${u}, ${rol}, ${ids[codigo]},
            ${extra.desde ? sql`now() + ${extra.desde}::interval` : sql`now() - interval '1 minute'`},
            ${extra.hasta ? sql`now() + ${extra.hasta}::interval` : null},
            ${extra.revocada ? sql`now()` : null},
            'Prueba de permisos')`;
}
const codigos = async (u: string) => (await sucursalesAccesibles(sql, u)).map((s) => s.codigo);

describe.skipIf(!URL_ADMIN)("permisos y alcance por sucursal", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal());
    await cargarDatosPrueba(sql, { entorno: "pruebas" });
    for (const s of await sql<{ id: string; codigo: string }[]>`select id, codigo from sucursal`) ids[s.codigo] = s.id;
  });
  afterAll(async () => cerrar?.());

  it("una cuenta sin asignaciones no tiene acceso a ninguna sucursal ni permiso general", async () => {
    const u = await usuario();
    expect(await codigos(u)).toEqual([]);
    for (const c of Object.keys(ids)) expect(await tienePermiso(sql, u, "sucursal.consultar", ids[c])).toBe(false);
    expect(await tienePermiso(sql, u, "sucursal.crear")).toBe(false);
    expect(await resumenAccesos(sql, u)).toEqual({ asignaciones: [], alcancesGenerales: [], facultades: [] });
  });

  it("Recepción asignada a Tenango ve solo Tenango, con su perfil", async () => {
    const u = await usuario();
    await asignar(u, "recepcion", "TEN");
    const lista = await sucursalesAccesibles(sql, u);
    expect(lista.map((s) => [s.codigo, s.perfiles])).toEqual([["TEN", ["recepcion"]]]);
    expect(await sucursalAccesiblePorCodigo(sql, u, "STG")).toBeNull();
    expect(await sucursalAccesiblePorId(sql, u, ids.STG)).toBeNull();
    expect((await sucursalAccesiblePorId(sql, u, ids.TEN))?.codigo).toBe("TEN");
    // Un identificador mal formado no llega a la base: responde igual que sin permiso, sin error.
    for (const malo of ["-".repeat(36), "g".repeat(36), "abc", `${ids.TEN}x`]) {
      expect(await sucursalAccesiblePorId(sql, u, malo)).toBeNull();
    }
    expect(await tienePermiso(sql, u, "sucursal.editar", ids.TEN)).toBe(false);
    expect(await tienePermiso(sql, u, "sucursal.crear")).toBe(false);
  });

  describe("vigencia", () => {
    it("una asignación vencida no da acceso", async () => {
      const u = await usuario();
      await sql`insert into asignacion (usuario_id, rol, sucursal_id, vigente_desde, vigente_hasta, motivo)
                values (${u}, 'recepcion', ${ids.TEN}, now() - interval '10 days', now() - interval '1 day', 'Vencida')`;
      expect(await codigos(u)).toEqual([]);
    });

    it("una asignación que empieza en el futuro todavía no da acceso", async () => {
      const u = await usuario();
      await asignar(u, "recepcion", "TEN", { desde: "1 day" });
      expect(await codigos(u)).toEqual([]);
    });

    it("una asignación revocada no da acceso", async () => {
      const u = await usuario();
      await asignar(u, "recepcion", "TEN", { revocada: true });
      expect(await codigos(u)).toEqual([]);
    });

    it("una asignación con fecha final futura sí da acceso, y aparece en el resumen", async () => {
      const u = await usuario();
      await asignar(u, "recepcion", "TEN", { hasta: "7 days" });
      expect(await codigos(u)).toEqual(["TEN"]);
      const r = await resumenAccesos(sql, u);
      expect(r.asignaciones[0]).toMatchObject({ rol: "recepcion", codigo: "TEN" });
      expect(r.asignaciones[0].hasta).not.toBeNull();
    });

    it("un usuario desactivado pierde todos sus permisos", async () => {
      const u = await usuario();
      await asignar(u, "recepcion", "TEN");
      await sql`update usuario set activo = false where id = ${u}`;
      expect(await codigos(u)).toEqual([]);
    });
  });

  describe("Dirección", () => {
    it("asignada a una sucursal: solo esa, y sin permisos generales ni facultades", async () => {
      const u = await usuario();
      await asignar(u, "direccion", "TEN");
      expect(await codigos(u)).toEqual(["TEN"]);
      expect(await tienePermiso(sql, u, "sucursal.editar", ids.TEN)).toBe(true);
      expect(await tienePermiso(sql, u, "sucursal.editar", ids.STG)).toBe(false);
      expect(await tienePermiso(sql, u, "sucursal.crear")).toBe(false);
      expect(await tienePermiso(sql, u, "autorizacion.gasto", ids.TEN)).toBe(false);
    });

    it("el alcance general se otorga aparte y cubre también sucursales creadas después", async () => {
      const u = await usuario();
      await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u}, 'direccion', 'Alcance de prueba')`;
      expect((await codigos(u)).sort()).toEqual(Object.keys(ids).sort());
      expect(await tienePermiso(sql, u, "sucursal.crear")).toBe(true);
      const [nueva] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values ('Nueva prueba', 'NUE') returning id`;
      expect(await tienePermiso(sql, u, "sucursal.consultar", nueva.id)).toBe(true);
      // El alcance general no da facultades de autorización.
      expect(await tienePermiso(sql, u, "autorizacion.gasto", ids.TEN)).toBe(false);
    });

    it("las facultades de autorización se otorgan aparte, por persona y siempre con límite", async () => {
      const u = await usuario();
      await asignar(u, "direccion", "TEN");
      await expect(sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, motivo)
                       values (${u}, 'autorizacion.gasto', ${ids.TEN}, 'Sin límite')`).rejects.toThrow(/límite/);
      await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, motivo)
                values (${u}, 'autorizacion.gasto', ${ids.TEN}, 500, 'Con límite')`;
      expect(await tienePermiso(sql, u, "autorizacion.gasto", ids.TEN)).toBe(true);
      expect(await tienePermiso(sql, u, "autorizacion.gasto", ids.STG)).toBe(false);
    });

    it("una facultad no puede formar parte de un perfil", async () => {
      await expect(sql`insert into rol_permiso (rol, permiso) values ('direccion', 'autorizacion.devolucion')`).rejects.toThrow();
    });
  });

  describe("cuentas ficticias cargadas", () => {
    const de = async (correo: string) =>
      (await sql<{ id: string }[]>`select id from usuario where correo = ${correo + "@prueba.fitnessland.invalid"}`)[0].id;

    it("cada cuenta ve exactamente sus sucursales", async () => {
      expect(await codigos(await de("sin.asignaciones"))).toEqual([]);
      expect(await codigos(await de("recepcion.vencida"))).toEqual([]);
      expect(await codigos(await de("recepcion.tenango"))).toEqual(["TEN"]);
      expect(await codigos(await de("recepcion.santiago"))).toEqual(["STG"]);
      expect(await codigos(await de("encargado.tenango"))).toEqual(["TEN"]);
      expect((await codigos(await de("administracion"))).sort()).toEqual(["STG", "TEN"]);
      expect(await codigos(await de("direccion"))).toEqual(["TEN"]);
      const [{ total }] = await sql<{ total: number }[]>`select count(*)::int as total from sucursal`;
      expect((await codigos(await de("direccion.general"))).length).toBe(total);
    });

    it("solo Dirección general tiene facultad de autorización, con límite ficticio", async () => {
      const r = await resumenAccesos(sql, await de("direccion.general"));
      expect(r.alcancesGenerales.map((g) => g.rol)).toEqual(["direccion"]);
      expect(r.facultades).toMatchObject([{ permiso: "autorizacion.gasto", todas: true, limite: "1000.00" }]);
      expect((await resumenAccesos(sql, await de("direccion"))).facultades).toEqual([]);
    });
  });
});

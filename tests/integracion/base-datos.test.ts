/**
 * Pruebas contra un PostgreSQL real. Cada ejecución crea una base temporal y la borra al final.
 * Requiere TEST_DATABASE_URL (por ejemplo, el PostgreSQL local de scripts/db-local.sh).
 * En GitHub es obligatoria: si falta, la prueba falla en lugar de omitirse.
 */
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aplicarMigraciones, DIRECTORIO_MIGRACIONES } from "../../scripts/migrar.mjs";
import { cargarDatosPrueba, SUCURSALES_PRUEBA, USUARIOS_PRUEBA } from "../../scripts/datos-prueba.mjs";

const URL_ADMIN = process.env.TEST_DATABASE_URL;
if (!URL_ADMIN && process.env.CI) {
  throw new Error("Falta TEST_DATABASE_URL: en GitHub las pruebas de base de datos son obligatorias.");
}

const NOMBRE_BD = `prueba_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let admin: postgres.Sql;
let sql: postgres.Sql;

describe.skipIf(!URL_ADMIN)("base de datos", () => {
  beforeAll(async () => {
    admin = postgres(URL_ADMIN!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${NOMBRE_BD}`);
    const url = new URL(URL_ADMIN!);
    url.pathname = `/${NOMBRE_BD}`;
    sql = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${NOMBRE_BD} with (force)`);
    await admin?.end({ timeout: 5 });
  });

  /** Ejecuta una instrucción que debe fallar dentro de una transacción que se deshace. */
  async function debeFallar(consulta: (tx: postgres.TransactionSql) => Promise<unknown>) {
    let error: unknown = null;
    await sql
      .begin(async (tx) => {
        await consulta(tx);
      })
      .catch((e) => (error = e));
    expect(error, "se esperaba que la base rechazara la operación").not.toBeNull();
    return error as Error;
  }

  describe("migraciones", () => {
    it("se aplican todas en orden", async () => {
      const archivos = (await readdir(DIRECTORIO_MIGRACIONES)).filter((a) => a.endsWith(".sql")).sort();
      const aplicadas = await aplicarMigraciones(sql);
      expect(aplicadas).toEqual(archivos);
    });

    it("una segunda ejecución no vuelve a aplicar nada", async () => {
      expect(await aplicarMigraciones(sql)).toEqual([]);
    });

    it("se detiene si una migración ya aplicada cambió", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "migraciones-"));
      for (const a of await readdir(DIRECTORIO_MIGRACIONES)) {
        await writeFile(path.join(dir, a), await readFile(path.join(DIRECTORIO_MIGRACIONES, a), "utf8"));
      }
      await writeFile(path.join(dir, "0001_base_acceso.sql"), "-- archivo alterado\nselect 1;");
      await expect(aplicarMigraciones(sql, { directorio: dir })).rejects.toThrow(/no edites migraciones/i);
    });
  });

  describe("sucursales", () => {
    it("rechaza códigos inválidos", async () => {
      for (const codigo of ["T", "tenx", "DEMASIADO", "TE N"]) {
        await debeFallar((tx) => tx`insert into sucursal (nombre, codigo) values (${"Prueba " + codigo}, ${codigo})`);
      }
    });

    it("no permite repetir código ni nombre (sin importar mayúsculas)", async () => {
      await sql`insert into sucursal (nombre, codigo) values ('Sucursal Única', 'UNI')`;
      await debeFallar((tx) => tx`insert into sucursal (nombre, codigo) values ('Otra', 'UNI')`);
      await debeFallar((tx) => tx`insert into sucursal (nombre, codigo) values ('  sucursal única ', 'UN2')`);
    });

    it("solo acepta los tres estados operativos", async () => {
      await debeFallar(
        (tx) => tx`insert into sucursal (nombre, codigo, estado_operativo) values ('X1', 'XA', 'cerrada')`,
      );
    });

    it("una sucursal nueva empieza como próxima apertura y no se puede borrar", async () => {
      const [s] = await sql`insert into sucursal (nombre, codigo) values ('Nueva', 'NVA') returning *`;
      expect(s.estado_operativo).toBe("proxima");
      await debeFallar((tx) => tx`delete from sucursal where id = ${s.id}`);
    });
  });

  describe("usuarios, roles y asignaciones", () => {
    it("el catálogo tiene los ocho perfiles de los manuales; cuatro disponibles en el bloque 1", async () => {
      const roles = await sql`select clave, disponible_en_bloque_1 from rol order by clave`;
      expect(roles.map((r) => r.clave)).toEqual([
        "administracion", "contabilidad", "direccion", "encargado",
        "mantenimiento", "marketing", "recepcion", "soporte",
      ]);
      expect(roles.filter((r) => r.disponible_en_bloque_1).map((r) => r.clave).sort()).toEqual([
        "administracion", "direccion", "encargado", "recepcion",
      ]);
    });

    it("ningún rol tiene permisos ni nadie tiene asignaciones al terminar las migraciones", async () => {
      const [{ n: rp }] = await sql`select count(*)::int as n from rol_permiso`;
      const [{ n: as }] = await sql`select count(*)::int as n from asignacion`;
      const [{ n: fa }] = await sql`select count(*)::int as n from facultad_otorgada`;
      expect([rp, as, fa]).toEqual([0, 0, 0]);
    });

    it("una facultad de autorización no puede formar parte de un rol", async () => {
      const e = await debeFallar(
        (tx) => tx`insert into rol_permiso (rol, permiso) values ('direccion', 'autorizacion.gasto')`,
      );
      expect(e.message).toMatch(/se otorga expresamente/);
      await sql`insert into rol_permiso (rol, permiso) values ('recepcion', 'visita.registrar')`;
      await sql`delete from rol_permiso where rol = 'recepcion'`;
    });

    it("una asignación exige sucursal o «todas» explícito, nunca ambas ni ninguna", async () => {
      const [u] = await sql`insert into usuario (nombre, correo) values ('Ana Prueba', 'ana@prueba.invalid') returning id`;
      const [s] = await sql`select id from sucursal where codigo = 'UNI'`;
      await debeFallar(
        (tx) => tx`insert into asignacion (usuario_id, rol, motivo) values (${u.id}, 'recepcion', 'sin alcance')`,
      );
      await debeFallar(
        (tx) => tx`insert into asignacion (usuario_id, rol, sucursal_id, todas_las_sucursales, motivo)
                   values (${u.id}, 'recepcion', ${s.id}, true, 'ambos')`,
      );
      await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
                values (${u.id}, 'recepcion', ${s.id}, 'Asignación de prueba')`;
      await sql`insert into asignacion (usuario_id, rol, todas_las_sucursales, motivo)
                values (${u.id}, 'direccion', true, 'Alcance general explícito de prueba')`;
    });

    it("una asignación exige motivo", async () => {
      const [u] = await sql`select id from usuario where correo = 'ana@prueba.invalid'`;
      const [s] = await sql`select id from sucursal where codigo = 'NVA'`;
      await debeFallar(
        (tx) => tx`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, 'encargado', ${s.id}, '  ')`,
      );
    });

    it("el correo se guarda en minúsculas y es único; un usuario no se puede borrar", async () => {
      await debeFallar((tx) => tx`insert into usuario (nombre, correo) values ('X', 'Mayus@prueba.invalid')`);
      await debeFallar((tx) => tx`insert into usuario (nombre, correo) values ('Ana Dos', 'ana@prueba.invalid')`);
      await debeFallar((tx) => tx`delete from usuario where correo = 'ana@prueba.invalid'`);
    });
  });

  describe("historial de cambios", () => {
    it("solo admite agregar registros", async () => {
      const [h] = await sql`
        insert into historial_cambio (entidad, entidad_id, accion, motivo)
        values ('sucursal', 'x', 'crear', 'prueba') returning id`;
      await debeFallar((tx) => tx`update historial_cambio set motivo = 'otro' where id = ${h.id}`);
      await debeFallar((tx) => tx`delete from historial_cambio where id = ${h.id}`);
      await debeFallar((tx) => tx`truncate historial_cambio`);
    });
  });

  describe("datos ficticios", () => {
    it("se cargan sin asignar nada y se pueden repetir sin duplicar", async () => {
      const primera = await cargarDatosPrueba(sql, { entorno: "pruebas" });
      expect(primera).toEqual({ sucursales: SUCURSALES_PRUEBA.length, usuarios: USUARIOS_PRUEBA.length });
      const segunda = await cargarDatosPrueba(sql, { entorno: "pruebas" });
      expect(segunda).toEqual({ sucursales: 0, usuarios: 0 });

      const [{ n }] = await sql`select count(*)::int as n from usuario where es_prueba`;
      expect(n).toBe(USUARIOS_PRUEBA.length);
      const sinAsignar = await sql`
        select u.correo from usuario u
        where u.es_prueba and exists (select 1 from asignacion a where a.usuario_id = u.id)`;
      expect(sinAsignar).toEqual([]);
    });

    it("todos los correos de prueba usan el dominio reservado .invalid", () => {
      for (const u of USUARIOS_PRUEBA) expect(u.correo).toMatch(/\.invalid$/);
    });

    it("se niegan a cargarse en producción", async () => {
      await expect(cargarDatosPrueba(sql, { entorno: "produccion" })).rejects.toThrow(/producción/);
    });
  });
});

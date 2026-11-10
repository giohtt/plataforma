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
import {
  ALCANCES_PRUEBA,
  ASIGNACIONES_PRUEBA,
  cargarDatosPrueba,
  FACULTADES_PRUEBA,
  VISITANTES_PRUEBA,
  DISTINTOS_PRUEBA,
  SUCURSALES_PRUEBA,
  USUARIOS_PRUEBA,
} from "../../scripts/datos-prueba.mjs";

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

    it("al terminar las migraciones nadie tiene asignaciones, alcance general ni facultades", async () => {
      const [{ n: as }] = await sql`select count(*)::int as n from asignacion`;
      const [{ n: ag }] = await sql`select count(*)::int as n from alcance_general`;
      const [{ n: fa }] = await sql`select count(*)::int as n from facultad_otorgada`;
      expect([as, ag, fa]).toEqual([0, 0, 0]);
    });

    it("los perfiles solo tienen permisos de los bloques construidos (1 a 4) y ninguno de autorización", async () => {
      const filas = await sql`
        select rp.rol, rp.permiso, p.bloque, p.es_autorizacion from rol_permiso rp join permiso p on p.clave = rp.permiso`;
      expect(filas.length).toBeGreaterThan(0);
      expect(filas.every((f) => f.bloque <= 4 && !f.es_autorizacion)).toBe(true);
      const recepcion = filas.filter((f) => f.rol === "recepcion").map((f) => f.permiso).sort();
      expect(recepcion).toEqual(["acceso.registrar_apertura", "sucursal.consultar", "turno.abrir", "turno.consultar", "visita.registrar", "visita.solicitar_cancelacion", "visitante.buscar", "visitante.consultar", "visitante.crear"]);
      // Registrar visitas: solo Recepción (provisional); además, solo la responsable de la bolsa.
      expect(filas.filter((f) => f.permiso === "visita.registrar").map((f) => f.rol)).toEqual(["recepcion"]);
      // Verificar abonos de transferencias: Administración y Dirección (provisional). Recepción no.
      expect(filas.filter((f) => f.permiso === "cobro.verificar_abono").map((f) => f.rol).sort()).toEqual(["administracion", "direccion"]);
      // Abrir turno: solo Recepción (provisional). El reporte de turnos no es para Recepción.
      expect(filas.filter((f) => f.permiso === "reporte.turnos").map((f) => f.rol).sort()).toEqual(["administracion", "direccion", "encargado"]);
      expect(filas.filter((f) => f.permiso === "turno.abrir").map((f) => f.rol)).toEqual(["recepcion"]);
      // Reporte de visitas y cobros: Encargado, Administración y Dirección. Recepción no.
      expect(filas.filter((f) => f.permiso === "reporte.visitas").map((f) => f.rol).sort()).toEqual(["administracion", "direccion", "encargado"]);
      // Accesos: Recepción registra; Encargado autoriza por rol (Dirección solo con permiso explícito); revisan Encargado, Administración y Dirección.
      expect(filas.filter((f) => f.permiso === "acceso.registrar_apertura").map((f) => f.rol)).toEqual(["recepcion"]);
      expect(filas.filter((f) => f.permiso === "acceso.autorizar").map((f) => f.rol)).toEqual(["encargado"]);
      expect(filas.filter((f) => f.permiso === "acceso.consultar").map((f) => f.rol).sort()).toEqual(["administracion", "direccion", "encargado"]);
      // Corregir: Encargado y Dirección. Fusionar: solo Dirección. Historial general: nadie todavía.
      expect(filas.filter((f) => f.permiso === "visitante.corregir").map((f) => f.rol).sort()).toEqual(["direccion", "encargado"]);
      expect(filas.filter((f) => f.permiso === "visitante.fusionar").map((f) => f.rol)).toEqual(["direccion"]);
      expect(filas.some((f) => f.permiso === "visitante.historial_general")).toBe(false);
    });

    it("una facultad de autorización no puede formar parte de un rol", async () => {
      const e = await debeFallar(
        (tx) => tx`insert into rol_permiso (rol, permiso) values ('direccion', 'autorizacion.gasto')`,
      );
      expect(e.message).toMatch(/se otorga expresamente/);
      await sql`insert into rol_permiso (rol, permiso) values ('recepcion', 'visita.consultar')`;
      await sql`delete from rol_permiso where rol = 'recepcion' and permiso = 'visita.consultar'`;
    });

    it("una asignación de perfil es siempre para una sucursal; «todas» se otorga aparte", async () => {
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
      await debeFallar(
        (tx) => tx`insert into asignacion (usuario_id, rol, todas_las_sucursales, motivo)
                   values (${u.id}, 'direccion', true, 'todas por asignación')`,
      );
      await sql`insert into alcance_general (usuario_id, rol, motivo)
                values (${u.id}, 'direccion', 'Alcance general explícito de prueba')`;
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
    it("se cargan con sus accesos y se pueden repetir sin duplicar", async () => {
      const primera = await cargarDatosPrueba(sql, { entorno: "pruebas" });
      expect(primera).toEqual({
        sucursales: SUCURSALES_PRUEBA.length,
        usuarios: USUARIOS_PRUEBA.length,
        asignaciones: ASIGNACIONES_PRUEBA.length,
        alcances: ALCANCES_PRUEBA.length,
        facultades: FACULTADES_PRUEBA.length,
        visitantes: VISITANTES_PRUEBA.length,
        distintos: DISTINTOS_PRUEBA.length,
      });
      const segunda = await cargarDatosPrueba(sql, { entorno: "pruebas" });
      expect(segunda).toEqual({ sucursales: 0, usuarios: 0, asignaciones: 0, alcances: 0, facultades: 0, visitantes: 0, distintos: 0 });

      const [{ n }] = await sql`select count(*)::int as n from usuario where es_prueba`;
      expect(n).toBe(USUARIOS_PRUEBA.length);
      const [sin] = await sql`
        select count(*)::int as n from asignacion a join usuario u on u.id = a.usuario_id
        where u.correo = 'sin.asignaciones@prueba.fitnessland.invalid'`;
      expect(sin.n).toBe(0);
    });

    it("todos los correos de prueba usan el dominio reservado .invalid", () => {
      for (const u of USUARIOS_PRUEBA) expect(u.correo).toMatch(/\.invalid$/);
    });

    it("se niegan a cargarse en producción", async () => {
      await expect(cargarDatosPrueba(sql, { entorno: "produccion" })).rejects.toThrow(/producción/);
    });
  });
});

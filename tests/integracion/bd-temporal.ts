import postgres from "postgres";
import { aplicarMigraciones } from "../../scripts/migrar.mjs";

/**
 * Crea una base temporal con todas las migraciones aplicadas y la borra al cerrar.
 * Requiere TEST_DATABASE_URL; en GitHub es obligatoria.
 */
export const URL_ADMIN = process.env.TEST_DATABASE_URL;
if (!URL_ADMIN && process.env.CI) {
  throw new Error("Falta TEST_DATABASE_URL: en GitHub las pruebas de base de datos son obligatorias.");
}

export async function crearBaseTemporal({ conexiones = 1 }: { conexiones?: number } = {}) {
  const nombre = `prueba_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = postgres(URL_ADMIN!, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${nombre}`);
  const url = new URL(URL_ADMIN!);
  url.pathname = `/${nombre}`;
  const sql = postgres(url.toString(), { max: conexiones, prepare: false, onnotice: () => {} });
  await aplicarMigraciones(sql);
  return {
    sql,
    async cerrar() {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${nombre} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}

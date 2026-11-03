#!/usr/bin/env node
/**
 * Aplica las migraciones de db/migraciones en orden.
 *
 * - Cada migración se aplica en su propia transacción: o se aplica completa o no se aplica.
 * - Se registra su nombre y su huella (SHA-256). Si una migración ya aplicada cambia, se detiene:
 *   las migraciones no se editan, se agregan nuevas.
 * - Un candado de transacción evita que dos publicaciones simultáneas apliquen lo mismo.
 *
 * Uso: DATABASE_URL=... node scripts/migrar.mjs
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const DIRECTORIO_MIGRACIONES = path.resolve(AQUI, "..", "db", "migraciones");

export async function leerMigraciones(directorio = DIRECTORIO_MIGRACIONES) {
  const archivos = (await readdir(directorio)).filter((a) => /^\d{4}_[a-z0-9_]+\.sql$/.test(a)).sort();
  return Promise.all(
    archivos.map(async (nombre) => {
      const contenido = await readFile(path.join(directorio, nombre), "utf8");
      const huella = createHash("sha256").update(contenido).digest("hex");
      return { nombre, contenido, huella };
    }),
  );
}

/**
 * Aplica las migraciones pendientes. Devuelve los nombres de las que aplicó.
 * @param {import("postgres").Sql} sql
 * @param {{ directorio?: string, registrar?: (mensaje: string) => void }} [opciones]
 * @returns {Promise<string[]>}
 */
export async function aplicarMigraciones(sql, { directorio = DIRECTORIO_MIGRACIONES, registrar = () => {} } = {}) {
  await sql.unsafe(`
    create table if not exists esquema_migracion (
      nombre      text primary key,
      huella      text not null,
      aplicada_en timestamptz not null default now()
    )`);

  const migraciones = await leerMigraciones(directorio);
  const aplicadas = [];

  for (const m of migraciones) {
    const aplicada = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('fitnessland_migraciones'))`;
      const [previa] = await tx`select huella from esquema_migracion where nombre = ${m.nombre}`;
      if (previa) {
        if (previa.huella !== m.huella) {
          throw new Error(
            `La migración ${m.nombre} ya se aplicó y su archivo cambió. No edites migraciones aplicadas: crea una nueva.`,
          );
        }
        return false;
      }
      await tx.unsafe(m.contenido);
      await tx`insert into esquema_migracion (nombre, huella) values (${m.nombre}, ${m.huella})`;
      return true;
    });
    if (aplicada) {
      aplicadas.push(m.nombre);
      registrar(`Aplicada: ${m.nombre}`);
    }
  }
  return aplicadas;
}

/** Opciones de conexión. prepare:false permite usar el agrupador de conexiones de Neon. */
export function conectar(url) {
  return postgres(url, { prepare: false, max: 1, connect_timeout: 10, onnotice: () => {} });
}

async function principal() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // En la producción de un proyecto de Vercel la base es obligatoria; en versiones de vista previa
    // y en la compilación de GitHub no hay base y no se migra.
    if (process.env.VERCEL_ENV === "production") {
      console.error("Falta DATABASE_URL en este proyecto de Vercel. No se puede publicar sin base de datos.");
      process.exit(1);
    }
    console.log("Sin DATABASE_URL: no se aplican migraciones.");
    return;
  }
  const sql = conectar(url);
  try {
    const aplicadas = await aplicarMigraciones(sql, { registrar: (m) => console.log(m) });
    console.log(aplicadas.length ? `Migraciones aplicadas: ${aplicadas.length}.` : "La base ya estaba al día.");
  } catch (e) {
    console.error(`No se pudieron aplicar las migraciones: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await principal();
}

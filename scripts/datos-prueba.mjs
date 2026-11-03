#!/usr/bin/env node
/**
 * Carga datos ficticios para desarrollo y pruebas: sucursales y usuarios de prueba.
 *
 * - Nunca se ejecuta en producción.
 * - No asigna roles, sucursales ni facultades a nadie (eso es la tarea 4).
 * - Se puede repetir: lo que ya existe no se modifica ni se duplica.
 *
 * Uso:
 *   DATABASE_URL=... node scripts/datos-prueba.mjs              carga los datos (falla en producción)
 *   DATABASE_URL=... node scripts/datos-prueba.mjs --solo-pruebas
 *       solo actúa si APP_ENV=pruebas; en cualquier otro caso no hace nada. Se usa al publicar en Vercel.
 */
import { pathToFileURL } from "node:url";
import { conectar } from "./migrar.mjs";

const VALIDOS = ["desarrollo", "pruebas", "produccion"];
export function normalizarEntorno(valor) {
  const limpio = (valor ?? "").trim().toLowerCase();
  return VALIDOS.includes(limpio) ? limpio : "desarrollo";
}

/** Sucursales precargadas. Colores acordados; datos operativos de demostración. */
export const SUCURSALES_PRUEBA = [
  { codigo: "TEN", nombre: "Tenango", color: "#c62828" },
  { codigo: "STG", nombre: "Santiago", color: "#1b7a3e" },
  { codigo: "ATL", nombre: "Atlacomulco", color: "#f4c20d" },
  { codigo: "RAY", nombre: "Rayón", color: "#6a2c9e" },
  { codigo: "SAD", nombre: "San Andrés", color: "#161616" },
  { codigo: "SCR", nombre: "San Cristóbal", color: null },
];

/** Usuarios ficticios. El dominio .invalid está reservado y nunca recibe correo real. */
export const USUARIOS_PRUEBA = [
  { correo: "recepcion.tenango@prueba.fitnessland.invalid", nombre: "Recepción Tenango (prueba)" },
  { correo: "recepcion.santiago@prueba.fitnessland.invalid", nombre: "Recepción Santiago (prueba)" },
  { correo: "encargado.tenango@prueba.fitnessland.invalid", nombre: "Encargado Tenango (prueba)" },
  { correo: "administracion@prueba.fitnessland.invalid", nombre: "Administración (prueba)" },
  { correo: "direccion@prueba.fitnessland.invalid", nombre: "Dirección (prueba)" },
];

const MOTIVO = "Datos ficticios de prueba";

export async function cargarDatosPrueba(sql, { entorno }) {
  if (normalizarEntorno(entorno) === "produccion") {
    throw new Error("Los datos ficticios no se cargan en producción.");
  }
  return sql.begin(async (tx) => {
    let sucursales = 0;
    let usuarios = 0;
    for (const s of SUCURSALES_PRUEBA) {
      const filas = await tx`
        insert into sucursal (nombre, codigo, color, estado_operativo)
        values (${s.nombre}, ${s.codigo}, ${s.color}, 'activa')
        on conflict do nothing
        returning id`;
      if (filas.length) {
        sucursales++;
        await tx`
          insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo)
          values ('sucursal', ${filas[0].id}, 'crear', ${tx.json(s)}, ${MOTIVO})`;
      }
    }
    for (const u of USUARIOS_PRUEBA) {
      const filas = await tx`
        insert into usuario (nombre, correo, es_prueba)
        values (${u.nombre}, ${u.correo}, true)
        on conflict do nothing
        returning id`;
      if (filas.length) {
        usuarios++;
        await tx`
          insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo)
          values ('usuario', ${filas[0].id}, 'crear', ${tx.json(u)}, ${MOTIVO})`;
      }
    }
    return { sucursales, usuarios };
  });
}

async function principal() {
  const soloPruebas = process.argv.includes("--solo-pruebas");
  const entorno = normalizarEntorno(process.env.APP_ENV);
  const url = process.env.DATABASE_URL;

  if (soloPruebas && entorno !== "pruebas") {
    console.log(`Entorno «${entorno}»: no se cargan datos ficticios automáticamente.`);
    return;
  }
  if (entorno === "produccion") {
    console.error("Los datos ficticios no se cargan en producción.");
    process.exit(1);
  }
  if (!url) {
    if (soloPruebas) {
      console.log("Sin DATABASE_URL: no se cargan datos ficticios.");
      return;
    }
    console.error("Falta DATABASE_URL.");
    process.exit(1);
  }
  const sql = conectar(url);
  try {
    const r = await cargarDatosPrueba(sql, { entorno });
    console.log(`Datos ficticios: ${r.sucursales} sucursales y ${r.usuarios} usuarios nuevos.`);
  } catch (e) {
    console.error(`No se pudieron cargar los datos ficticios: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await principal();
}

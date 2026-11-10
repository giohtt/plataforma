"use server";

/** Cobertura del historial por sucursal: la registra Dirección. Permiso y validaciones en src/lib/historial.ts. */
import { redirect } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { registrarCobertura, type ErrorCobertura } from "@/lib/historial";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

const MENSAJES: Record<ErrorCobertura, string> = {
  no_encontrada: "No encontrada.",
  fecha: "Escribe una fecha válida que no sea futura.",
  nota: "La nota debe tener de 5 a 300 caracteres, o déjala vacía.",
  bloqueado_produccion: "Registrar la cobertura está desactivado fuera del entorno de pruebas.",
};

export type EstadoCobertura = { error?: string; intento: number } | null;

export async function accionRegistrarCobertura(previo: EstadoCobertura, datos: FormData): Promise<EstadoCobertura> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  const leer = (c: string, max: number) => { const v = datos.get(c); return typeof v === "string" ? v.slice(0, max) : ""; };
  const codigo = leer("codigo", 10);
  const r = await registrarCobertura(sql, sesion.usuarioId, codigo, {
    desde: leer("desde", 12), desdeInicio: leer("desdeInicio", 5) === "si", nota: leer("nota", 400),
  }, { entorno: leerEntorno() });
  if (!r.ok) return { error: MENSAJES[r.error], intento: (previo?.intento ?? 0) + 1 };
  redirect(`/sucursales/${codigo}/cobertura?aviso=registrada`);
}

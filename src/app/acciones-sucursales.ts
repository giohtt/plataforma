"use server";

/**
 * Acciones del catálogo de sucursales. Se pueden invocar con una solicitud POST directa, así que
 * aquí se lee la sesión y todo lo demás (permiso, versión, duplicados) se comprueba en
 * src/lib/catalogo-sucursales.ts dentro de la transacción que guarda el cambio.
 */
import { redirect } from "next/navigation";
import {
  cambiarActividadSucursal,
  crearSucursal,
  editarSucursal,
  type ErrorCatalogo,
  type ResultadoCatalogo,
} from "@/lib/catalogo-sucursales";
import { validarDatosSucursal, validarMotivo, validarNuevaSucursal, type ErroresCampos } from "@/lib/datos-sucursal";
import { obtenerBaseDatos } from "@/lib/db";
import { tienePermiso } from "@/lib/permisos";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

export type EstadoFormularioSucursal = {
  error?: string;
  errores?: ErroresCampos;
  /** Lo que la persona escribió, para no perderlo si hay que corregir algo. */
  valores?: Record<string, string>;
  intento: number;
} | null;

const MENSAJES: Record<ErrorCatalogo, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para hacer este cambio.",
  nombre_duplicado: "Ya existe una sucursal con ese nombre (sin contar mayúsculas ni acentos).",
  codigo_duplicado: "Ya existe una sucursal con ese código.",
  modificada: "Otra persona guardó cambios en esta sucursal mientras la editabas. Recarga la página para ver la versión actual.",
  sin_cambios: "No hay cambios que guardar.",
  estado_invalido: "La sucursal ya estaba en ese estado. Recarga la página.",
};

const CAMPOS = ["nombre", "codigo", "color", "sinColor", "direccion", "estadoRepublica", "estadoOperativo", "motivo", "confirmo"] as const;

function leer(datos: FormData): Record<string, string> {
  const valores: Record<string, string> = {};
  for (const campo of CAMPOS) {
    const v = datos.get(campo);
    if (typeof v === "string") valores[campo] = v.slice(0, 400);
  }
  return valores;
}

function datosDeFormulario(v: Record<string, string>) {
  return { ...v, color: v.sinColor ? "" : v.color };
}

function fallo(previo: EstadoFormularioSucursal, valores: Record<string, string>, extra: Omit<NonNullable<EstadoFormularioSucursal>, "intento" | "valores">) {
  return { ...extra, valores, intento: (previo?.intento ?? 0) + 1 };
}

async function sesionYBase() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}

function numero(valor: FormDataEntryValue | null): number {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export async function accionCrearSucursal(previo: EstadoFormularioSucursal, datos: FormData): Promise<EstadoFormularioSucursal> {
  const { sesion, sql } = await sesionYBase();
  const valores = leer(datos);
  const v = validarNuevaSucursal(datosDeFormulario(valores));
  if (!v.ok) return fallo(previo, valores, { error: "Revisa los campos marcados.", errores: v.errores });
  const motivo = valores.motivo?.trim() ? validarMotivo(valores.motivo) : null;
  if (valores.motivo?.trim() && !motivo) return fallo(previo, valores, { errores: { motivo: "De 5 a 300 caracteres, o déjalo vacío." } });

  const r = await crearSucursal(sql, sesion.usuarioId, v.datos, motivo);
  if (!r.ok) return fallo(previo, valores, erroresDe(r));
  // Quien crea solo la ve si ya tenía acceso a todas las sucursales; crear no asigna a nadie.
  if (await tienePermiso(sql, sesion.usuarioId, "sucursal.consultar", r.id)) redirect(`/sucursales/${r.codigo}?aviso=creada`);
  redirect("/?aviso=creada");
}

export async function accionEditarSucursal(previo: EstadoFormularioSucursal, datos: FormData): Promise<EstadoFormularioSucursal> {
  const { sesion, sql } = await sesionYBase();
  const valores = leer(datos);
  const v = validarDatosSucursal(datosDeFormulario(valores));
  const motivo = validarMotivo(valores.motivo);
  const errores: ErroresCampos = v.ok ? {} : { ...v.errores };
  if (!motivo) errores.motivo = "Explica el cambio en 5 a 300 caracteres. Queda en el historial.";
  if (!v.ok || !motivo) return fallo(previo, valores, { error: "Revisa los campos marcados.", errores });

  const r = await editarSucursal(sql, sesion.usuarioId, String(datos.get("id") ?? ""), numero(datos.get("version")), v.datos, motivo);
  if (!r.ok) return fallo(previo, valores, erroresDe(r));
  redirect(`/sucursales/${r.codigo}?aviso=guardada`);
}

export async function accionCambiarActividad(previo: EstadoFormularioSucursal, datos: FormData): Promise<EstadoFormularioSucursal> {
  const { sesion, sql } = await sesionYBase();
  const valores = leer(datos);
  const tipo = datos.get("tipo");
  const motivo = validarMotivo(valores.motivo);
  const errores: ErroresCampos = {};
  if (!motivo) errores.motivo = "Explica el motivo en 5 a 300 caracteres. Queda en el historial.";
  if (tipo === "desactivar" && valores.confirmo !== "si") errores.estadoOperativo = "Marca la casilla para confirmar.";
  const estado = valores.estadoOperativo;
  if (tipo === "reactivar" && estado !== "activa" && estado !== "proxima") errores.estadoOperativo = "Elige el estado con el que vuelve.";
  if ((tipo !== "desactivar" && tipo !== "reactivar") || !motivo || Object.keys(errores).length) {
    return fallo(previo, valores, { error: "Revisa los campos marcados.", errores });
  }

  const r = await cambiarActividadSucursal(
    sql,
    sesion.usuarioId,
    String(datos.get("id") ?? ""),
    numero(datos.get("version")),
    motivo,
    tipo === "desactivar" ? { tipo } : { tipo, estado: estado as "activa" | "proxima" },
  );
  if (!r.ok) return fallo(previo, valores, erroresDe(r));
  redirect(`/sucursales/${r.codigo}?aviso=${tipo === "desactivar" ? "desactivada" : "reactivada"}`);
}

function erroresDe(r: Extract<ResultadoCatalogo, { ok: false }>) {
  const errores: ErroresCampos = {};
  if (r.error === "nombre_duplicado") errores.nombre = MENSAJES.nombre_duplicado;
  if (r.error === "codigo_duplicado") errores.codigo = MENSAJES.codigo_duplicado;
  return { error: MENSAJES[r.error], errores };
}

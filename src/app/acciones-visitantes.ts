"use server";

/**
 * Búsqueda y alta de expedientes. Las dos van por POST: el nombre y el teléfono viajan en el cuerpo de la
 * solicitud y nunca en la dirección (no quedan en el historial del navegador, en registros de acceso ni en
 * enlaces compartidos). Se pueden invocar con un POST directo: aquí solo se lee la sesión y el formulario;
 * permisos, coincidencias y bloqueo en producción se comprueban en src/lib/visitantes.ts.
 */
import { redirect } from "next/navigation";
import { corregirVisitante } from "@/lib/correccion-visitantes";
import { interpretarConsulta, validarCorreccion, validarVisitante, type ErroresVisitante } from "@/lib/datos-visitante";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";
import { buscarVisitantes, crearVisitante, type ResultadoVisitante } from "@/lib/visitantes";

export type EstadoAltaVisitante = {
  error?: string;
  errores?: ErroresVisitante;
  valores?: Record<string, string>;
  coincidencias?: ResultadoVisitante[];
  intento: number;
} | null;

const MENSAJES = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para crear expedientes.",
  bloqueado_produccion: "Los expedientes están desactivados hasta aprobar el aviso de privacidad.",
} as const;

export async function accionCrearVisitante(previo: EstadoAltaVisitante, datos: FormData): Promise<EstadoAltaVisitante> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");

  const texto = (campo: string) => {
    const v = datos.get(campo);
    return typeof v === "string" ? v.slice(0, 200) : "";
  };
  const codigo = texto("codigo");
  const valores = { nombre: texto("nombre"), telefono: texto("telefono"), estadoProcedencia: texto("estadoProcedencia") };
  const intento = (previo?.intento ?? 0) + 1;

  const v = validarVisitante(valores);
  if (!v.ok) return { error: "Revisa los campos marcados.", errores: v.errores, valores, intento };

  // Solo cuentan como confirmados los expedientes mostrados, y solo si se marcó la casilla.
  const confirmados = datos.get("confirmo") === "si" ? datos.getAll("distinto").filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  const r = await crearVisitante(sql, sesion.usuarioId, codigo, v.datos, confirmados, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/visitantes/${r.id}?aviso=creado`);
  if (r.error === "coincidencias") {
    return {
      error: confirmados.length
        ? "Apareció otra posible coincidencia. Revísala antes de continuar."
        : "Hay expedientes que podrían ser de esta persona. Elige uno o confirma que es otra persona.",
      coincidencias: r.coincidencias,
      valores,
      intento,
    };
  }
  return { error: MENSAJES[r.error], valores, intento };
}

export type EstadoBusqueda = {
  error?: string;
  resultados?: ResultadoVisitante[];
  limitado?: boolean;
  /** Lo que se buscó, devuelto en la respuesta (no en la dirección) para pasarlo al alta. */
  texto: string;
  intento: number;
} | null;

export async function accionBuscarVisitantes(previo: EstadoBusqueda, datos: FormData): Promise<EstadoBusqueda> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  const leer = (campo: string) => {
    const v = datos.get(campo);
    return typeof v === "string" ? v.slice(0, 120) : "";
  };
  const texto = leer("q");
  const intento = (previo?.intento ?? 0) + 1;
  const r = await buscarVisitantes(sql, sesion.usuarioId, leer("codigo"), interpretarConsulta(texto));
  if (!r.ok) return { error: r.error === "no_encontrada" ? "No encontrada." : r.motivo, texto, intento };
  return { resultados: r.resultados, limitado: r.limitado, texto, intento };
}

export type EstadoCorreccion = {
  error?: string;
  errores?: ErroresVisitante & { motivo?: string };
  valores?: Record<string, string>;
  coincidencias?: ResultadoVisitante[];
  intento: number;
} | null;

const MENSAJES_CORRECCION = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para corregir este expediente.",
  modificada: "Otra persona corrigió este expediente mientras lo editabas. Recarga la página para ver los datos actuales.",
  sin_cambios: "No hay cambios que guardar.",
  motivo: "Explica el motivo de la corrección (de 5 a 300 caracteres).",
  bloqueado_produccion: "Los expedientes están desactivados hasta aprobar el aviso de privacidad.",
} as const;

/** Corrección de un expediente, por POST. Permisos, versión y coincidencias se comprueban en el servidor. */
export async function accionCorregirVisitante(previo: EstadoCorreccion, datos: FormData): Promise<EstadoCorreccion> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  const texto = (campo: string, max = 300) => {
    const v = datos.get(campo);
    return typeof v === "string" ? v.slice(0, max) : "";
  };
  const codigo = texto("codigo", 10);
  const id = texto("id", 40);
  const valores = {
    nombre: texto("nombre", 200),
    telefono: texto("telefono", 30),
    quitarTelefono: texto("quitarTelefono", 3),
    estadoProcedencia: texto("estadoProcedencia", 60),
    motivo: texto("motivo"),
  };
  const intento = (previo?.intento ?? 0) + 1;

  const v = validarCorreccion(valores);
  const motivoValido = valores.motivo.trim().length >= 5;
  if (!v.ok || !motivoValido) {
    const errores = { ...(v.ok ? {} : v.errores), ...(motivoValido ? {} : { motivo: MENSAJES_CORRECCION.motivo }) };
    return { error: "Revisa los campos marcados.", errores, valores, intento };
  }

  const vistas = datos.get("confirmo") === "si" ? datos.getAll("coincidencia").filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  const version = Number(texto("version", 10));
  const r = await corregirVisitante(sql, sesion.usuarioId, codigo, id, Number.isInteger(version) ? version : 0, v.datos, valores.motivo, {
    entorno: leerEntorno(),
    coincidenciasVistas: vistas,
  });
  if (r.ok) redirect(`/sucursales/${codigo}/visitantes/${id}?aviso=corregido`);
  if (r.error === "coincidencias") {
    return {
      error: "Con estos datos, el expediente se parece a otros. Revísalos: si es la misma persona, no guardes; la unión de duplicados se hace aparte.",
      coincidencias: r.coincidencias,
      valores,
      intento,
    };
  }
  return { error: MENSAJES_CORRECCION[r.error], valores, intento };
}

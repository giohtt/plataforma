"use server";

/**
 * Cierre del día y custodia nocturna (bloque 5, regla 7), por POST. Aquí se leen la sesión y el formulario; permisos,
 * responsables, bloqueos, custodio, verificación de sobres y producción se comprueban en src/lib/cierres.ts.
 */
import { redirect } from "next/navigation";
import type { EstadoFormularioEntrega } from "@/app/acciones-entrega";
import {
  abrirDesdeCierre, cancelarPreparacionCierre, cerrarDia, configurarCustodia, confirmarCustodia, prepararCierre, terminarApertura,
  type ErrorApertura, type ErrorCierre, type VerificacionDatos,
} from "@/lib/cierres";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { importes, leerApoyo } from "@/lib/formulario-conteo";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

const MENSAJES_CIERRE: Record<ErrorCierre, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para cerrar el turno en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada.",
  sin_turno: "No hay turno abierto en esta sucursal.",
  no_responsable: "Solo la responsable vigente de la bolsa y del cajón cierra el turno.",
  entrega_en_curso: "Hay un cambio de turno en curso: confírmalo o cancélalo antes de cerrar.",
  retiro_en_preparacion: "Hay un retiro con folio en preparación: confirma la entrega o cancela la preparación antes de cerrar.",
  cancelaciones_pendientes: "Hay solicitudes de cancelación pendientes en este turno: deben resolverse antes de cerrar.",
  sin_configuracion: "Dirección todavía no define dónde se guardan los sobres ni quién tiene acceso en esta sucursal.",
  sin_preparacion: "Genera los folios de los sobres antes de cerrar.",
  custodio: "Elige al Encargado de la sucursal que queda como custodio nocturno.",
  nota: "La nota debe tener entre 5 y 300 caracteres, o déjala vacía.",
  apoyo: "Indica si alguien te ayudó a contar y, si sí, elige a las personas de la sucursal que participaron.",
  cambio: "El turno cambió mientras tenías la pantalla abierta. Revisa los datos actuales.",
  bloqueado_produccion: "El cierre del día está desactivado fuera del entorno de pruebas.",
};
const MENSAJES_APERTURA: Record<ErrorApertura, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para abrir turno en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada.",
  sin_cierre: "No hay un cierre pendiente de apertura en esta sucursal.",
  otra_persona: "Otra persona ya empezó a abrir desde este cierre.",
  cambio: "El cierre cambió mientras tenías la pantalla abierta. Revisa los datos actuales.",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
  apoyo: "Indica si alguien te ayudó a contar y, si sí, elige a las personas de la sucursal que participaron.",
  sobres: "Verifica cada sobre.",
  estado: "Indica cómo llegó cada sobre.",
  folio_visto: "Escribe el folio que trae el sobre.",
  bloqueado_produccion: "La apertura está desactivada fuera del entorno de pruebas.",
};

async function inicio() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}
const lector = (datos: FormData) => (campo: string, max = 30) => {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
};
/** Sello y folio de cada sobre: campos sobre-<id>, folio-<id> y motivo-<id>. */
function leerSobres(datos: FormData): { sobres: VerificacionDatos[]; valores: Record<string, string> } {
  const leer = lector(datos);
  const ids = datos.getAll("sobre").filter((s): s is string => typeof s === "string").slice(0, 2).map((s) => s.slice(0, 40));
  const valores: Record<string, string> = {};
  const sobres = ids.map((id) => {
    const v = { sobreId: id, estado: leer(`estado-${id}`), folioVisto: leer(`folio-${id}`, 40), motivo: leer(`motivo-${id}`, 400) };
    Object.assign(valores, { [`estado-${id}`]: v.estado, [`folio-${id}`]: v.folioVisto, [`motivo-${id}`]: v.motivo });
    return v;
  });
  return { sobres, valores };
}
const MENSAJE_SOBRE = { sobres: "Verifica cada sobre.", estado: "Indica cómo llegó el sobre.", folio_visto: "Escribe el folio que trae el sobre.", motivo: "Escribe el motivo (de 5 a 300 caracteres)." };

// --- Recepción: preparar, cancelar y cerrar -----------------------------------------------------------------

export async function accionPrepararCierre(datos: FormData): Promise<void> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const r = await prepararCierre(sql, sesion.usuarioId, codigo, { turnoId: leer("turno", 40) }, { entorno: leerEntorno() });
  redirect(`/sucursales/${codigo}/turno/cierre${r.ok ? "" : `?error=${r.error}`}`);
}

export async function accionCancelarPreparacionCierre(datos: FormData): Promise<void> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const r = await cancelarPreparacionCierre(sql, sesion.usuarioId, codigo, { turnoId: leer("turno", 40) }, { entorno: leerEntorno() });
  redirect(`/sucursales/${codigo}/turno/cierre?${r.ok ? `cancelados=${encodeURIComponent(r.folios.join(", "))}` : `error=${r.error}`}`);
}

export async function accionCerrarDia(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { bolsa: leer("bolsa"), cajon: leer("cajon"), custodio: leer("custodio", 40), nota: leer("nota", 400), apoyo: leer("apoyo") };
  const intento = (previo?.intento ?? 0) + 1;
  const i = importes(valores);
  const a = leerApoyo(datos);
  if (!i.ok || !valores.custodio || !a.ok) {
    return {
      error: "Revisa los campos marcados.",
      errores: { ...(i.ok ? {} : i.errores), custodio: valores.custodio ? undefined : MENSAJES_CIERRE.custodio, apoyo: a.ok ? undefined : MENSAJES_CIERRE.apoyo },
      valores, personas: a.personas, intento,
    };
  }
  const r = await cerrarDia(sql, sesion.usuarioId, codigo,
    { turnoId: leer("turno", 40), conteo: i.conteo, custodio: valores.custodio, nota: valores.nota, apoyo: a.apoyo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/turno?aviso=cerrado`);
  if (r.error === "nota" || r.error === "custodio" || r.error === "apoyo") {
    return { error: "Revisa los campos marcados.", errores: { [r.error]: MENSAJES_CIERRE[r.error] }, valores, personas: a.personas, intento };
  }
  return { error: MENSAJES_CIERRE[r.error], valores, personas: a.personas, intento };
}

// --- Custodio -----------------------------------------------------------------------------------------------

export async function accionConfirmarCustodia(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const { sobres, valores } = leerSobres(datos);
  const ubicacion = leer("ubicacion", 200);
  const intento = (previo?.intento ?? 0) + 1;
  const todos = { ...valores, ubicacion };
  const r = await confirmarCustodia(sql, sesion.usuarioId, codigo, { entregaId: leer("entrega", 40), ubicacion, sobres }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/custodia?aviso=confirmada&incidencias=${r.incidencias}`);
  if (r.error === "ubicacion") return { error: "Revisa los campos marcados.", errores: { ubicacion: "Escribe dónde guardaste los sobres (de 5 a 120 caracteres)." }, valores: todos, intento };
  if (r.error in MENSAJE_SOBRE) {
    const campo = r.sobreId ? `sobre-${r.sobreId}` : "sobres";
    return { error: "Revisa los campos marcados.", errores: { [campo]: MENSAJE_SOBRE[r.error as keyof typeof MENSAJE_SOBRE] }, valores: todos, intento };
  }
  const OTROS: Record<string, string> = {
    no_encontrada: "No tienes una custodia por confirmar en esta sucursal.",
    ya_confirmada: "Ya confirmaste esta custodia.",
    ya_abierto: "El turno ya se está abriendo desde este cierre: la custodia ya no se confirma.",
    bloqueado_produccion: "La custodia está desactivada fuera del entorno de pruebas.",
  };
  return { error: OTROS[r.error] ?? "No disponible.", valores: todos, intento };
}

// --- Apertura -----------------------------------------------------------------------------------------------

export async function accionAbrirDesdeCierre(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const { sobres, valores: vs } = leerSobres(datos);
  const valores = { ...vs, bolsa: leer("bolsa"), cajon: leer("cajon"), apoyo: leer("apoyo") };
  const intento = (previo?.intento ?? 0) + 1;
  const i = importes(valores);
  const a = leerApoyo(datos);
  if (!i.ok || !a.ok) {
    return { error: "Revisa los campos marcados.", errores: { ...(i.ok ? {} : i.errores), apoyo: a.ok ? undefined : MENSAJES_APERTURA.apoyo }, valores, personas: a.personas, intento };
  }
  const r = await abrirDesdeCierre(sql, sesion.usuarioId, codigo,
    { entregaId: leer("entrega", 40), version: Number(leer("version")), sobres, conteo: i.conteo, apoyo: a.apoyo }, { entorno: leerEntorno() });
  if (r.ok && r.resultado === "abierto") redirect(`/sucursales/${codigo}/turno?aviso=abierto-cierre`);
  if (r.ok) redirect(`/sucursales/${codigo}/turno/apertura?aviso=recuento`);
  if (r.error in MENSAJE_SOBRE) {
    const campo = r.sobreId ? `sobre-${r.sobreId}` : "sobres";
    return { error: "Revisa los campos marcados.", errores: { [campo]: MENSAJE_SOBRE[r.error as keyof typeof MENSAJE_SOBRE] }, valores, personas: a.personas, intento };
  }
  if (r.error === "apoyo") return { error: "Revisa los campos marcados.", errores: { apoyo: MENSAJES_APERTURA.apoyo }, valores, personas: a.personas, intento };
  return { error: MENSAJES_APERTURA[r.error], valores, personas: a.personas, intento };
}

export async function accionTerminarApertura(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { recontaron: leer("recontaron"), bolsa: leer("bolsa"), cajon: leer("cajon"), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  if (valores.recontaron !== "si" && valores.recontaron !== "no") {
    return { error: "Revisa los campos marcados.", errores: { recontaron: "Indica si recontaron con el custodio." }, valores, intento };
  }
  const recontaron = valores.recontaron === "si";
  let conteo = null;
  if (recontaron) {
    const i = importes(valores);
    if (!i.ok) return { error: "Revisa los campos marcados.", errores: i.errores, valores, intento };
    conteo = i.conteo;
  }
  const r = await terminarApertura(sql, sesion.usuarioId, codigo,
    { entregaId: leer("entrega", 40), version: Number(leer("version")), recontaron, conteo, motivo: valores.motivo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/turno?aviso=abierto-cierre`);
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errores: { motivo: MENSAJES_APERTURA.motivo }, valores, intento };
  return { error: MENSAJES_APERTURA[r.error], valores, intento };
}

// --- Dirección ----------------------------------------------------------------------------------------------

export async function accionConfigurarCustodia(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const acceso = datos.getAll("acceso").filter((p): p is string => typeof p === "string").slice(0, 10).map((p) => p.slice(0, 40));
  const valores = { lugar: leer("lugar", 200) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await configurarCustodia(sql, sesion.usuarioId, codigo, { lugar: valores.lugar, acceso }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/custodia/configurar?aviso=guardada`);
  if (r.error === "lugar") return { error: "Revisa los campos marcados.", errores: { lugar: "Escribe el lugar (de 5 a 120 caracteres)." }, valores, personas: acceso, intento };
  if (r.error === "acceso") return { error: "Revisa los campos marcados.", errores: { acceso: "Elige de 1 a 10 personas con asignación en la sucursal." }, valores, personas: acceso, intento };
  const OTROS: Record<string, string> = {
    no_encontrada: "No encontrada.",
    sin_permiso: "Solo Dirección con asignación en la sucursal define la custodia.",
    bloqueado_produccion: "La custodia está desactivada fuera del entorno de pruebas.",
  };
  return { error: OTROS[r.error], valores, personas: acceso, intento };
}

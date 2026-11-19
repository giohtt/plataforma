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
import { leerImporte, MENSAJES_IMPORTE } from "@/lib/datos-turno";
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
  custodio: "Elige quién se queda con los sobres y la llave (una de las custodias que nombró Dirección).",
  nota: "La nota debe tener entre 5 y 300 caracteres, o déjala vacía.",
  apoyo: "Indica si alguien te ayudó a contar y, si sí, elige a las personas de la sucursal que participaron.",
  cambio: "El turno cambió mientras tenías la pantalla abierta. Revisa los datos actuales.",
  fondo: "El fondo apartado no puede ser mayor que lo contado ni que el fondo vigente.",
  fondo_primero: "Primero completa el fondo: solo lo que sobra va al sobre.",
  ubicacion: "Escribe dónde guardas los sobres y la llave (de 5 a 120 caracteres).",
  motivo_llave: "Indica si el cajón de los fondos quedó cerrado y tienes su llave; si hay un problema, escribe el motivo (de 5 a 300 caracteres).",
  motivo_llave_caja: "Indica si la caja de sobres quedó cerrada y tienes su llave; si hay un problema, escribe el motivo (de 5 a 300 caracteres).",
  depositados: "Confirma que depositaste cada sobre en el buzón.",
  sobres: "Verifica cada sobre.",
  estado: "Indica cómo quedó cada sobre.",
  folio_visto: "Escribe el folio que trae el sobre.",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
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
  custodia_pendiente: "El custodio todavía no confirma la custodia. Si está disponible, que confirme primero desde su cuenta; si no, marca que no está disponible y escribe el motivo.",
  motivo_custodia: "Escribe por qué abres sin la confirmación del custodio (de 5 a 300 caracteres).",
  fondo: "Revisa el fondo y el sobre de cada lugar.",
  motivo_llave: "Indica si recibiste la llave del cajón de los fondos y, si hay un problema, escribe el motivo (de 5 a 300 caracteres).",
  motivo_llave_caja: "Indica si recibiste la llave de la caja de sobres y, si hay un problema, escribe el motivo (de 5 a 300 caracteres).",
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
  // Los dos sobres del cierre más los que ya estaban guardados en la caja.
  const ids = datos.getAll("sobre").filter((s): s is string => typeof s === "string").slice(0, 80).map((s) => s.slice(0, 40));
  const valores: Record<string, string> = {};
  const sobres = ids.map((id) => {
    const v = { sobreId: id, estado: leer(`estado-${id}`), folioVisto: leer(`folio-${id}`, 40), motivo: leer(`motivo-${id}`, 400) };
    Object.assign(valores, { [`estado-${id}`]: v.estado, [`folio-${id}`]: v.folioVisto, [`motivo-${id}`]: v.motivo });
    return v;
  });
  return { sobres, valores };
}
/** Llave del cajón de los fondos: «correcta» o «incidencia» con motivo. */
function leerLlave(datos: FormData) {
  const leer = lector(datos);
  return { estado: leer("llave") || "", motivo: leer("motivo_llave", 400) };
}
/** Llave de la caja de sobres, por separado. */
function leerLlaveCaja(datos: FormData) {
  const leer = lector(datos);
  return { estado: leer("llave_caja") || "", motivo: leer("motivo_llave_caja", 400) };
}
/** Fondo y sobre de cada lugar (fondo_bolsa, sobre_bolsa, fondo_cajon, sobre_cajon); el total es la suma. */
function leerSeparado(valores: Record<string, string>) {
  const errores: Record<string, string> = {};
  const v: Record<string, string> = {};
  for (const campo of ["fondo_bolsa", "sobre_bolsa", "fondo_cajon", "sobre_cajon"]) {
    const r = leerImporte(valores[campo]);
    if (r.ok) v[campo] = r.valor;
    else errores[campo] = MENSAJES_IMPORTE[r.motivo];
  }
  if (Object.keys(errores).length) return { ok: false as const, errores };
  const suma = (a: string, b: string) => ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
  return {
    ok: true as const,
    conteo: { bolsa: suma(v.fondo_bolsa, v.sobre_bolsa), cajon: suma(v.fondo_cajon, v.sobre_cajon) },
    fondos: { bolsa: v.fondo_bolsa, cajon: v.fondo_cajon },
  };
}
const CAMPOS_SEPARADOS = (leer: (c: string, m?: number) => string) =>
  ({ fondo_bolsa: leer("fondo_bolsa"), sobre_bolsa: leer("sobre_bolsa"), fondo_cajon: leer("fondo_cajon"), sobre_cajon: leer("sobre_cajon") });

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
  const { sobres, valores: vs } = leerSobres(datos);
  const llave = leerLlave(datos);
  const llaveCaja = leerLlaveCaja(datos);
  const depositados = datos.getAll("depositado").filter((x): x is string => typeof x === "string").slice(0, 4).map((x) => x.slice(0, 40));
  const valores = {
    depositados: depositados.join(","), ...vs, llave_caja: llaveCaja.estado, motivo_llave_caja: llaveCaja.motivo, bolsa: leer("bolsa"), cajon: leer("cajon"), fondo_bolsa: leer("fondo_bolsa"), fondo_cajon: leer("fondo_cajon"),
    custodio: leer("custodio", 40), nota: leer("nota", 400), apoyo: leer("apoyo"), ubicacion: leer("ubicacion", 200), llave: llave.estado, motivo_llave: llave.motivo,
  };
  const intento = (previo?.intento ?? 0) + 1;
  const i = importes(valores);
  const f = importes({ bolsa: valores.fondo_bolsa, cajon: valores.fondo_cajon });
  const a = leerApoyo(datos);
  if (!i.ok || !f.ok || !valores.custodio || !a.ok) {
    return {
      error: "Revisa los campos marcados.",
      errores: {
        ...(i.ok ? {} : i.errores), fondo_bolsa: f.ok ? undefined : f.errores.bolsa, fondo_cajon: f.ok ? undefined : f.errores.cajon,
        custodio: valores.custodio ? undefined : MENSAJES_CIERRE.custodio, apoyo: a.ok ? undefined : MENSAJES_CIERRE.apoyo,
      },
      valores, personas: a.personas, intento,
    };
  }
  const mismaPersona = valores.custodio === sesion.usuarioId;
  const r = await cerrarDia(sql, sesion.usuarioId, codigo, {
    turnoId: leer("turno", 40), conteo: i.conteo, fondos: f.conteo, custodio: valores.custodio, nota: valores.nota, apoyo: a.apoyo,
    custodia: mismaPersona ? { ubicacion: valores.ubicacion, sobres, llave, llaveCaja } : undefined,
    depositados,
  }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/turno?aviso=cerrado${mismaPersona ? "-custodia" : ""}`);
  const marcados = "Revisa los campos marcados.";
  if (r.error === "fondo" || r.error === "fondo_primero") {
    return { error: marcados, errores: { [r.lugar === "bolsa_visitas" ? "fondo_bolsa" : "fondo_cajon"]: MENSAJES_CIERRE[r.error] }, valores, personas: a.personas, intento };
  }
  if (r.error in MENSAJE_SOBRE) {
    return { error: marcados, errores: { [r.sobreId ? `sobre-${r.sobreId}` : "sobres"]: MENSAJES_CIERRE[r.error] }, valores, personas: a.personas, intento };
  }
  if (["nota", "custodio", "apoyo", "ubicacion", "motivo_llave", "motivo_llave_caja", "depositados"].includes(r.error)) {
    return { error: marcados, errores: { [r.error]: MENSAJES_CIERRE[r.error] }, valores, personas: a.personas, intento };
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
  const llave = leerLlave(datos);
  const llaveCaja = leerLlaveCaja(datos);
  const intento = (previo?.intento ?? 0) + 1;
  const todos = { ...valores, ubicacion, llave: llave.estado, motivo_llave: llave.motivo, llave_caja: llaveCaja.estado, motivo_llave_caja: llaveCaja.motivo };
  if (llave.estado !== "correcta" && llave.estado !== "incidencia") {
    return { error: "Revisa los campos marcados.", errores: { motivo_llave: "Indica si el cajón quedó cerrado y recibiste la llave." }, valores: todos, intento };
  }
  const r = await confirmarCustodia(sql, sesion.usuarioId, codigo, { entregaId: leer("entrega", 40), ubicacion, sobres, llave, llaveCaja }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/custodia?aviso=confirmada&incidencias=${r.incidencias}`);
  if (r.error === "ubicacion") return { error: "Revisa los campos marcados.", errores: { ubicacion: "Escribe dónde guardaste los sobres (de 5 a 120 caracteres)." }, valores: todos, intento };
  if (r.error === "motivo_llave" || r.error === "motivo_llave_caja") {
    return { error: "Revisa los campos marcados.", errores: { [r.error]: MENSAJES_CIERRE[r.error] }, valores: todos, intento };
  }
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
  const valores = { ...vs, ...CAMPOS_SEPARADOS(leer), apoyo: leer("apoyo"), sinCustodia: leer("sin_custodia"), motivoSinCustodia: leer("motivo_sin_custodia", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const guardados = leer("guardados") === "si";
  const llave = leerLlave(datos);
  const llaveCaja = leerLlaveCaja(datos);
  Object.assign(valores, { llave: llave.estado, motivo_llave: llave.motivo, llave_caja: llaveCaja.estado, motivo_llave_caja: llaveCaja.motivo });
  const i = leerSeparado(valores);
  const a = leerApoyo(datos);
  const elegida = (l: { estado: string }) => l.estado === "correcta" || l.estado === "incidencia";
  const sinLlave = guardados && !elegida(llave);
  // Con buzón no hay llave de la caja de sobres (solo la del cajón).
  const buzon = leer("buzon") === "si";
  const sinLlaveCaja = guardados && !buzon && !elegida(llaveCaja);
  if (!i.ok || !a.ok || sinLlave || sinLlaveCaja) {
    return {
      error: "Revisa los campos marcados.",
      errores: {
        ...(i.ok ? {} : i.errores), apoyo: a.ok ? undefined : MENSAJES_APERTURA.apoyo,
        motivo_llave: sinLlave ? MENSAJES_APERTURA.motivo_llave : undefined, motivo_llave_caja: sinLlaveCaja ? MENSAJES_APERTURA.motivo_llave_caja : undefined,
      },
      valores, personas: a.personas, intento,
    };
  }
  const r = await abrirDesdeCierre(sql, sesion.usuarioId, codigo,
    { entregaId: leer("entrega", 40), version: Number(leer("version")), sobres, conteo: i.conteo, fondos: i.fondos, apoyo: a.apoyo,
      sinCustodia: valores.sinCustodia === "si" ? { motivo: valores.motivoSinCustodia } : null,
      llave: guardados ? llave : undefined, llaveCaja: guardados && !buzon ? llaveCaja : undefined }, { entorno: leerEntorno() });
  if (r.ok && r.resultado === "abierto") redirect(`/sucursales/${codigo}/turno?aviso=abierto-cierre`);
  if (r.ok) redirect(`/sucursales/${codigo}/turno/apertura?aviso=recuento`);
  if (r.error in MENSAJE_SOBRE) {
    const campo = r.sobreId ? `sobre-${r.sobreId}` : "sobres";
    return { error: "Revisa los campos marcados.", errores: { [campo]: MENSAJE_SOBRE[r.error as keyof typeof MENSAJE_SOBRE] }, valores, personas: a.personas, intento };
  }
  if (r.error === "apoyo") return { error: "Revisa los campos marcados.", errores: { apoyo: MENSAJES_APERTURA.apoyo }, valores, personas: a.personas, intento };
  if (r.error === "motivo_llave" || r.error === "motivo_llave_caja") {
    return { error: "Revisa los campos marcados.", errores: { [r.error]: MENSAJES_APERTURA[r.error] }, valores, personas: a.personas, intento };
  }
  if (r.error === "custodia_pendiente" || r.error === "motivo_custodia") {
    return { error: "Revisa los campos marcados.", errores: { sinCustodia: MENSAJES_APERTURA[r.error] }, valores, personas: a.personas, intento };
  }
  return { error: MENSAJES_APERTURA[r.error], valores, personas: a.personas, intento };
}

export async function accionTerminarApertura(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { recontaron: leer("recontaron"), ...CAMPOS_SEPARADOS(leer), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  if (valores.recontaron !== "si" && valores.recontaron !== "no") {
    return { error: "Revisa los campos marcados.", errores: { recontaron: "Indica si recontaron con el custodio." }, valores, intento };
  }
  const recontaron = valores.recontaron === "si";
  let conteo = null;
  let fondos = null;
  if (recontaron) {
    const i = leerSeparado(valores);
    if (!i.ok) return { error: "Revisa los campos marcados.", errores: i.errores, valores, intento };
    conteo = i.conteo;
    fondos = i.fondos;
  }
  const r = await terminarApertura(sql, sesion.usuarioId, codigo,
    { entregaId: leer("entrega", 40), version: Number(leer("version")), recontaron, conteo, fondos, motivo: valores.motivo }, { entorno: leerEntorno() });
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
  const accesoCajon = datos.getAll("acceso_cajon").filter((p): p is string => typeof p === "string").slice(0, 10).map((p) => p.slice(0, 40));
  const custodias = datos.getAll("custodias").filter((p): p is string => typeof p === "string").slice(0, 10).map((p) => p.slice(0, 40));
  const valores = { lugar: leer("lugar", 200), lugar_fondos: leer("lugar_fondos", 200), acceso_cajon: accesoCajon.join(","), custodias: custodias.join(",") };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await configurarCustodia(sql, sesion.usuarioId, codigo,
    // Desde el 18 nov 2026 (19:10) la configuración es con buzón: su llave es solo de Dirección.
    { lugar: valores.lugar, acceso, lugarFondos: valores.lugar_fondos, accesoCajon, custodias, buzon: true }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/custodia/configurar?aviso=guardada`);
  if (r.error === "lugar") return { error: "Revisa los campos marcados.", errores: { lugar: "Escribe el lugar (de 5 a 120 caracteres)." }, valores, personas: acceso, intento };
  if (r.error === "acceso") return { error: "Revisa los campos marcados.", errores: { acceso: "Elige de 1 a 10 personas con asignación en la sucursal." }, valores, personas: acceso, intento };
  if (r.error === "acceso_buzon") return { error: "Revisa los campos marcados.", errores: { acceso: "La llave del buzón es solo de Dirección: elige únicamente a personas de Dirección." }, valores, personas: acceso, intento };
  if (r.error === "lugar_fondos") return { error: "Revisa los campos marcados.", errores: { lugar_fondos: "Escribe dónde quedan los fondos (de 5 a 120 caracteres)." }, valores, personas: acceso, intento };
  if (r.error === "acceso_cajon") return { error: "Revisa los campos marcados.", errores: { acceso_cajon: "Elige de 1 a 10 personas con asignación en la sucursal." }, valores, personas: acceso, intento };
  if (r.error === "custodias") return { error: "Revisa los campos marcados.", errores: { custodias: "Elige de 1 a 10 custodias con asignación en la sucursal." }, valores, personas: acceso, intento };
  const OTROS: Record<string, string> = {
    no_encontrada: "No encontrada.",
    sin_permiso: "Solo Dirección con asignación en la sucursal define la custodia.",
    bloqueado_produccion: "La custodia está desactivada fuera del entorno de pruebas.",
  };
  return { error: OTROS[r.error], valores, personas: acceso, intento };
}

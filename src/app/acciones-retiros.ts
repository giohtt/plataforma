"use server";

/**
 * Retiros a Encargada de retiros (bloque 5), por POST. Aquí se leen la sesión y el formulario; quién entrega, quién
 * confirma, quién revisa, los montos y el bloqueo de producción se comprueban en src/lib/retiros.ts.
 */
import { redirect } from "next/navigation";
import { leerImporte, MENSAJES_IMPORTE } from "@/lib/datos-turno";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import {
  confirmarRetiro, recontarRetiro, registrarDeposito, registrarRetiro, revisarRetiro,
  type ErrorConfirmacion, type ErrorDeposito, type ErrorRetiro, type ErrorRevisionRetiro,
} from "@/lib/retiros";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

export type EstadoFormularioRetiro = {
  error?: string;
  errores?: Partial<Record<"contado" | "cambio" | "folio" | "encargada" | "importe" | "folioCoincide" | "motivo" | "recontaron" | "con"
    | "fecha" | "referencia" | "resultado" | "monto", string>>;
  valores?: Record<string, string>;
  intento: number;
} | null;

async function inicio() {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  return { sesion, sql };
}
const lector = (datos: FormData) => (campo: string, max = 40) => {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
};
const REVISA = "Revisa los campos marcados.";

const MENSAJES_RETIRO: Record<ErrorRetiro, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no puede entregar retiros en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada: no se registran retiros.",
  sin_turno: "No hay turno abierto en esta sucursal.",
  no_responsable: "Solo la responsable vigente de este lugar entrega su efectivo.",
  entrega_en_curso: "Hay un cambio de turno en curso: no se registran retiros hasta que se confirme o se cancele.",
  lugar: "Elige la bolsa de visitas o el cajón de mensualidades.",
  cambio_mayor: "Lo que deja para cambio debe ser menor que lo contado: el retiro no puede quedar en $0.",
  folio: "Escribe el folio del sobre: de 3 a 30 letras, números o guiones.",
  folio_repetido: "Ese folio ya se usó en esta sucursal. Revisa el sobre: cada folio es único.",
  encargada: "Elige a la Encargada de retiros que recibe el sobre en persona.",
  cambio: "El turno cambió mientras tenías abierta la pantalla. Revisa los datos actuales.",
  bloqueado_produccion: "Los retiros están desactivados fuera del entorno de pruebas.",
};

export async function accionEntregarRetiro(previo: EstadoFormularioRetiro, datos: FormData): Promise<EstadoFormularioRetiro> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { lugar: leer("lugar"), contado: leer("contado", 30), cambio: leer("cambio", 30), folio: leer("folio"), encargada: leer("encargada") };
  const intento = (previo?.intento ?? 0) + 1;
  const contado = leerImporte(valores.contado);
  const cambio = leerImporte(valores.cambio);
  const errores: NonNullable<EstadoFormularioRetiro>["errores"] = {
    contado: contado.ok ? undefined : MENSAJES_IMPORTE[contado.motivo],
    cambio: cambio.ok ? undefined : cambio.motivo === "vacio" ? "Escribe cuánto deja para cambio. Si no deja nada, escribe 0." : MENSAJES_IMPORTE[cambio.motivo],
    folio: valores.folio.trim() ? undefined : MENSAJES_RETIRO.folio,
    encargada: valores.encargada ? undefined : MENSAJES_RETIRO.encargada,
  };
  if (!contado.ok || !cambio.ok || errores.folio || errores.encargada) return { error: REVISA, errores, valores, intento };
  const r = await registrarRetiro(sql, sesion.usuarioId, codigo,
    { turnoId: leer("turno"), lugar: valores.lugar, contado: contado.valor, cambio: cambio.valor, folio: valores.folio, encargada: valores.encargada },
    { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/turno?aviso=retiro`);
  const campo = r.error === "cambio_mayor" ? "cambio" : r.error === "folio" || r.error === "folio_repetido" ? "folio" : r.error === "encargada" ? "encargada" : null;
  if (campo) return { error: REVISA, errores: { [campo]: MENSAJES_RETIRO[r.error] }, valores, intento };
  return { error: MENSAJES_RETIRO[r.error], valores, intento };
}

const MENSAJES_CONFIRMACION: Record<ErrorConfirmacion, string> = {
  no_encontrado: "No encontrado.",
  sin_permiso: "Tu cuenta no confirma retiros en esta sucursal.",
  cambio: "El retiro cambió mientras tenías abierta la pantalla. Revisa su estado actual.",
  importe: "Escribe lo que contaste en el sobre.",
  folio: "Indica si el folio del sobre coincide.",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
  persona: "Elige con quién recontaste en persona.",
  bloqueado_produccion: "Los retiros están desactivados fuera del entorno de pruebas.",
};

export async function accionConfirmarRetiro(previo: EstadoFormularioRetiro, datos: FormData): Promise<EstadoFormularioRetiro> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const valores = { importe: leer("importe", 30), folioCoincide: leer("folio_coincide", 4), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const importe = leerImporte(valores.importe);
  const folioOk = valores.folioCoincide === "si" || valores.folioCoincide === "no";
  if (!importe.ok || !folioOk) {
    return {
      error: REVISA, valores, intento,
      errores: { importe: importe.ok ? undefined : MENSAJES_IMPORTE[importe.motivo], folioCoincide: folioOk ? undefined : MENSAJES_CONFIRMACION.folio },
    };
  }
  const r = await confirmarRetiro(sql, sesion.usuarioId,
    { retiroId: leer("retiro"), version: Number(leer("version")), importe: importe.valor, folioCoincide: valores.folioCoincide === "si", motivo: valores.motivo },
    { entorno: leerEntorno() });
  if (r.ok) redirect(`/retiros?aviso=${r.resultado}`);
  if (r.error === "motivo") return { error: REVISA, errores: { motivo: "Si el folio no coincide, escribe el motivo (de 5 a 300 caracteres)." }, valores, intento };
  return { error: MENSAJES_CONFIRMACION[r.error], valores, intento };
}

export async function accionRecontarRetiro(previo: EstadoFormularioRetiro, datos: FormData): Promise<EstadoFormularioRetiro> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const valores = { recontaron: leer("recontaron", 4), importe: leer("importe", 30), con: leer("con"), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const recontaron = valores.recontaron === "si";
  if (valores.recontaron !== "si" && valores.recontaron !== "no") {
    return { error: REVISA, errores: { recontaron: "Indica si pudieron recontar en persona." }, valores, intento };
  }
  const importe = recontaron ? leerImporte(valores.importe) : null;
  if (recontaron && (!importe!.ok || !valores.con)) {
    return {
      error: REVISA, valores, intento,
      errores: { importe: importe!.ok ? undefined : MENSAJES_IMPORTE[importe!.motivo], con: valores.con ? undefined : MENSAJES_CONFIRMACION.persona },
    };
  }
  const r = await recontarRetiro(sql, sesion.usuarioId, {
    retiroId: leer("retiro"), version: Number(leer("version")), recontaron,
    importe: importe && importe.ok ? importe.valor : null, con: recontaron ? valores.con : null, motivo: valores.motivo,
  }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/retiros?aviso=${r.resultado}`);
  if (r.error === "motivo") {
    return { error: REVISA, errores: { motivo: "Si no coincide, escribe el motivo (de 5 a 300 caracteres)." }, valores, intento };
  }
  if (r.error === "persona") return { error: REVISA, errores: { con: MENSAJES_CONFIRMACION.persona }, valores, intento };
  return { error: MENSAJES_CONFIRMACION[r.error], valores, intento };
}

const MENSAJES_DEPOSITO: Record<ErrorDeposito, string> = {
  no_encontrado: "No encontrado.",
  sin_permiso: "Tu cuenta no registra depósitos en esta sucursal.",
  en_pausa: "Los depósitos de este folio están en pausa hasta que se revise la discrepancia.",
  importe: "Escribe el importe depositado.",
  excede: "El depósito supera lo que queda por depositar de este folio.",
  fecha: "Escribe la fecha y hora del depósito (no puede ser futura ni anterior al retiro).",
  referencia: "Escribe la referencia del comprobante (de 4 a 60 caracteres).",
  motivo: "Escribe el motivo de la corrección (de 5 a 300 caracteres).",
  corrige: "Ese depósito ya se corrigió o no es de este folio.",
  bloqueado_produccion: "Los retiros están desactivados fuera del entorno de pruebas.",
};

export async function accionRegistrarDeposito(previo: EstadoFormularioRetiro, datos: FormData): Promise<EstadoFormularioRetiro> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const retiroId = leer("retiro");
  const corrige = leer("corrige") || null;
  const valores = { importe: leer("importe", 30), fecha: leer("fecha", 20), referencia: leer("referencia", 80), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const importe = leerImporte(valores.importe);
  const errores: NonNullable<EstadoFormularioRetiro>["errores"] = {
    importe: !importe.ok ? (importe.motivo === "vacio" ? MENSAJES_DEPOSITO.importe : MENSAJES_IMPORTE[importe.motivo])
      : Number(importe.valor) <= 0 && !corrige ? MENSAJES_DEPOSITO.importe : undefined,
    fecha: valores.fecha ? undefined : MENSAJES_DEPOSITO.fecha,
    referencia: valores.referencia.trim().length >= 4 ? undefined : MENSAJES_DEPOSITO.referencia,
    motivo: !corrige || valores.motivo.trim().length >= 5 ? undefined : MENSAJES_DEPOSITO.motivo,
  };
  if (Object.values(errores).some(Boolean) || !importe.ok) return { error: REVISA, errores, valores, intento };
  const r = await registrarDeposito(sql, sesion.usuarioId,
    { retiroId, importe: importe.valor, depositadoEn: valores.fecha, referencia: valores.referencia, corrige, motivo: valores.motivo },
    { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/retiros/${retiroId}?aviso=${corrige ? "corregido" : "depositado"}`);
  const campo = r.error === "excede" ? "importe" : r.error === "fecha" || r.error === "referencia" || r.error === "motivo" ? r.error : null;
  if (campo) return { error: REVISA, errores: { [campo]: MENSAJES_DEPOSITO[r.error] }, valores, intento };
  return { error: MENSAJES_DEPOSITO[r.error], valores, intento };
}

const MENSAJES_REVISION: Record<ErrorRevisionRetiro, string> = {
  no_encontrado: "No encontrado.",
  sin_permiso: "Tu cuenta no revisa retiros en esta sucursal.",
  participaste: "Participaste en este retiro: lo revisa otra persona.",
  otro_nivel: "Este retiro lo revisa otro perfil, según quién participó.",
  cambio: "El retiro cambió mientras tenías abierta la pantalla. Revisa su estado actual.",
  resultado: "Elige «Aclarada» o «Faltante confirmado».",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
  monto: "Con «Faltante confirmado», el monto verificado debe ser menor que lo registrado.",
  bloqueado_produccion: "Los retiros están desactivados fuera del entorno de pruebas.",
};

export async function accionRevisarRetiro(previo: EstadoFormularioRetiro, datos: FormData): Promise<EstadoFormularioRetiro> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const retiroId = leer("retiro");
  const valores = { resultado: leer("resultado"), motivo: leer("motivo", 400), monto: leer("monto", 30) };
  const intento = (previo?.intento ?? 0) + 1;
  const monto = leerImporte(valores.monto);
  const errores: NonNullable<EstadoFormularioRetiro>["errores"] = {
    resultado: valores.resultado ? undefined : MENSAJES_REVISION.resultado,
    motivo: valores.motivo.trim().length >= 5 ? undefined : MENSAJES_REVISION.motivo,
    monto: monto.ok ? undefined : monto.motivo === "vacio" ? "Escribe el monto verificado en el sobre." : MENSAJES_IMPORTE[monto.motivo],
  };
  if (Object.values(errores).some(Boolean) || !monto.ok) return { error: REVISA, errores, valores, intento };
  const r = await revisarRetiro(sql, sesion.usuarioId, codigo,
    { retiroId, version: Number(leer("version")), resultado: valores.resultado, motivo: valores.motivo, montoVerificado: monto.valor },
    { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/retiros/${retiroId}?aviso=revisado`);
  const campo = r.error === "motivo" || r.error === "monto" || r.error === "resultado" ? r.error : null;
  if (campo) return { error: REVISA, errores: { [campo]: MENSAJES_REVISION[r.error] }, valores, intento };
  return { error: MENSAJES_REVISION[r.error], valores, intento };
}

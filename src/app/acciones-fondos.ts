"use server";

/**
 * Fondo fijo de caja (bloque 5, regla 7), por POST. Permisos, montos, origen o destino, quién confirma y producción se
 * comprueban en src/lib/fondos.ts.
 */
import { redirect } from "next/navigation";
import type { EstadoFormularioEntrega } from "@/app/acciones-entrega";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { cambiarMontoFondo, cancelarEntradaFondo, confirmarEntradaFondo, registrarReposicion } from "@/lib/fondos";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

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
const MARCADOS = "Revisa los campos marcados.";
const OTROS: Record<string, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para esto en esta sucursal.",
  sin_cambio: "El monto nuevo es igual al vigente.",
  cambio: "Los datos cambiaron mientras tenías la pantalla abierta.",
  bloqueado_produccion: "Los fondos están desactivados fuera del entorno de pruebas.",
  no_pendiente: "Esta entrada ya no está pendiente.",
  sin_turno: "Se recibe con un turno abierto: abre el turno primero.",
  entrega_en_curso: "Hay un cambio de turno pendiente o en recuento: confírmalo o cancélalo antes de recibir el fondo.",
  no_puedes: "Confirma la responsable vigente del lugar; si ella entregó, otra persona autorizada (Encargado, Administración o Dirección).",
  no_coincide: "Lo que recibiste no coincide con lo registrado. No se aplicó, pero quedó constancia de tu conteo: aclara con quien entrega; puede cancelar y registrar de nuevo.",
};

export async function accionCambiarMontoFondo(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { lugar: leer("lugar"), monto: leer("monto"), origen: leer("origen"), destino: leer("destino"), detalle: leer("detalle", 250), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await cambiarMontoFondo(sql, sesion.usuarioId, codigo,
    { lugar: valores.lugar, monto: valores.monto, origen: valores.origen, destino: valores.destino, detalleOrigen: valores.detalle, motivo: valores.motivo },
    { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/fondos?aviso=${r.entradaId ? "monto-pendiente" : "monto"}`);
  const CAMPO: Record<string, [string, string]> = {
    lugar: ["lugar", "Elige el lugar."],
    monto: ["monto", "Escribe el monto nuevo del fondo (de $0 a $5,000)."],
    origen: ["origen", "Indica de dónde sale el dinero; si lo entregas tú, describe el origen (de 5 a 200 caracteres)."],
    destino: ["destino", "Indica a dónde va el dinero que sale del fondo."],
    motivo: ["motivo", "Escribe el motivo (de 5 a 300 caracteres)."],
  };
  if (CAMPO[r.error]) return { error: MARCADOS, errores: { [CAMPO[r.error][0]]: CAMPO[r.error][1] }, valores, intento };
  return { error: OTROS[r.error] ?? "No disponible.", valores, intento };
}

export async function accionRegistrarReposicion(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { lugar: leer("lugar"), importe: leer("importe"), origen: leer("origen", 250) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await registrarReposicion(sql, sesion.usuarioId, codigo, valores, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/fondos?aviso=reposicion`);
  const CAMPO: Record<string, [string, string]> = {
    lugar: ["lugar", "Elige el lugar."],
    importe: ["importe", "Escribe cuánto entregas (más de $0 y hasta $5,000)."],
    origen: ["origen", "Escribe de dónde sale el dinero (de 5 a 200 caracteres)."],
  };
  if (CAMPO[r.error]) return { error: MARCADOS, errores: { [CAMPO[r.error][0]]: CAMPO[r.error][1] }, valores, intento };
  return { error: OTROS[r.error] ?? "No disponible.", valores, intento };
}

export async function accionConfirmarEntradaFondo(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { recibido: leer("recibido") };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await confirmarEntradaFondo(sql, sesion.usuarioId, codigo, { entradaId: leer("entrada"), recibido: valores.recibido }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/fondos?aviso=recibida`);
  if (r.error === "importe") return { error: MARCADOS, errores: { recibido: "Escribe cuánto recibiste." }, valores, intento };
  return { error: OTROS[r.error] ?? "No disponible.", valores, intento };
}

export async function accionCancelarEntradaFondo(previo: EstadoFormularioEntrega, datos: FormData): Promise<EstadoFormularioEntrega> {
  const { sesion, sql } = await inicio();
  const leer = lector(datos);
  const codigo = leer("codigo");
  const valores = { motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const r = await cancelarEntradaFondo(sql, sesion.usuarioId, codigo, { entradaId: leer("entrada"), motivo: valores.motivo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/fondos?aviso=cancelada`);
  if (r.error === "motivo") return { error: MARCADOS, errores: { motivo: "Escribe el motivo (de 5 a 300 caracteres)." }, valores, intento };
  return { error: OTROS[r.error] ?? "No disponible.", valores, intento };
}

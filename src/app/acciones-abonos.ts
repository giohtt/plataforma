"use server";

/**
 * Verificación manual de abonos de transferencias, por POST. Aquí se leen la sesión y el formulario;
 * permisos, quién registró, versión, importe completo, fecha y abono ya usado se comprueban en src/lib/abonos.ts.
 */
import { redirect } from "next/navigation";
import { marcarNoLocalizado, verificarAbono, type ErrorAbono } from "@/lib/abonos";
import { leerImporte } from "@/lib/datos-turno";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

const MENSAJES: Record<ErrorAbono, string> = {
  no_encontrada: "No encontrada.",
  propia: "No puedes verificar una transferencia que tú registraste. Debe hacerlo otra persona con permiso.",
  cambio: "Otra persona cambió esta transferencia mientras la revisabas. Recarga la página para ver su estado actual.",
  importe_incompleto: "El abono debe ser por el importe completo del cobro. Si llegó otro importe, no lo marques como verificado.",
  fecha_invalida: "Revisa la fecha del abono: no puede ser futura ni muy anterior a la fecha del cobro.",
  abono_usado: "Ese abono (misma referencia y fecha) ya se usó para verificar otro cobro. Un abono solo se usa una vez.",
  motivo: "Explica por qué no se localizó (de 5 a 300 caracteres).",
  bloqueado_produccion: "La verificación de abonos está desactivada fuera del entorno de pruebas.",
};

export type EstadoAbono = { error?: string; cobroId?: string; intento: number } | null;

function leer(datos: FormData, campo: string, max: number) {
  const v = datos.get(campo);
  return typeof v === "string" ? v.slice(0, max) : "";
}

export async function accionAbono(previo: EstadoAbono, datos: FormData): Promise<EstadoAbono> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  const intento = (previo?.intento ?? 0) + 1;
  const codigo = leer(datos, "codigo", 10);
  const cobroId = leer(datos, "cobroId", 40);
  const version = Number(leer(datos, "version", 10));
  const opciones = { entorno: leerEntorno() };

  let r;
  if (leer(datos, "accion", 20) === "verificar") {
    if (datos.get("completo") !== "si") return { error: "Confirma que llegó el importe completo.", cobroId, intento };
    const importe = leerImporte(leer(datos, "importe", 30));
    if (!importe.ok) return { error: "Escribe el importe que llegó según el estado de cuenta.", cobroId, intento };
    r = await verificarAbono(sql, sesion.usuarioId, codigo, cobroId,
      { version: Number.isInteger(version) ? version : 0, fecha: leer(datos, "fecha", 10), importe: importe.valor }, opciones);
    if (r.ok) redirect(`/sucursales/${codigo}/transferencias?aviso=verificado`);
  } else {
    r = await marcarNoLocalizado(sql, sesion.usuarioId, codigo, cobroId,
      { version: Number.isInteger(version) ? version : 0, motivo: leer(datos, "motivo", 400) }, opciones);
    if (r.ok) redirect(`/sucursales/${codigo}/transferencias?aviso=no_localizado`);
  }
  return { error: MENSAJES[r.error], cobroId, intento };
}

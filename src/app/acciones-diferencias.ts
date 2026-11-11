"use server";

/**
 * Revisión de una diferencia de efectivo (bloque 5), por POST. Aquí se leen la sesión y el formulario; quién puede
 * revisar, el resultado según el signo y el bloqueo en producción se comprueban en src/lib/diferencias.ts.
 */
import { redirect } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { revisarDiferencia, type ErrorRevision } from "@/lib/diferencias";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

export type EstadoRevision = { error?: string; errores?: { resultado?: string; motivo?: string }; valores?: Record<string, string>; intento: number } | null;

const MENSAJES: Record<ErrorRevision, string> = {
  no_encontrada: "No encontrada.",
  sin_permiso: "Tu cuenta no tiene permiso para revisar diferencias en esta sucursal.",
  participaste: "Participaste en esta entrega: su revisión le corresponde a otra persona.",
  otro_nivel: "Esta diferencia la revisa otro perfil, según quién participó en la entrega.",
  ya_revisada: "Esta diferencia ya fue revisada. Revisa su resultado en el historial.",
  resultado: "Elige un resultado válido para esta diferencia.",
  motivo: "Escribe el motivo (de 5 a 300 caracteres).",
  bloqueado_produccion: "La revisión de diferencias está desactivada fuera del entorno de pruebas.",
};

export async function accionRevisarDiferencia(previo: EstadoRevision, datos: FormData): Promise<EstadoRevision> {
  const sesion = await obtenerSesionActual();
  if (!sesion) redirect("/iniciar-sesion");
  const sql = obtenerBaseDatos();
  if (!sql) throw new Error("Sin base de datos");
  const leer = (campo: string, max = 40) => {
    const v = datos.get(campo);
    return typeof v === "string" ? v.slice(0, max) : "";
  };
  const codigo = leer("codigo");
  const valores = { resultado: leer("resultado"), motivo: leer("motivo", 400) };
  const intento = (previo?.intento ?? 0) + 1;
  const sinResultado = !valores.resultado;
  const motivoCorto = valores.motivo.trim().length < 5;
  if (sinResultado || motivoCorto) {
    return {
      error: "Revisa los campos marcados.",
      errores: { resultado: sinResultado ? "Elige el resultado." : undefined, motivo: motivoCorto ? MENSAJES.motivo : undefined },
      valores, intento,
    };
  }
  const r = await revisarDiferencia(sql, sesion.usuarioId, codigo,
    { diferenciaId: leer("diferencia"), resultado: valores.resultado, motivo: valores.motivo }, { entorno: leerEntorno() });
  if (r.ok) redirect(`/sucursales/${codigo}/diferencias/${r.entregaId}?aviso=revisada`);
  if (r.error === "motivo") return { error: "Revisa los campos marcados.", errores: { motivo: MENSAJES.motivo }, valores, intento };
  return { error: MENSAJES[r.error], valores, intento };
}

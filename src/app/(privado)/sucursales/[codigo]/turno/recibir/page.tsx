import Link from "next/link";
import { conPunto } from "@/lib/formato";
import { notFound } from "next/navigation";
import { FormularioRecepcion } from "@/components/Entrega";
import { obtenerBaseDatos } from "@/lib/db";
import { pantallaRecepcion } from "@/lib/entregas";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Recibir el turno · Fitnessland" };

const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const MOTIVO: Record<string, string> = {
  sin_permiso: "Tu cuenta no tiene permiso para recibir turnos en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada: no se pueden recibir turnos.",
  sin_turno: "No hay turno abierto en esta sucursal.",
  sin_entrega: "No tienes una entrega pendiente de recibir en esta sucursal.",
  bloqueado_produccion: "El cambio de turno está desactivado fuera del entorno de pruebas.",
};

/** Cambio de turno: la entrante cuenta sin ver el conteo de la saliente y confirma desde su cuenta. */
export default async function RecibirTurno({ params, searchParams }: PageProps<"/sucursales/[codigo]/turno/recibir">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const { aviso } = await searchParams;
  const p = await pantallaRecepcion(obtenerBaseDatos()!, sesion.usuarioId, codigo, leerEntorno());
  if (!p.ok && p.error === "no_encontrada") notFound();
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Recibir el turno{p.ok ? ` · ${p.sucursal}` : ""}</h1>
      {!p.ok ? (
        <p className="aviso aviso-info" data-testid="recepcion-impedida">{MOTIVO[p.error] ?? "No disponible."}</p>
      ) : (
        <>
          <p className="sub">
            Te entrega <strong>{p.entrega.entregaPor}</strong> · {conPunto(hora.format(p.entrega.creadaEn))} Solo datos ficticios.
          </p>
          {aviso === "recuento" && p.recuento ? (
            <p className="aviso aviso-error" role="status" data-testid="aviso-recuento">
              Tu conteo no coincide con lo que se entregó. Recuenten juntas antes de confirmar.
            </p>
          ) : null}
          <section className="tarjeta">
            <FormularioRecepcion codigo={codigo} entregaId={p.entrega.id} version={p.entrega.version} recuento={p.recuento} />
          </section>
        </>
      )}
    </main>
  );
}

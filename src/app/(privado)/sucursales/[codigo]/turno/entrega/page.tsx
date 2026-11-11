import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioEntrega } from "@/components/Entrega";
import { obtenerBaseDatos } from "@/lib/db";
import { pantallaEntrega } from "@/lib/entregas";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Entregar el turno · Fitnessland" };

const MOTIVO: Record<string, string> = {
  sin_permiso: "Tu cuenta no tiene permiso para entregar turnos en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada: no se pueden entregar turnos.",
  sin_turno: "No hay turno abierto en esta sucursal.",
  no_responsable: "Solo la responsable vigente de la bolsa y del cajón puede entregar el turno.",
  bloqueado_produccion: "El cambio de turno está desactivado fuera del entorno de pruebas.",
};

/** Cambio de turno: la saliente cuenta cada lugar y elige a quién entrega. */
export default async function EntregarTurno({ params }: PageProps<"/sucursales/[codigo]/turno/entrega">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const p = await pantallaEntrega(obtenerBaseDatos()!, sesion.usuarioId, codigo, leerEntorno());
  if (!p.ok && p.error === "no_encontrada") notFound();
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Entregar el turno{p.ok ? ` · ${p.sucursal}` : ""}</h1>
      <p className="sub">Solo datos ficticios. Cuenta cada lugar por separado; quien recibe confirma desde su propia cuenta.</p>
      {!p.ok ? (
        <p className="aviso aviso-info" data-testid="entrega-impedida">{MOTIVO[p.error] ?? "No disponible."}</p>
      ) : p.enCurso ? (
        <p className="aviso aviso-info">Ya hay una entrega en curso a {p.enCurso.recibe}. Puedes cancelarla desde la pantalla del turno.</p>
      ) : p.cancelacionesPendientes ? (
        <p className="aviso aviso-info" data-testid="entrega-impedida">
          Hay {p.cancelacionesPendientes} {p.cancelacionesPendientes === 1 ? "solicitud" : "solicitudes"} de cancelación pendientes en este turno: deben resolverse antes de entregar.
        </p>
      ) : !p.receptores.length ? (
        <p className="aviso aviso-info" data-testid="entrega-impedida">No hay otra cuenta de Recepción de esta sucursal que pueda recibir.</p>
      ) : (
        <section className="tarjeta">
          <FormularioEntrega codigo={codigo} turnoId={p.turnoId} esperadoBolsa={p.esperadoBolsa}
            contadoCajon={p.contadoAlAbrir.cajon} receptores={p.receptores} />
        </section>
      )}
    </main>
  );
}

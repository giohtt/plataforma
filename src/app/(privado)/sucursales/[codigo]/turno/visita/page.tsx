import Link from "next/link";
import { notFound } from "next/navigation";
import { FlujoVisita } from "@/components/FlujoVisita";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";
import { pantallaCobro } from "@/lib/visitas";

export const metadata = { title: "Registrar visita · Fitnessland" };

const AVISO: Record<string, string> = {
  sucursal_inactiva: "Esta sucursal está desactivada: no se pueden registrar cobros.",
  sin_turno: "No hay turno abierto en esta sucursal. Abre el turno antes de cobrar.",
  no_responsable: "Solo la responsable de la bolsa de visitas puede cobrar en este turno.",
  bloqueado_produccion: "El registro de visitas está desactivado fuera del entorno de pruebas.",
};

/** Registrar una visita individual en efectivo. Sin permiso de registrar visitas en la sucursal: «No encontrada». */
export default async function RegistrarVisita({ params }: PageProps<"/sucursales/[codigo]/turno/visita">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const p = await pantallaCobro(obtenerBaseDatos()!, sesion.usuarioId, codigo, leerEntorno());
  if (!p.ok && (p.error === "no_encontrada" || p.error === "sin_permiso")) notFound();

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Registrar visita</h1>
      <p className="sub">Solo datos ficticios. Una persona, $50 en efectivo. El registro grupal llega después.</p>
      {!p.ok ? (
        <p className="aviso aviso-info" data-testid="no-puede-cobrar">{AVISO[p.error] ?? "No se puede registrar la visita."}</p>
      ) : (
        <FlujoVisita codigo={codigo} sucursal={p.sucursal} turnoId={p.turnoId} responsableBolsa={p.responsableBolsa} />
      )}
    </main>
  );
}

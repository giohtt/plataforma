import Link from "next/link";
import { notFound } from "next/navigation";
import { FlujoVisita } from "@/components/FlujoVisita";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";
import { ESTADOS_PROCEDENCIA, REGLAS_PROVISIONALES } from "@/lib/datos-visitante";
import { pantallaCobro } from "@/lib/visitas";
import { puedeEnSucursal } from "@/lib/visitantes";

export const metadata = { title: "Registrar visita · Fitnessland" };

const AVISO: Record<string, string> = {
  sucursal_inactiva: "Esta sucursal está desactivada: no se pueden registrar cobros.",
  entrega_en_curso: "El turno se está entregando: no se pueden registrar cobros hasta que la entrante confirme o se cancele la entrega.",
  sin_turno: "No hay turno abierto en esta sucursal. Abre el turno antes de cobrar.",
  no_responsable: "Solo la responsable de la bolsa de visitas puede cobrar en este turno.",
  bloqueado_produccion: "El registro de visitas está desactivado fuera del entorno de pruebas.",
};

/** Registrar visitas en efectivo, de una persona o de un grupo. Sin permiso de registrar visitas en la sucursal: «No encontrada». */
export default async function RegistrarVisita({ params }: PageProps<"/sucursales/[codigo]/turno/visita">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const sql = obtenerBaseDatos()!;
  const p = await pantallaCobro(sql, sesion.usuarioId, codigo, leerEntorno());
  if (!p.ok && (p.error === "no_encontrada" || p.error === "sin_permiso")) notFound();
  const puedeCrear = p.ok && (await puedeEnSucursal(sql, sesion.usuarioId, codigo, "visitante.crear"));

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Registrar visita</h1>
      <p className="sub">Solo datos ficticios. $50 por persona, en efectivo, con tarjeta o por transferencia. Una persona o un grupo de hasta 20 en un mismo cobro.</p>
      {!p.ok ? (
        <p className="aviso aviso-info" data-testid="no-puede-cobrar">{AVISO[p.error] ?? "No se puede registrar la visita."}</p>
      ) : (
        <FlujoVisita codigo={codigo} sucursal={p.sucursal} turnoId={p.turnoId} responsableBolsa={p.responsableBolsa}
          puedeCrear={puedeCrear} estados={ESTADOS_PROCEDENCIA}
          telefonoObligatorio={REGLAS_PROVISIONALES.telefonoObligatorio} estadoObligatorio={REGLAS_PROVISIONALES.estadoObligatorio} />
      )}
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { FlujoVisitantes } from "@/components/FlujoVisitantes";
import { ESTADOS_PROCEDENCIA, REGLAS_PROVISIONALES } from "@/lib/datos-visitante";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { sucursalAccesiblePorCodigo } from "@/lib/permisos";
import { requerirSesion } from "@/lib/sesion-servidor";
import { puedeEnSucursal } from "@/lib/visitantes";

export const metadata = { title: "Visitantes · Fitnessland" };

/**
 * Búsqueda y alta de expedientes desde una sucursal. No lee parámetros de la dirección: el nombre y el
 * teléfono se envían por POST. Sin permiso: «No encontrada».
 */
export default async function Visitantes({ params }: PageProps<"/sucursales/[codigo]/visitantes">) {
  const sesion = await requerirSesion();
  const sql = obtenerBaseDatos()!;
  const { codigo } = await params;
  const sucursal = await sucursalAccesiblePorCodigo(sql, sesion.usuarioId, codigo);
  if (!sucursal || !(await puedeEnSucursal(sql, sesion.usuarioId, codigo, "visitante.buscar"))) notFound();
  const puedeCrear = leerEntorno() !== "produccion" && (await puedeEnSucursal(sql, sesion.usuarioId, codigo, "visitante.crear"));

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {sucursal.nombre}</Link></p>
      <h1 className="cabecera-titulo">Visitantes</h1>
      <p className="sub">Busca primero: el expediente es uno solo para todas las sucursales.</p>
      {leerEntorno() === "produccion" ? (
        <p className="aviso aviso-info">El alta de expedientes está desactivada hasta aprobar el aviso de privacidad.</p>
      ) : null}
      <FlujoVisitantes
        codigo={codigo}
        puedeCrear={puedeCrear}
        estados={ESTADOS_PROCEDENCIA}
        telefonoObligatorio={REGLAS_PROVISIONALES.telefonoObligatorio}
        estadoObligatorio={REGLAS_PROVISIONALES.estadoObligatorio}
      />
    </main>
  );
}

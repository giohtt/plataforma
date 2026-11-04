import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioVisitante } from "@/components/FormularioVisitante";
import { ESTADOS_PROCEDENCIA, normalizarTelefono, REGLAS_PROVISIONALES } from "@/lib/datos-visitante";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { sucursalAccesiblePorCodigo } from "@/lib/permisos";
import { requerirSesion } from "@/lib/sesion-servidor";
import { puedeEnSucursal } from "@/lib/visitantes";

export const metadata = { title: "Nuevo expediente · Fitnessland" };

export default async function NuevoVisitante({ params, searchParams }: PageProps<"/sucursales/[codigo]/visitantes/nuevo">) {
  const sesion = await requerirSesion();
  const sql = obtenerBaseDatos()!;
  const { codigo } = await params;
  const sucursal = await sucursalAccesiblePorCodigo(sql, sesion.usuarioId, codigo);
  if (!sucursal || !(await puedeEnSucursal(sql, sesion.usuarioId, codigo, "visitante.crear"))) notFound();

  // Lo que se escribió en el buscador pasa al campo que corresponde.
  const { q } = await searchParams;
  const texto = typeof q === "string" ? q.slice(0, 120) : "";
  const telefono = /^[\d\s()+-]+$/.test(texto) ? (normalizarTelefono(texto) ?? texto) : "";
  const inicial = { nombre: telefono ? "" : texto, telefono };

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/visitantes${texto ? `?q=${encodeURIComponent(texto)}` : ""}`}>← Volver a la búsqueda</Link></p>
      <h1 className="cabecera-titulo">Nuevo expediente</h1>
      {leerEntorno() === "produccion" ? (
        <p className="aviso aviso-error">Los expedientes están desactivados hasta aprobar el aviso de privacidad.</p>
      ) : (
        <>
          <p className="aviso aviso-info">
            Solo datos ficticios. Antes de guardar, el sistema revisa si ya existe alguien con el mismo teléfono o un nombre
            parecido. Las reglas de campos obligatorios y de qué se muestra están pendientes de aprobar.
          </p>
          <section className="tarjeta">
            <FormularioVisitante
              codigo={codigo}
              inicial={inicial}
              estados={ESTADOS_PROCEDENCIA}
              telefonoObligatorio={REGLAS_PROVISIONALES.telefonoObligatorio}
              estadoObligatorio={REGLAS_PROVISIONALES.estadoObligatorio}
            />
          </section>
        </>
      )}
    </main>
  );
}

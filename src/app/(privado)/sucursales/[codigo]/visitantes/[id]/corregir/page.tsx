import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioCorreccion } from "@/components/FormularioCorreccion";
import { expedienteParaCorregir } from "@/lib/correccion-visitantes";
import { ESTADOS_PROCEDENCIA } from "@/lib/datos-visitante";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Corregir expediente · Fitnessland" };

/** Sin permiso de corregir este expediente (o en producción): «No encontrada». El envío se vuelve a comprobar en el servidor. */
export default async function CorregirVisitante({ params }: PageProps<"/sucursales/[codigo]/visitantes/[id]/corregir">) {
  const sesion = await requerirSesion();
  const { codigo, id } = await params;
  const e = await expedienteParaCorregir(obtenerBaseDatos()!, sesion.usuarioId, codigo, id);
  if (!e || !e.puedeCorregir || leerEntorno() === "produccion") notFound();

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/visitantes/${id}`}>← Volver al expediente</Link></p>
      <h1 className="cabecera-titulo">Corregir expediente</h1>
      <p className="aviso aviso-info">Solo datos ficticios. Expediente creado en {e.sucursalAlta}.</p>
      <section className="tarjeta">
        <FormularioCorreccion
          codigo={codigo}
          id={e.id}
          version={e.version}
          inicial={{ nombre: e.nombre, telefonoEnmascarado: e.telefonoEnmascarado, estadoProcedencia: e.estadoProcedencia }}
          estados={ESTADOS_PROCEDENCIA}
        />
      </section>
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { FlujoFusion } from "@/components/FlujoFusion";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { puedeFusionarDesde } from "@/lib/fusion-visitantes";
import { requerirSesion } from "@/lib/sesion-servidor";
import { consultarVisitante } from "@/lib/visitantes";

export const metadata = { title: "Unir fichas duplicadas · Fitnessland" };

/** Solo Dirección con el permiso de fusión en la sucursal de esta ficha. Si no: «No encontrada». Al guardar se vuelve a comprobar todo. */
export default async function FusionarVisitante({ params }: PageProps<"/sucursales/[codigo]/visitantes/[id]/fusionar">) {
  const sesion = await requerirSesion();
  const { codigo, id } = await params;
  const sql = obtenerBaseDatos()!;
  if (leerEntorno() === "produccion" || !(await puedeFusionarDesde(sql, sesion.usuarioId, codigo, id))) notFound();
  const e = await consultarVisitante(sql, sesion.usuarioId, codigo, id);
  if (!e) notFound();

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/visitantes/${id}`}>← Volver al expediente</Link></p>
      <h1 className="cabecera-titulo">Unir fichas duplicadas</h1>
      <p className="aviso aviso-info">
        Solo datos ficticios. Úsalo únicamente cuando por error se crearon dos fichas de la misma persona. Compartir nombre o
        teléfono no demuestra que sean la misma persona.
      </p>
      <section className="tarjeta">
        <p><strong>{e.nombre}</strong></p>
        <p className="sub">Tel. {e.telefono ?? "no registrado"} · {e.estadoProcedencia ?? "procedencia no registrada"} · creada en {e.sucursalAlta}</p>
      </section>
      <FlujoFusion codigo={codigo} base={{ id: e.id }} />
    </main>
  );
}

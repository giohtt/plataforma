import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioActividad, FormularioSucursal } from "@/components/FormulariosSucursal";
import { sucursalEditable } from "@/lib/catalogo-sucursales";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Editar sucursal · Fitnessland" };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/** Edición y desactivación. Sin permiso para cambiar esta sucursal: «No encontrada». */
export default async function EditarSucursal({ params }: PageProps<"/sucursales/[codigo]/editar">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const s = await sucursalEditable(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!s) notFound();
  const inactiva = s.estadoOperativo === "inactiva";

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${s.codigo}`}>← {s.nombre}</Link></p>
      <h1 className="cabecera-titulo">Editar {s.nombre}</h1>

      {s.puedeEditar ? (
        <section className="tarjeta" aria-labelledby="titulo-datos">
          <h2 id="titulo-datos" className="titulo-seccion">Datos de la sucursal</h2>
          <FormularioSucursal modo="editar" inicial={s} id={s.id} version={s.version} />
        </section>
      ) : null}

      {s.puedeDesactivar ? (
        <section className={inactiva ? "tarjeta" : "tarjeta zona-riesgo"} aria-labelledby="titulo-actividad" data-testid="actividad">
          <h2 id="titulo-actividad" className="titulo-seccion">{inactiva ? "Reactivar" : "Desactivar"}</h2>
          {inactiva ? (
            <p>Desactivada{s.desactivadaEn ? ` el ${fecha.format(s.desactivadaEn)}` : ""}. Al reactivarla vuelve a aparecer como próxima apertura o activa.</p>
          ) : (
            <ul className="lista-explicacion">
              <li>La sucursal no se borra: conserva sus datos y su historial, y se puede reactivar.</li>
              <li>Las personas asignadas la siguen viendo, marcada como inactiva. Sus asignaciones no cambian.</li>
              <li>No cambia nada en Open Desk.</li>
            </ul>
          )}
          <FormularioActividad id={s.id} version={s.version} inactiva={inactiva} nombre={s.nombre} />
        </section>
      ) : null}
    </main>
  );
}

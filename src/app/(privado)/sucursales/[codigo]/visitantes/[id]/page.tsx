import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";
import { consultarVisitante } from "@/lib/visitantes";

export const metadata = { title: "Expediente · Fitnessland" };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const AVISOS: Record<string, string> = {
  creado: "Expediente creado.",
  seleccionado: "Expediente elegido.",
};

/** Expediente consultado desde una sucursal. Sin permiso o inexistente: «No encontrada». */
export default async function ExpedienteVisitante({ params, searchParams }: PageProps<"/sucursales/[codigo]/visitantes/[id]">) {
  const sesion = await requerirSesion();
  const { codigo, id } = await params;
  const e = await consultarVisitante(obtenerBaseDatos()!, sesion.usuarioId, codigo, id);
  if (!e) notFound();
  const { aviso } = await searchParams;

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/visitantes`}>← Buscar otro visitante</Link></p>
      {typeof aviso === "string" && AVISOS[aviso] ? <p className="aviso aviso-ok" role="status">{AVISOS[aviso]}</p> : null}
      <h1 className="cabecera-titulo" data-testid="nombre-visitante">{e.nombre}</h1>
      <section className="tarjeta" data-testid="expediente">
        <dl className="datos-expediente">
          <dt>Teléfono</dt><dd>{e.telefono ?? "No registrado"}</dd>
          <dt>Estado de procedencia</dt><dd>{e.estadoProcedencia ?? "No registrado"}</dd>
          <dt>Expediente creado</dt><dd>En {e.sucursalAlta}, el {fecha.format(e.creadoEn)}</dd>
        </dl>
      </section>
      <section className="tarjeta">
        <h2 className="titulo-seccion">Visitas</h2>
        <p className="sub">
          Todavía no se registran visitas en la plataforma (llega en el bloque 4). Que no aparezcan visitas no significa que
          la persona nunca haya asistido.
        </p>
      </section>
    </main>
  );
}

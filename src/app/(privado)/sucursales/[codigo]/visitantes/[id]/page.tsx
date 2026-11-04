import Link from "next/link";
import { notFound } from "next/navigation";
import { correccionesDeVisitante, expedienteParaCorregir } from "@/lib/correccion-visitantes";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";
import { consultarVisitante } from "@/lib/visitantes";

export const metadata = { title: "Expediente · Fitnessland" };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const AVISOS: Record<string, string> = {
  creado: "Expediente creado.",
  seleccionado: "Expediente elegido.",
  corregido: "Corrección guardada.",
};
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const CAMPO: Record<string, string> = { nombre: "Nombre", telefono: "Teléfono", estado_procedencia: "Estado de procedencia" };

/** Expediente consultado desde una sucursal. Sin permiso o inexistente: «No encontrada». */
export default async function ExpedienteVisitante({ params, searchParams }: PageProps<"/sucursales/[codigo]/visitantes/[id]">) {
  const sesion = await requerirSesion();
  const { codigo, id } = await params;
  const sql = obtenerBaseDatos()!;
  const e = await consultarVisitante(sql, sesion.usuarioId, codigo, id);
  if (!e) notFound();
  const [editable, correcciones] = await Promise.all([
    expedienteParaCorregir(sql, sesion.usuarioId, codigo, id),
    correccionesDeVisitante(sql, sesion.usuarioId, codigo, id),
  ]);
  const puedeCorregir = !!editable?.puedeCorregir && leerEntorno() !== "produccion";
  const { aviso } = await searchParams;

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/visitantes`}>← Buscar otro visitante</Link></p>
      {typeof aviso === "string" && AVISOS[aviso] ? <p className="aviso aviso-ok" role="status">{AVISOS[aviso]}</p> : null}
      <h1 className="cabecera-titulo" data-testid="nombre-visitante">{e.nombre}</h1>
      {puedeCorregir ? (
        <p className="fila-acciones">
          <Link className="boton" href={`/sucursales/${codigo}/visitantes/${id}/corregir`} data-testid="corregir-visitante">Corregir datos</Link>
        </p>
      ) : null}
      <section className="tarjeta" data-testid="expediente">
        <dl className="datos-expediente">
          <dt>Teléfono</dt><dd>{e.telefono ?? "No registrado"}</dd>
          <dt>Estado de procedencia</dt><dd>{e.estadoProcedencia ?? "No registrado"}</dd>
          <dt>Expediente creado</dt><dd>En {e.sucursalAlta}, el {fecha.format(e.creadoEn)}</dd>
        </dl>
      </section>
      {correcciones?.length ? (
        <section className="tarjeta" aria-labelledby="t-correcciones" data-testid="correcciones">
          <h2 id="t-correcciones" className="titulo-seccion">Correcciones</h2>
          <ol className="historial">
            {correcciones.map((c) => (
              <li key={c.id}>
                <strong>{CAMPO[c.campo]}</strong>: {c.anterior ?? "(vacío)"} → {c.nuevo ?? "(vacío)"}
                <div className="sub">{fechaHora.format(c.en)} · {c.usuario} · desde {c.sucursal}</div>
                <div>Motivo: {c.motivo}</div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
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

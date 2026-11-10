import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { HistorialVisitante } from "@/components/HistorialVisitante";
import { historialVisitante } from "@/lib/historial";
import { correccionesDeVisitante, expedienteParaCorregir } from "@/lib/correccion-visitantes";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { fichaActiva, fusionesDeVisitante, puedeFusionarDesde } from "@/lib/fusion-visitantes";
import { requerirSesion } from "@/lib/sesion-servidor";
import { consultarVisitante } from "@/lib/visitantes";

export const metadata = { title: "Expediente · Fitnessland" };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const AVISOS: Record<string, string> = {
  creado: "Expediente creado.",
  seleccionado: "Expediente elegido.",
  corregido: "Corrección guardada.",
  fusionado: "Fichas unidas. Esta es la ficha activa.",
  unida: "La ficha que abriste se unió a esta. Esta es la ficha activa.",
};
const ORIGEN: Record<string, string> = { activa: "de la ficha que quedó activa", unida: "de la ficha unida" };
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const CAMPO: Record<string, string> = { nombre: "Nombre", telefono: "Teléfono", estado_procedencia: "Estado de procedencia" };

/** Expediente consultado desde una sucursal. Sin permiso o inexistente: «No encontrada». */
export default async function ExpedienteVisitante({ params, searchParams }: PageProps<"/sucursales/[codigo]/visitantes/[id]">) {
  const sesion = await requerirSesion();
  const { codigo, id } = await params;
  const sql = obtenerBaseDatos()!;
  // Un enlace a una ficha unida lleva a la ficha activa, solo si se puede consultar desde esta sucursal.
  const destino = await fichaActiva(sql, id);
  if (destino?.unida) {
    if (await consultarVisitante(sql, sesion.usuarioId, codigo, destino.activa)) redirect(`/sucursales/${codigo}/visitantes/${destino.activa}?aviso=unida`);
    notFound();
  }
  const e = await consultarVisitante(sql, sesion.usuarioId, codigo, id);
  if (!e) notFound();
  const [editable, correcciones, fusiones, fusionable, historial] = await Promise.all([
    expedienteParaCorregir(sql, sesion.usuarioId, codigo, id),
    correccionesDeVisitante(sql, sesion.usuarioId, codigo, id),
    fusionesDeVisitante(sql, sesion.usuarioId, codigo, id),
    puedeFusionarDesde(sql, sesion.usuarioId, codigo, id),
    historialVisitante(sql, sesion.usuarioId, codigo, id),
  ]);
  const enProduccion = leerEntorno() === "produccion";
  const puedeCorregir = !!editable?.puedeCorregir && !enProduccion;
  const puedeFusionar = fusionable && !enProduccion;
  const { aviso } = await searchParams;

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/visitantes`}>← Buscar otro visitante</Link></p>
      {typeof aviso === "string" && AVISOS[aviso] ? <p className="aviso aviso-ok" role="status">{AVISOS[aviso]}</p> : null}
      <h1 className="cabecera-titulo" data-testid="nombre-visitante">{e.nombre}</h1>
      {puedeCorregir || puedeFusionar ? (
        <p className="fila-acciones">
          {puedeCorregir ? (
            <Link className="boton" href={`/sucursales/${codigo}/visitantes/${id}/corregir`} data-testid="corregir-visitante">Corregir datos</Link>
          ) : null}
          {puedeFusionar ? (
            <Link className="boton" href={`/sucursales/${codigo}/visitantes/${id}/fusionar`} data-testid="fusionar-visitante">Unir con un duplicado</Link>
          ) : null}
        </p>
      ) : null}
      <section className="tarjeta" data-testid="expediente">
        <dl className="datos-expediente">
          <dt>Teléfono</dt><dd>{e.telefono ?? "No registrado"}</dd>
          <dt>Estado de procedencia</dt><dd>{e.estadoProcedencia ?? "No registrado"}</dd>
          {e.sucursalAlta && e.creadoEn ? (
            <><dt>Expediente creado</dt><dd data-testid="expediente-creado">En {e.sucursalAlta}, el {fecha.format(e.creadoEn)}</dd></>
          ) : null}
        </dl>
      </section>
      {historial ? <HistorialVisitante h={historial} /> : null}
      {fusiones?.length ? (
        <section className="tarjeta" aria-labelledby="t-fusiones" data-testid="fusiones">
          <h2 id="t-fusiones" className="titulo-seccion">Fichas unidas</h2>
          <ol className="historial">
            {fusiones.map((f) => (
              <li key={f.id}>
                <strong>{f.unida.nombre}</strong>
                <span className="sub"> · Tel. {f.unida.telefono ?? "no registrado"} · {f.unida.estadoProcedencia ?? "sin procedencia"} · creada en {f.unida.sucursalAlta}</span>
                <div className="sub">
                  {f.activaEnEseMomento.esEsta ? "Unida a esta ficha" : `Unida a «${f.activaEnEseMomento.nombre}», que después se unió a esta`}
                </div>
                <div className="sub">{fechaHora.format(f.en)} · {f.usuario} · desde {f.sucursal}</div>
                <div className="sub">
                  Se conservó: nombre {ORIGEN[f.camposTomados.nombre]}, teléfono {ORIGEN[f.camposTomados.telefono]}, procedencia {ORIGEN[f.camposTomados.estado_procedencia]}.
                </div>
                <div>Motivo: {f.motivo}</div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {correcciones?.length ? (
        <section className="tarjeta" aria-labelledby="t-correcciones" data-testid="correcciones">
          <h2 id="t-correcciones" className="titulo-seccion">Correcciones</h2>
          <ol className="historial">
            {correcciones.map((c) => (
              <li key={c.id}>
                <strong>{CAMPO[c.campo]}</strong>: {c.anterior ?? "(vacío)"} → {c.nuevo ?? "(vacío)"}
                {c.deFichaUnida ? <span className="sub"> (en la ficha unida)</span> : null}
                <div className="sub">{fechaHora.format(c.en)} · {c.usuario} · desde {c.sucursal}</div>
                <div>Motivo: {c.motivo}</div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </main>
  );
}

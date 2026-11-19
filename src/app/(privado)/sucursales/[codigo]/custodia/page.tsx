import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioCustodia } from "@/components/Cierre";
import { custodiasPorConfirmar } from "@/lib/cierres";
import { obtenerBaseDatos } from "@/lib/db";
import { conPunto } from "@/lib/formato";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Custodia nocturna · Fitnessland" };

const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/** El custodio nocturno confirma desde su cuenta dónde guardó los sobres y verifica sello y folio de cada uno. */
export default async function Custodia({ params, searchParams }: PageProps<"/sucursales/[codigo]/custodia">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const { aviso, incidencias } = await searchParams;
  const c = await custodiasPorConfirmar(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!c) notFound();
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {c.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Confirmar custodia · {c.sucursal}</h1>
      <p className="sub">Solo datos ficticios. Recibes los sobres cerrados y compruebas sus folios; no ves los importes.</p>
      {aviso === "confirmada" ? (
        <p className="aviso aviso-ok" role="status" data-testid="custodia-confirmada">
          Custodia confirmada{incidencias && incidencias !== "0" ? ` con ${incidencias} ${incidencias === "1" ? "incidencia" : "incidencias"}: queda en el cierre para revisarse` : ""}.
        </p>
      ) : null}
      {!c.cierre ? (
        <p className="aviso aviso-info" data-testid="sin-custodia">No tienes sobres por confirmar en esta sucursal.</p>
      ) : (
        <section className="tarjeta">
          <p className="sub">Cierre de {conPunto(hora.format(c.cierre.cerradoEn))} Cerró <strong>{c.cierre.cerradoPor}</strong>.</p>
          {c.cierre.buzon ? (
            <p className="sub">Los sobres quedaron en el buzón; su llave la tiene solo Dirección ({c.cierre.configuracion.acceso.map((p) => p.nombre).join(" · ")}).</p>
          ) : <p className="sub">Acceso definido por Dirección: {c.cierre.configuracion.acceso.map((p) => p.nombre).join(" · ")}.</p>}
          <FormularioCustodia codigo={codigo} entregaId={c.cierre.entregaId} sobres={c.cierre.sobres} lugar={c.cierre.configuracion.lugar}
            caja={c.caja} guardados={c.cierre.sobresGuardados} fuera={c.fuera} buzon={c.cierre.buzon} />
        </section>
      )}
    </main>
  );
}

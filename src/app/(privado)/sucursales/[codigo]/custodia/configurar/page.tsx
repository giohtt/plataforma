import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioConfigurarCustodia } from "@/components/Cierre";
import { pantallaConfiguracionCustodia } from "@/lib/cierres";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Custodia de sobres · Fitnessland" };

const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/** Dirección define por sucursal dónde se guardan los sobres del cierre y quién tiene acceso. */
export default async function ConfigurarCustodia({ params, searchParams }: PageProps<"/sucursales/[codigo]/custodia/configurar">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const { aviso } = await searchParams;
  const p = await pantallaConfiguracionCustodia(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!p) notFound();
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {p.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Custodia de sobres · {p.sucursal}</h1>
      <p className="sub">Solo datos ficticios. Sin esta configuración no se puede cerrar el día en la sucursal.</p>
      {aviso === "guardada" ? <p className="aviso aviso-ok" role="status">Custodia guardada. Se usará desde el siguiente cierre.</p> : null}
      {leerEntorno() === "produccion" ? (
        <p className="aviso aviso-info">La custodia está desactivada fuera del entorno de pruebas.</p>
      ) : (
        <section className="tarjeta">
          {p.vigente && !p.vigente.buzon ? (
            <p className="aviso aviso-info" data-testid="aviso-configurar-buzon">
              La configuración vigente es anterior al buzón (los sobres se verifican en cada turno). Al guardar, queda con buzón: la llave del
              buzón solo la tiene Dirección y en los turnos se registra solo la llave del cajón de los fondos.
            </p>
          ) : null}
          <FormularioConfigurarCustodia codigo={codigo} personas={p.personas} direccion={p.direccion}
            vigente={p.vigente ? {
              lugar: p.vigente.lugar, acceso: p.vigente.acceso.map((a) => a.id),
              lugarFondos: p.vigente.lugarFondos, accesoCajon: (p.vigente.accesoCajon ?? []).map((a) => a.id),
              custodias: (p.vigente.custodias ?? []).map((a) => a.id),
            } : null} />
        </section>
      )}
      {p.historial.length ? (
        <section className="tarjeta" aria-labelledby="t-hist">
          <h2 id="t-hist" className="titulo-seccion">Historial</h2>
          <ul className="lista-simple" data-testid="historial-custodia">
            {p.historial.map((c, i) => (
              <li key={c.id}>
                {hora.format(c.en)} · {c.configuradaPor} · {c.buzon ? "buzón: " : ""}<strong>{c.lugar}</strong> · {c.buzon ? "llave del buzón" : "acceso"}: {c.acceso.map((a) => a.nombre).join(", ")}
                {c.lugarFondos ? <> · fondos: <strong>{c.lugarFondos}</strong> · acceso al cajón: {(c.accesoCajon ?? []).map((a) => a.nombre).join(", ")}</> : " · sin fondos ni acceso al cajón"}
                {c.custodias ? <> · {c.buzon ? "custodias de la llave del cajón" : "custodias"}: <strong>{c.custodias.map((a) => a.nombre).join(", ")}</strong></> : " · custodia del Encargado (sin custodias nombradas)"}
                {i === 0 ? " · vigente" : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

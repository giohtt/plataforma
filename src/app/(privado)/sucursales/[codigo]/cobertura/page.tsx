import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioCobertura } from "@/components/FormularioCobertura";
import { obtenerBaseDatos } from "@/lib/db";
import { pantallaCobertura } from "@/lib/historial";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Cobertura del historial · Fitnessland" };

const diaUtc = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/** Dirección registra desde cuándo hay datos confiables de visitas en la sucursal. Sin permiso: «No encontrada». */
export default async function Cobertura({ params, searchParams }: PageProps<"/sucursales/[codigo]/cobertura">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const p = await pantallaCobertura(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!p) notFound();
  const { aviso } = await searchParams;
  const actual = p.registros[0];
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {p.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Cobertura del historial · {p.sucursal}</h1>
      <p className="sub">
        Solo datos ficticios. Indica desde cuándo hay datos confiables de visitas en esta sucursal. El historial de un visitante se marca
        «incompleto» si alguna sucursal de su alcance no tiene cobertura o no la tiene desde que empezó a operar. El primer turno no la fija solo.
      </p>
      {aviso === "registrada" ? <p className="aviso aviso-ok" role="status">Cobertura registrada.</p> : null}
      <section className="tarjeta" aria-labelledby="t-actual" data-testid="cobertura-actual">
        <h2 id="t-actual" className="titulo-seccion">Cobertura vigente</h2>
        {actual ? (
          <p>
            Datos confiables desde el <strong>{diaUtc.format(new Date(`${actual.desde}T00:00:00Z`))}</strong>
            {actual.desdeInicio ? " (desde que empezó a operar)" : " (puede haber visitas anteriores sin registrar)"} · registró {actual.registradaPor}
          </p>
        ) : (
          <p>Sin cobertura registrada.</p>
        )}
      </section>
      <section className="tarjeta" aria-labelledby="t-nueva">
        <h2 id="t-nueva" className="titulo-seccion">Registrar cobertura</h2>
        <FormularioCobertura codigo={codigo} />
      </section>
      {p.registros.length ? (
        <section className="tarjeta" aria-labelledby="t-cambios">
          <h2 id="t-cambios" className="titulo-seccion">Registros anteriores</h2>
          <ul className="lista-simple">
            {p.registros.map((r, i) => (
              <li key={i}>
                {fechaHora.format(new Date(r.registradaEn))} · {r.registradaPor}: desde el {diaUtc.format(new Date(`${r.desde}T00:00:00Z`))}
                {r.desdeInicio ? " (desde que empezó a operar)" : ""}{r.nota ? ` · «${r.nota}»` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

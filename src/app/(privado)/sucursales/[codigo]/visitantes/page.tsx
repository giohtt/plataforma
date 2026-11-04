import Link from "next/link";
import { notFound } from "next/navigation";
import { TarjetaVisitante } from "@/components/Visitantes";
import { interpretarConsulta } from "@/lib/datos-visitante";
import { obtenerBaseDatos } from "@/lib/db";
import { sucursalAccesiblePorCodigo } from "@/lib/permisos";
import { requerirSesion } from "@/lib/sesion-servidor";
import { buscarVisitantes, puedeEnSucursal } from "@/lib/visitantes";

export const metadata = { title: "Visitantes · Fitnessland" };

/** Búsqueda de expedientes por nombre o teléfono, desde una sucursal. Sin permiso: «No encontrada». */
export default async function BuscarVisitantes({ params, searchParams }: PageProps<"/sucursales/[codigo]/visitantes">) {
  const sesion = await requerirSesion();
  const sql = obtenerBaseDatos()!;
  const { codigo } = await params;
  const { q } = await searchParams;
  const texto = typeof q === "string" ? q.slice(0, 120) : "";
  const sucursal = await sucursalAccesiblePorCodigo(sql, sesion.usuarioId, codigo);
  if (!sucursal || !(await puedeEnSucursal(sql, sesion.usuarioId, codigo, "visitante.buscar"))) notFound();
  const puedeCrear = await puedeEnSucursal(sql, sesion.usuarioId, codigo, "visitante.crear");

  const busqueda = texto ? await buscarVisitantes(sql, sesion.usuarioId, codigo, interpretarConsulta(texto)) : null;
  if (busqueda && !busqueda.ok && busqueda.error === "no_encontrada") notFound();
  const nuevo = `/sucursales/${codigo}/visitantes/nuevo${texto ? `?q=${encodeURIComponent(texto)}` : ""}`;

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {sucursal.nombre}</Link></p>
      <h1 className="cabecera-titulo">Visitantes</h1>
      <p className="sub">Busca primero: el expediente es uno solo para todas las sucursales.</p>

      <form className="tarjeta buscador" method="get" role="search">
        <div className="campo">
          <label htmlFor="q">Nombre completo o teléfono</label>
          <input id="q" name="q" type="search" defaultValue={texto} autoComplete="off" maxLength={120} placeholder="Ej. María Hernández o 722 123 4567" />
          <span className="sub">Por teléfono, escribe los 10 dígitos.</span>
        </div>
        <button className="boton boton-principal" type="submit">Buscar</button>
      </form>

      {busqueda && !busqueda.ok ? <p className="aviso aviso-error" role="alert">{busqueda.motivo}</p> : null}

      {busqueda?.ok ? (
        <section className="tarjeta" aria-labelledby="t-resultados" data-testid="resultados">
          <h2 id="t-resultados" className="titulo-seccion">
            {busqueda.resultados.length === 0
              ? "Sin coincidencias"
              : busqueda.resultados.length === 1
                ? "1 coincidencia"
                : `${busqueda.resultados.length}${busqueda.limitado ? "+" : ""} coincidencias`}
          </h2>
          {busqueda.resultados.length > 1 ? (
            <p className="aviso aviso-info">Hay varias personas posibles. Confirma con el visitante cuál es antes de elegir.</p>
          ) : null}
          {busqueda.limitado ? <p className="sub">Se muestran las primeras 20. Escribe el nombre más completo o el teléfono.</p> : null}
          <ul className="lista-visitantes">
            {busqueda.resultados.map((v) => <TarjetaVisitante key={v.id} v={v} codigo={codigo} />)}
          </ul>
          {puedeCrear ? (
            <p className="fila-acciones">
              <Link className="boton" href={nuevo} data-testid="crear-visitante">
                {busqueda.resultados.length ? "No es ninguna: crear expediente nuevo" : "Crear expediente nuevo"}
              </Link>
            </p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

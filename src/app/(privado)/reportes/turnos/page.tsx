import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { reporteTurnos, type Responsable } from "@/lib/reporte-turnos";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Turnos abiertos · Fitnessland" };

const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

function Persona({ r }: { r: Responsable | null }) {
  return r ? <span>{r.nombre}<span className="sub"> · desde {hora.format(r.desde)}</span></span> : <span className="sub">Sin responsable</span>;
}

/** Solo consulta. Sin el permiso reporte.turnos (por ejemplo, Recepción): «No encontrada». */
export default async function ReporteTurnos({ searchParams }: PageProps<"/reportes/turnos">) {
  const sesion = await requerirSesion();
  const { sucursal } = await searchParams;
  const codigo = typeof sucursal === "string" && sucursal ? sucursal.slice(0, 10) : null;
  const r = await reporteTurnos(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!r) notFound();
  const volver = r.codigo ?? (r.sucursales.length === 1 ? r.sucursales[0].codigo : null);

  return (
    <main className="contenedor">
      <p className="sub"><Link href={volver ? `/sucursales/${volver}` : "/"}>← {volver ? r.sucursales.find((s) => s.codigo === volver)?.nombre : "Inicio"}</Link></p>
      <h1 className="cabecera-titulo">Turnos abiertos y responsables</h1>
      <p className="sub">Solo consulta. Solo datos ficticios. Actualizado: {hora.format(r.generadoEn)}</p>

      {r.sucursales.length > 1 ? (
        <form className="tarjeta filtros-reporte" method="get" action="/reportes/turnos">
          <div className="campo">
            <label htmlFor="sucursal">Sucursal</label>
            <select id="sucursal" name="sucursal" defaultValue={r.codigo ?? ""}>
              <option value="">Todas mis sucursales</option>
              {r.sucursales.map((s) => <option key={s.codigo} value={s.codigo}>{s.nombre}</option>)}
            </select>
          </div>
          <button className="boton" type="submit">Ver</button>
        </form>
      ) : null}

      <section className="tarjeta" aria-labelledby="t-turnos" data-testid="reporte-turnos">
        <h2 id="t-turnos" className="titulo-seccion">
          Turnos abiertos: <span data-testid="turnos-abiertos">{r.turnosAbiertos}</span>
        </h2>
        <p className="sub">La bolsa de visitas y el cajón de mensualidades tienen responsable por separado.</p>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead>
              <tr><th>Sucursal</th><th>Apertura</th><th>Abrió</th><th>Responsable de la bolsa de visitas</th><th>Responsable del cajón de mensualidades</th></tr>
            </thead>
            <tbody>
              {r.filas.map((f) => (
                <tr key={f.codigo} data-testid={`turno-${f.codigo}`}>
                  <td data-etiqueta="Sucursal">{f.nombre}</td>
                  {f.turno ? (
                    <>
                      <td data-etiqueta="Apertura">{hora.format(f.turno.abiertoEn)}</td>
                      <td data-etiqueta="Abrió">{f.turno.abiertoPor}</td>
                      <td data-etiqueta="Bolsa de visitas" data-testid={`bolsa-${f.codigo}`}><Persona r={f.turno.bolsa} /></td>
                      <td data-etiqueta="Cajón de mensualidades" data-testid={`cajon-${f.codigo}`}><Persona r={f.turno.cajon} /></td>
                    </>
                  ) : (
                    <td data-etiqueta="Turno" colSpan={4}><span className="sub">Sin turno abierto</span></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { reporteExpedientes, UMBRAL_NOMBRE_MUY_PARECIDO } from "@/lib/reporte-expedientes";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Expedientes creados · Fitnessland" };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const MOTIVO = { mismo_telefono: "Mismo teléfono", mismo_nombre: "Mismo nombre", nombre_parecido: "Nombre muy parecido" } as const;
const dia = (f: string) => fecha.format(new Date(`${f}T12:00:00Z`));

/**
 * Reporte básico del bloque 2. Solo consulta. Los filtros (sucursal y fechas) van en la dirección; no
 * contienen datos personales. Sin el permiso reporte.expedientes: «No encontrada».
 */
export default async function ReporteExpedientes({ searchParams }: PageProps<"/reportes/expedientes">) {
  const sesion = await requerirSesion();
  const p = await searchParams;
  const texto = (v: unknown) => (typeof v === "string" ? v.slice(0, 20) : null);
  const r = await reporteExpedientes(obtenerBaseDatos()!, sesion.usuarioId, {
    codigo: texto(p.sucursal) || null,
    desde: texto(p.desde),
    hasta: texto(p.hasta),
  });
  if (!r) notFound();
  const volver = r.filtro.codigo ?? (r.sucursales.length === 1 ? r.sucursales[0].codigo : null);

  return (
    <main className="contenedor">
      <p className="sub"><Link href={volver ? `/sucursales/${volver}` : "/"}>← {volver ? r.sucursales.find((s) => s.codigo === volver)?.nombre : "Inicio"}</Link></p>
      <h1 className="cabecera-titulo">Expedientes de visitantes</h1>
      <p className="sub">Solo consulta. Solo datos ficticios. Generado el {fecha.format(r.generadoEn)}.</p>

      <form className="tarjeta filtros-reporte" method="get" action="/reportes/expedientes">
        <div className="campo">
          <label htmlFor="sucursal">Sucursal</label>
          <select id="sucursal" name="sucursal" defaultValue={r.filtro.codigo ?? ""}>
            {r.sucursales.length > 1 ? <option value="">Todas mis sucursales</option> : null}
            {r.sucursales.map((s) => <option key={s.id} value={s.codigo}>{s.nombre}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor="desde">Desde</label>
          <input id="desde" name="desde" type="date" defaultValue={r.filtro.desde} />
        </div>
        <div className="campo">
          <label htmlFor="hasta">Hasta</label>
          <input id="hasta" name="hasta" type="date" defaultValue={r.filtro.hasta} />
        </div>
        <button className="boton" type="submit">Ver</button>
      </form>

      <section className="tarjeta" aria-labelledby="t-creados" data-testid="expedientes-creados">
        <h2 id="t-creados" className="titulo-seccion">Expedientes creados</h2>
        <p className="sub">
          Del {dia(r.filtro.desde)} al {dia(r.filtro.hasta)}, por la sucursal donde se creó cada ficha. Las visitas por
          sucursal se contarán en el bloque 4.
        </p>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Sucursal</th><th>Expedientes creados</th><th>De ellos, unidos después a otra ficha</th></tr></thead>
            <tbody>
              {r.creados.map((f) => (
                <tr key={f.codigo} data-codigo={f.codigo}>
                  <td data-etiqueta="Sucursal">{f.nombre}</td>
                  <td data-etiqueta="Expedientes creados" data-testid={`creados-${f.codigo}`}>{f.creados}</td>
                  <td data-etiqueta="Unidos después">{f.unidosDespues}</td>
                </tr>
              ))}
              {r.creados.length > 1 ? (
                <tr className="fila-total"><td data-etiqueta="Sucursal"><strong>Total</strong></td><td data-etiqueta="Expedientes creados" data-testid="creados-total"><strong>{r.totalCreados}</strong></td><td data-etiqueta="Unidos después" /></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="tarjeta" aria-labelledby="t-duplicados" data-testid="posibles-duplicados">
        <h2 id="t-duplicados" className="titulo-seccion">
          Posibles duplicados pendientes: <span data-testid="total-duplicados">{r.totalDuplicados}</span>
        </h2>
        <p className="sub">
          Pares de fichas activas con el mismo teléfono o un nombre muy parecido (similitud de al menos{" "}
          {Math.round(UMBRAL_NOMBRE_MUY_PARECIDO * 100)}%). No incluye personas ya confirmadas como distintas ni fichas
          unidas. Un par con fichas de dos sucursales solo aparece si tienes este reporte en ambas. No es la fecha del
          periodo: son los pendientes de hoy.
        </p>
        {r.duplicados.length ? (
          <ul className="lista-pares">
            {r.duplicados.map((d) => (
              <li key={`${d.a.id}-${d.b.id}`} className="par-duplicado" data-testid="par">
                <span className="motivos-coincidencia">
                  {d.motivos.map((m) => <span key={m} className="chip-estado chip-programada">{MOTIVO[m]}</span>)}
                </span>
                <div className="par-fichas">
                  {[d.a, d.b].map((f) => (
                    <div key={f.id} className="tarjeta-visitante-datos">
                      <strong>{f.nombre}</strong>
                      <span className="sub">Tel. {f.telefono ?? "no registrado"}</span>
                      <span className="sub">Creada en {f.sucursal} el {fecha.format(f.creadoEn)}</span>
                      <Link href={`/sucursales/${f.codigo}/visitantes/${f.id}`}>Ver ficha</Link>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="sub">Ninguno.</p>}
        {r.totalDuplicados > r.duplicados.length ? <p className="sub">Se muestran los primeros {r.duplicados.length}.</p> : null}
      </section>
    </main>
  );
}

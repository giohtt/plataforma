import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { detalleCaja } from "@/lib/reporte-caja";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Detalle del reporte de caja · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (v: string) => (Number(v) < 0 ? `−${pesos.format(-Number(v))}` : pesos.format(Number(v)));
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const dia = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" });
const fecha = (f: string) => dia.format(new Date(`${f}T00:00:00Z`));
const texto = (v: string | string[] | undefined, max = 40) => (typeof v === "string" ? v.slice(0, max) : "");
const oculto = <span className="importe-oculto">Oculto: sin contar</span>;

/** Detalle e historial de un importe del reporte de caja, con el mismo corte con que se abrió. */
export default async function DetalleCaja({ searchParams }: PageProps<"/reportes/caja/detalle">) {
  const sesion = await requerirSesion();
  const q = await searchParams;
  const p = await detalleCaja(obtenerBaseDatos()!, sesion.usuarioId, {
    codigo: texto(q.sucursal, 10), desde: texto(q.desde, 10) || undefined, hasta: texto(q.hasta, 10) || undefined, corte: texto(q.corte) || undefined,
    tipo: texto(q.tipo, 20), id: texto(q.id, 40),
  });
  if (!p) notFound();
  const d = p.detalle;
  const volver = `/reportes/caja?${new URLSearchParams({ sucursal: p.sucursal.codigo, desde: p.desde, hasta: p.hasta, corte: p.corte.toISOString() })}`;
  const enlace = (tipo: string, id: string) =>
    `/reportes/caja/detalle?${new URLSearchParams({ sucursal: p.sucursal.codigo, desde: p.desde, hasta: p.hasta, corte: p.corte.toISOString(), tipo, id })}`;

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={volver}>← Reporte de caja · {p.sucursal.nombre} · {fecha(p.desde)} al {fecha(p.hasta)} · corte {hora.format(p.corte)}</Link></p>
      <h1 className="cabecera-titulo">{d.titulo}{d.anterior ? <> <span className="marca-anterior">Anterior al periodo</span></> : null}</h1>
      <p className="sub">{d.subtitulo} · Solo datos ficticios.</p>
      <div className="franja-corte" data-testid="corte-detalle">
        <span>Corte: <b>{hora.format(p.corte)}</b> · {p.sucursal.nombre} · {fecha(p.desde)} al {fecha(p.hasta)}</span>
        <span>Las cifras de esta página son al corte</span>
      </div>

      <section className="tarjeta" data-testid="al-corte">
        <h2 className="titulo-seccion">Dónde estaba al corte</h2>
        <p className="aviso aviso-info">{d.alCorte}</p>
        {d.importeAlCorte !== null || d.oculto ? (
          <p className="cifra-reporte" data-testid="importe-al-corte">{d.importeAlCorte === null ? oculto : <strong>{$(d.importeAlCorte)}</strong>}</p>
        ) : null}
        <ul className="lista-simple" data-testid="filas-detalle">
          {d.filas.map((f, i) => (
            <li key={i}>{f.etiqueta} · {f.valor === null ? oculto : <strong>{$(f.valor)}</strong>}{f.nota ? <><br /><span className="sub">{f.nota}</span></> : null}</li>
          ))}
        </ul>
        {d.tabla ? (
          <div className="tabla-desplazable">
            <table className="tabla">
              <thead><tr>{d.tabla.columnas.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {d.tabla.filas.map((f, i) => (
                  <tr key={i}>
                    {f.celdas.map((c, j) => (
                      <td key={j} data-etiqueta={d.tabla!.columnas[j]}>
                        {j === 0 && f.enlace ? <Link prefetch={false} href={enlace(f.enlace.tipo, f.enlace.id)}><span className="mono">{c}</span></Link>
                          : c === null ? oculto : /^-?\d+\.\d{2}$/.test(c) ? $(c) : c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {d.anotadosSinContar ? <p className="sub">Contiene importes anotados de sobres sin contar: no los recoges, por eso los ves.</p> : null}
      </section>

      <section className="tarjeta" data-testid="historial-detalle">
        <h2 className="titulo-seccion">Historial</h2>
        {d.eventos.length ? (
          <ol className="lista-simple">
            {d.eventos.map((e, i) => (
              <li key={i} className={e.despues ? "despues-corte" : undefined} data-testid={e.despues ? "evento-despues" : "evento"}>
                {e.despues ? <b>Después del corte · </b> : null}{hora.format(e.en)} · {e.texto}{e.persona ? ` · ${e.persona}` : ""}
              </li>
            ))}
          </ol>
        ) : <p className="sub">Sin movimientos registrados.</p>}
        <p className="sub">Nada se edita ni se borra; cada paso queda con cuenta, fecha y hora. Lo posterior al corte se ve en gris y no cambia las cifras al corte.</p>
      </section>
    </main>
  );
}

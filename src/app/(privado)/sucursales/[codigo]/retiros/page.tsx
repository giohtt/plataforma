import Link from "next/link";
import { notFound } from "next/navigation";
import { NOMBRE_LUGAR } from "@/lib/datos-diferencia";
import { obtenerBaseDatos } from "@/lib/db";
import { listaRetiros } from "@/lib/retiros";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Retiros de efectivo · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const firmado = (v: string) => (Number(v) < 0 ? "−" : "+") + pesos.format(Math.abs(Number(v)));

/**
 * Retiros de la sucursal. Administración y Dirección: todos y el saldo bajo responsabilidad de Encargada de retiros.
 * Encargado: solo las discrepancias que le toca revisar.
 */
export default async function RetirosSucursal({ params }: PageProps<"/sucursales/[codigo]/retiros">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const l = await listaRetiros(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!l) notFound();
  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {l.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Retiros de efectivo · {l.sucursal}</h1>
      <p className="sub">
        Solo datos ficticios. {l.consulta
          ? "Todos los retiros de la sucursal y el saldo que sigue bajo responsabilidad de Encargada de retiros."
          : "Las discrepancias en retiros que te toca revisar, según quién participó."}
      </p>

      {l.consulta ? (
        <section className="tarjeta" aria-labelledby="t-saldo" data-testid="saldo-por-encargada">
          <h2 id="t-saldo" className="titulo-seccion">Bajo responsabilidad de Encargada de retiros</h2>
          {l.porEncargada.length ? (
            <div className="tabla-desplazable" tabIndex={0} aria-label="Saldo por Encargada de retiros">
              <table className="tabla tabla-ancha">
                <thead><tr><th>Encargada de retiros</th><th>Sin destino</th><th>En pausa (por revisar)</th><th>Por aclarar</th><th>Faltante pendiente para Dirección</th><th>Avisos de 48 horas</th></tr></thead>
                <tbody>
                  {l.porEncargada.map((x) => (
                    <tr key={x.encargada} data-testid="saldo-encargada">
                      <td>{x.encargada}</td>
                      <td data-testid="sin-destino"><strong>{pesos.format(Number(x.sinDestino))}</strong></td>
                      <td data-testid="en-pausa">{pesos.format(Number(x.enPausa))}</td>
                      <td data-testid="por-aclarar">{Number(x.porAclarar) ? firmado(x.porAclarar) : pesos.format(0)}</td>
                      <td data-testid="faltante-direccion">{Number(x.faltanteDireccion) ? `−${pesos.format(Number(x.faltanteDireccion))}` : pesos.format(0)}</td>
                      <td>{x.avisos48 ? <span className="chip-estado chip-vencida">{x.avisos48}</span> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="sub">Sin retiros todavía.</p>}
          <p className="sub">Lo que no coincide no se suma al saldo: queda aparte «por aclarar» hasta revisarlo.</p>
        </section>
      ) : null}

      <section className="tarjeta" aria-labelledby="t-lista" data-testid="lista-retiros">
        <h2 id="t-lista" className="titulo-seccion">Retiros</h2>
        {l.retiros.length ? (
          <div className="tabla-desplazable" tabIndex={0} aria-label="Retiros: desliza para ver todas las columnas">
            <table className="tabla tabla-ancha">
              <thead><tr><th>Folio</th><th>Lugar</th><th>Entregó</th><th>Encargada de retiros</th><th>Estado</th><th>Sin destino</th><th></th></tr></thead>
              <tbody>
                {l.retiros.map((r) => (
                  <tr key={r.id} data-testid="retiro" data-folio={r.folio}>
                    <td className="mono">{r.folio}</td>
                    <td>{NOMBRE_LUGAR[r.lugar]}</td>
                    <td>{r.entregadoPor} · {hora.format(r.entregadoEn)}</td>
                    <td>{r.encargada}</td>
                    <td data-testid="estado">
                      <strong>{r.textoEstado}</strong>
                      {r.avisos.revision ? <><br /><span className="sub">Por revisar desde hace {r.avisos.revision.texto}</span></> : null}
                      {r.avisos.revision?.masDe48 ? <> <span className="chip-estado chip-vencida">48 horas o más en revisión</span></> : null}
                      {r.avisos.sinDestino?.masDe48 ? <><br /><span className="chip-estado chip-vencida">48 horas o más con saldo sin destino</span></> : null}
                    </td>
                    <td>{r.saldo.habilitado !== null ? pesos.format(Number(r.saldo.sinDestino)) : "En pausa"}</td>
                    <td><Link href={`/sucursales/${codigo}/retiros/${r.id}`} data-testid="ver-retiro">Ver</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub">{l.consulta ? "Todavía no hay retiros en esta sucursal." : "No tienes discrepancias por revisar."}</p>}
      </section>
    </main>
  );
}

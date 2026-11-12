import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { ESTADO_DIFERENCIA, etiquetaDiferencia, NOMBRE_LUGAR, tiempoPendiente } from "@/lib/datos-diferencia";
import { listaDiferencias } from "@/lib/diferencias";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Diferencias de efectivo · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const firmado = (v: string) => (Number(v) < 0 ? "−" : "+") + pesos.format(Math.abs(Number(v)));

/** Diferencias de efectivo de los cambios de turno de la sucursal; primero las que siguen por revisar. */
export default async function Diferencias({ params }: PageProps<"/sucursales/[codigo]/diferencias">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const r = await listaDiferencias(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!r) notFound();
  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {r.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Diferencias de efectivo · {r.sucursal}</h1>
      <p className="sub">Cambios de turno confirmados, con las diferencias por revisar primero. Solo datos ficticios.</p>
      <section className="tarjeta">
        {r.casos.length ? (
          <div className="tabla-desplazable">
            <table className="tabla" data-testid="lista-diferencias">
              <thead><tr><th>Cambio de turno</th><th>Quién entregó y quién recibió</th><th>Diferencias</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {r.casos.map((c) => (
                  <tr key={c.entregaId} data-testid="caso-diferencia">
                    <td data-etiqueta="Confirmado">{hora.format(c.confirmadaEn)}</td>
                    <td data-etiqueta="Personas">{c.entregaPor} → {c.recibe}</td>
                    <td data-etiqueta="Diferencias">
                      {c.diferencias.length ? (
                        <ul className="lista-simple">
                          {c.diferencias.map((d) => (
                            <li key={d.id}>{NOMBRE_LUGAR[d.lugar]}: <strong style={{ whiteSpace: "nowrap" }}>{firmado(d.importe)}</strong> · {etiquetaDiferencia(d.tipo, d.importe)} · {ESTADO_DIFERENCIA[d.estado]}</li>
                          ))}
                        </ul>
                      ) : "Sin diferencias"}
                      {c.diferencias.length > 1 ? <p className="sub" data-testid="neto">Total neto en la bolsa: {Number(c.neto) ? firmado(c.neto) : pesos.format(0)} (solo referencia; cada diferencia se revisa aparte)</p> : null}
                    </td>
                    <td data-etiqueta="Estado" data-testid="estado-caso">
                      {c.pendientes ? <span className="chip-estado chip-vencida">{c.pendientes} por revisar</span> : null}
                      {c.paraDireccion ? (() => {
                        const desde = c.diferencias.map((d) => d.pendienteDireccionDesde).filter((x): x is Date => !!x)
                          .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
                        const t = tiempoPendiente(desde);
                        return (
                          <>
                            {" "}<span className="chip-estado chip-vencida" data-testid="para-direccion">{c.paraDireccion} pendiente{c.paraDireccion === 1 ? "" : "s"} para Dirección</span>
                            <br /><span className="sub" data-testid="tiempo-pendiente">hace {t.texto}</span>
                            {t.masDe48 ? <> <span className="chip-estado chip-vencida" data-testid="aviso-48">Más de 48 horas pendiente</span></> : null}
                          </>
                        );
                      })() : null}
                      {!c.pendientes && !c.paraDireccion ? "Sin pendientes" : null}
                    </td>
                    <td data-etiqueta=""><Link href={`/sucursales/${codigo}/diferencias/${c.entregaId}`} data-testid="ver-caso">Ver caso</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub">Todavía no hay cambios de turno confirmados en esta sucursal.</p>}
      </section>
    </main>
  );
}

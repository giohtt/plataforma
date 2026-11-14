import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioConfirmarRetiro, FormularioRecontar } from "@/components/Retiros";
import { NOMBRE_LUGAR } from "@/lib/datos-diferencia";
import { obtenerBaseDatos } from "@/lib/db";
import { bandejaEncargada } from "@/lib/retiros";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Retiros · Encargada de retiros · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const firmado = (v: string) => (Number(v) < 0 ? "−" : "+") + pesos.format(Math.abs(Number(v)));

const AVISOS: Record<string, string> = {
  confirmado: "Retiro confirmado. Ya puedes registrar su depósito.",
  recuento: "Lo que contaste no coincide con lo registrado. Recuenten en persona o, si no pueden, registra «No coincide» con motivo.",
  por_revisar: "Registrado como «No coincide». El retiro queda por revisar y solo los depósitos de ese folio quedan en pausa.",
};

/** Bandeja de Encargada de retiros: lo que espera su conteo y el saldo bajo su responsabilidad. */
export default async function Retiros({ searchParams }: PageProps<"/retiros">) {
  const sesion = await requerirSesion();
  const b = await bandejaEncargada(obtenerBaseDatos()!, sesion.usuarioId);
  if (!b) notFound();
  const { aviso } = await searchParams;
  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href="/">← Tus sucursales</Link></p>
      <h1 className="cabecera-titulo">Retiros · Encargada de retiros</h1>
      <p className="sub">Solo datos ficticios. Confirmas desde tu propia cuenta lo que recibes en persona y registras su depósito.</p>
      {typeof aviso === "string" && AVISOS[aviso] ? <p className="aviso aviso-ok" role="status">{AVISOS[aviso]}</p> : null}

      <section className="tarjeta tarjeta-oscura" data-testid="saldo-encargada">
        <p className="sub">Bajo tu responsabilidad · Encargada de retiros</p>
        <p className="cifra-grande" data-testid="saldo-sin-destino">{pesos.format(Number(b.total.sinDestino))}</p>
        <p className="sub">Confirmado o verificado, sin depósito registrado.</p>
        {Number(b.total.enPausa) ? (
          <p data-testid="saldo-en-pausa">En pausa por revisión (lo que contaste): <strong>{pesos.format(Number(b.total.enPausa))}</strong></p>
        ) : null}
        {Number(b.total.porAclarar) ? (
          <p data-testid="saldo-por-aclarar">Diferencia por aclarar, fuera de tu saldo: <strong>{firmado(b.total.porAclarar)}</strong></p>
        ) : null}
      </section>

      <section className="tarjeta" aria-labelledby="t-confirmar" data-testid="por-confirmar">
        <h2 id="t-confirmar" className="titulo-seccion">Retiros por confirmar ({b.porConfirmar.length + b.porRecontar.length})</h2>
        {!b.porConfirmar.length && !b.porRecontar.length ? <p className="sub">No tienes retiros por confirmar.</p> : null}
        <div className="lugares-turno">
          {b.porConfirmar.map((r) => (
            <div key={r.id} className="tarjeta" data-testid="retiro-por-confirmar" data-folio={r.folio}>
              <h3 className="titulo-seccion">{NOMBRE_LUGAR[r.lugar]} · {r.sucursal}</h3>
              <dl className="cuentas-lugar">
                <dt>Folio del sobre</dt><dd className="mono">{r.folio}</dd>
                <dt>Entregó</dt><dd>{r.entregadoPor} · {hora.format(r.entregadoEn)}</dd>
                <dt>Dejaste para cambio</dt><dd>{pesos.format(Number(r.cambio))}</dd>
              </dl>
              <FormularioConfirmarRetiro retiroId={r.id} version={r.version} folio={r.folio} />
            </div>
          ))}
          {b.porRecontar.map((r) => (
            <div key={r.id} className="tarjeta" data-testid="retiro-por-recontar" data-folio={r.folio}>
              <h3 className="titulo-seccion">{NOMBRE_LUGAR[r.lugar]} · {r.sucursal}</h3>
              <dl className="cuentas-lugar">
                <dt>Folio del sobre</dt><dd className="mono">{r.folio}</dd>
                <dt>Entregó</dt><dd>{r.entregadoPor} · {hora.format(r.entregadoEn)}</dd>
              </dl>
              <FormularioRecontar retiroId={r.id} version={r.version} registrado={r.registrado} inicial={r.inicial} personas={r.personas} />
            </div>
          ))}
        </div>
      </section>

      <section className="tarjeta" aria-labelledby="t-mios" data-testid="mis-retiros">
        <h2 id="t-mios" className="titulo-seccion">Tus retiros</h2>
        {b.retiros.length ? (
          <div className="tabla-desplazable" tabIndex={0} aria-label="Tus retiros: desliza para ver todas las columnas">
            <table className="tabla tabla-ancha">
              <thead><tr><th>Folio</th><th>Lugar</th><th>Estado</th><th>Habilitado</th><th>Depositado</th><th>Sigue bajo tu responsabilidad</th><th></th></tr></thead>
              <tbody>
                {b.retiros.map((r) => (
                  <tr key={r.id} data-testid="mi-retiro" data-folio={r.folio}>
                    <td className="mono">{r.folio}</td>
                    <td>{NOMBRE_LUGAR[r.lugar]} · {r.sucursal}</td>
                    <td data-testid="estado">
                      <strong>{r.textoEstado}</strong>
                      {r.avisos.revision ? <><br /><span className="sub">Por revisar desde hace {r.avisos.revision.texto}</span></> : null}
                      {r.avisos.revision?.masDe48 ? <> <span className="chip-estado chip-vencida">48 horas o más en revisión</span></> : null}
                      {r.avisos.sinDestino?.masDe48 ? <><br /><span className="chip-estado chip-vencida" data-testid="aviso-sin-destino">48 horas o más con saldo sin destino</span></> : null}
                    </td>
                    <td>{r.saldo.habilitado !== null ? pesos.format(Number(r.saldo.habilitado)) : "En pausa"}</td>
                    <td>{pesos.format(Number(r.saldo.depositado))}</td>
                    <td data-testid="sin-destino">
                      <strong>{r.saldo.habilitado !== null ? pesos.format(Number(r.saldo.sinDestino)) : `${pesos.format(Number(r.saldo.enPausa))} en pausa`}</strong>
                      {Number(r.saldo.porAclarar) ? <><br /><span className="sub">{firmado(r.saldo.porAclarar)} por aclarar (fuera de tu saldo)</span></> : null}
                    </td>
                    <td><Link href={`/sucursales/${r.codigo}/retiros/${r.id}`} data-testid="ver-retiro">Ver</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub">Todavía no confirmas retiros.</p>}
      </section>
    </main>
  );
}

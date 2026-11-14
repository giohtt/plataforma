import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioDeposito, FormularioRevisionRetiro } from "@/components/Retiros";
import { NOMBRE_LUGAR } from "@/lib/datos-diferencia";
import { obtenerBaseDatos } from "@/lib/db";
import { detalleRetiro, NOMBRE_NIVEL_RETIRO } from "@/lib/retiros";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Retiro · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const firmado = (v: number) => (v < 0 ? "−" : v > 0 ? "+" : "") + pesos.format(Math.abs(v) / 100);
const cent = (v: string) => Math.round(Number(v) * 100);

const AVISOS: Record<string, string> = {
  revisado: "Revisión registrada. Los depósitos de este folio quedan habilitados por el monto verificado; la salida y los conteos no cambiaron.",
  depositado: "Depósito registrado.",
  corregido: "Corrección registrada. El depósito anterior se conserva en el historial.",
};

/** Detalle de un retiro: lo registrado, los conteos de Encargada de retiros, la revisión, los depósitos y el historial. */
export default async function Retiro({ params, searchParams }: PageProps<"/sucursales/[codigo]/retiros/[retiro]">) {
  const sesion = await requerirSesion();
  const { codigo, retiro } = await params;
  const d = await detalleRetiro(obtenerBaseDatos()!, sesion.usuarioId, codigo, retiro);
  if (!d) notFound();
  const { aviso } = await searchParams;
  const r = d.retiro;
  const contado = d.conteos.recuento?.importe ?? d.conteos.inicial?.importe ?? null;
  const vigentes = d.depositos.filter((x) => x.vigente && Number(x.importe) > 0);
  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={d.esSuyo ? "/retiros" : `/sucursales/${codigo}/retiros`}>← {d.esSuyo ? "Tus retiros" : `Retiros de ${r.sucursal}`}</Link></p>
      <h1 className="cabecera-titulo">Retiro <span className="mono">{r.folio}</span> · {NOMBRE_LUGAR[r.lugar]} · {r.sucursal}</h1>
      <p className="sub">
        De <strong>{r.entregadoPor}</strong> a <strong>{r.encargada}</strong> (Encargada de retiros), en persona · {hora.format(r.entregadoEn)}
      </p>
      {typeof aviso === "string" && AVISOS[aviso] ? <p className="aviso aviso-ok" role="status">{AVISOS[aviso]}</p> : null}
      <p>
        <span className={`chip-estado ${r.estado === "por_revisar" || r.estado === "recuento" || r.estado === "pendiente" || r.resultado === "faltante_confirmado" ? "chip-vencida" : "chip-aclarada"}`} data-testid="estado-retiro">{r.textoEstado}</span>
        {r.avisos.revision ? <> <span className="sub" data-testid="tiempo-revision">Por revisar desde hace {r.avisos.revision.texto}</span></> : null}
        {r.avisos.revision?.masDe48 ? <> <span className="chip-estado chip-vencida" data-testid="aviso-48-revision">48 horas o más en revisión</span></> : null}
      </p>

      <section className="tarjeta" aria-labelledby="t-cifras" data-testid="cifras-retiro">
        <h2 id="t-cifras" className="titulo-seccion">Lo registrado y lo contado</h2>
        <div className="cifras-caso">
          {d.registrado ? (
            <>
              <div className="cifra-caso"><span className="sub">Contó antes del retiro · {r.entregadoPor}</span><strong>{pesos.format(Number(d.registrado.contado))}</strong>
                {d.registrado.esperado !== null ? <span className="sub">Esperado {pesos.format(Number(d.registrado.esperado))}</span> : <span className="sub">Esperado no calculado</span>}</div>
              <div className="cifra-caso"><span className="sub">Deja para cambio</span><strong>{pesos.format(Number(d.registrado.cambio))}</strong></div>
              <div className="cifra-caso" data-testid="cifra-registrado"><span className="sub">Registró como entregado (salida)</span><strong>{pesos.format(Number(d.registrado.importe))}</strong></div>
            </>
          ) : (
            <div className="cifra-caso"><span className="sub">Registrado por Recepción</span><strong>—</strong><span className="sub">Se muestra después de tu conteo.</span></div>
          )}
          {d.conteos.inicial ? (
            <div className="cifra-caso" data-testid="cifra-inicial"><span className="sub">Contó al recibir · {r.encargada}</span><strong>{pesos.format(Number(d.conteos.inicial.importe))}</strong>
              <span className="sub">Folio {d.conteos.inicial.folioCoincide ? "coincide" : "no coincide"}</span></div>
          ) : null}
          {d.conteos.recuento ? (
            <div className="cifra-caso" data-testid="cifra-recuento"><span className="sub">Recuento en persona con {d.conteos.recuento.con}</span><strong>{pesos.format(Number(d.conteos.recuento.importe))}</strong></div>
          ) : null}
          {d.registrado && contado !== null && cent(contado) !== cent(d.registrado.importe) ? (
            <div className="cifra-caso cifra-mal" data-testid="cifra-diferencia"><span className="sub">Diferencia (contado al recibir − registrado)</span><strong>{firmado(cent(contado) - cent(d.registrado.importe))}</strong></div>
          ) : null}
        </div>
        {d.motivo ? <p className="sub" data-testid="motivo-discrepancia">«No coincide» ({r.discrepancia === "folio" ? "folio" : "importe"}) · {d.reportadoEn ? hora.format(d.reportadoEn) : ""} · Motivo: «{d.motivo}»</p> : null}
        {r.discrepancia ? (
          <p className="sub" data-testid="quien-revisa">
            Participaron: {d.participantes.join(", ")}. <strong>Revisa: {NOMBRE_NIVEL_RETIRO[d.nivel]}</strong>, según quién participó; quien participó no revisa.
          </p>
        ) : null}
        <p className="sub">La salida registrada al entregar y los conteos se conservan; no se editan ni se borran.</p>
      </section>

      {d.revision ? (
        <section className="tarjeta" aria-labelledby="t-revision" data-testid="revision-retiro">
          <h2 id="t-revision" className="titulo-seccion">Revisión</h2>
          <p>
            <strong>{d.revision.resultado === "aclarada" ? "Aclarada" : "Faltante confirmado"}</strong> · revisó <strong>{d.revision.revisadaPor}</strong> ({NOMBRE_NIVEL_RETIRO[d.revision.nivel]}) · {hora.format(d.revision.en)}
          </p>
          <p>Monto verificado: <strong data-testid="monto-verificado">{pesos.format(Number(d.revision.montoVerificado))}</strong> · Motivo: «{d.revision.motivo}»</p>
          {d.revision.resultado === "faltante_confirmado" ? (
            <p className="aviso aviso-info" data-testid="faltante-direccion">
              Faltante de {pesos.format(Number(r.saldo.faltanteDireccion))}: pendiente para Dirección. Los depósitos del folio ya están habilitados por el monto verificado.
            </p>
          ) : null}
        </section>
      ) : d.puedeRevisar ? (
        <section className="tarjeta" aria-labelledby="t-revisar">
          <h2 id="t-revisar" className="titulo-seccion">Revisar la discrepancia</h2>
          <FormularioRevisionRetiro codigo={codigo} retiroId={r.id} version={r.version} registrado={d.registrado!.importe} />
        </section>
      ) : r.estado === "por_revisar" ? (
        <p className="aviso aviso-info" data-testid="pausa">
          Por revisar ({NOMBRE_NIVEL_RETIRO[d.nivel]}). Los depósitos de este folio están en pausa hasta aclararlo; los demás folios siguen normales.
        </p>
      ) : null}

      <section className="tarjeta" aria-labelledby="t-depositos" data-testid="seguimiento">
        <h2 id="t-depositos" className="titulo-seccion">Depósitos</h2>
        <dl className="cuentas-lugar">
          <dt>Habilitado para depósitos</dt>
          <dd data-testid="habilitado">{r.saldo.habilitado !== null ? pesos.format(Number(r.saldo.habilitado)) : "En pausa"}</dd>
          <dt>Depositado</dt>
          <dd data-testid="depositado">{pesos.format(Number(r.saldo.depositado))}</dd>
          <dt>Sigue bajo responsabilidad de Encargada de retiros</dt>
          <dd data-testid="sin-destino"><strong>{r.saldo.habilitado !== null ? pesos.format(Number(r.saldo.sinDestino)) : `${pesos.format(Number(r.saldo.enPausa))} en pausa`}</strong></dd>
          {Number(r.saldo.porAclarar) ? (<><dt>Por aclarar (fuera de su saldo)</dt><dd data-testid="por-aclarar">{firmado(cent(r.saldo.porAclarar))}</dd></>) : null}
        </dl>
        {r.avisos.sinDestino ? (
          <p className="sub" data-testid="tiempo-sin-destino">
            Saldo sin destino desde hace {r.avisos.sinDestino.texto}
            {r.avisos.sinDestino.masDe48 ? <> · <span className="chip-estado chip-vencida" data-testid="aviso-sin-destino">48 horas o más con saldo sin destino</span></> : null}
          </p>
        ) : null}
        {d.depositos.length ? (
          <div className="tabla-desplazable" tabIndex={0} aria-label="Depósitos del folio">
            <table className="tabla tabla-ancha">
              <thead><tr><th>Depósito</th><th>Importe</th><th>Referencia</th><th>Registró</th><th>Estado</th></tr></thead>
              <tbody>
                {d.depositos.map((x) => (
                  <tr key={x.id} data-testid="deposito">
                    <td>{hora.format(x.depositadoEn)}</td>
                    <td>{pesos.format(Number(x.importe))}</td>
                    <td className="mono">{x.referencia}</td>
                    <td>{x.registradoPor} · {hora.format(x.en)}</td>
                    <td>{x.vigente ? (x.corrige ? `Vigente (corrección: «${x.motivoCorreccion}»)` : "Vigente") : "Reemplazado por una corrección"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {d.puedeDepositar ? (
          <>
            <h3 className="titulo-seccion">Registrar depósito</h3>
            <FormularioDeposito codigo={codigo} retiroId={r.id} porDepositar={r.saldo.sinDestino} />
          </>
        ) : null}
        {d.esSuyo && vigentes.length ? (
          <details>
            <summary>Corregir un depósito</summary>
            {vigentes.map((x) => (
              <div key={x.id} className="tarjeta">
                <p className="sub">Depósito de {pesos.format(Number(x.importe))} · referencia <span className="mono">{x.referencia}</span></p>
                <FormularioDeposito codigo={codigo} retiroId={r.id} porDepositar={r.saldo.sinDestino} corrige={{ id: x.id, importe: x.importe, referencia: x.referencia }} />
              </div>
            ))}
          </details>
        ) : null}
        <p className="sub">Único destino en esta versión: depósito bancario. Los depósitos no pasan del monto habilitado del folio.</p>
      </section>

      <section className="tarjeta" aria-labelledby="t-historial" data-testid="historial-retiro">
        <h2 id="t-historial" className="titulo-seccion">Historial del retiro</h2>
        <div className="tabla-desplazable" tabIndex={0} aria-label="Historial del retiro">
          <table className="tabla tabla-ancha">
            <thead><tr><th>Fecha y hora</th><th>Qué pasó</th><th>Cuenta</th></tr></thead>
            <tbody>
              {d.historial.map((h, i) => (
                <tr key={i}><td>{hora.format(h.en)}</td><td>{h.que}</td><td>{h.cuenta}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">El historial no se edita ni se borra.</p>
      </section>
    </main>
  );
}

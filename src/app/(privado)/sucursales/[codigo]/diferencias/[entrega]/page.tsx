import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { etiquetaDiferencia, NOMBRE_LUGAR } from "@/lib/datos-diferencia";
import { detalleDiferencias } from "@/lib/diferencias";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Diferencia de efectivo · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const firmado = (v: string) => (Number(v) < 0 ? "−" : Number(v) > 0 ? "+" : "") + pesos.format(Math.abs(Number(v)));
const LUGARES = ["bolsa_visitas", "cajon_mensualidades"] as const;

/** Un cambio de turno: esperado, entregado, recibido y cada diferencia por separado, con el desglose del esperado. */
export default async function CasoDiferencia({ params }: PageProps<"/sucursales/[codigo]/diferencias/[entrega]">) {
  const sesion = await requerirSesion();
  const { codigo, entrega } = await params;
  const c = await detalleDiferencias(obtenerBaseDatos()!, sesion.usuarioId, codigo, entrega);
  if (!c) notFound();
  const dif = (lugar: (typeof LUGARES)[number], tipo: "contra_esperado" | "entre_personas") =>
    c.diferencias.find((d) => d.lugar === lugar && d.tipo === tipo);
  const f = c.fueraDeLaBolsa;
  const coincide = c.desglose.calculado === Number(c.lugares.bolsa_visitas.esperado).toFixed(2);
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/diferencias`}>← Diferencias de {c.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Cambio de turno · {c.sucursal}</h1>
      <p className="sub">
        De <strong>{c.entregaPor}</strong> a <strong>{c.recibe}</strong> · entregó {hora.format(c.entregadaEn)} · confirmó {hora.format(c.confirmadaEn)} desde su propia cuenta
      </p>
      {c.participaste ? (
        <p className="aviso aviso-info" data-testid="participaste">Participaste en esta entrega: su revisión le corresponde a otra persona.</p>
      ) : null}
      {LUGARES.map((l) => {
        const x = c.lugares[l];
        const de = dif(l, "contra_esperado");
        const dp = dif(l, "entre_personas");
        return (
          <section key={l} className="tarjeta" data-testid={`caso-${l}`} aria-label={NOMBRE_LUGAR[l]}>
            <h2 className="titulo-seccion">{NOMBRE_LUGAR[l]}</h2>
            <div className="cifras-caso">
              <div className="cifra-caso"><span className="sub">Saldo esperado</span>
                <strong data-testid="cifra-esperado">{x.esperado !== null ? pesos.format(Number(x.esperado)) : "No calculado"}</strong>
                {x.esperado === null ? <span className="sub">Faltan datos de Open Desk</span> : null}</div>
              <div className="cifra-caso"><span className="sub">Entregó {c.entregaPor}</span><strong data-testid="cifra-entregado">{pesos.format(Number(x.entregado))}</strong></div>
              <div className="cifra-caso"><span className="sub">Recibió {c.recibe}</span><strong data-testid="cifra-recibido">{pesos.format(Number(x.confirmado))}</strong>
                <span className="sub">Primer conteo {pesos.format(Number(x.inicial))}</span></div>
              <div className={`cifra-caso ${dp ? "cifra-mal" : "cifra-bien"}`}><span className="sub">Diferencia entre entrega y recepción</span>
                <strong data-testid="cifra-entre-personas">{dp ? firmado(dp.importe) : pesos.format(0)}</strong>
                {dp ? <span className="sub">{etiquetaDiferencia(dp.tipo, dp.importe)} · Por revisar</span> : null}</div>
            </div>
            <div className={`cifra-caso ${de ? "cifra-mal" : ""}`} data-testid="cifra-contra-esperado">
              <span className="sub">Diferencia contra el esperado (lo entregado − el esperado)</span>
              <strong>{x.esperado === null ? "No se puede calcular" : de ? firmado(de.importe) : pesos.format(0)}</strong>
              {de ? <span className="sub">{etiquetaDiferencia(de.tipo, de.importe)} · <span className="chip-estado chip-vencida">Por revisar</span></span> : null}
            </div>
          </section>
        );
      })}
      {c.nota ? <p className="sub">Nota de quien entregó: {c.nota}</p> : null}
      {c.aclaracion ? <p className="sub">Aclaración del recuento: {c.aclaracion}</p> : null}

      <section className="tarjeta" aria-labelledby="t-desglose" data-testid="desglose">
        <h2 id="t-desglose" className="titulo-seccion">Movimientos que componen el saldo esperado de la bolsa</h2>
        <p className="sub">Turno abierto por {c.desglose.abiertoPor} el {hora.format(c.desglose.abiertoEn)}; movimientos registrados hasta la entrega.</p>
        <div className="tabla-desplazable">
          <table className="tabla tabla-ancha">
            <thead><tr><th>Movimiento</th><th>Detalle</th><th>Importe</th></tr></thead>
            <tbody>
              <tr><td>Contado al abrir</td><td>{hora.format(c.desglose.abiertoEn)} · {c.desglose.abiertoPor}</td><td>{pesos.format(Number(c.desglose.contadoAlAbrir))}</td></tr>
              <tr data-testid="desglose-cobros"><td>Cobros de visitas en efectivo</td>
                <td>{c.desglose.cobros.cuantos} {c.desglose.cobros.cuantos === 1 ? "cobro" : "cobros"} · {c.desglose.cobros.visitas} {c.desglose.cobros.visitas === 1 ? "visita" : "visitas"}</td>
                <td>+ {pesos.format(Number(c.desglose.cobros.importe))}</td></tr>
              <tr data-testid="desglose-cancelaciones"><td>Cancelaciones aprobadas</td>
                <td>{c.desglose.cancelaciones.cuantas} {c.desglose.cancelaciones.cuantas === 1 ? "cobro duplicado" : "cobros duplicados"}</td>
                <td>{Number(c.desglose.cancelaciones.importe) ? `− ${pesos.format(Math.abs(Number(c.desglose.cancelaciones.importe)))}` : pesos.format(0)}</td></tr>
              <tr><td>Retiros</td><td>Ninguno (llegan en un paso siguiente del bloque 5)</td><td>{pesos.format(0)}</td></tr>
              <tr><td><strong>Saldo esperado al entregar</strong></td><td></td><td data-testid="desglose-total"><strong>{pesos.format(Number(c.desglose.calculado))}</strong></td></tr>
            </tbody>
          </table>
        </div>
        {!coincide ? (
          <p className="aviso aviso-error" data-testid="desglose-no-coincide">
            El desglose ({pesos.format(Number(c.desglose.calculado))}) no coincide con el esperado guardado al entregar ({pesos.format(Number(c.lugares.bolsa_visitas.esperado))}). Revísalo con Dirección.
          </p>
        ) : null}
        <p className="sub" data-testid="fuera-bolsa">
          <strong>No entran a la bolsa</strong> (no cambian el esperado): tarjeta {pesos.format(Number(f.tarjeta.importe))} ({f.tarjeta.cobros});
          transferencias verificadas {pesos.format(Number(f.transferenciaVerificada.importe))}, pendientes {pesos.format(Number(f.transferenciaPendiente.importe))} y
          no localizadas {pesos.format(Number(f.transferenciaNoLocalizada.importe))}.
        </p>
      </section>
      <p className="sub">Consultar no cambia ningún importe. Los resultados de la revisión («Aclarada», «Faltante confirmado») llegan en un paso siguiente.</p>
    </main>
  );
}

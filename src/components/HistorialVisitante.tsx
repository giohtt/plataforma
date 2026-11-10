import Link from "next/link";
import type { EstadoPago, Historial } from "@/lib/historial";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const dia = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const diaUtc = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const PAGO: Record<EstadoPago, string> = {
  pagado_efectivo: "Pagado (efectivo)",
  pagado_tarjeta: "Pagado con tarjeta · liquidación pendiente de conciliar",
  pendiente_abono: "Pendiente de verificar abono",
  abono_verificado: "Pagado (transferencia verificada)",
  no_localizado: "Transferencia no localizada",
  cancelado: "Cancelado (no cuenta como visita)",
};
const FORMA = { efectivo: "en efectivo", tarjeta: "con tarjeta", transferencia: "por transferencia" } as const;
const PASE = { vigente_hoy: "Vigente hoy", vencido: "Vencido", cancelado: "Cancelado" } as const;

/** Historial del visitante con el alcance que el servidor ya recortó según los permisos de la cuenta. */
export function HistorialVisitante({ h }: { h: Historial }) {
  const r = h.resumen;
  return (
    <section className="tarjeta" id="historial" aria-labelledby="t-historial" data-testid="historial">
      <h2 id="t-historial" className="titulo-seccion">Historial de visitas</h2>
      <p data-testid="historial-total">
        {r.visitas ? <strong>{r.visitas} {r.visitas === 1 ? "visita registrada" : "visitas registradas"}</strong> : "Sin visitas registradas"}
        {r.ultima ? ` · Última el ${dia.format(new Date(r.ultima.en))} en ${r.ultima.sucursal}` : ""}{" "}
        {r.incompleto ? <span className="chip-estado chip-incompleto" data-testid="historial-incompleto">Historial incompleto</span> : null}
      </p>

      {h.conDetalle.length || h.otras.length ? (
        <div className="tabla-desplazable">
          <table className="tabla" data-testid="historial-sucursales">
            <thead><tr><th>Sucursal</th><th>Visitas registradas</th><th>Primera visita registrada</th><th>Última visita registrada</th></tr></thead>
            <tbody>
              {h.conDetalle.map((s) => (
                <tr key={s.codigo} data-testid="historial-sucursal">
                  <td data-etiqueta="Sucursal">{s.nombre}</td>
                  <td data-etiqueta="Visitas registradas">{s.visitas}</td>
                  <td data-etiqueta="Primera visita registrada">{s.primera ? dia.format(new Date(s.primera)) : "—"}</td>
                  <td data-etiqueta="Última visita registrada">{s.ultima ? dia.format(new Date(s.ultima)) : "—"}</td>
                </tr>
              ))}
              {h.otras.map((s) => (
                <tr key={s.nombre} data-testid="historial-otra">
                  <td data-etiqueta="Sucursal">{s.nombre}</td>
                  <td data-etiqueta="Visitas registradas">{s.visitas}</td>
                  <td data-etiqueta="Primera visita registrada">(solo en su sucursal)</td>
                  <td data-etiqueta="Última visita registrada">{dia.format(new Date(s.ultima))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h3 className="titulo-seccion">Cobertura</h3>
      <ul className="lista-simple" data-testid="cobertura">
        {h.cobertura.map((c) => (
          <li key={c.sucursal}>
            <strong>{c.sucursal}:</strong>{" "}
            {c.desde
              ? `datos confiables desde el ${diaUtc.format(new Date(`${c.desde}T00:00:00Z`))}${c.desdeInicio ? " (desde que empezó a operar)" : ""} · registró ${c.registradaPor}`
              : "sin fecha de cobertura registrada"}
          </li>
        ))}
        <li>Sin datos de libreta ni de Open Desk. Donde no hay visitas se lee «sin visitas registradas», no que la persona nunca vino.</li>
      </ul>

      {h.conDetalle.map((s) => (
        <div key={s.codigo} data-testid="detalle-sucursal" data-sucursal={s.codigo}>
          <h3 className="titulo-seccion">Detalle de {s.nombre}</h3>
          <h4 className="subtitulo">Visitas registradas</h4>
          {s.detalle.length ? (
            <div className="tabla-desplazable">
              <table className="tabla">
                <thead><tr><th>Fecha y hora</th><th>Estado del pago</th><th>Cobro</th><th>Estado del pase</th></tr></thead>
                <tbody>
                  {s.detalle.map((v) => (
                    <tr key={v.paseId} data-testid="visita">
                      <td data-etiqueta="Fecha y hora">{fechaHora.format(new Date(v.en))}</td>
                      <td data-etiqueta="Estado del pago" data-testid="estado-pago">{PAGO[v.estadoPago]}</td>
                      <td data-etiqueta="Cobro">
                        {pesos.format(Number(v.totalCobro))} {FORMA[v.formaPago]}
                        {v.personasCobro > 1 ? `, grupo de ${v.personasCobro} · su pase ${pesos.format(Number(v.totalPase))}` : ""}
                        {" · "}<Link href={`/sucursales/${s.codigo}/turno/cobros/${v.operacionId}`}>ver cobro</Link>
                      </td>
                      <td data-etiqueta="Estado del pase">{PASE[v.estadoPase]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="sub">Sin visitas registradas.</p>}
          <h4 className="subtitulo">Aperturas manuales</h4>
          {s.aperturas.length ? (
            <div className="tabla-desplazable">
              <table className="tabla">
                <thead><tr><th>Fecha y hora</th><th>Tipo</th><th>Registró</th><th>Autorización</th></tr></thead>
                <tbody>
                  {s.aperturas.map((a, i) => (
                    <tr key={i} data-testid="apertura">
                      <td data-etiqueta="Fecha y hora">{fechaHora.format(new Date(a.en))}</td>
                      <td data-etiqueta="Tipo">{a.tipo === "entrada" ? "Entrada" : "Reingreso (mismo pase)"}</td>
                      <td data-etiqueta="Registró">{a.registro}</td>
                      <td data-etiqueta="Autorización">{a.autorizo ? `${a.autorizo}: «${a.motivoAutorizacion}»` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="sub">Sin aperturas registradas.</p>}
          <h4 className="subtitulo">Entradas confirmadas</h4>
          <p className="sub">Sin fuente confiable todavía: llegarán con el lector (bloque 8).</p>
        </div>
      ))}

      {h.otras.length ? (
        <p className="sub" data-testid="aviso-otras">
          De otras sucursales solo se muestran el conteo y la fecha de la última visita: sin primera visita, importes, formas de pago, cobros ni accesos.
        </p>
      ) : null}
    </section>
  );
}

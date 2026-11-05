"use client";

import Link from "next/link";
import { useActionState } from "react";
import { accionAbono } from "@/app/acciones-abonos";
import type { TransferenciaPorVerificar } from "@/lib/abonos";
import { NOMBRE_REFERENCIA } from "@/lib/datos-visita";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (importe: string) => pesos.format(Number(importe));
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/**
 * Una transferencia por verificar, con sus dos acciones: «Abono verificado» (importe completo y fecha del
 * abono) o «No localizado» (con motivo). Un «No localizado» solo se puede verificar después.
 */
export function TransferenciaPorVerificarFila({ t, codigo, hoy }: { t: TransferenciaPorVerificar; codigo: string; hoy: string }) {
  const [estado, accion, enviando] = useActionState(accionAbono, null);
  const error = estado?.cobroId === t.cobroId ? estado.error : undefined;
  const id = t.cobroId.slice(0, 8);
  return (
    <li className="tarjeta-visitante transferencia" data-testid="transferencia" data-cobro={t.cobroId}>
      <div className="tarjeta-visitante-datos">
        <strong>{$(t.total)} · {t.personas} {t.personas === 1 ? "persona" : "personas"}</strong>
        <span className="sub">{t.visitantes.join(", ")}</span>
        <span className="sub">
          {NOMBRE_REFERENCIA[t.tipoReferencia]}: <strong data-testid="referencia">{t.referencia}</strong>
          {t.referenciaRepetidaConfirmada ? " · Se confirmó como otra transferencia con referencia repetida" : ""}
        </span>
        <span className="sub">Registrada el {hora.format(new Date(t.registradaEn))} por {t.registradaPor}</span>
        <span className={`chip-estado ${t.estado === "no_localizado" ? "chip-vencida" : "chip-programada"}`} data-testid="estado">
          {t.estado === "no_localizado" ? "No localizado" : "Pendiente de verificar abono"}
        </span>
        {t.motivoNoLocalizado ? <span className="sub">Motivo: {t.motivoNoLocalizado}</span> : null}
        <span className="sub"><Link href={`/sucursales/${codigo}/turno/cobros/${t.operacionId}`}>Ver detalle del cobro</Link></span>
      </div>
      {error ? <p className="aviso aviso-error" role="alert">{error}</p> : null}
      {t.propia ? (
        <p className="aviso aviso-info" data-testid="propia">La registraste tú: debe verificarla otra persona con permiso.</p>
      ) : (
        <div className="acciones-abono">
          <form action={accion} className="formulario" key={`v-${estado?.intento ?? 0}`} aria-label="Abono verificado">
            <input type="hidden" name="codigo" value={codigo} />
            <input type="hidden" name="cobroId" value={t.cobroId} />
            <input type="hidden" name="version" value={t.version} />
            <input type="hidden" name="accion" value="verificar" />
            <div className="campo">
              <label htmlFor={`importe-${id}`}>Importe que llegó</label>
              <div className="importe"><span aria-hidden="true">$</span>
                <input id={`importe-${id}`} name="importe" inputMode="decimal" autoComplete="off" required />
              </div>
            </div>
            <div className="campo">
              <label htmlFor={`fecha-${id}`}>Fecha del abono</label>
              <input id={`fecha-${id}`} name="fecha" type="date" max={hoy} required />
            </div>
            <label className="casilla">
              <input type="checkbox" name="completo" value="si" required />
              Comprobé en el estado de cuenta que llegó el importe completo de {$(t.total)}.
            </label>
            <button className="boton boton-principal" type="submit" disabled={enviando}>Abono verificado</button>
          </form>
          {t.estado === "pendiente_abono" ? (
            <form action={accion} className="formulario" key={`n-${estado?.intento ?? 0}`} aria-label="No localizado">
              <input type="hidden" name="codigo" value={codigo} />
              <input type="hidden" name="cobroId" value={t.cobroId} />
              <input type="hidden" name="version" value={t.version} />
              <input type="hidden" name="accion" value="no_localizado" />
              <div className="campo">
                <label htmlFor={`motivo-${id}`}>Motivo si no se localiza</label>
                <input id={`motivo-${id}`} name="motivo" maxLength={300} autoComplete="off" />
              </div>
              <button className="boton" type="submit" disabled={enviando}>No localizado</button>
            </form>
          ) : null}
        </div>
      )}
    </li>
  );
}

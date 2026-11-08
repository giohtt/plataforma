"use client";

import Link from "next/link";
import { useActionState } from "react";
import { accionResolverCancelacion, accionSolicitarCancelacion } from "@/app/acciones-cancelacion";
import type { CancelacionPorAutorizar, CobroResumen } from "@/lib/cancelaciones";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (importe: string) => pesos.format(Number(importe));
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/** Recepción: pedir la cancelación de este cobro por duplicado, eligiendo el cobro correcto que se conserva. */
export function FormularioCancelacion({ codigo, operacionId, total, candidatos }: {
  codigo: string; operacionId: string; total: string; candidatos: CobroResumen[];
}) {
  const [estado, accion, enviando] = useActionState(accionSolicitarCancelacion, null);
  return (
    <section className="tarjeta" aria-labelledby="t-cancelar" data-testid="solicitar-cancelacion">
      <h2 id="t-cancelar" className="titulo-seccion">Solicitar cancelación por duplicado</h2>
      <p className="sub">
        Solo si este cobro de {$(total)} se registró dos veces. Nada cambia hasta que otra persona con permiso lo autorice.
      </p>
      {candidatos.length === 0 ? (
        <p className="aviso aviso-info" data-testid="sin-candidatos">
          No hay otro cobro vigente en efectivo de este turno con el mismo total y las mismas personas, así que no parece un duplicado.
        </p>
      ) : (
        <form action={accion} className="formulario" noValidate>
          <input type="hidden" name="codigo" value={codigo} />
          <input type="hidden" name="operacionId" value={operacionId} />
          {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
          <fieldset className="campo campo-grupo">
            <legend>¿Cuál es el cobro correcto que se conserva?</legend>
            {candidatos.map((c) => (
              <label key={c.operacionId} className="casilla" data-testid="candidato">
                <input type="radio" name="conserva" value={c.operacionId} required defaultChecked={candidatos.length === 1} />
                <span>
                  {hora.format(new Date(c.registradaEn))} · {$(c.total)} en efectivo · {c.visitantes.join(", ")} · registró {c.registradaPor}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="campo">
            <label htmlFor="explicacion">Qué pasó</label>
            <input id="explicacion" name="explicacion" maxLength={300} autoComplete="off" required />
          </div>
          <label className="casilla">
            <input type="checkbox" name="sinDinero" value="si" required />
            El dinero de este cobro no entró: solo se registró dos veces. El dinero físico es el del cobro que se conserva.
          </label>
          <p className="fila-acciones">
            <button className="boton boton-principal" type="submit" disabled={enviando}>Solicitar cancelación</button>
          </p>
        </form>
      )}
    </section>
  );
}

const IMPEDIMENTO: Record<NonNullable<CancelacionPorAutorizar["impedimento"]>, string> = {
  propia: "La pediste tú: debe resolverla otra persona.",
  registro_propio: "Registraste este cobro: debe resolverla otra persona.",
  excede_limite: "El importe es mayor que tu límite para autorizar cancelaciones.",
};

function Cobro({ c, codigo, titulo }: { c: CobroResumen; codigo: string; titulo: string }) {
  return (
    <div className="tarjeta-visitante-datos">
      <strong>{titulo}</strong>
      <span>{hora.format(new Date(c.registradaEn))} · {$(c.total)} en efectivo · registró {c.registradaPor}</span>
      <span className="sub">{c.visitantes.join(", ")}</span>
      <span className="sub"><Link href={`/sucursales/${codigo}/turno/cobros/${c.operacionId}`}>Ver cobro</Link></span>
    </div>
  );
}

/** Una solicitud pendiente, con «Aprobar cancelación» y «Rechazar» (con motivo). */
export function SolicitudPendiente({ s, codigo }: { s: CancelacionPorAutorizar; codigo: string }) {
  const [estado, accion, enviando] = useActionState(accionResolverCancelacion, null);
  const error = estado?.id === s.id ? estado.error : undefined;
  return (
    <li className="tarjeta-visitante transferencia" data-testid="solicitud">
      <p><strong>Duplicado</strong> · pidió {s.solicitadaPor} el {hora.format(new Date(s.solicitadaEn))}</p>
      <p className="sub">«{s.explicacion}»</p>
      <div className="acciones-abono">
        <Cobro c={s.duplicado} codigo={codigo} titulo="Se cancelaría" />
        <Cobro c={s.conserva} codigo={codigo} titulo="Se conserva" />
      </div>
      <p className="sub">
        Al aprobar: el cobro duplicado y su pase quedan cancelados y se registra un ajuste de {$(`-${s.duplicado.total}`)} en la bolsa.
        El dinero físico sigue en la bolsa.
      </p>
      {error ? <p className="aviso aviso-error" role="alert">{error}</p> : null}
      {s.impedimento ? (
        <p className="aviso aviso-info" data-testid="impedimento">{IMPEDIMENTO[s.impedimento]}</p>
      ) : (
        <div className="acciones-abono">
          <form action={accion} className="formulario" aria-label="Aprobar cancelación">
            <input type="hidden" name="codigo" value={codigo} />
            <input type="hidden" name="id" value={s.id} />
            <input type="hidden" name="version" value={s.version} />
            <input type="hidden" name="decision" value="aprobar" />
            <button className="boton boton-principal" type="submit" disabled={enviando}>Aprobar cancelación</button>
          </form>
          <form action={accion} className="formulario" aria-label="Rechazar" key={estado?.intento ?? 0}>
            <input type="hidden" name="codigo" value={codigo} />
            <input type="hidden" name="id" value={s.id} />
            <input type="hidden" name="version" value={s.version} />
            <input type="hidden" name="decision" value="rechazar" />
            <div className="campo">
              <label htmlFor={`motivo-${s.id.slice(0, 8)}`}>Motivo si se rechaza</label>
              <input id={`motivo-${s.id.slice(0, 8)}`} name="motivo" maxLength={300} autoComplete="off" />
            </div>
            <button className="boton" type="submit" disabled={enviando}>Rechazar</button>
          </form>
        </div>
      )}
    </li>
  );
}

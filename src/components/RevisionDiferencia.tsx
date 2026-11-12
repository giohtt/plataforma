"use client";

import { useActionState, useState } from "react";
import { accionRegistrarCorreccion, accionResolverDiferencia, accionRevisarDiferencia } from "@/app/acciones-diferencias";
import { opcionesRevision } from "@/lib/datos-diferencia";

/** Resultado de UNA diferencia: dos opciones según su signo y motivo obligatorio. No cambia ningún importe. */
export function FormularioRevision({ codigo, diferenciaId, importe }: { codigo: string; diferenciaId: string; importe: string }) {
  const [estado, accion, enviando] = useActionState(accionRevisarDiferencia, null);
  const id = (c: string) => `${c}-${diferenciaId}`;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-revision">
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="diferencia" value={diferenciaId} />
      <fieldset className="campo campo-grupo">
        <legend>Resultado</legend>
        {opcionesRevision(importe).map((o) => (
          <label key={o.valor} className="opcion-revision">
            <input type="radio" name="resultado" value={o.valor} defaultChecked={estado?.valores?.resultado === o.valor} />
            <span><strong>{o.titulo}</strong><br /><span className="sub">{o.ayuda}</span></span>
          </label>
        ))}
        {estado?.errores?.resultado ? <span className="campo-error">{estado.errores.resultado}</span> : null}
      </fieldset>
      <div className="campo">
        <label htmlFor={id("motivo")}>Motivo (obligatorio)</label>
        <textarea id={id("motivo")} name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""}
          aria-invalid={estado?.errores?.motivo ? true : undefined} />
        <span className="sub">De 5 a 300 caracteres. Queda en el historial con tu cuenta, la fecha y la hora.</span>
        {estado?.errores?.motivo ? <span className="campo-error">{estado.errores.motivo}</span> : null}
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar revisión"}</button>
    </form>
  );
}

/**
 * Resolución de Dirección. Faltante: «Lo absorbe la sucursal». Sobrante: «Se queda en la bolsa» u «Origen identificado»
 * (con o sin corrección pendiente). Motivo obligatorio. No cambia ningún importe.
 */
export function FormularioResolucion({ codigo, diferenciaId, importe }: { codigo: string; diferenciaId: string; importe: string }) {
  const [estado, accion, enviando] = useActionState(accionResolverDiferencia, null);
  const faltante = Number(importe) < 0;
  const [decision, setDecision] = useState(estado?.valores?.resultado ?? (faltante ? "absorbe_sucursal" : ""));
  const id = (c: string) => `${c}-dir-${diferenciaId}`;
  const opciones = faltante
    ? [{ valor: "absorbe_sucursal", titulo: "Lo absorbe la sucursal", ayuda: "Se registra como pérdida de efectivo de la sucursal. Cierra el seguimiento." }]
    : [
        { valor: "queda_en_bolsa", titulo: "Se queda en la bolsa", ayuda: "El excedente permanece en el efectivo de la sucursal. Cierra el seguimiento." },
        { valor: "origen_identificado", titulo: "Origen identificado", ayuda: "Se documenta de dónde salió. Si queda una corrección pendiente, el caso sigue abierto hasta registrarla." },
      ];
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-resolucion">
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="diferencia" value={diferenciaId} />
      <fieldset className="campo campo-grupo">
        <legend>Decisión de Dirección</legend>
        {opciones.map((o) => (
          <label key={o.valor} className="opcion-revision">
            <input type="radio" name="decision" value={o.valor} checked={decision === o.valor} onChange={() => setDecision(o.valor)} />
            <span><strong>{o.titulo}</strong><br /><span className="sub">{o.ayuda}</span></span>
          </label>
        ))}
        {estado?.errores?.resultado ? <span className="campo-error">{estado.errores.resultado}</span> : null}
      </fieldset>
      {decision === "origen_identificado" ? (
        <>
          <div className="campo">
            <label htmlFor={id("origen")}>Origen identificado</label>
            <textarea id={id("origen")} name="origen" rows={2} maxLength={300} defaultValue={estado?.valores?.origen ?? ""} />
            {estado?.errores?.origen ? <span className="campo-error">{estado.errores.origen}</span> : null}
          </div>
          <fieldset className="campo campo-grupo">
            <legend>¿Queda una corrección pendiente?</legend>
            <label className="opcion-revision">
              <input type="radio" name="requiere" value="si" defaultChecked={estado?.valores?.requiere === "si"} />
              <span>Sí: el caso sigue abierto hasta registrar la corrección</span>
            </label>
            <label className="opcion-revision">
              <input type="radio" name="requiere" value="no" defaultChecked={estado?.valores?.requiere !== "si"} />
              <span>No: el origen ya está documentado y no requiere corrección (cierra)</span>
            </label>
          </fieldset>
        </>
      ) : null}
      <div className="campo">
        <label htmlFor={id("motivo")}>Motivo (obligatorio)</label>
        <textarea id={id("motivo")} name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} />
        <span className="sub">Queda en el historial con tu cuenta, la fecha y la hora.</span>
        {estado?.errores?.motivo ? <span className="campo-error">{estado.errores.motivo}</span> : null}
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar decisión"}</button>
    </form>
  );
}

/** Registra la corrección pendiente de un sobrante con origen identificado; cierra el caso. */
export function FormularioCorreccion({ codigo, diferenciaId }: { codigo: string; diferenciaId: string }) {
  const [estado, accion, enviando] = useActionState(accionRegistrarCorreccion, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-correccion">
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="diferencia" value={diferenciaId} />
      <div className="campo">
        <label htmlFor={`correccion-${diferenciaId}`}>Corrección registrada</label>
        <textarea id={`correccion-${diferenciaId}`} name="correccion" rows={2} maxLength={300} defaultValue={estado?.valores?.correccion ?? ""} />
        <span className="sub">Qué se corrigió y dónde (por ejemplo, el cobro regularizado). Queda vinculada al historial y cierra el caso.</span>
        {estado?.errores?.correccion ? <span className="campo-error">{estado.errores.correccion}</span> : null}
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar corrección"}</button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { accionRevisarDiferencia } from "@/app/acciones-diferencias";
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

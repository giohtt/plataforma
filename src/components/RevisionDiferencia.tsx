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

/**
 * Cierre de un sobrante con corrección pendiente: descripción y referencia verificable al registro de la corrección.
 * Una nota sola no cierra. Mientras no exista el registro de ese tipo de corrección, el caso sigue pendiente.
 */
export function FormularioCorreccion({ codigo, diferenciaId, tipos }: { codigo: string; diferenciaId: string; tipos: readonly string[] }) {
  const [estado, accion, enviando] = useActionState(accionRegistrarCorreccion, null);
  const id = (c: string) => `${c}-${diferenciaId}`;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-correccion">
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      {!tipos.length ? (
        <p className="aviso aviso-info" data-testid="sin-flujo-correccion">
          Para cerrar se necesita la referencia del registro de la corrección (por ejemplo, su folio). Todavía no existe en la
          plataforma un registro para este tipo de corrección, así que el caso sigue pendiente.
        </p>
      ) : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="diferencia" value={diferenciaId} />
      <div className="campo">
        <label htmlFor={id("correccion")}>Descripción de la corrección realizada</label>
        <textarea id={id("correccion")} name="correccion" rows={2} maxLength={300} defaultValue={estado?.valores?.correccion ?? ""} />
        {estado?.errores?.correccion ? <span className="campo-error">{estado.errores.correccion}</span> : null}
      </div>
      <div className="campo">
        <label htmlFor={id("referencia_tipo")}>Registro de la corrección</label>
        <select id={id("referencia_tipo")} name="referencia_tipo" defaultValue={estado?.valores?.referenciaTipo ?? ""}>
          <option value="">{tipos.length ? "Elige el tipo de registro" : "Sin tipos de registro disponibles todavía"}</option>
          {tipos.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="campo">
        <label htmlFor={id("referencia_id")}>Folio o referencia del registro</label>
        <input id={id("referencia_id")} name="referencia_id" maxLength={80} defaultValue={estado?.valores?.referenciaId ?? ""} />
        <span className="sub">La plataforma comprueba que el registro exista. La descripción y la referencia quedan en el historial.</span>
        {estado?.errores?.referencia ? <span className="campo-error">{estado.errores.referencia}</span> : null}
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar corrección y cerrar"}</button>
    </form>
  );
}

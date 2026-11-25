"use client";

import { useActionState } from "react";
import { accionResolverFaltante } from "@/app/acciones-resoluciones";

/**
 * Resolución de Dirección de un faltante confirmado (retiro o sobre): «Lo absorbe la sucursal», con motivo. Cierra el
 * caso sin cambiar el efectivo contado ni los depósitos y sin descontar nada a ninguna persona.
 */
export function FormularioResolverFaltante({ codigo, clase, id, importe }: { codigo: string; clase: "retiro" | "sobre"; id: string; importe: string }) {
  const [estado, accion, enviando] = useActionState(accionResolverFaltante, null);
  const campo = `motivo-resolver-${id}`;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="resolver-faltante">
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clase" value={clase} />
      <input type="hidden" name="id" value={id} />
      <fieldset className="campo campo-grupo">
        <legend>Decisión de Dirección</legend>
        <label className="opcion-revision">
          <input type="radio" name="decision" value="absorbe_sucursal" defaultChecked readOnly />
          <span><strong>Lo absorbe la sucursal</strong><br /><span className="sub">Cierra el faltante de {importe}. No cambia el efectivo contado ni los depósitos, y no se descuenta a ninguna persona.</span></span>
        </label>
      </fieldset>
      <div className="campo">
        <label htmlFor={campo}>Motivo (obligatorio)</label>
        <textarea id={campo} name="motivo" rows={2} maxLength={300} defaultValue={estado?.motivo ?? ""}
          aria-invalid={estado?.errorMotivo ? true : undefined} aria-describedby={estado?.errorMotivo ? `${campo}-error` : undefined} />
        <span className="sub">Queda en el historial con tu cuenta, la fecha y la hora. No se edita ni se borra.</span>
        {estado?.errorMotivo ? <span className="campo-error" id={`${campo}-error`}>{estado.errorMotivo}</span> : null}
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar resolución"}</button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { accionRegistrarCobertura } from "@/app/acciones-historial";

export function FormularioCobertura({ codigo }: { codigo: string }) {
  const [estado, accion, enviando] = useActionState(accionRegistrarCobertura, null);
  return (
    <form action={accion} className="formulario" data-testid="form-cobertura">
      <input type="hidden" name="codigo" value={codigo} />
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <div className="campo">
        <label htmlFor="desde">Hay datos confiables de visitas desde</label>
        <input id="desde" name="desde" type="date" required />
      </div>
      <label className="casilla">
        <input type="checkbox" name="desdeInicio" value="si" /> Esa fecha es desde que la sucursal empezó a operar (no faltan visitas anteriores)
      </label>
      <div className="campo">
        <label htmlFor="nota">Nota (opcional)</label>
        <textarea id="nota" name="nota" maxLength={300} />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>Registrar cobertura</button>
    </form>
  );
}

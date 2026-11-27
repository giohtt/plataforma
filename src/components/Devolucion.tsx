"use client";

import { useActionState } from "react";
import { accionRegistrarDevolucion } from "@/app/acciones-diferencias";

/**
 * Recepción entrega a la persona visitante el cambio que faltó y registra que lo recibió. El importe es el autorizado
 * por Dirección; sale de la bolsa del turno abierto una sola vez y no cambia el ingreso de la visita.
 */
export function FormularioDevolucion({ codigo, devolucionId, importe, visitante }: { codigo: string; devolucionId: string; importe: string; visitante: string }) {
  const [estado, accion, enviando] = useActionState(accionRegistrarDevolucion, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-devolucion">
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="devolucion" value={devolucionId} />
      <p><strong>Importe a devolver: {importe}</strong> <span className="sub">(lo autorizado; no se cambia)</span></p>
      <label className="opcion-revision">
        <input type="checkbox" name="recibio" value="si" defaultChecked={estado?.valores?.recibio === "si"} />
        <span>Lo recibió <strong>{visitante}</strong> (comprobado con esta ficha)</span>
      </label>
      <div className="campo">
        <label htmlFor={`nota-${devolucionId}`}>Nota (opcional)</label>
        <input id={`nota-${devolucionId}`} name="nota" maxLength={300} defaultValue={estado?.valores?.nota ?? ""} />
      </div>
      <p className="sub">Sale de la bolsa de visitas de tu turno una sola vez. Queda en el historial del caso con tu cuenta, la fecha y la hora.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar devolución"}</button>
    </form>
  );
}

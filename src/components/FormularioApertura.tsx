"use client";

import { useActionState } from "react";
import { accionAbrirTurno, type EstadoApertura } from "@/app/acciones-turno";

function Lugar({ estado, campo, titulo, responsable, nota }: {
  estado: EstadoApertura; campo: "bolsa" | "cajon"; titulo: string; responsable: string; nota?: string;
}) {
  const error = estado?.errores?.[campo];
  return (
    <fieldset className="campo campo-grupo lugar-apertura" data-testid={`apertura-${campo}`}>
      <legend>{titulo}</legend>
      <label htmlFor={campo}>Total contado</label>
      <div className="importe">
        <span aria-hidden="true">$</span>
        <input id={campo} name={campo} inputMode="decimal" autoComplete="off" defaultValue={estado?.valores?.[campo] ?? ""}
          aria-invalid={error ? true : undefined} aria-describedby={`${campo}-ayuda${error ? ` ${campo}-error` : ""}`} />
      </div>
      <span className="sub" id={`${campo}-ayuda`}>Solo el total, en pesos. Si no hay dinero, escribe 0. No hay fondo fijo.</span>
      {error ? <span className="campo-error" id={`${campo}-error`}>{error}</span> : null}
      <span className="sub">Responsable desde la apertura: <strong>{responsable}</strong></span>
      {nota ? <span className="chip-estado chip-vencida">{nota}</span> : null}
    </fieldset>
  );
}

/** Dos totales por separado. Vacío no es lo mismo que 0: si no hay dinero, se escribe 0. Sin fondo fijo ni desglose. */
export function FormularioApertura({ codigo, responsable }: { codigo: string; responsable: string }) {
  const [estado, accion, enviando] = useActionState(accionAbrirTurno, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate>
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <Lugar estado={estado} campo="bolsa" titulo="Bolsa de visitas" responsable={responsable} />
      <Lugar estado={estado} campo="cajon" titulo="Cajón de mensualidades" responsable={responsable} nota="No conciliado: faltan datos de Open Desk" />
      <p className="sub">
        Abrir el turno solo registra lo que contaste en cada lugar y que tú los recibes. No registra cobros ni movimientos.
      </p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Abriendo…" : "Abrir turno"}</button>
    </form>
  );
}

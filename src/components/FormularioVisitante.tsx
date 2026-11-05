"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { accionCrearVisitante, type EstadoAltaVisitante } from "@/app/acciones-visitantes";
import { TarjetaVisitante } from "@/components/Visitantes";
import type { ResultadoVisitante } from "@/lib/visitantes";

type Props = {
  codigo: string;
  inicial: { nombre: string; telefono: string };
  estados: readonly string[];
  telefonoObligatorio: boolean;
  estadoObligatorio: boolean;
  onVolver?: () => void;
  /**
   * Para crear la ficha sin salir del cobro: recibe la ficha creada en lugar de ir a su página.
   * `accionCoincidencia` reemplaza «Es esta persona» en las coincidencias (por ejemplo, «Agregar al grupo»).
   */
  alCrear?: (v: ResultadoVisitante) => void;
  accionCoincidencia?: (v: ResultadoVisitante) => ReactNode;
};

function MensajeCampo({ estado, campo }: { estado: EstadoAltaVisitante; campo: "nombre" | "telefono" | "estadoProcedencia" }) {
  const t = estado?.errores?.[campo];
  return t ? <span className="campo-error" id={`${campo}-error`}>{t}</span> : null;
}

export function FormularioVisitante({ codigo, inicial, estados, telefonoObligatorio, estadoObligatorio, onVolver, alCrear, accionCoincidencia }: Props) {
  const [estado, accion, enviando] = useActionState(accionCrearVisitante, null);
  const avisado = useRef<number | null>(null);
  useEffect(() => {
    if (estado?.creado && alCrear && avisado.current !== estado.intento) {
      avisado.current = estado.intento;
      alCrear(estado.creado);
    }
  }, [estado, alCrear]);
  const v = estado?.valores;
  const coincidencias = estado?.coincidencias ?? [];
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate>
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      {alCrear ? <input type="hidden" name="destino" value="cobro" /> : null}

      {coincidencias.length ? (
        <section className="coincidencias" aria-labelledby="t-coincidencias" data-testid="coincidencias">
          <h2 id="t-coincidencias" className="titulo-seccion">Posibles coincidencias</h2>
          <p className="sub">Si es alguna de estas personas, elígela: no se crea un expediente nuevo.</p>
          <ul className="lista-visitantes">
            {coincidencias.map((c) => (
              <TarjetaVisitante key={c.id} v={c} codigo={codigo} mostrarMotivos accion={accionCoincidencia?.(c)} />
            ))}
          </ul>
          {coincidencias.map((c) => <input key={c.id} type="hidden" name="distinto" value={c.id} />)}
          <label className="casilla">
            <input type="checkbox" name="confirmo" value="si" />
            Confirmo que la persona no es ninguna de las anteriores. Esta confirmación queda registrada.
          </label>
        </section>
      ) : null}

      <div className="campo">
        <label htmlFor="nombre">Nombre completo</label>
        <input id="nombre" name="nombre" defaultValue={v?.nombre ?? inicial.nombre} maxLength={120} required autoComplete="off"
          aria-invalid={estado?.errores?.nombre ? true : undefined} />
        <MensajeCampo estado={estado} campo="nombre" />
      </div>
      <div className="campo">
        <label htmlFor="telefono">{telefonoObligatorio ? "Teléfono" : "Teléfono (opcional)"}</label>
        <input id="telefono" name="telefono" inputMode="tel" defaultValue={v?.telefono ?? inicial.telefono} maxLength={20} autoComplete="off"
          aria-invalid={estado?.errores?.telefono ? true : undefined} />
        <span className="sub">10 dígitos. Puede ser el mismo de otra persona (por ejemplo, de su familia).</span>
        <MensajeCampo estado={estado} campo="telefono" />
      </div>
      <div className="campo">
        <label htmlFor="estadoProcedencia">{estadoObligatorio ? "Estado de procedencia" : "Estado de procedencia (opcional)"}</label>
        <select id="estadoProcedencia" name="estadoProcedencia" defaultValue={v?.estadoProcedencia ?? ""}>
          <option value="">Sin indicar</option>
          {estados.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <MensajeCampo estado={estado} campo="estadoProcedencia" />
      </div>
      <p className="fila-acciones">
        <button className="boton boton-principal" type="submit" disabled={enviando}>
          {enviando ? "Guardando…" : coincidencias.length ? "Crear expediente nuevo" : "Crear expediente"}
        </button>
        {onVolver ? <button className="boton" type="button" onClick={onVolver}>Volver a la búsqueda</button> : null}
      </p>
    </form>
  );
}

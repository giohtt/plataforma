"use client";

import { useActionState, useState } from "react";
import { accionBuscarVisitantes } from "@/app/acciones-visitantes";
import { FormularioVisitante } from "@/components/FormularioVisitante";
import { TarjetaVisitante } from "@/components/Visitantes";
import { normalizarTelefono } from "@/lib/datos-visitante";

type Props = {
  codigo: string;
  puedeCrear: boolean;
  estados: readonly string[];
  telefonoObligatorio: boolean;
  estadoObligatorio: boolean;
};

/**
 * Buscar → elegir entre coincidencias → o crear. Todo en la misma dirección: la búsqueda se envía por POST
 * y el paso al alta ocurre en esta pantalla, así que el nombre y el teléfono nunca aparecen en la URL.
 */
export function FlujoVisitantes({ codigo, puedeCrear, estados, telefonoObligatorio, estadoObligatorio }: Props) {
  const [busqueda, buscar, buscando] = useActionState(accionBuscarVisitantes, null);
  const [alta, setAlta] = useState<{ nombre: string; telefono: string } | null>(null);

  if (alta) {
    return (
      <section className="tarjeta" aria-labelledby="t-alta" data-testid="alta-visitante">
        <h2 id="t-alta" className="titulo-seccion">Nuevo expediente</h2>
        <p className="aviso aviso-info">
          Solo datos ficticios. Antes de guardar, el sistema revisa si ya existe alguien con el mismo teléfono o un nombre
          parecido. Las reglas de campos obligatorios y de qué se muestra están pendientes de aprobar.
        </p>
        <FormularioVisitante
          codigo={codigo}
          inicial={alta}
          estados={estados}
          telefonoObligatorio={telefonoObligatorio}
          estadoObligatorio={estadoObligatorio}
          onVolver={() => setAlta(null)}
        />
      </section>
    );
  }

  const resultados = busqueda?.resultados;
  const empezarAlta = () => {
    // Lo buscado pasa al campo que corresponde, dentro de la pantalla (no por la dirección).
    const texto = busqueda?.texto ?? "";
    const esTelefono = /^[\d\s()+-]+$/.test(texto);
    setAlta(esTelefono ? { nombre: "", telefono: normalizarTelefono(texto) ?? texto } : { nombre: texto, telefono: "" });
  };

  return (
    <>
      <form className="tarjeta buscador" action={buscar} role="search" key={busqueda?.intento ?? 0}>
        <input type="hidden" name="codigo" value={codigo} />
        <div className="campo">
          <label htmlFor="q">Nombre completo o teléfono</label>
          <input id="q" name="q" type="search" defaultValue={busqueda?.texto ?? ""} autoComplete="off" maxLength={120}
            placeholder="Ej. María Hernández o 722 123 4567" />
          <span className="sub">Por teléfono, escribe los 10 dígitos.</span>
        </div>
        <button className="boton boton-principal" type="submit" disabled={buscando}>{buscando ? "Buscando…" : "Buscar"}</button>
      </form>

      {busqueda?.error ? <p className="aviso aviso-error" role="alert">{busqueda.error}</p> : null}

      {resultados ? (
        <section className="tarjeta" aria-labelledby="t-resultados" data-testid="resultados">
          <h2 id="t-resultados" className="titulo-seccion">
            {resultados.length === 0
              ? "Sin coincidencias"
              : resultados.length === 1
                ? "1 coincidencia"
                : `${resultados.length}${busqueda?.limitado ? "+" : ""} coincidencias`}
          </h2>
          {resultados.length > 1 ? (
            <p className="aviso aviso-info">Hay varias personas posibles. Confirma con el visitante cuál es antes de elegir.</p>
          ) : null}
          {busqueda?.limitado ? <p className="sub">Se muestran las primeras 20. Escribe el nombre más completo o el teléfono.</p> : null}
          <ul className="lista-visitantes">
            {resultados.map((v) => <TarjetaVisitante key={v.id} v={v} codigo={codigo} />)}
          </ul>
          {puedeCrear ? (
            <p className="fila-acciones">
              <button className="boton" type="button" onClick={empezarAlta} data-testid="crear-visitante">
                {resultados.length ? "No es ninguna: crear expediente nuevo" : "Crear expediente nuevo"}
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

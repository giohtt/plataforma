"use client";

import { useState } from "react";

/**
 * Botón «Descargar» de «Caja y depósitos»: al tocarlo muestra las opciones (formato y contenido) y una forma visible de
 * cerrarlas. El servidor vuelve a comprobar los permisos al descargar; esto solo es la presentación.
 */
export function PanelDescarga({ sucursal, desde, hasta, corte, corteTexto, incluidas, excluidas }: {
  sucursal: string; desde: string; hasta: string; corte: string; corteTexto: string; incluidas: string[]; excluidas: string[];
}) {
  const [abierto, setAbierto] = useState(false);
  return (
    <div className="descarga-caja">
      <button type="button" className="boton boton-principal" aria-expanded={abierto} aria-controls="panel-descarga" onClick={() => setAbierto(!abierto)}
              data-testid="abrir-descarga">
        Descargar
      </button>
      {abierto ? (
        <form id="panel-descarga" className="panel-descarga" method="post" action="/reportes/caja/descargar" data-testid="descargar">
          <div className="panel-descarga-cabeza">
            <b>Descargar</b>
            <button type="button" className="boton boton-chico" onClick={() => setAbierto(false)} data-testid="cerrar-descarga">Cerrar ✕</button>
          </div>
          {excluidas.length ? (
            <p className="aviso aviso-info" data-testid="descarga-incluidas">
              Se incluyen: <b>{incluidas.join(", ")}</b>. No se incluyen (sin permiso de descarga): <b>{excluidas.join(", ")}</b>. El archivo se calcula solo con las incluidas.
            </p>
          ) : null}
          <input type="hidden" name="sucursal" value={sucursal} />
          <input type="hidden" name="desde" value={desde} />
          <input type="hidden" name="hasta" value={hasta} />
          <input type="hidden" name="corte" value={corte} />
          <fieldset className="campo-grupo">
            <legend className="campo-etiqueta">Formato</legend>
            <label className="casilla"><input type="radio" name="formato" value="xlsx" defaultChecked /> Excel (.xlsx)</label>
            <label className="casilla"><input type="radio" name="formato" value="pdf" /> PDF</label>
          </fieldset>
          <fieldset className="campo-grupo">
            <legend className="campo-etiqueta">Contenido</legend>
            <label className="casilla"><input type="radio" name="contenido" value="resumen" defaultChecked /> Resumen</label>
            <label className="casilla"><input type="radio" name="contenido" value="detalle" /> Con detalle (origen y destino e historial)</label>
          </fieldset>
          <p className="sub">Mismo corte ({corteTexto}); respeta los importes ocultos. Queda en el historial de descargas.</p>
          <button className="boton boton-principal" type="submit" data-testid="boton-descargar">Descargar</button>
        </form>
      ) : null}
    </div>
  );
}

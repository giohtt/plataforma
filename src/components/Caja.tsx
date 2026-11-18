"use client";

import { useState } from "react";
import type { EstadoFormularioEntrega } from "@/app/acciones-entrega";

type Sobre = { id: string; lugar: "bolsa_visitas" | "cajon_mensualidades"; folio: string };
const NOMBRE = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" } as const;

/** Cajón (y, con sobres guardados, la caja) cerrado y llave recibida, o una incidencia con motivo. */
export function Llave({ estado, caja = false }: { estado: EstadoFormularioEntrega; caja?: boolean }) {
  const [llave, setLlave] = useState(estado?.valores?.llave ?? "");
  return (
    <fieldset className="campo campo-grupo" data-testid="llave" aria-invalid={estado?.errores?.motivo_llave ? true : undefined}>
      <legend>{caja ? "Caja de sobres, cajón de los fondos y su llave" : "Cajón con los fondos y su llave"}</legend>
      <label className="opcion-revision">
        <input type="radio" name="llave" value="correcta" checked={llave === "correcta"} onChange={() => setLlave("correcta")} />
        <span>
          {caja
            ? "Sí: la caja de sobres y el cajón de los fondos están cerrados, y tengo la llave"
            : "Sí: el cajón quedó cerrado con los fondos separados e identificados, y tengo la llave"}
        </span>
      </label>
      <label className="opcion-revision">
        <input type="radio" name="llave" value="incidencia" checked={llave === "incidencia"} onChange={() => setLlave("incidencia")} />
        <span>{caja ? "Hay un problema con la caja, el cajón o la llave" : "Hay un problema con el cajón o la llave"}</span>
      </label>
      {llave === "incidencia" ? (
        <div className="campo">
          <label htmlFor="motivo_llave">Motivo de la incidencia</label>
          <textarea id="motivo_llave" name="motivo_llave" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo_llave ?? ""} />
        </div>
      ) : null}
      {estado?.errores?.motivo_llave ? <span className="campo-error">{estado.errores.motivo_llave}</span> : null}
    </fieldset>
  );
}

/** Sello y folio de cada sobre: «Cerrado y con este folio» o una incidencia (falta, abierto, otro folio) con motivo. */
export function VerificarSobres({ estado, sobres, pregunta, porFolio = false }: {
  estado: EstadoFormularioEntrega; sobres: Sobre[]; pregunta: string;
  /** Sobres de la caja: se identifican por folio (puede haber varios del mismo lugar). */
  porFolio?: boolean;
}) {
  const [elegidos, setElegidos] = useState<Record<string, string>>(
    Object.fromEntries(sobres.map((s) => [s.id, estado?.valores?.[`estado-${s.id}`] ?? ""])),
  );
  return (
    <>
      {estado?.errores?.sobres ? <p className="campo-error">{estado.errores.sobres}</p> : null}
      {sobres.map((s) => {
        const elegido = elegidos[s.id];
        const error = estado?.errores?.[`sobre-${s.id}`];
        return (
          <fieldset key={s.id} className="campo campo-grupo" data-testid={porFolio ? `verificar-${s.folio}` : `verificar-${s.lugar}`} aria-invalid={error ? true : undefined}>
            <input type="hidden" name="sobre" value={s.id} />
            <legend>{NOMBRE[s.lugar]} · sobre <span className="mono">{s.folio}</span></legend>
            <span className="sub">{pregunta}</span>
            {([
              ["correcto", "Sí: cerrado, sello intacto y con este folio"],
              ["abierto", "Llegó abierto o con el sello roto"],
              ["otro_folio", "Trae otro folio"],
              ["falta", "No está el sobre"],
            ] as const).map(([v, t]) => (
              <label key={v} className="opcion-revision">
                <input type="radio" name={`estado-${s.id}`} value={v} checked={elegido === v} onChange={() => setElegidos({ ...elegidos, [s.id]: v })} />
                <span>{t}</span>
              </label>
            ))}
            {elegido === "otro_folio" ? (
              <div className="campo">
                <label htmlFor={`folio-${s.id}`}>Folio que trae el sobre</label>
                <input id={`folio-${s.id}`} name={`folio-${s.id}`} autoComplete="off" className="mono" defaultValue={estado?.valores?.[`folio-${s.id}`] ?? ""} />
              </div>
            ) : null}
            {elegido && elegido !== "correcto" ? (
              <div className="campo">
                <label htmlFor={`motivo-${s.id}`}>Motivo de la incidencia</label>
                <textarea id={`motivo-${s.id}`} name={`motivo-${s.id}`} rows={2} maxLength={300} defaultValue={estado?.valores?.[`motivo-${s.id}`] ?? ""} />
              </div>
            ) : null}
            {error ? <span className="campo-error">{error}</span> : null}
          </fieldset>
        );
      })}
    </>
  );
}


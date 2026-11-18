"use client";

import { useState } from "react";
import type { EstadoFormularioEntrega } from "@/app/acciones-entrega";

type Sobre = { id: string; lugar: "bolsa_visitas" | "cajon_mensualidades"; folio: string };
const NOMBRE = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" } as const;

/**
 * Llave recibida o una incidencia con motivo. Por separado: la del cajón de los fondos (campos llave y motivo_llave) y la
 * de la caja de sobres (llave_caja y motivo_llave_caja), porque aún no se confirma que sean una sola.
 */
export function Llave({ estado, de = "cajon" }: { estado: EstadoFormularioEntrega; de?: "cajon" | "caja" }) {
  const campo = de === "caja" ? "llave_caja" : "llave";
  const motivo = `motivo_${campo}`;
  const [llave, setLlave] = useState(estado?.valores?.[campo] ?? "");
  const textos = de === "caja"
    ? { legend: "Llave de la caja de sobres", ok: "Sí: la caja de sobres está cerrada y tengo su llave", mal: "Hay un problema con la caja de sobres o su llave" }
    : { legend: "Llave del cajón de los fondos", ok: "Sí: el cajón quedó cerrado con los fondos separados e identificados, y tengo su llave",
        mal: "Hay un problema con el cajón o su llave" };
  return (
    <fieldset className="campo campo-grupo" data-testid={de === "caja" ? "llave-caja-sobres" : "llave"} aria-invalid={estado?.errores?.[motivo] ? true : undefined}>
      <legend>{textos.legend}</legend>
      <label className="opcion-revision">
        <input type="radio" name={campo} value="correcta" checked={llave === "correcta"} onChange={() => setLlave("correcta")} />
        <span>{textos.ok}</span>
      </label>
      <label className="opcion-revision">
        <input type="radio" name={campo} value="incidencia" checked={llave === "incidencia"} onChange={() => setLlave("incidencia")} />
        <span>{textos.mal}</span>
      </label>
      {llave === "incidencia" ? (
        <div className="campo">
          <label htmlFor={motivo}>Motivo de la incidencia</label>
          <textarea id={motivo} name={motivo} rows={2} maxLength={300} defaultValue={estado?.valores?.[motivo] ?? ""} />
        </div>
      ) : null}
      {estado?.errores?.[motivo] ? <span className="campo-error">{estado.errores[motivo]}</span> : null}
    </fieldset>
  );
}

/** Las dos llaves que pasan con la custodia (con sobres guardados). */
export function Llaves({ estado }: { estado: EstadoFormularioEntrega }) {
  return (
    <>
      <Llave estado={estado} de="caja" />
      <Llave estado={estado} de="cajon" />
    </>
  );
}

type Fuera = Sobre & { estado: "por_confirmar" | "por_devolver"; entrego: string; recibe: string };
/** Sobres que no están en la caja: no se verifican; se ve quién los entregó y quién debe confirmar o devolverlos. */
export function SobresFuera({ fuera }: { fuera: Fuera[] }) {
  if (!fuera.length) return null;
  return (
    <div className="aviso aviso-info" data-testid="sobres-fuera">
      <p><strong>No están en la caja</strong> (no los verifiques):</p>
      <ul className="lista-simple">
        {fuera.map((f) => (
          <li key={f.id} data-testid={`fuera-${f.folio}`}>
            Sobre <span className="mono">{f.folio}</span> · {NOMBRE[f.lugar]} ·{" "}
            {f.estado === "por_confirmar"
              ? <>entregó <strong>{f.entrego}</strong>; debe confirmar su recepción <strong>{f.recibe}</strong> (Dirección)</>
              : <>entrega cancelada; <strong>{f.recibe}</strong> debe devolverlo y la responsable en turno registrar que lo recibe</>}
          </li>
        ))}
      </ul>
    </div>
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


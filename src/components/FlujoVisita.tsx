"use client";

import Link from "next/link";
import { useActionState, useRef, useState, type FormEvent } from "react";
import { accionConfirmarVisita } from "@/app/acciones-visita";
import { accionBuscarVisitantes } from "@/app/acciones-visitantes";
import { TarjetaVisitante } from "@/components/Visitantes";
import { leerRecibido, MENSAJES_RECIBIDO, TARIFA_VISITA } from "@/lib/datos-visita";
import type { CobroRegistrado } from "@/lib/visitas";
import type { ResultadoVisitante } from "@/lib/visitantes";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (importe: string) => pesos.format(Number(importe));

/** Clave del cobro: se crea al elegir la ficha y se conserva hasta que el cobro se guarda. */
function nuevaClave(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Props = { codigo: string; sucursal: string; turnoId: string; responsableBolsa: string };

/**
 * Una sola pantalla: buscar y elegir la ficha → visitante, sucursal, total, «Recibido» (opcional) y cambio →
 * «Confirmar cobro · $50.00». Nombre y teléfono no van en la dirección. Si se pierde la conexión, el mismo
 * botón reintenta con la misma clave: el servidor no cobra dos veces.
 */
export function FlujoVisita({ codigo, sucursal, turnoId, responsableBolsa }: Props) {
  const [busqueda, buscar, buscando] = useActionState(accionBuscarVisitantes, null);
  const [limpiada, setLimpiada] = useState<number | null>(null);
  const [elegido, setElegido] = useState<{ v: ResultadoVisitante; clave: string } | null>(null);
  const [recibido, setRecibido] = useState("");
  const [enviando, setEnviando] = useState(false);
  const enCurso = useRef(false);
  const [error, setError] = useState<{ general: string; recibido?: string } | null>(null);
  const [registrado, setRegistrado] = useState<CobroRegistrado | null>(null);

  const nuevaVisita = () => {
    setElegido(null);
    setRecibido("");
    setError(null);
    setRegistrado(null);
    setLimpiada(busqueda?.intento ?? 0);
  };

  if (registrado) {
    return (
      <section className="tarjeta" aria-labelledby="t-registrado" data-testid="cobro-registrado">
        <h2 id="t-registrado" className="titulo-seccion">Cobro registrado</h2>
        <p><strong>{registrado.visitante}</strong> · {sucursal}</p>
        <dl className="resumen-cobro">
          <dt>Total</dt>
          <dd><strong>{$(registrado.total)}</strong> en efectivo</dd>
          {registrado.recibido ? (
            <>
              <dt>Recibido</dt>
              <dd>{$(registrado.recibido)}</dd>
              <dt>Cambio</dt>
              <dd data-testid="cambio-registrado"><strong>{$(registrado.cambio ?? "0")}</strong></dd>
            </>
          ) : null}
          <dt>Entró a la bolsa</dt>
          <dd>{$(registrado.total)}</dd>
        </dl>
        <p className="fila-acciones">
          <button className="boton boton-principal" type="button" onClick={nuevaVisita}>Nueva visita</button>
          <Link className="boton" href={`/sucursales/${codigo}/turno`}>Ver el turno</Link>
        </p>
      </section>
    );
  }

  if (elegido) {
    const vivo = leerRecibido(recibido);
    const errorCampo = !vivo.ok ? MENSAJES_RECIBIDO[vivo.motivo] : error?.recibido;
    const confirmar = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (enCurso.current || !vivo.ok) return; // doble clic: el segundo no sale del navegador
      enCurso.current = true;
      setEnviando(true);
      setError(null);
      try {
        const r = await accionConfirmarVisita(new FormData(e.currentTarget));
        if (r.ok) setRegistrado(r.cobro);
        else setError({ general: r.error, recibido: r.errorRecibido });
      } catch {
        // No se sabe si llegó al servidor. La clave se conserva: reintentar no cobra dos veces.
        setError({ general: "Se perdió la conexión y no sabemos si el cobro se guardó. Vuelve a tocar «Confirmar cobro»: si ya se había guardado, no se cobrará dos veces." });
      } finally {
        enCurso.current = false;
        setEnviando(false);
      }
    };
    const v = elegido.v;
    return (
      <section className="tarjeta" aria-labelledby="t-cobro" data-testid="datos-cobro">
        <h2 id="t-cobro" className="titulo-seccion">Cobro de visita</h2>
        <dl className="resumen-cobro">
          <dt>Visitante</dt>
          <dd><strong>{v.nombre}</strong> · Tel. {v.telefono ?? "no registrado"}</dd>
          <dt>Sucursal</dt>
          <dd>{sucursal}</dd>
          <dt>Total</dt>
          <dd data-testid="total"><strong>{$(TARIFA_VISITA)}</strong> en efectivo</dd>
        </dl>
        {error ? <p className="aviso aviso-error" role="alert">{error.general}</p> : null}
        <form onSubmit={confirmar} className="formulario" noValidate>
          <input type="hidden" name="codigo" value={codigo} />
          <input type="hidden" name="clave" value={elegido.clave} />
          <input type="hidden" name="turnoId" value={turnoId} />
          <input type="hidden" name="visitanteId" value={v.id} />
          <div className="campo">
            <label htmlFor="recibido">Recibido (opcional)</label>
            <div className="importe">
              <span aria-hidden="true">$</span>
              <input id="recibido" name="recibido" inputMode="decimal" autoComplete="off" value={recibido}
                onChange={(e) => { setRecibido(e.target.value); if (error?.recibido) setError(null); }}
                aria-invalid={errorCampo ? true : undefined}
                aria-describedby={`recibido-ayuda${errorCampo ? " recibido-error" : ""}`} />
            </div>
            {errorCampo ? <span className="campo-error" id="recibido-error">{errorCampo}</span> : null}
            {vivo.ok && vivo.cambio !== null ? (
              <span className="cambio-vivo" data-testid="cambio">Cambio: <strong>{$(vivo.cambio)}</strong></span>
            ) : null}
            <span className="sub" id="recibido-ayuda">
              Si lo escribes, se calcula el cambio. A la bolsa solo entran los {$(TARIFA_VISITA)} de la visita.
            </span>
          </div>
          <p className="sub">Responsable de la bolsa: <strong>{responsableBolsa}</strong></p>
          <p className="fila-acciones">
            <button className="boton boton-principal" type="submit" disabled={enviando || !vivo.ok}>
              {enviando ? "Registrando…" : `Confirmar cobro · ${$(TARIFA_VISITA)}`}
            </button>
            <button className="boton" type="button" onClick={nuevaVisita} disabled={enviando}>Cambiar visitante</button>
          </p>
        </form>
      </section>
    );
  }

  const resultados = busqueda && busqueda.intento !== limpiada ? busqueda.resultados : undefined;
  return (
    <>
      <form className="tarjeta buscador" action={buscar} role="search" key={busqueda?.intento ?? 0}>
        <input type="hidden" name="codigo" value={codigo} />
        <div className="campo">
          <label htmlFor="q">Busca la ficha del visitante: nombre completo o teléfono</label>
          <input id="q" name="q" type="search" defaultValue={busqueda && busqueda.intento !== limpiada ? busqueda.texto : ""}
            autoComplete="off" maxLength={120} />
          <span className="sub">Por teléfono, escribe los 10 dígitos. Si no tiene ficha, créala primero en Visitantes.</span>
        </div>
        <button className="boton boton-principal" type="submit" disabled={buscando}>{buscando ? "Buscando…" : "Buscar"}</button>
      </form>
      {busqueda?.error && busqueda.intento !== limpiada ? <p className="aviso aviso-error" role="alert">{busqueda.error}</p> : null}
      {resultados ? (
        <section className="tarjeta" aria-labelledby="t-resultados" data-testid="resultados">
          <h2 id="t-resultados" className="titulo-seccion">
            {resultados.length === 0 ? "Sin coincidencias" : resultados.length === 1 ? "1 coincidencia" : `${resultados.length} coincidencias`}
          </h2>
          {resultados.length > 1 ? (
            <p className="aviso aviso-info">Hay varias personas posibles. Confirma con el visitante cuál es antes de elegir.</p>
          ) : null}
          <ul className="lista-visitantes">
            {resultados.map((v) => (
              <TarjetaVisitante key={v.id} v={v} codigo={codigo} accion={
                <button className="boton" type="button" onClick={() => { setError(null); setRecibido(""); setElegido({ v, clave: nuevaClave() }); }}>
                  Elegir
                </button>
              } />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

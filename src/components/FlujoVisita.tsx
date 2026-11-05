"use client";

import { useActionState, useState } from "react";
import { accionConfirmarVisita, accionRevisarVisita } from "@/app/acciones-visita";
import { accionBuscarVisitantes } from "@/app/acciones-visitantes";
import { TarjetaVisitante } from "@/components/Visitantes";
import { leerRecibido, MENSAJES_RECIBIDO, TARIFA_VISITA } from "@/lib/datos-visita";
import type { ResultadoVisitante } from "@/lib/visitantes";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (importe: string) => pesos.format(Number(importe));

/**
 * Registrar una visita individual en efectivo: buscar la ficha → elegirla → escribir lo recibido (opcional)
 * → revisar el cobro → confirmar. Todo por POST y en la misma dirección: nombre y teléfono no van en la URL.
 * El servidor vuelve a comprobar todo al confirmar.
 */
export function FlujoVisita({ codigo }: { codigo: string }) {
  const [busqueda, buscar, buscando] = useActionState(accionBuscarVisitantes, null);
  const [revision, revisar, revisando] = useActionState(accionRevisarVisita, null);
  const [confirmacion, confirmar, confirmando] = useActionState(accionConfirmarVisita, null);
  const [elegido, setElegido] = useState<ResultadoVisitante | null>(null);
  const [recibido, setRecibido] = useState("");
  // Al tocar «Volver» se oculta el resumen de esa revisión (y el error de confirmación que tuviera).
  const [oculto, setOculto] = useState<{ revision: number; confirmacion: number }>({ revision: 0, confirmacion: 0 });

  const resumen = revision?.resumen && revision.intento !== oculto.revision && revision.resumen.visitante.id === elegido?.id ? revision.resumen : null;
  const errorConfirmacion = confirmacion?.error && confirmacion.intento !== oculto.confirmacion ? confirmacion.error : null;
  const volver = () => setOculto({ revision: revision?.intento ?? 0, confirmacion: confirmacion?.intento ?? 0 });

  if (elegido && resumen) {
    return (
      <section className="tarjeta" aria-labelledby="t-revisar" data-testid="resumen-cobro">
        <h2 id="t-revisar" className="titulo-seccion">Revisa el cobro</h2>
        <p className="sub">Todavía no se ha guardado nada.</p>
        <dl className="resumen-cobro">
          <dt>Visitante</dt>
          <dd><strong>{resumen.visitante.nombre}</strong> · Tel. {resumen.visitante.telefono ?? "no registrado"}</dd>
          <dt>Sucursal de la visita</dt>
          <dd>{resumen.sucursal.nombre}</dd>
          <dt>Tarifa</dt>
          <dd>{$(resumen.tarifa)}</dd>
          <dt>Descuento</dt>
          <dd>{$(resumen.descuento)}</dd>
          <dt>Total</dt>
          <dd data-testid="resumen-total"><strong>{$(resumen.total)}</strong></dd>
          <dt>Forma de pago</dt>
          <dd>Efectivo: entra a la bolsa de visitas</dd>
          <dt>Recibido</dt>
          <dd data-testid="resumen-recibido">{resumen.recibido ? $(resumen.recibido) : "No se escribió"}</dd>
          {resumen.cambio !== null ? (
            <>
              <dt>Cambio</dt>
              <dd data-testid="resumen-cambio"><strong>{$(resumen.cambio)}</strong></dd>
            </>
          ) : null}
          <dt>Entra a la bolsa</dt>
          <dd data-testid="resumen-bolsa"><strong>{$(resumen.total)}</strong></dd>
          <dt>Responsable de la bolsa</dt>
          <dd>{resumen.responsableBolsa}</dd>
        </dl>
        {errorConfirmacion ? <p className="aviso aviso-error" role="alert">{errorConfirmacion}</p> : null}
        <form action={confirmar} className="fila-acciones">
          <input type="hidden" name="codigo" value={codigo} />
          <input type="hidden" name="clave" value={resumen.clave} />
          <input type="hidden" name="turnoId" value={resumen.turnoId} />
          <input type="hidden" name="visitanteId" value={resumen.visitante.id} />
          <input type="hidden" name="recibido" value={resumen.recibido ?? ""} />
          <button className="boton boton-principal" type="submit" disabled={confirmando}>
            {confirmando ? "Confirmando…" : "Confirmar cobro"}
          </button>
          <button className="boton" type="button" onClick={volver} disabled={confirmando}>Volver</button>
        </form>
      </section>
    );
  }

  if (elegido) {
    const vivo = leerRecibido(recibido);
    return (
      <section className="tarjeta" aria-labelledby="t-cobro" data-testid="datos-cobro">
        <h2 id="t-cobro" className="titulo-seccion">Cobro de visita</h2>
        <p>
          <strong>{elegido.nombre}</strong> · Tel. {elegido.telefono ?? "no registrado"} · Ficha de {elegido.sucursalAlta}
        </p>
        <p className="cifra-reporte"><strong>{$(TARIFA_VISITA)}</strong> tarifa de visita</p>
        <p className="sub">Forma de pago: <strong>Efectivo</strong>. Por ahora es la única forma de pago en esta prueba.</p>
        {revision?.error && revision.intento !== oculto.revision ? <p className="aviso aviso-error" role="alert">{revision.error}</p> : null}
        <form action={revisar} className="formulario" noValidate>
          <input type="hidden" name="codigo" value={codigo} />
          <input type="hidden" name="visitanteId" value={elegido.id} />
          <div className="campo">
            <label htmlFor="recibido">Recibido (opcional)</label>
            <div className="importe">
              <span aria-hidden="true">$</span>
              <input id="recibido" name="recibido" inputMode="decimal" autoComplete="off" value={recibido}
                onChange={(e) => setRecibido(e.target.value)}
                aria-invalid={!vivo.ok ? true : undefined} aria-describedby={`recibido-ayuda${!vivo.ok ? " recibido-error" : ""}`} />
            </div>
            <span className="sub" id="recibido-ayuda">
              Si lo escribes, se calcula el cambio. A la bolsa solo entran los {$(TARIFA_VISITA)} de la visita.
            </span>
            {!vivo.ok ? (
              <span className="campo-error" id="recibido-error">{MENSAJES_RECIBIDO[vivo.motivo]}</span>
            ) : vivo.cambio !== null ? (
              <span data-testid="cambio-vivo">Cambio: <strong>{$(vivo.cambio)}</strong></span>
            ) : null}
          </div>
          <p className="fila-acciones">
            <button className="boton boton-principal" type="submit" disabled={revisando || !vivo.ok}>
              {revisando ? "Revisando…" : "Revisar cobro"}
            </button>
            <button className="boton" type="button" onClick={() => { volver(); setElegido(null); }}>Cambiar visitante</button>
          </p>
        </form>
      </section>
    );
  }

  const resultados = busqueda?.resultados;
  return (
    <>
      <form className="tarjeta buscador" action={buscar} role="search" key={busqueda?.intento ?? 0}>
        <input type="hidden" name="codigo" value={codigo} />
        <div className="campo">
          <label htmlFor="q">Busca la ficha del visitante: nombre completo o teléfono</label>
          <input id="q" name="q" type="search" defaultValue={busqueda?.texto ?? ""} autoComplete="off" maxLength={120} />
          <span className="sub">Por teléfono, escribe los 10 dígitos. Si no tiene ficha, créala primero en Visitantes.</span>
        </div>
        <button className="boton boton-principal" type="submit" disabled={buscando}>{buscando ? "Buscando…" : "Buscar"}</button>
      </form>
      {busqueda?.error ? <p className="aviso aviso-error" role="alert">{busqueda.error}</p> : null}
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
                <button className="boton" type="button" onClick={() => { volver(); setRecibido(""); setElegido(v); }}>
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

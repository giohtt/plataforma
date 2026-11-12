"use client";

import { useActionState, useState } from "react";
import {
  accionCancelarEntrega, accionEntregarTurno, accionRecibirTurno, type EstadoFormularioEntrega,
} from "@/app/acciones-entrega";
import { leerImporte } from "@/lib/datos-turno";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const firmado = (centavos: number) => (centavos < 0 ? "−" : centavos > 0 ? "+" : "") + pesos.format(Math.abs(centavos) / 100);
const cent = (v: string) => Math.round(Number(v) * 100);

function Importe({ estado, campo, etiqueta, ayuda, alCambiar }: {
  estado: EstadoFormularioEntrega; campo: "bolsa" | "cajon"; etiqueta: string; ayuda?: string; alCambiar?: (v: string) => void;
}) {
  const error = estado?.errores?.[campo];
  return (
    <div className="campo">
      <label htmlFor={campo}>{etiqueta}</label>
      <div className="importe">
        <span aria-hidden="true">$</span>
        <input id={campo} name={campo} inputMode="decimal" autoComplete="off" defaultValue={estado?.valores?.[campo] ?? ""}
          onChange={alCambiar ? (e) => alCambiar(e.target.value) : undefined}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${campo}-error` : undefined} />
      </div>
      {ayuda ? <span className="sub">{ayuda}</span> : null}
      {error ? <span className="campo-error" id={`${campo}-error`}>{error}</span> : null}
    </div>
  );
}

/**
 * «¿Alguien te ayudó a contar?» Obligatorio: «No, nadie más participó» o «Sí» con las personas de la sucursal que
 * participaron. Cada una confirma después desde su propia cuenta.
 */
function Apoyo({ estado, candidatos, etapa }: { estado: EstadoFormularioEntrega; candidatos: { id: string; nombre: string }[]; etapa: string }) {
  const [hubo, setHubo] = useState(estado?.valores?.apoyo ?? "");
  const error = estado?.errores?.apoyo;
  return (
    <fieldset className="campo campo-grupo" data-testid="apoyo" aria-invalid={error ? true : undefined}>
      <legend>¿Alguien te ayudó {etapa}?</legend>
      <label className="opcion-revision">
        <input type="radio" name="apoyo" value="no" checked={hubo === "no"} onChange={() => setHubo("no")} />
        <span>No, nadie más participó</span>
      </label>
      <label className="opcion-revision">
        <input type="radio" name="apoyo" value="si" checked={hubo === "si"} onChange={() => setHubo("si")} disabled={!candidatos.length} />
        <span>Sí, me ayudaron{candidatos.length ? "" : " (no hay otras personas de la sucursal para elegir)"}</span>
      </label>
      {hubo === "si" ? (
        <div className="campo" data-testid="personas-apoyo">
          <span className="sub">Elige a las personas de la sucursal que participaron. Cada una confirmará desde su propia cuenta; desde ahora no podrá revisar las diferencias de esta entrega.</span>
          {candidatos.map((c) => (
            <label key={c.id} className="opcion-revision">
              <input type="checkbox" name="personas" value={c.id} defaultChecked={estado?.personas?.includes(c.id)} />
              <span>{c.nombre}</span>
            </label>
          ))}
        </div>
      ) : null}
      {error ? <span className="campo-error">{error}</span> : null}
    </fieldset>
  );
}

/** La saliente cuenta cada lugar y elige a quién entrega. Ve el esperado de la bolsa y su diferencia al escribir. */
export function FormularioEntrega({ codigo, turnoId, esperadoBolsa, contadoCajon, receptores, apoyos }: {
  codigo: string; turnoId: string; esperadoBolsa: string; contadoCajon: string; receptores: { id: string; nombre: string }[];
  apoyos: { id: string; nombre: string }[];
}) {
  const [estado, accion, enviando] = useActionState(accionEntregarTurno, null);
  const [bolsa, setBolsa] = useState(estado?.valores?.bolsa ?? "");
  const leida = leerImporte(bolsa);
  const diferencia = leida.ok ? cent(leida.valor) - cent(esperadoBolsa) : null;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-entrega">
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="turno" value={turnoId} />
      <div className="lugares-turno">
        <fieldset className="campo campo-grupo" data-testid="entrega-bolsa">
          <legend>Bolsa de visitas</legend>
          <dl className="cuentas-lugar">
            <dt>Efectivo esperado</dt>
            <dd data-testid="entrega-esperado"><strong>{pesos.format(Number(esperadoBolsa))}</strong></dd>
          </dl>
          <Importe estado={estado} campo="bolsa" etiqueta="Total contado que entregas" alCambiar={setBolsa} />
          {diferencia !== null && diferencia !== 0 ? (
            <p className="aviso aviso-error" data-testid="entrega-diferencia">
              Diferencia contra el esperado: <strong>{firmado(diferencia)}</strong>. Se registra tal cual; el esperado no se ajusta.
            </p>
          ) : diferencia === 0 ? <p className="aviso aviso-ok" data-testid="entrega-diferencia">Coincide con el esperado.</p> : null}
        </fieldset>
        <fieldset className="campo campo-grupo" data-testid="entrega-cajon">
          <legend>Cajón de mensualidades</legend>
          <dl className="cuentas-lugar">
            <dt>Recibido al abrir</dt>
            <dd>{pesos.format(Number(contadoCajon))}</dd>
            <dt>Efectivo esperado</dt>
            <dd className="dd-largo">No calculado: faltan datos de Open Desk</dd>
          </dl>
          <Importe estado={estado} campo="cajon" etiqueta="Total contado que entregas"
            ayuda="Sin diferencia contra el esperado mientras falte Open Desk; sí se compara con lo que cuente quien recibe." />
        </fieldset>
      </div>
      <div className="campo">
        <label htmlFor="recibe">Quién recibe</label>
        <select id="recibe" name="recibe" defaultValue={estado?.valores?.recibe ?? ""} aria-invalid={estado?.errores?.recibe ? true : undefined}>
          <option value="">Elige a la recepcionista que entra</option>
          {receptores.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}
        </select>
        <span className="sub">Ella cuenta y confirma desde su propia cuenta, sin ver tu conteo antes de capturar el suyo.</span>
        {estado?.errores?.recibe ? <span className="campo-error">{estado.errores.recibe}</span> : null}
      </div>
      <Apoyo estado={estado} candidatos={apoyos} etapa="a contar lo que entregas" />
      <div className="campo">
        <label htmlFor="nota">Nota (opcional)</label>
        <textarea id="nota" name="nota" rows={2} maxLength={300} defaultValue={estado?.valores?.nota ?? ""} />
        <span className="sub">Por ejemplo, si hay una diferencia contra el esperado.</span>
        {estado?.errores?.nota ? <span className="campo-error">{estado.errores.nota}</span> : null}
      </div>
      <p className="sub">Mientras la entrega esté pendiente no se registran cobros en este turno.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Entregando…" : "Entregar el turno"}</button>
    </form>
  );
}

/**
 * La entrante cuenta y confirma. En «pendiente» no recibe el conteo de la saliente; en «recuento» ve ambos,
 * recuentan juntas y confirma un importe con aclaración.
 */
export function FormularioRecepcion({ codigo, entregaId, version, recuento, apoyos }: {
  codigo: string; entregaId: string; version: number;
  recuento: { entregado: { bolsa: string; cajon: string }; inicial: { bolsa: string; cajon: string } } | null;
  apoyos: { id: string; nombre: string }[];
}) {
  const [estado, accion, enviando] = useActionState(accionRecibirTurno, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-recepcion">
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="entrega" value={entregaId} />
      <input type="hidden" name="version" value={version} />
      {recuento ? (
        <>
          <table className="tabla" data-testid="tabla-recuento">
            <thead><tr><th>Lugar</th><th>Entregó</th><th>Tu primer conteo</th><th>Diferencia</th></tr></thead>
            <tbody>
              {(["bolsa", "cajon"] as const).map((l) => (
                <tr key={l}>
                  <td>{l === "bolsa" ? "Bolsa de visitas" : "Cajón de mensualidades"}</td>
                  <td>{pesos.format(Number(recuento.entregado[l]))}</td>
                  <td>{pesos.format(Number(recuento.inicial[l]))}</td>
                  <td>{firmado(cent(recuento.inicial[l]) - cent(recuento.entregado[l]))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sub">Recuenten juntas. Escribe el importe que confirmas recibir; tu primer conteo y lo que entregó se conservan.
            Si sigue sin coincidir, la diferencia queda por revisar y empiezas con lo que confirmes.</p>
        </>
      ) : null}
      <div className="lugares-turno">
        <fieldset className="campo campo-grupo" data-testid="recepcion-bolsa">
          <legend>Bolsa de visitas</legend>
          <Importe estado={estado} campo="bolsa" etiqueta={recuento ? "Total que confirmas tras recontar" : "Total que recibes"} />
        </fieldset>
        <fieldset className="campo campo-grupo" data-testid="recepcion-cajon">
          <legend>Cajón de mensualidades</legend>
          <Importe estado={estado} campo="cajon" etiqueta={recuento ? "Total que confirmas tras recontar" : "Total que recibes"} />
        </fieldset>
      </div>
      <Apoyo estado={estado} candidatos={apoyos} etapa={recuento ? "en el recuento" : "a contar lo que recibes"} />
      {recuento ? (
        <div className="campo">
          <label htmlFor="aclaracion">Aclaración del recuento</label>
          <textarea id="aclaracion" name="aclaracion" rows={2} maxLength={300} defaultValue={estado?.valores?.aclaracion ?? ""}
            aria-invalid={estado?.errores?.aclaracion ? true : undefined} />
          {estado?.errores?.aclaracion ? <span className="campo-error">{estado.errores.aclaracion}</span> : null}
        </div>
      ) : (
        <p className="sub">Cuenta cada lugar por separado y escribe solo el total. Desde que confirmes, tú eres la responsable de ambos lugares.</p>
      )}
      <button className="boton boton-principal" type="submit" disabled={enviando}>
        {enviando ? "Confirmando…" : recuento ? "Confirmar tras recontar" : "Confirmar lo que recibo"}
      </button>
    </form>
  );
}

/** La saliente cancela la entrega en curso, con motivo. */
export function FormularioCancelarEntrega({ codigo, entregaId, version }: { codigo: string; entregaId: string; version: number }) {
  const [estado, accion, enviando] = useActionState(accionCancelarEntrega, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-cancelar-entrega">
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="entrega" value={entregaId} />
      <input type="hidden" name="version" value={version} />
      <div className="campo">
        <label htmlFor="motivo">Motivo para cancelar la entrega</label>
        <textarea id="motivo" name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} />
        {estado?.errores?.motivo ? <span className="campo-error">{estado.errores.motivo}</span> : null}
      </div>
      <button className="boton" type="submit" disabled={enviando}>{enviando ? "Cancelando…" : "Cancelar la entrega"}</button>
    </form>
  );
}

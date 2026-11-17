"use client";

import { useActionState, useState } from "react";
import {
  accionAbrirDesdeCierre, accionCerrarDia, accionConfigurarCustodia, accionConfirmarCustodia, accionTerminarApertura,
} from "@/app/acciones-cierre";
import type { EstadoFormularioEntrega } from "@/app/acciones-entrega";
import { Apoyo, Importe } from "@/components/Entrega";
import { leerImporte } from "@/lib/datos-turno";

type Persona = { id: string; nombre: string };
type Sobre = { id: string; lugar: "bolsa_visitas" | "cajon_mensualidades"; folio: string };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const firmado = (centavos: number) => (centavos < 0 ? "−" : centavos > 0 ? "+" : "") + pesos.format(Math.abs(centavos) / 100);
const cent = (v: string) => Math.round(Number(v) * 100);
const NOMBRE = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" } as const;

function Aviso({ estado }: { estado: EstadoFormularioEntrega }) {
  return estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null;
}

/**
 * Cierre: la responsable cuenta cada lugar (la bolsa contra su esperado), anota los folios ya generados en los sobres,
 * elige al custodio y declara si alguien ayudó. Cerrar termina el turno.
 */
export function FormularioCierre({ codigo, turnoId, esperadoBolsa, contadoCajon, sobres, custodios, apoyos, configuracion }: {
  codigo: string; turnoId: string; esperadoBolsa: string; contadoCajon: string; sobres: Sobre[]; custodios: Persona[]; apoyos: Persona[];
  configuracion: { lugar: string; acceso: Persona[] };
}) {
  const [estado, accion, enviando] = useActionState(accionCerrarDia, null);
  const [bolsa, setBolsa] = useState(estado?.valores?.bolsa ?? "");
  const leida = leerImporte(bolsa);
  const diferencia = leida.ok ? cent(leida.valor) - cent(esperadoBolsa) : null;
  const folio = (l: Sobre["lugar"]) => sobres.find((s) => s.lugar === l)!.folio;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-cierre">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="turno" value={turnoId} />
      <div className="lugares-turno">
        <fieldset className="campo campo-grupo" data-testid="cierre-bolsa">
          <legend>Bolsa de visitas</legend>
          <dl className="cuentas-lugar">
            <dt>Efectivo esperado al cerrar</dt>
            <dd data-testid="cierre-esperado"><strong>{pesos.format(Number(esperadoBolsa))}</strong></dd>
            <dt>Sobre de cierre</dt>
            <dd className="mono" data-testid="folio-bolsa">{folio("bolsa_visitas")}</dd>
          </dl>
          <Importe estado={estado} campo="bolsa" etiqueta="Total contado al cerrar" alCambiar={setBolsa} />
          {diferencia !== null && diferencia !== 0 ? (
            <p className="aviso aviso-error" data-testid="cierre-diferencia">
              Diferencia contra el esperado: <strong>{firmado(diferencia)}</strong>. Queda constancia en el cierre; el esperado no se ajusta.
            </p>
          ) : diferencia === 0 ? <p className="aviso aviso-ok" data-testid="cierre-diferencia">Coincide con el esperado.</p> : null}
        </fieldset>
        <fieldset className="campo campo-grupo" data-testid="cierre-cajon">
          <legend>Cajón de mensualidades</legend>
          <dl className="cuentas-lugar">
            <dt>Contado al abrir</dt>
            <dd>{pesos.format(Number(contadoCajon))}</dd>
            <dt>Efectivo esperado</dt>
            <dd className="dd-largo">No calculado: pendiente de Open Desk</dd>
            <dt>Sobre de cierre</dt>
            <dd className="mono" data-testid="folio-cajon">{folio("cajon_mensualidades")}</dd>
          </dl>
          <Importe estado={estado} campo="cajon" etiqueta="Total contado al cerrar" ayuda="Se registra lo contado y se compara con lo que cuente quien abra." />
        </fieldset>
      </div>
      <fieldset className="campo campo-grupo" data-testid="custodia">
        <legend>Custodia nocturna</legend>
        <dl className="cuentas-lugar">
          <dt>Dónde quedan los sobres</dt>
          <dd className="dd-largo" data-testid="lugar-custodia">{configuracion.lugar}</dd>
          <dt>Quién tiene acceso</dt>
          <dd className="dd-largo">{configuracion.acceso.map((p) => p.nombre).join(" · ")}</dd>
        </dl>
        <span className="sub">Lo definió Dirección para esta sucursal y queda copiado en este cierre.</span>
        <label htmlFor="custodio">Custodio nocturno</label>
        <select id="custodio" name="custodio" defaultValue={estado?.valores?.custodio ?? (custodios.length === 1 ? custodios[0].id : "")}
          aria-invalid={estado?.errores?.custodio ? true : undefined}>
          <option value="">Elige al Encargado que recibe los sobres</option>
          {custodios.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
        <span className="sub">Confirma desde su cuenta dónde los guardó y verifica sello y folio de cada sobre.</span>
        {estado?.errores?.custodio ? <span className="campo-error">{estado.errores.custodio}</span> : null}
      </fieldset>
      <Apoyo estado={estado} candidatos={apoyos} etapa="a contar lo que cierras" />
      <div className="campo">
        <label htmlFor="nota">Nota (opcional)</label>
        <textarea id="nota" name="nota" rows={2} maxLength={300} defaultValue={estado?.valores?.nota ?? ""} />
        {estado?.errores?.nota ? <span className="campo-error">{estado.errores.nota}</span> : null}
      </div>
      <p className="sub">Al cerrar termina el turno: no se registran cobros ni retiros hasta la siguiente apertura.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Cerrando…" : "Cerrar el turno y entregar los sobres al custodio"}</button>
    </form>
  );
}

/** Sello y folio de cada sobre: «Cerrado y con este folio» o una incidencia (falta, abierto, otro folio) con motivo. */
function VerificarSobres({ estado, sobres, pregunta }: { estado: EstadoFormularioEntrega; sobres: Sobre[]; pregunta: string }) {
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
          <fieldset key={s.id} className="campo campo-grupo" data-testid={`verificar-${s.lugar}`} aria-invalid={error ? true : undefined}>
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

/** El custodio confirma desde su cuenta dónde guardó los sobres y verifica cada uno. No ve importes. */
export function FormularioCustodia({ codigo, entregaId, sobres, lugar }: { codigo: string; entregaId: string; sobres: Sobre[]; lugar: string }) {
  const [estado, accion, enviando] = useActionState(accionConfirmarCustodia, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-custodia">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="entrega" value={entregaId} />
      <VerificarSobres estado={estado} sobres={sobres} pregunta="¿Lo recibiste cerrado y con este folio?" />
      <div className="campo">
        <label htmlFor="ubicacion">Dónde los guardaste</label>
        <input id="ubicacion" name="ubicacion" maxLength={120} defaultValue={estado?.valores?.ubicacion ?? lugar}
          aria-invalid={estado?.errores?.ubicacion ? true : undefined} />
        <span className="sub">Lugar definido por Dirección: {lugar}.</span>
        {estado?.errores?.ubicacion ? <span className="campo-error">{estado.errores.ubicacion}</span> : null}
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Confirmando…" : "Confirmo que los sobres quedan bajo mi custodia"}</button>
    </form>
  );
}

/** Quien abre verifica los sobres y cuenta a ciegas cada lugar. */
export function FormularioAperturaCierre({ codigo, entregaId, version, sobres, apoyos, custodioSinConfirmar }: {
  codigo: string; entregaId: string; version: number; sobres: Sobre[]; apoyos: Persona[];
  /** Nombre del custodio si todavía no confirma la custodia. */
  custodioSinConfirmar: string | null;
}) {
  const [estado, accion, enviando] = useActionState(accionAbrirDesdeCierre, null);
  const [sinCustodia, setSinCustodia] = useState(estado?.valores?.sinCustodia === "si");
  const folio = (l: Sobre["lugar"]) => sobres.find((s) => s.lugar === l)!.folio;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-apertura-cierre">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="entrega" value={entregaId} />
      <input type="hidden" name="version" value={version} />
      {custodioSinConfirmar ? (
        <fieldset className="campo campo-grupo" data-testid="custodia-sin-confirmar" aria-invalid={estado?.errores?.sinCustodia ? true : undefined}>
          <legend>Custodia sin confirmar</legend>
          <span className="sub">
            {custodioSinConfirmar} todavía no confirma dónde guardó los sobres. Si está disponible, que confirme primero desde su cuenta y
            después recarga esta pantalla.
          </span>
          <label className="opcion-revision">
            <input type="checkbox" name="sin_custodia" value="si" checked={sinCustodia} onChange={(e) => setSinCustodia(e.target.checked)} />
            <span>{custodioSinConfirmar} no está disponible: abro sin su confirmación</span>
          </label>
          {sinCustodia ? (
            <div className="campo">
              <label htmlFor="motivo_sin_custodia">Motivo (obligatorio)</label>
              <textarea id="motivo_sin_custodia" name="motivo_sin_custodia" rows={2} maxLength={300} defaultValue={estado?.valores?.motivoSinCustodia ?? ""} />
              <span className="sub">La falta de confirmación queda por revisar en «Diferencias de efectivo».</span>
            </div>
          ) : null}
          {estado?.errores?.sinCustodia ? <span className="campo-error">{estado.errores.sinCustodia}</span> : null}
        </fieldset>
      ) : null}
      <VerificarSobres estado={estado} sobres={sobres} pregunta="¿El sobre está cerrado, con el sello intacto y con este folio?" />
      <p className="sub">Si un sobre no llega cerrado y con su folio, queda por revisar aunque el efectivo cuadre.</p>
      <div className="lugares-turno">
        <fieldset className="campo campo-grupo" data-testid="apertura-bolsa">
          <legend>Bolsa de visitas (sobre <span className="mono">{folio("bolsa_visitas")}</span>)</legend>
          <Importe estado={estado} campo="bolsa" etiqueta="Total que cuentas" />
        </fieldset>
        <fieldset className="campo campo-grupo" data-testid="apertura-cajon">
          <legend>Cajón de mensualidades (sobre <span className="mono">{folio("cajon_mensualidades")}</span>)</legend>
          <Importe estado={estado} campo="cajon" etiqueta="Total que cuentas" />
        </fieldset>
      </div>
      <Apoyo estado={estado} candidatos={apoyos} etapa="a contar al abrir" />
      <p className="sub">Cuenta sin ver el cierre. Si coincide, el turno abre con lo que cuentas; si no, se pide recontar con el custodio.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Abriendo…" : "Abrir el turno"}</button>
    </form>
  );
}

/** Si no coincidió: recuento con el custodio, o abrir con lo contado con motivo obligatorio. */
export function FormularioTerminarApertura({ codigo, entregaId, version, custodio }: { codigo: string; entregaId: string; version: number; custodio: string }) {
  const [estado, accion, enviando] = useActionState(accionTerminarApertura, null);
  const [recontaron, setRecontaron] = useState(estado?.valores?.recontaron ?? "");
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-terminar-apertura">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="entrega" value={entregaId} />
      <input type="hidden" name="version" value={version} />
      <fieldset className="campo campo-grupo" aria-invalid={estado?.errores?.recontaron ? true : undefined}>
        <legend>¿Recontaron con {custodio}?</legend>
        <label className="opcion-revision">
          <input type="radio" name="recontaron" value="si" checked={recontaron === "si"} onChange={() => setRecontaron("si")} />
          <span>Sí, recontamos juntos</span>
        </label>
        <label className="opcion-revision">
          <input type="radio" name="recontaron" value="no" checked={recontaron === "no"} onChange={() => setRecontaron("no")} />
          <span>No pudimos recontar juntos: abro con lo que conté</span>
        </label>
        {estado?.errores?.recontaron ? <span className="campo-error">{estado.errores.recontaron}</span> : null}
      </fieldset>
      {recontaron === "si" ? (
        <div className="lugares-turno">
          <fieldset className="campo campo-grupo"><legend>Bolsa de visitas</legend>
            <Importe estado={estado} campo="bolsa" etiqueta="Total tras recontar" />
          </fieldset>
          <fieldset className="campo campo-grupo"><legend>Cajón de mensualidades</legend>
            <Importe estado={estado} campo="cajon" etiqueta="Total tras recontar" />
          </fieldset>
        </div>
      ) : null}
      {recontaron ? (
        <div className="campo">
          <label htmlFor="motivo">{recontaron === "no" ? "Motivo (obligatorio)" : "Aclaración del recuento (opcional)"}</label>
          <textarea id="motivo" name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""}
            aria-invalid={estado?.errores?.motivo ? true : undefined} />
          {estado?.errores?.motivo ? <span className="campo-error">{estado.errores.motivo}</span> : null}
        </div>
      ) : null}
      <p className="sub">Se conservan los dos conteos. Si sigue sin coincidir, el turno abre con lo confirmado y la diferencia queda por revisar.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Abriendo…" : "Abrir el turno"}</button>
    </form>
  );
}

/** Dirección define el lugar de custodia y quién tiene acceso. Nada se marca por omisión. */
export function FormularioConfigurarCustodia({ codigo, personas, vigente }: { codigo: string; personas: Persona[]; vigente: { lugar: string; acceso: string[] } | null }) {
  const [estado, accion, enviando] = useActionState(accionConfigurarCustodia, null);
  const marcados = estado?.personas ?? vigente?.acceso ?? [];
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-custodia-config">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <div className="campo">
        <label htmlFor="lugar">Dónde se guardan los sobres</label>
        <input id="lugar" name="lugar" maxLength={120} defaultValue={estado?.valores?.lugar ?? vigente?.lugar ?? ""}
          aria-invalid={estado?.errores?.lugar ? true : undefined} />
        {estado?.errores?.lugar ? <span className="campo-error">{estado.errores.lugar}</span> : null}
      </div>
      <fieldset className="campo campo-grupo" aria-invalid={estado?.errores?.acceso ? true : undefined}>
        <legend>Quién tiene acceso</legend>
        {personas.map((p) => (
          <label key={p.id} className="opcion-revision">
            <input type="checkbox" name="acceso" value={p.id} defaultChecked={marcados.includes(p.id)} />
            <span>{p.nombre}</span>
          </label>
        ))}
        {estado?.errores?.acceso ? <span className="campo-error">{estado.errores.acceso}</span> : null}
      </fieldset>
      <p className="sub">Cada cierre guarda la configuración vigente en ese momento. Los cambios no alteran cierres anteriores.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Guardando…" : "Guardar la custodia"}</button>
    </form>
  );
}

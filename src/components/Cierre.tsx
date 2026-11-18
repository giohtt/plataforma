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
 * Cierre: la responsable cuenta cada lugar (la bolsa contra su esperado), aparta y cuenta el fondo fijo, y el excedente
 * va al sobre con su folio. Elige al custodio (o a sí misma, si también es Encargado: confirma la custodia aquí) y
 * declara si alguien ayudó. Cerrar termina el turno.
 */
export function FormularioCierre({ codigo, turnoId, usuarioId, esperadoBolsa, contadoCajon, sobres, fondos, custodios, apoyos, configuracion }: {
  codigo: string; turnoId: string; usuarioId: string; esperadoBolsa: string; contadoCajon: string; sobres: Sobre[];
  fondos: { tipo: Sobre["lugar"]; monto: string }[]; custodios: Persona[]; apoyos: Persona[];
  configuracion: { lugar: string; acceso: Persona[]; lugarFondos: string; accesoCajon: Persona[] };
}) {
  const [estado, accion, enviando] = useActionState(accionCerrarDia, null);
  const [total, setTotal] = useState({ bolsa: estado?.valores?.bolsa ?? "", cajon: estado?.valores?.cajon ?? "" });
  const [fondo, setFondo] = useState({ bolsa: estado?.valores?.fondo_bolsa ?? "", cajon: estado?.valores?.fondo_cajon ?? "" });
  const [custodio, setCustodio] = useState(estado?.valores?.custodio ?? (custodios.length === 1 ? custodios[0].id : ""));
  const leida = leerImporte(total.bolsa);
  const diferencia = leida.ok ? cent(leida.valor) - cent(esperadoBolsa) : null;
  const monto = (l: Sobre["lugar"]) => fondos.find((f) => f.tipo === l)?.monto ?? "0.00";
  const lugar = (l: Sobre["lugar"], clave: "bolsa" | "cajon") => {
    const sobre = sobres.find((s) => s.lugar === l)!;
    const t = leerImporte(total[clave]);
    const f = Number(monto(l)) ? leerImporte(fondo[clave]) : ({ ok: true, valor: "0.00" } as const);
    const excedente = t.ok && f.ok ? cent(t.valor) - cent(f.valor) : null;
    return (
      <>
        {Number(monto(l)) ? (
          <Importe estado={estado} campo={`fondo_${clave}`} etiqueta={`Fondo apartado (contado) · vigente ${pesos.format(Number(monto(l)))}`}
            ayuda="Primero completa el fondo; si no alcanza, cuenta lo que hay y la diferencia queda por revisar."
            alCambiar={(v) => setFondo({ ...fondo, [clave]: v })} />
        ) : <input type="hidden" name={`fondo_${clave}`} value="0" />}
        <div className="cuadre" data-testid={`cuadre-${clave}`}>
          {excedente === null ? (
            <span className="sub">Sobre <span className="mono">{sobre.folio}</span>: escribe lo contado{Number(monto(l)) ? " y el fondo" : ""}.</span>
          ) : excedente < 0 ? (
            <span className="campo-error">El fondo no puede ser mayor que lo contado.</span>
          ) : (
            <span>
              {Number(monto(l)) ? <>Fondo {pesos.format(cent(f.ok ? f.valor : "0") / 100)} + </> : null}
              sobre <span className="mono">{sobre.folio}</span> {pesos.format(excedente / 100)} = <strong>{pesos.format(cent(t.ok ? t.valor : "0") / 100)}</strong>
              {excedente === 0 ? " · sin excedente: este lugar no lleva sobre" : ""}
            </span>
          )}
        </div>
      </>
    );
  };
  const yo = custodio === usuarioId;
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
          </dl>
          <Importe estado={estado} campo="bolsa" etiqueta="Total contado al cerrar" alCambiar={(v) => setTotal({ ...total, bolsa: v })} />
          {diferencia !== null && diferencia !== 0 ? (
            <p className="aviso aviso-error" data-testid="cierre-diferencia">
              Diferencia contra el esperado: <strong>{firmado(diferencia)}</strong>. Queda constancia en el cierre; el esperado no se ajusta.
            </p>
          ) : diferencia === 0 ? <p className="aviso aviso-ok" data-testid="cierre-diferencia">Coincide con el esperado.</p> : null}
          {lugar("bolsa_visitas", "bolsa")}
          <span className="sub">Folio del sobre: <span className="mono" data-testid="folio-bolsa">{sobres.find((s) => s.lugar === "bolsa_visitas")!.folio}</span></span>
        </fieldset>
        <fieldset className="campo campo-grupo" data-testid="cierre-cajon">
          <legend>Cajón de mensualidades</legend>
          <dl className="cuentas-lugar">
            <dt>Contado al abrir</dt>
            <dd>{pesos.format(Number(contadoCajon))}</dd>
            <dt>Efectivo esperado</dt>
            <dd className="dd-largo">No calculado: pendiente de Open Desk</dd>
          </dl>
          <Importe estado={estado} campo="cajon" etiqueta="Total contado al cerrar" ayuda="Se registra lo contado y se compara con lo que cuente quien abra."
            alCambiar={(v) => setTotal({ ...total, cajon: v })} />
          {lugar("cajon_mensualidades", "cajon")}
          <span className="sub">Folio del sobre: <span className="mono" data-testid="folio-cajon">{sobres.find((s) => s.lugar === "cajon_mensualidades")!.folio}</span></span>
        </fieldset>
      </div>
      <fieldset className="campo campo-grupo" data-testid="custodia">
        <legend>Custodia nocturna</legend>
        <dl className="cuentas-lugar">
          <dt>Dónde quedan los sobres</dt>
          <dd className="dd-largo" data-testid="lugar-custodia">{configuracion.lugar}</dd>
          <dt>Acceso a los sobres</dt>
          <dd className="dd-largo">{configuracion.acceso.map((p) => p.nombre).join(" · ")}</dd>
          <dt>Dónde quedan los fondos</dt>
          <dd className="dd-largo" data-testid="lugar-fondos">{configuracion.lugarFondos}, separados e identificados</dd>
          <dt>Acceso al cajón</dt>
          <dd className="dd-largo">{configuracion.accesoCajon.map((p) => p.nombre).join(" · ")}</dd>
        </dl>
        <span className="sub">Lo definió Dirección para esta sucursal y queda copiado en este cierre. El custodio guarda los sobres y la llave del cajón.</span>
        <label htmlFor="custodio">Custodio nocturno</label>
        <select id="custodio" name="custodio" value={custodio} onChange={(e) => setCustodio(e.target.value)}
          aria-invalid={estado?.errores?.custodio ? true : undefined}>
          <option value="">Elige al Encargado que recibe los sobres y la llave</option>
          {custodios.map((c) => <option key={c.id} value={c.id}>{c.id === usuarioId ? `Yo · ${c.nombre} — cierro y custodio` : c.nombre}</option>)}
        </select>
        <span className="sub">{yo ? "Como cierras y custodias tú, confirmas la custodia aquí mismo." : "Confirma desde su cuenta dónde guardó los sobres y la llave, y verifica sello y folio de cada sobre."}</span>
        {estado?.errores?.custodio ? <span className="campo-error">{estado.errores.custodio}</span> : null}
      </fieldset>
      {yo ? (
        <fieldset className="campo campo-grupo" data-testid="custodia-misma-persona">
          <legend>Confirmar la custodia</legend>
          <VerificarSobres estado={estado} sobres={sobres} pregunta="¿Queda cerrado, con el sello intacto y con este folio? (si no lleva sobre, no se toma en cuenta)" />
          <Llave estado={estado} />
          <div className="campo">
            <label htmlFor="ubicacion">Dónde guardas los sobres y la llave del cajón</label>
            <input id="ubicacion" name="ubicacion" maxLength={120} defaultValue={estado?.valores?.ubicacion ?? configuracion.lugar}
              aria-invalid={estado?.errores?.ubicacion ? true : undefined} />
            {estado?.errores?.ubicacion ? <span className="campo-error">{estado.errores.ubicacion}</span> : null}
          </div>
          <p className="aviso aviso-info" data-testid="aviso-misma-persona">
            Cierras y custodias tú: queda en el historial. Puedes abrir tú misma; la revisión la hace alguien que no participó
            (Administración, o Dirección si Administración participó).
          </p>
        </fieldset>
      ) : null}
      <Apoyo estado={estado} candidatos={apoyos} etapa="a contar lo que cierras" />
      <div className="campo">
        <label htmlFor="nota">Nota (opcional)</label>
        <textarea id="nota" name="nota" rows={2} maxLength={300} defaultValue={estado?.valores?.nota ?? ""} />
        {estado?.errores?.nota ? <span className="campo-error">{estado.errores.nota}</span> : null}
      </div>
      <p className="sub">Al cerrar termina el turno: no se registran cobros ni retiros hasta la siguiente apertura.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>
        {enviando ? "Cerrando…" : yo ? "Cerrar el turno y guardar sobres y llave" : "Cerrar el turno y entregar sobres y llave al custodio"}
      </button>
    </form>
  );
}

/** Cajón cerrado y llave recibida, o una incidencia con motivo. */
function Llave({ estado }: { estado: EstadoFormularioEntrega }) {
  const [llave, setLlave] = useState(estado?.valores?.llave ?? "");
  return (
    <fieldset className="campo campo-grupo" data-testid="llave" aria-invalid={estado?.errores?.motivo_llave ? true : undefined}>
      <legend>Cajón con los fondos y su llave</legend>
      <label className="opcion-revision">
        <input type="radio" name="llave" value="correcta" checked={llave === "correcta"} onChange={() => setLlave("correcta")} />
        <span>Sí: el cajón quedó cerrado con los fondos separados e identificados, y tengo la llave</span>
      </label>
      <label className="opcion-revision">
        <input type="radio" name="llave" value="incidencia" checked={llave === "incidencia"} onChange={() => setLlave("incidencia")} />
        <span>Hay un problema con el cajón o la llave</span>
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
      <Llave estado={estado} />
      <div className="campo">
        <label htmlFor="ubicacion">Dónde guardaste los sobres y la llave</label>
        <input id="ubicacion" name="ubicacion" maxLength={120} defaultValue={estado?.valores?.ubicacion ?? lugar}
          aria-invalid={estado?.errores?.ubicacion ? true : undefined} />
        <span className="sub">Lugar definido por Dirección: {lugar}.</span>
        {estado?.errores?.ubicacion ? <span className="campo-error">{estado.errores.ubicacion}</span> : null}
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Confirmando…" : "Confirmo que sobres y llave quedan bajo mi custodia"}</button>
    </form>
  );
}

/** Quien abre verifica los sobres y cuenta a ciegas cada lugar. */
export function FormularioAperturaCierre({ codigo, entregaId, version, sobres, fondos, apoyos, custodioSinConfirmar }: {
  codigo: string; entregaId: string; version: number; sobres: Sobre[]; fondos: Fondos; apoyos: Persona[];
  /** Nombre del custodio si todavía no confirma la custodia. */
  custodioSinConfirmar: string | null;
}) {
  const [estado, accion, enviando] = useActionState(accionAbrirDesdeCierre, null);
  const [sinCustodia, setSinCustodia] = useState(estado?.valores?.sinCustodia === "si");
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
      <ConteoSeparado estado={estado} sobres={sobres} fondos={fondos} etiqueta="que cuentas" prefijo="apertura" />
      <Apoyo estado={estado} candidatos={apoyos} etapa="a contar al abrir" />
      <p className="sub">Cuenta sin ver el cierre. Si coincide, el turno abre con lo que cuentas; si no, se pide recontar con el custodio.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Abriendo…" : "Abrir el turno"}</button>
    </form>
  );
}

type Fondos = { lugar: Sobre["lugar"]; monto: string; tieneSobre: boolean }[];
/** Fondo y sobre de cada lugar, por separado. Un lugar sin fondo o sin sobre no pide ese campo (va en 0). */
function ConteoSeparado({ estado, sobres, fondos, etiqueta, prefijo }: { estado: EstadoFormularioEntrega; sobres: Sobre[]; fondos: Fondos; etiqueta: string; prefijo: string }) {
  return (
    <div className="lugares-turno">
      {(["bolsa_visitas", "cajon_mensualidades"] as const).map((l) => {
        const clave = l === "bolsa_visitas" ? "bolsa" : "cajon";
        const f = fondos.find((x) => x.lugar === l);
        const sobre = sobres.find((s) => s.lugar === l);
        return (
          <fieldset key={l} className="campo campo-grupo" data-testid={`${prefijo}-${clave}`}>
            <legend>{NOMBRE[l]}</legend>
            {f && Number(f.monto) ? (
              <Importe estado={estado} campo={`fondo_${clave}`} etiqueta={`Fondo ${etiqueta} (fondo de ${pesos.format(Number(f.monto))})`} />
            ) : <input type="hidden" name={`fondo_${clave}`} value="0" />}
            {sobre ? (
              <Importe estado={estado} campo={`sobre_${clave}`} etiqueta={`Sobre ${sobre.folio} · total ${etiqueta}`} />
            ) : (
              <>
                <input type="hidden" name={`sobre_${clave}`} value="0" />
                <span className="sub">Este lugar no llevó sobre: no hubo excedente al cerrar.</span>
              </>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

/** Si no coincidió: recuento con el custodio, o abrir con lo contado con motivo obligatorio. */
export function FormularioTerminarApertura({ codigo, entregaId, version, custodio, sobres, fondos }: {
  codigo: string; entregaId: string; version: number; custodio: string; sobres: Sobre[]; fondos: Fondos;
}) {
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
        <ConteoSeparado estado={estado} sobres={sobres} fondos={fondos} etiqueta="tras recontar" prefijo="recuento" />
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
export function FormularioConfigurarCustodia({ codigo, personas, vigente }: {
  codigo: string; personas: Persona[]; vigente: { lugar: string; acceso: string[]; lugarFondos: string | null; accesoCajon: string[] } | null;
}) {
  const [estado, accion, enviando] = useActionState(accionConfigurarCustodia, null);
  const marcados = estado?.personas ?? vigente?.acceso ?? [];
  const marcadosCajon = estado ? (estado.valores?.acceso_cajon ?? "").split(",").filter(Boolean) : (vigente?.accesoCajon ?? []);
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
      <div className="campo">
        <label htmlFor="lugar_fondos">Dónde quedan los fondos fijos</label>
        <input id="lugar_fondos" name="lugar_fondos" maxLength={120} defaultValue={estado?.valores?.lugar_fondos ?? vigente?.lugarFondos ?? ""}
          aria-invalid={estado?.errores?.lugar_fondos ? true : undefined} />
        <span className="sub">Por ejemplo, «Cajón con llave de recepción». Los dos fondos quedan separados e identificados; el custodio guarda la llave.</span>
        {estado?.errores?.lugar_fondos ? <span className="campo-error">{estado.errores.lugar_fondos}</span> : null}
      </div>
      <fieldset className="campo campo-grupo" aria-invalid={estado?.errores?.acceso_cajon ? true : undefined} data-testid="acceso-cajon">
        <legend>Quién tiene acceso al cajón</legend>
        {personas.map((p) => (
          <label key={p.id} className="opcion-revision">
            <input type="checkbox" name="acceso_cajon" value={p.id} defaultChecked={marcadosCajon.includes(p.id)} />
            <span>{p.nombre}</span>
          </label>
        ))}
        {estado?.errores?.acceso_cajon ? <span className="campo-error">{estado.errores.acceso_cajon}</span> : null}
      </fieldset>
      <p className="sub">Cada cierre guarda la configuración vigente en ese momento. Los cambios no alteran cierres anteriores.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Guardando…" : "Guardar la custodia"}</button>
    </form>
  );
}

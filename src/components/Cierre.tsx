"use client";

import { useActionState, useState } from "react";
import {
  accionAbrirDesdeCierre, accionCerrarDia, accionConfigurarCustodia, accionConfirmarCustodia, accionTerminarApertura,
} from "@/app/acciones-cierre";
import type { EstadoFormularioEntrega } from "@/app/acciones-entrega";
import { Llave, VerificarSobres } from "@/components/Caja";
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
export function FormularioCierre({ codigo, turnoId, usuarioId, esperadoBolsa, contadoCajon, sobres, fondos, custodios, apoyos, configuracion, caja }: {
  codigo: string; turnoId: string; usuarioId: string; esperadoBolsa: string; contadoCajon: string; sobres: Sobre[];
  fondos: { tipo: Sobre["lugar"]; monto: string }[]; custodios: Persona[]; apoyos: Persona[];
  configuracion: { lugar: string; acceso: Persona[]; lugarFondos: string; accesoCajon: Persona[]; guardados: boolean };
  /** Sobres que ya estaban guardados en la caja (con sobres guardados). */
  caja: Sobre[];
}) {
  const guardados = configuracion.guardados;
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
      {guardados ? (
        <p className="aviso aviso-info" data-testid="aviso-sobres-guardados">
          Los sobres se quedan sellados en la caja con llave hasta que Dirección los recoja. Al siguiente turno pasa solo el fondo;
          quien abra no abre los sobres.
        </p>
      ) : null}
      <fieldset className="campo campo-grupo" data-testid="custodia">
        <legend>{guardados ? "Custodia de la caja y la llave" : "Custodia nocturna"}</legend>
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
        <span className="sub">
          Lo definió Dirección para esta sucursal y queda copiado en este cierre.
          {guardados ? " La custodia guarda la llave de la caja de sobres y del cajón." : " El custodio guarda los sobres y la llave del cajón."}
        </span>
        <label htmlFor="custodio">{guardados ? "Custodia que se queda con la llave" : "Custodio nocturno"}</label>
        <select id="custodio" name="custodio" value={custodio} onChange={(e) => setCustodio(e.target.value)}
          aria-invalid={estado?.errores?.custodio ? true : undefined}>
          <option value="">{guardados ? "Elige a la custodia que nombró Dirección" : "Elige al Encargado que recibe los sobres y la llave"}</option>
          {custodios.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id === usuarioId ? `Yo · ${c.nombre} — ${guardados ? "cierro y me quedo con la llave" : "cierro y custodio"}` : c.nombre}
            </option>
          ))}
        </select>
        <span className="sub">{yo ? "Como cierras y custodias tú, confirmas la custodia aquí mismo." : "Confirma desde su cuenta dónde guardó los sobres y la llave, y verifica sello y folio de cada sobre."}</span>
        {estado?.errores?.custodio ? <span className="campo-error">{estado.errores.custodio}</span> : null}
      </fieldset>
      {yo ? (
        <fieldset className="campo campo-grupo" data-testid="custodia-misma-persona">
          <legend>Confirmar la custodia</legend>
          <VerificarSobres estado={estado} sobres={sobres} pregunta="¿Queda cerrado, con el sello intacto y con este folio? (si no lleva sobre, no se toma en cuenta)" />
          {caja.length ? (
            <>
              <p className="sub" data-testid="caja-anterior">Sobres que ya estaban en la caja: verifica cada uno al recibir la llave.</p>
              <VerificarSobres estado={estado} sobres={caja} porFolio pregunta="¿Sigue en la caja, cerrado y con este folio?" />
            </>
          ) : null}
          <Llave estado={estado} caja={guardados} />
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

/** El custodio confirma desde su cuenta dónde guardó los sobres y verifica cada uno. No ve importes. */
export function FormularioCustodia({ codigo, entregaId, sobres, lugar, caja, guardados }: {
  codigo: string; entregaId: string; sobres: Sobre[]; lugar: string; caja: Sobre[]; guardados: boolean;
}) {
  const [estado, accion, enviando] = useActionState(accionConfirmarCustodia, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-custodia">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="entrega" value={entregaId} />
      <VerificarSobres estado={estado} sobres={sobres} pregunta="¿Lo recibiste cerrado y con este folio?" />
      {caja.length ? (
        <>
          <p className="sub" data-testid="caja-anterior">Sobres que ya estaban en la caja: verifica cada uno al recibir la llave.</p>
          <VerificarSobres estado={estado} sobres={caja} porFolio pregunta="¿Sigue en la caja, cerrado y con este folio?" />
        </>
      ) : null}
      <Llave estado={estado} caja={guardados} />
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
export function FormularioAperturaCierre({ codigo, entregaId, version, sobres, fondos, apoyos, custodioSinConfirmar, caja }: {
  codigo: string; entregaId: string; version: number; sobres: Sobre[]; fondos: Fondos; apoyos: Persona[];
  /** Nombre del custodio si todavía no confirma la custodia. */
  custodioSinConfirmar: string | null;
  /** Con sobres guardados: todos los sobres de la caja (se verifican, no se abren). null en cierres anteriores. */
  caja: Sobre[] | null;
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
      {caja ? (
        <>
          <input type="hidden" name="guardados" value="si" />
          <p className="aviso aviso-info" data-testid="aviso-caja-apertura">
            Los sobres se quedan sellados en la caja hasta que Dirección los recoja: no los abras. Verifica cada uno y cuenta solo el fondo.
          </p>
          {caja.length ? (
            <VerificarSobres estado={estado} sobres={caja} porFolio pregunta="¿Está en la caja, cerrado, con el sello intacto y con este folio?" />
          ) : <p className="sub">La caja no tiene sobres guardados.</p>}
          <Llave estado={estado} caja />
          <ConteoFondo estado={estado} fondos={fondos} etiqueta="que cuentas" prefijo="apertura" />
        </>
      ) : (
        <>
          <VerificarSobres estado={estado} sobres={sobres} pregunta="¿El sobre está cerrado, con el sello intacto y con este folio?" />
          <ConteoSeparado estado={estado} sobres={sobres} fondos={fondos} etiqueta="que cuentas" prefijo="apertura" />
        </>
      )}
      <p className="sub">Si un sobre no llega cerrado y con su folio, queda por revisar aunque el efectivo cuadre.</p>
      <Apoyo estado={estado} candidatos={apoyos} etapa="a contar al abrir" />
      <p className="sub">Cuenta sin ver el cierre. Si coincide, el turno abre con lo que cuentas; si no, se pide recontar con el custodio.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Abriendo…" : "Abrir el turno"}</button>
    </form>
  );
}

type Fondos = { lugar: Sobre["lugar"]; monto: string; tieneSobre: boolean }[];
/** Con sobres guardados: en cada lugar se cuenta solo el fondo (los sobres siguen en la caja). */
function ConteoFondo({ estado, fondos, etiqueta, prefijo }: { estado: EstadoFormularioEntrega; fondos: Fondos; etiqueta: string; prefijo: string }) {
  return (
    <div className="lugares-turno">
      {(["bolsa_visitas", "cajon_mensualidades"] as const).map((l) => {
        const clave = l === "bolsa_visitas" ? "bolsa" : "cajon";
        const f = fondos.find((x) => x.lugar === l);
        return (
          <fieldset key={l} className="campo campo-grupo" data-testid={`${prefijo}-${clave}`}>
            <legend>{NOMBRE[l]}</legend>
            <Importe estado={estado} campo={`fondo_${clave}`}
              etiqueta={f && Number(f.monto) ? `Fondo ${etiqueta} (fondo de ${pesos.format(Number(f.monto))})` : `Efectivo ${etiqueta} (sin fondo fijo)`} />
            <input type="hidden" name={`sobre_${clave}`} value="0" />
          </fieldset>
        );
      })}
    </div>
  );
}
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
export function FormularioTerminarApertura({ codigo, entregaId, version, custodio, sobres, fondos, guardados = false }: {
  codigo: string; entregaId: string; version: number; custodio: string; sobres: Sobre[]; fondos: Fondos; guardados?: boolean;
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
        guardados
          ? <ConteoFondo estado={estado} fondos={fondos} etiqueta="tras recontar" prefijo="recuento" />
          : <ConteoSeparado estado={estado} sobres={sobres} fondos={fondos} etiqueta="tras recontar" prefijo="recuento" />
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
  codigo: string; personas: Persona[]; vigente: { lugar: string; acceso: string[]; lugarFondos: string | null; accesoCajon: string[]; custodias: string[] } | null;
}) {
  const [estado, accion, enviando] = useActionState(accionConfigurarCustodia, null);
  const marcadasCustodias = estado ? (estado.valores?.custodias ?? "").split(",").filter(Boolean) : (vigente?.custodias ?? []);
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
      <fieldset className="campo campo-grupo" aria-invalid={estado?.errores?.custodias ? true : undefined} data-testid="custodias">
        <legend>Custodias: quién puede quedarse con la llave de la caja</legend>
        <span className="sub">
          Al cerrar, una de ellas se queda con la llave; la llave pasa con el turno. Los sobres se quedan sellados en la caja hasta
          que Dirección los recoja. Nadie queda marcada por omisión.
        </span>
        {personas.map((p) => (
          <label key={p.id} className="opcion-revision">
            <input type="checkbox" name="custodias" value={p.id} defaultChecked={marcadasCustodias.includes(p.id)} />
            <span>{p.nombre}</span>
          </label>
        ))}
        {estado?.errores?.custodias ? <span className="campo-error">{estado.errores.custodias}</span> : null}
      </fieldset>
      <p className="sub">Cada cierre guarda la configuración vigente en ese momento. Los cambios no alteran cierres anteriores.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Guardando…" : "Guardar la custodia"}</button>
    </form>
  );
}

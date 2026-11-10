"use client";

import Link from "next/link";
import { useActionState, useCallback, useRef, useState, type FormEvent } from "react";
import { accionConfirmarVisita, accionVisitasDeHoy } from "@/app/acciones-visita";
import { accionBuscarVisitantes } from "@/app/acciones-visitantes";
import { FormularioVisitante } from "@/components/FormularioVisitante";
import { TarjetaVisitante } from "@/components/Visitantes";
import {
  leerAutorizacion, leerRecibido, leerReferencia, MAXIMO_PERSONAS, MENSAJES_AUTORIZACION, MENSAJES_REFERENCIA, mensajeRecibido,
  NOMBRE_REFERENCIA, TARIFA_VISITA, totalVisitas, type FormaPago, type TipoReferencia,
} from "@/lib/datos-visita";
import { normalizarTelefono } from "@/lib/datos-visitante";
import type { CobroPrevio, CobroRegistrado, EstadoCobro, VisitaHoy } from "@/lib/visitas";
import type { ResultadoVisitante } from "@/lib/visitantes";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (importe: string) => pesos.format(Number(importe));
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const MEDIO: Record<FormaPago, string> = { efectivo: "en efectivo", tarjeta: "con tarjeta", transferencia: "por transferencia" };
const ESTADO: Record<EstadoCobro, string> = {
  confirmado: "Confirmado",
  confirmado_operativamente: "Confirmado operativamente",
  pendiente_abono: "Pendiente de verificar abono",
  abono_verificado: "Abono verificado",
  no_localizado: "No localizado",
  cancelado: "Cancelado",
};

/** Clave del cobro: se crea al agregar a la primera persona y se conserva hasta que el cobro se guarda. */
function nuevaClave(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Props = {
  codigo: string;
  sucursal: string;
  turnoId: string;
  responsableBolsa: string;
  puedeCrear: boolean;
  estados: readonly string[];
  telefonoObligatorio: boolean;
  estadoObligatorio: boolean;
};

/**
 * Una sola pantalla para una persona o un grupo (hasta 20): buscar y «Agregar» fichas (o crear una sin perder
 * el grupo) → total, «Recibido» (opcional) y cambio → «Confirmar cobro · $X». Nombre y teléfono no van en la
 * dirección. Si se pierde la conexión, el grupo, lo recibido y la clave quedan fijos hasta reintentar: el
 * servidor no cobra dos veces y rechaza la misma clave con otros datos.
 */
export function FlujoVisita(props: Props) {
  const { codigo, sucursal, turnoId, responsableBolsa, puedeCrear } = props;
  const [busqueda, buscar, buscando] = useActionState(accionBuscarVisitantes, null);
  const [limpiada, setLimpiada] = useState<number | null>(null);
  const [grupo, setGrupo] = useState<ResultadoVisitante[]>([]);
  const [hoy, setHoy] = useState<Record<string, VisitaHoy>>({});
  const [clave, setClave] = useState<string | null>(null);
  const [recibido, setRecibido] = useState("");
  const [forma, setForma] = useState<FormaPago>("efectivo");
  const [autorizacion, setAutorizacion] = useState("");
  const [intentoTarjeta, setIntentoTarjeta] = useState(false);
  const [referencia, setReferencia] = useState("");
  const [tipoReferencia, setTipoReferencia] = useState<TipoReferencia | "">("");
  // La autorización (tarjeta) o la referencia (transferencia) ya está registrada: se muestran los cobros previos
  // (solo los que la persona puede ver) y se pide confirmar que es otra venta u otra transferencia.
  const [previos, setPrevios] = useState<CobroPrevio[] | null>(null);
  const [otraVenta, setOtraVenta] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const enCurso = useRef(false);
  // Tras perder la conexión no se sabe si el cobro se guardó: grupo y recibido quedan fijos hasta reintentar.
  const [pendiente, setPendiente] = useState(false);
  const [error, setError] = useState<{ general: string; recibido?: string; autorizacion?: string; referencia?: string } | null>(null);
  const [registrado, setRegistrado] = useState<CobroRegistrado | null>(null);
  const [creando, setCreando] = useState<{ nombre: string; telefono: string } | null>(null);

  const fijo = pendiente || enviando;
  const lleno = grupo.length >= MAXIMO_PERSONAS;
  const enGrupo = (id: string) => grupo.some((g) => g.id === id);

  const agregar = useCallback((v: ResultadoVisitante) => {
    if (fijo) return;
    setGrupo((g) => (g.some((x) => x.id === v.id) || g.length >= MAXIMO_PERSONAS ? g : [...g, v]));
    setClave((c) => c ?? nuevaClave());
    setError(null);
    setCreando(null);
    accionVisitasDeHoy(codigo, [v.id])
      .then((r) => setHoy((h) => ({ ...h, ...Object.fromEntries(r.map((x) => [x.id, x])) })))
      .catch(() => {});
  }, [codigo, fijo]);

  const quitar = (id: string) => {
    if (fijo) return;
    setGrupo((g) => g.filter((x) => x.id !== id));
    setError(null);
  };

  const nuevaVisita = () => {
    setGrupo([]);
    setHoy({});
    setClave(null);
    setRecibido("");
    setForma("efectivo");
    setAutorizacion("");
    setIntentoTarjeta(false);
    setReferencia("");
    setTipoReferencia("");
    setPrevios(null);
    setOtraVenta(false);
    setError(null);
    setPendiente(false);
    setRegistrado(null);
    setCreando(null);
    setLimpiada(busqueda?.intento ?? 0);
  };

  if (registrado) {
    return (
      <section className="tarjeta" aria-labelledby="t-registrado" data-testid="cobro-registrado">
        <h2 id="t-registrado" className="titulo-seccion">Cobro registrado</h2>
        <p>
          {registrado.personas} {registrado.personas === 1 ? "persona" : "personas"} · {sucursal}
        </p>
        <ul className="lista-simple" data-testid="registrados">
          {registrado.visitantes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
        <dl className="resumen-cobro">
          <dt>Total</dt>
          <dd><strong>{$(registrado.total)}</strong> {MEDIO[registrado.formaPago]}</dd>
          {registrado.formaPago === "transferencia" ? (
            <>
              <dt>{registrado.tipoReferencia ? NOMBRE_REFERENCIA[registrado.tipoReferencia] : "Referencia"}</dt>
              <dd data-testid="referencia-registrada">{registrado.referencia}</dd>
              <dt>Estado</dt>
              <dd data-testid="estado-registrado">{ESTADO[registrado.estado]}</dd>
            </>
          ) : null}
          {registrado.formaPago === "tarjeta" ? (
            <>
              <dt>Autorización</dt>
              <dd data-testid="autorizacion-registrada">{registrado.autorizacion}</dd>
              <dt>Estado</dt>
              <dd data-testid="estado-registrado">Confirmado operativamente</dd>
              <dt>Liquidación bancaria</dt>
              <dd data-testid="conciliacion-registrada">Pendiente de conciliar</dd>
            </>
          ) : null}
          {registrado.recibido ? (
            <>
              <dt>Recibido</dt>
              <dd>{$(registrado.recibido)}</dd>
              <dt>Cambio</dt>
              <dd data-testid="cambio-registrado"><strong>{$(registrado.cambio ?? "0")}</strong></dd>
            </>
          ) : null}
          <dt>{registrado.formaPago === "efectivo" ? "Entró a la bolsa" : "Bolsa de visitas"}</dt>
          <dd data-testid="bolsa-registrado">
            {registrado.formaPago === "efectivo" ? $(registrado.total) : `No entra efectivo (${registrado.formaPago})`}
          </dd>
        </dl>
        {registrado.formaPago === "transferencia" ? (
          <p className="aviso aviso-info" data-testid="aviso-acceso">
            El abono todavía no está verificado. Para entrar, pide la autorización de Encargado en «Registrar entradas».
          </p>
        ) : null}
        <p className="fila-acciones">
          <Link className="boton boton-principal" href={`/sucursales/${codigo}/turno/cobros/${registrado.operacionId}#entradas`} data-testid="registrar-entradas">
            {registrado.personas === 1 ? "Registrar entrada" : "Registrar entradas"}
          </Link>
          <button className="boton" type="button" onClick={nuevaVisita}>Nueva visita</button>
          <Link className="boton" href={`/sucursales/${codigo}/turno`}>Ver el turno</Link>
        </p>
      </section>
    );
  }

  const total = totalVisitas(grupo.length);
  const tarjeta = forma === "tarjeta";
  const transferencia = forma === "transferencia";
  const vivo = leerRecibido(forma !== "efectivo" ? "" : recibido, total);
  const errorCampo = !vivo.ok ? mensajeRecibido(vivo.motivo, total) : error?.recibido;
  const aut = leerAutorizacion(autorizacion);
  const errorAut = tarjeta && intentoTarjeta && !aut.ok ? MENSAJES_AUTORIZACION[aut.motivo] : error?.autorizacion;
  const ref = leerReferencia(referencia);
  const errorRef = transferencia && intentoTarjeta && (!tipoReferencia || !ref.ok)
    ? (!tipoReferencia ? MENSAJES_REFERENCIA.tipo : !ref.ok ? MENSAJES_REFERENCIA[ref.motivo] : undefined)
    : error?.referencia;
  const falta = previos !== null && !otraVenta;
  // Con pase de hoy en esta sucursal no se cobra otra visita: se registra la entrada o el reingreso con el mismo pase.
  const conPaseAqui = grupo.filter((v) => hoy[v.id]?.paseAqui);
  const conVisitaHoy = grupo.filter((v) => (hoy[v.id]?.visitasHoy ?? 0) > 0 && !hoy[v.id]?.paseAqui);

  const confirmar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (forma !== "efectivo") setIntentoTarjeta(true);
    const faltaDato = (tarjeta && !aut.ok) || (transferencia && (!tipoReferencia || !ref.ok));
    if (enCurso.current || !vivo.ok || !grupo.length || faltaDato || falta || conPaseAqui.length) return; // doble clic: el segundo no sale del navegador
    enCurso.current = true;
    setEnviando(true);
    setError(null);
    try {
      const r = await accionConfirmarVisita(new FormData(e.currentTarget));
      setPendiente(false);
      if (r.ok) setRegistrado(r.cobro);
      else {
        // Con una autorización repetida basta el recuadro con el cobro previo y la confirmación.
        if (r.previos) { setPrevios(r.previos); setError(null); }
        else setError({ general: r.error, recibido: r.errorRecibido, autorizacion: r.errorAutorizacion, referencia: r.errorReferencia });
      }
    } catch {
      // No se sabe si llegó al servidor. Grupo, medio de pago, recibido o autorización y clave se conservan:
      // reintentar no registra dos veces.
      setPendiente(true);
      setError({
        general: transferencia
          ? "Se perdió la conexión y no sabemos si la transferencia se registró en Fitnessland. Vuelve a tocar «Registrar transferencia» con la misma referencia: si ya se había registrado, no se registrará dos veces."
          : tarjeta
          ? "Se perdió la conexión y no sabemos si el cobro se registró en Fitnessland. El pago ya se cobró en la terminal: no vuelvas a pasar la tarjeta. Toca «Registrar cobro aprobado» otra vez con la misma autorización: si ya se había registrado, no se registrará dos veces."
          : "Se perdió la conexión y no sabemos si el cobro se guardó. Vuelve a tocar «Confirmar cobro»: si ya se había guardado, no se cobrará dos veces. Mientras tanto no se puede cambiar el grupo ni lo recibido.",
      });
    } finally {
      enCurso.current = false;
      setEnviando(false);
    }
  };

  const botonAgregar = (v: ResultadoVisitante) =>
    enGrupo(v.id) ? (
      <button className="boton" type="button" disabled>Ya está en el grupo</button>
    ) : (
      <button className="boton" type="button" onClick={() => agregar(v)} disabled={fijo || lleno}>Agregar</button>
    );

  const resultados = busqueda && busqueda.intento !== limpiada ? busqueda.resultados : undefined;
  const empezarAlta = () => {
    const texto = busqueda?.texto ?? "";
    const esTelefono = /^[\d\s()+-]+$/.test(texto);
    setCreando(esTelefono ? { nombre: "", telefono: normalizarTelefono(texto) ?? texto } : { nombre: texto, telefono: "" });
  };

  return (
    <>
      {grupo.length ? (
        <section className="tarjeta" aria-labelledby="t-cobro" data-testid="datos-cobro">
          <h2 id="t-cobro" className="titulo-seccion">Cobro de visita · {grupo.length} {grupo.length === 1 ? "persona" : "personas"}</h2>
          <ul className="lista-grupo">
            {grupo.map((v) => {
              const h = hoy[v.id];
              return (
                <li key={v.id} data-testid="en-grupo">
                  <span className="lista-grupo-datos">
                    <strong>{v.nombre}</strong>
                    <span className="sub">Tel. {v.telefono ?? "no registrado"} · {$(TARIFA_VISITA)}</span>
                    {h?.paseAqui ? (
                      <span className="chip-estado chip-pase-aqui" data-testid="pase-aqui">
                        Ya tiene pase de hoy en {sucursal}{h.paseAqui.entro ? " y ya entró" : ""}: no se cobra otra visita.{" "}
                        <Link href={`/sucursales/${codigo}/turno/cobros/${h.paseAqui.operacionId}#entradas`} data-testid="ir-pase">
                          {h.paseAqui.entro ? "Registrar reingreso" : "Registrar entrada"}
                        </Link>
                      </span>
                    ) : h && h.visitasHoy > 0 ? (
                      <span className="chip-estado chip-vencida" data-testid="visita-hoy">
                        Ya tiene una visita registrada hoy {h.enEstaSucursal ? `en ${sucursal}` : "en otra sucursal: aquí necesita un pase nuevo"}
                      </span>
                    ) : null}
                  </span>
                  <button className="boton boton-chico" type="button" onClick={() => quitar(v.id)} disabled={fijo}
                    aria-label={`Quitar a ${v.nombre}`}>Quitar</button>
                </li>
              );
            })}
          </ul>
          <dl className="resumen-cobro">
            <dt>Sucursal</dt>
            <dd>{sucursal}</dd>
            <dt>Total</dt>
            <dd data-testid="total">
              <strong>{$(total)}</strong> {MEDIO[forma]}{grupo.length > 1 ? ` (${grupo.length} × ${$(TARIFA_VISITA)})` : ""}
            </dd>
          </dl>
          {conPaseAqui.length ? (
            <p className="aviso aviso-error" data-testid="aviso-pase-aqui">
              {conPaseAqui.length === 1 ? `${conPaseAqui[0].nombre} ya tiene` : `${conPaseAqui.length} personas ya tienen`} pase de hoy
              en {sucursal}: el pase vale todo el día en esta sucursal, así que no se cobra otra visita. Quítalas del grupo y registra su
              entrada o reingreso con el mismo pase.
            </p>
          ) : null}
          {conVisitaHoy.length ? (
            <p className="aviso aviso-info" data-testid="aviso-visita-hoy">
              {conVisitaHoy.length === 1 ? `${conVisitaHoy[0].nombre} ya tiene` : `${conVisitaHoy.length} personas ya tienen`} una visita
              registrada hoy en otra sucursal. Su pase solo vale allá: aquí necesita un pase nuevo.
            </p>
          ) : null}
          {error ? <p className="aviso aviso-error" role="alert">{error.general}</p> : null}
          <form onSubmit={confirmar} className="formulario" noValidate>
            <input type="hidden" name="codigo" value={codigo} />
            <input type="hidden" name="clave" value={clave ?? ""} />
            <input type="hidden" name="turnoId" value={turnoId} />
            {grupo.map((v) => <input key={v.id} type="hidden" name="visitanteId" value={v.id} />)}
            <input type="hidden" name="formaPago" value={forma} />
            {/* Campo oculto: las opciones se desactivan al quedar fijo el cobro y un control desactivado no se envía. */}
            {transferencia ? <input type="hidden" name="tipoReferencia" value={tipoReferencia} /> : null}
            <fieldset className="campo campo-grupo" disabled={fijo}>
              <legend>Medio de pago</legend>
              <div className="opciones-pago">
                {(["efectivo", "tarjeta", "transferencia"] as const).map((f) => (
                  <label key={f} className="casilla">
                    <input type="radio" name="medio" value={f} checked={forma === f}
                      onChange={() => { setForma(f); setError(null); setPrevios(null); setOtraVenta(false); }} />
                    {f === "efectivo" ? "Efectivo" : f === "tarjeta" ? "Tarjeta" : "Transferencia"}
                  </label>
                ))}
              </div>
            </fieldset>
            {transferencia ? (
              <div className="campo">
                <ol className="pasos-tarjeta">
                  <li>Pide al visitante que transfiera <strong>{$(total)}</strong> a la cuenta de Fitnessland y que te muestre el comprobante.</li>
                  <li>Copia la clave de rastreo o el folio bancario del comprobante.</li>
                </ol>
                <fieldset className="campo campo-grupo" disabled={fijo}>
                  <legend>Tipo de referencia</legend>
                  <div className="opciones-pago">
                    {(["clave_rastreo", "folio_bancario"] as const).map((t) => (
                      <label key={t} className="casilla">
                        <input type="radio" name="tipoReferenciaOpcion" value={t} checked={tipoReferencia === t}
                          onChange={() => { setTipoReferencia(t); setPrevios(null); setOtraVenta(false); if (error) setError(null); }} />
                        {NOMBRE_REFERENCIA[t]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label htmlFor="referencia">Clave de rastreo o folio bancario</label>
                <input id="referencia" name="referencia" autoComplete="off" autoCapitalize="characters" maxLength={40}
                  value={referencia} readOnly={pendiente}
                  onChange={(e) => { setReferencia(e.target.value); setPrevios(null); setOtraVenta(false); if (error) setError(null); }}
                  aria-invalid={errorRef ? true : undefined}
                  aria-describedby={`referencia-ayuda${errorRef ? " referencia-error" : ""}`} />
                {errorRef ? <span className="campo-error" id="referencia-error">{errorRef}</span> : null}
                <span className="sub" id="referencia-ayuda">
                  Como aparece en el comprobante. No escribas nombres ni números de cuenta. Formato provisional: de 4 a 30 letras o números.
                </span>
                <p className="aviso aviso-info" data-testid="aviso-acceso">
                  El cobro quedará «Pendiente de verificar abono» hasta que Administración o Dirección lo verifique. Para entrar antes,
                  necesita la autorización de Encargado.
                </p>
              </div>
            ) : tarjeta ? (
              <div className="campo">
                <ol className="pasos-tarjeta">
                  <li>Cobra <strong>{$(total)}</strong> en la terminal y espera a que diga <strong>«Aprobado»</strong>.</li>
                  <li>Si la terminal rechaza el pago, no registres nada.</li>
                </ol>
                <label htmlFor="autorizacion">Autorización del comprobante</label>
                <input id="autorizacion" name="autorizacion" autoComplete="off" autoCapitalize="characters" maxLength={20}
                  value={autorizacion} readOnly={pendiente}
                  onChange={(e) => { setAutorizacion(e.target.value); setPrevios(null); setOtraVenta(false); if (error) setError(null); }}
                  aria-invalid={errorAut ? true : undefined}
                  aria-describedby={`autorizacion-ayuda${errorAut ? " autorizacion-error" : ""}`} />
                {errorAut ? <span className="campo-error" id="autorizacion-error">{errorAut}</span> : null}
                <span className="sub" id="autorizacion-ayuda">
                  Solo la autorización, como aparece en el comprobante. No escribas datos de la tarjeta. Formato provisional: de 4 a 12 letras o números.
                </span>
              </div>
            ) : (
              <div className="campo">
                <label htmlFor="recibido">Recibido (opcional)</label>
                <div className="importe">
                  <span aria-hidden="true">$</span>
                  <input id="recibido" name="recibido" inputMode="decimal" autoComplete="off" value={recibido} readOnly={pendiente}
                    onChange={(e) => { setRecibido(e.target.value); if (error?.recibido) setError(null); }}
                    aria-invalid={errorCampo ? true : undefined}
                    aria-describedby={`recibido-ayuda${errorCampo ? " recibido-error" : ""}`} />
                </div>
                {errorCampo ? <span className="campo-error" id="recibido-error">{errorCampo}</span> : null}
                {vivo.ok && vivo.cambio !== null ? (
                  <span className="cambio-vivo" data-testid="cambio">Cambio: <strong>{$(vivo.cambio)}</strong></span>
                ) : null}
                <span className="sub" id="recibido-ayuda">
                  Si lo escribes, se calcula el cambio. A la bolsa solo entra el total de {$(total)}.
                </span>
              </div>
            )}
            {forma !== "efectivo" && previos ? (
              <section className="aviso aviso-info" data-testid={tarjeta ? "autorizacion-previa" : "referencia-previa"}
                aria-label={tarjeta ? "Cobro con la misma autorización" : "Cobro con la misma referencia"}>
                <p><strong>{tarjeta ? `Esta autorización ya se registró hoy en ${sucursal}:` : "Esta referencia ya está registrada en otro cobro:"}</strong></p>
                <ul className="lista-simple">
                  {previos.map((p, i) => p.visible ? (
                    <li key={p.id}>
                      {hora.format(new Date(p.registradaEn))} · {p.sucursal} · {p.personas} {p.personas === 1 ? "persona" : "personas"} ·
                      {" "}{$(p.total)} · {ESTADO[p.estado]} · registrado por {p.registradaPor} ·{" "}
                      <a href={`/sucursales/${p.codigo}/turno/cobros/${p.id}`} target="_blank" rel="noopener">Ver cobro</a>
                    </li>
                  ) : (
                    <li key={`oculto-${i}`} data-testid="previo-oculto">En una sucursal a la que no tienes acceso. Pide a Administración que lo revise.</li>
                  ))}
                </ul>
                <label className="casilla">
                  <input type="checkbox" checked={otraVenta} onChange={(e) => setOtraVenta(e.target.checked)} disabled={fijo} />
                  {tarjeta
                    ? "Confirmo que es otra venta aprobada en la terminal, distinta de la anterior."
                    : "Confirmo que es otra transferencia, distinta de la anterior."}
                </label>
                {otraVenta ? <input type="hidden" name="otraVenta" value="si" /> : null}
              </section>
            ) : null}
            {forma !== "efectivo" ? null : <p className="sub">Responsable de la bolsa: <strong>{responsableBolsa}</strong></p>}
            <p className="fila-acciones">
              <button className="boton boton-principal" type="submit" disabled={enviando || !vivo.ok || falta || conPaseAqui.length > 0}>
                {enviando
                  ? "Registrando…"
                  : tarjeta ? `Registrar cobro aprobado · ${$(total)}`
                  : transferencia ? `Registrar transferencia · ${$(total)}`
                  : `Confirmar cobro · ${$(total)}`}
              </button>
              <button className="boton" type="button" onClick={nuevaVisita} disabled={fijo}>Empezar de nuevo</button>
            </p>
          </form>
        </section>
      ) : null}

      {creando ? (
        <section className="tarjeta" aria-labelledby="t-alta" data-testid="alta-visitante">
          <h2 id="t-alta" className="titulo-seccion">Nueva ficha</h2>
          <p className="aviso aviso-info">
            Solo datos ficticios. Antes de guardar se revisa si ya existe alguien con el mismo teléfono o un nombre parecido.
            {grupo.length ? " El grupo que ya armaste se conserva." : ""}
          </p>
          <FormularioVisitante
            codigo={codigo}
            inicial={creando}
            estados={props.estados}
            telefonoObligatorio={props.telefonoObligatorio}
            estadoObligatorio={props.estadoObligatorio}
            onVolver={() => setCreando(null)}
            alCrear={agregar}
            accionCoincidencia={botonAgregar}
          />
        </section>
      ) : (
        <fieldset className="sin-marco" disabled={fijo}>
          <form className="tarjeta buscador" action={buscar} role="search" key={busqueda?.intento ?? 0}>
            <input type="hidden" name="codigo" value={codigo} />
            <div className="campo">
              <label htmlFor="q">{grupo.length ? "Agregar otra persona: nombre completo o teléfono" : "Busca la ficha del visitante: nombre completo o teléfono"}</label>
              <input id="q" name="q" type="search" defaultValue={busqueda && busqueda.intento !== limpiada ? busqueda.texto : ""}
                autoComplete="off" maxLength={120} />
              <span className="sub">
                Por teléfono, escribe los 10 dígitos. {lleno ? `El grupo ya tiene ${MAXIMO_PERSONAS} personas, el máximo por cobro.` : "Puedes agregar hasta 20 personas en un mismo cobro."}
              </span>
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
                <p className="aviso aviso-info">Hay varias personas posibles. Confirma con cada visitante cuál es su ficha antes de agregarla.</p>
              ) : null}
              <ul className="lista-visitantes">
                {resultados.map((v) => <TarjetaVisitante key={v.id} v={v} codigo={codigo} accion={botonAgregar(v)} />)}
              </ul>
              {puedeCrear ? (
                <p className="fila-acciones">
                  <button className="boton" type="button" onClick={empezarAlta} data-testid="crear-visitante">
                    {resultados.length ? "No es ninguna: crear ficha nueva" : "Crear ficha nueva"}
                  </button>
                </p>
              ) : null}
            </section>
          ) : null}
        </fieldset>
      )}
    </>
  );
}

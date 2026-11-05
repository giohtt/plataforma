"use client";

import Link from "next/link";
import { useActionState, useCallback, useRef, useState, type FormEvent } from "react";
import { accionConfirmarVisita, accionVisitasDeHoy } from "@/app/acciones-visita";
import { accionBuscarVisitantes } from "@/app/acciones-visitantes";
import { FormularioVisitante } from "@/components/FormularioVisitante";
import { TarjetaVisitante } from "@/components/Visitantes";
import { leerRecibido, MAXIMO_PERSONAS, mensajeRecibido, TARIFA_VISITA, totalVisitas } from "@/lib/datos-visita";
import { normalizarTelefono } from "@/lib/datos-visitante";
import type { CobroRegistrado, VisitaHoy } from "@/lib/visitas";
import type { ResultadoVisitante } from "@/lib/visitantes";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (importe: string) => pesos.format(Number(importe));

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
  const [enviando, setEnviando] = useState(false);
  const enCurso = useRef(false);
  // Tras perder la conexión no se sabe si el cobro se guardó: grupo y recibido quedan fijos hasta reintentar.
  const [pendiente, setPendiente] = useState(false);
  const [error, setError] = useState<{ general: string; recibido?: string } | null>(null);
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
          <dd data-testid="bolsa-registrado">{$(registrado.total)}</dd>
        </dl>
        <p className="fila-acciones">
          <button className="boton boton-principal" type="button" onClick={nuevaVisita}>Nueva visita</button>
          <Link className="boton" href={`/sucursales/${codigo}/turno`}>Ver el turno</Link>
        </p>
      </section>
    );
  }

  const total = totalVisitas(grupo.length);
  const vivo = leerRecibido(recibido, total);
  const errorCampo = !vivo.ok ? mensajeRecibido(vivo.motivo, total) : error?.recibido;
  const conVisitaHoy = grupo.filter((v) => (hoy[v.id]?.visitasHoy ?? 0) > 0);

  const confirmar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (enCurso.current || !vivo.ok || !grupo.length) return; // doble clic: el segundo no sale del navegador
    enCurso.current = true;
    setEnviando(true);
    setError(null);
    try {
      const r = await accionConfirmarVisita(new FormData(e.currentTarget));
      setPendiente(false);
      if (r.ok) setRegistrado(r.cobro);
      else setError({ general: r.error, recibido: r.errorRecibido });
    } catch {
      // No se sabe si llegó al servidor. Grupo, recibido y clave se conservan: reintentar no cobra dos veces.
      setPendiente(true);
      setError({
        general: "Se perdió la conexión y no sabemos si el cobro se guardó. Vuelve a tocar «Confirmar cobro»: si ya se había guardado, no se cobrará dos veces. Mientras tanto no se puede cambiar el grupo ni lo recibido.",
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
                    {h && h.visitasHoy > 0 ? (
                      <span className="chip-estado chip-vencida" data-testid="visita-hoy">
                        Ya tiene una visita registrada hoy {h.enEstaSucursal ? `en ${sucursal}` : "en otra sucursal"}
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
              <strong>{$(total)}</strong> en efectivo{grupo.length > 1 ? ` (${grupo.length} × ${$(TARIFA_VISITA)})` : ""}
            </dd>
          </dl>
          {conVisitaHoy.length ? (
            <p className="aviso aviso-info" data-testid="aviso-visita-hoy">
              {conVisitaHoy.length === 1 ? `${conVisitaHoy[0].nombre} ya tiene` : `${conVisitaHoy.length} personas ya tienen`} una visita
              registrada hoy. La regla de reingreso está pendiente: confirma solo si corresponde cobrar otra visita.
            </p>
          ) : null}
          {error ? <p className="aviso aviso-error" role="alert">{error.general}</p> : null}
          <form onSubmit={confirmar} className="formulario" noValidate>
            <input type="hidden" name="codigo" value={codigo} />
            <input type="hidden" name="clave" value={clave ?? ""} />
            <input type="hidden" name="turnoId" value={turnoId} />
            {grupo.map((v) => <input key={v.id} type="hidden" name="visitanteId" value={v.id} />)}
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
            <p className="sub">Responsable de la bolsa: <strong>{responsableBolsa}</strong></p>
            <p className="fila-acciones">
              <button className="boton boton-principal" type="submit" disabled={enviando || !vivo.ok}>
                {enviando ? "Registrando…" : `Confirmar cobro · ${$(total)}`}
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

"use client";

import { useActionState, useState } from "react";
import {
  accionConfirmarRetiro, accionEntregarRetiro, accionRecontarRetiro, accionRegistrarDeposito, accionRevisarRetiro,
  type EstadoFormularioRetiro,
} from "@/app/acciones-retiros";
import { leerImporte } from "@/lib/datos-turno";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const cent = (v: string) => Math.round(Number(v) * 100);
const firmado = (c: number) => (c < 0 ? "−" : c > 0 ? "+" : "") + pesos.format(Math.abs(c) / 100);
type Campo = keyof NonNullable<NonNullable<EstadoFormularioRetiro>["errores"]>;

function ErrorCampo({ estado, campo, id }: { estado: EstadoFormularioRetiro; campo: Campo; id: string }) {
  const e = estado?.errores?.[campo];
  return e ? <span className="campo-error" id={`${id}-error`}>{e}</span> : null;
}
function Aviso({ estado }: { estado: EstadoFormularioRetiro }) {
  return estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null;
}
function Importe({ estado, campo, id, etiqueta, ayuda, alCambiar }: {
  estado: EstadoFormularioRetiro; campo: Campo; id: string; etiqueta: string; ayuda?: string; alCambiar?: (v: string) => void;
}) {
  const error = estado?.errores?.[campo];
  return (
    <div className="campo">
      <label htmlFor={id}>{etiqueta}</label>
      <div className="importe">
        <span aria-hidden="true">$</span>
        <input id={id} name={campo} inputMode="decimal" autoComplete="off" defaultValue={estado?.valores?.[campo] ?? ""}
          onChange={alCambiar ? (e) => alCambiar(e.target.value) : undefined}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} />
      </div>
      {ayuda ? <span className="sub">{ayuda}</span> : null}
      <ErrorCampo estado={estado} campo={campo} id={id} />
    </div>
  );
}

const NOMBRE = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" } as const;

/**
 * Recepción entrega en persona el sobre de UN lugar: cuenta, captura lo que deja para cambio (lo indica Encargada de
 * retiros) y el folio. Se lleva = contado − cambio.
 */
export function FormularioRetiro({ codigo, turnoId, lugar, esperado, encargadas }: {
  codigo: string; turnoId: string; lugar: keyof typeof NOMBRE; esperado: string | null; encargadas: { id: string; nombre: string }[];
}) {
  const [estado, accion, enviando] = useActionState(accionEntregarRetiro, null);
  const [contado, setContado] = useState(estado?.valores?.contado ?? "");
  const [cambio, setCambio] = useState(estado?.valores?.cambio ?? "");
  const c = leerImporte(contado);
  const k = leerImporte(cambio);
  const llevaC = c.ok && k.ok ? cent(c.valor) - cent(k.valor) : null;
  const id = (x: string) => `${x}-${lugar}`;
  return (
    <form action={accion} className="formulario tarjeta" key={estado?.intento ?? 0} noValidate data-testid={`retiro-${lugar}`}>
      <h2 className="titulo-seccion">{NOMBRE[lugar]}</h2>
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="turno" value={turnoId} />
      <input type="hidden" name="lugar" value={lugar} />
      <dl className="cuentas-lugar">
        <dt>Efectivo esperado</dt>
        <dd data-testid="retiro-esperado">{esperado !== null ? <strong>{pesos.format(Number(esperado))}</strong> : "No calculado: faltan datos de Open Desk"}</dd>
      </dl>
      <Importe estado={estado} campo="contado" id={id("contado")} etiqueta="Total contado antes del retiro" alCambiar={setContado}
        ayuda={esperado !== null && c.ok ? (cent(c.valor) === cent(esperado) ? "Coincide con el esperado." : `No coincide con el esperado (${firmado(cent(c.valor) - cent(esperado))}). Se registra lo contado.`) : undefined} />
      <Importe estado={estado} campo="cambio" id={id("cambio")} etiqueta="Deja para cambio (lo indica Encargada de retiros)" alCambiar={setCambio}
        ayuda="Si no deja nada, escribe 0." />
      <p data-testid="se-lleva">
        Se lleva Encargada de retiros: <strong>{llevaC !== null ? (llevaC > 0 ? pesos.format(llevaC / 100) : "debe ser mayor que $0") : "—"}</strong>
      </p>
      <div className="campo">
        <label htmlFor={id("folio")}>Folio del sobre</label>
        <input id={id("folio")} name="folio" autoComplete="off" maxLength={30} defaultValue={estado?.valores?.folio ?? ""} className="mono"
          aria-invalid={estado?.errores?.folio ? true : undefined} />
        <span className="sub">Único en la sucursal. Letras, números y guiones.</span>
        <ErrorCampo estado={estado} campo="folio" id={id("folio")} />
      </div>
      <div className="campo">
        <label htmlFor={id("encargada")}>Encargada de retiros que recibe en persona</label>
        <select id={id("encargada")} name="encargada" defaultValue={estado?.valores?.encargada ?? (encargadas.length === 1 ? encargadas[0].id : "")}>
          <option value="">Elige</option>
          {encargadas.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}
        </select>
        <ErrorCampo estado={estado} campo="encargada" id={id("encargada")} />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>
        {enviando ? "Registrando…" : `Entregar a Encargada de retiros${llevaC && llevaC > 0 ? ` · ${pesos.format(llevaC / 100)}` : ""}`}
      </button>
      <p className="sub">La salida se descuenta al registrar la entrega. Queda «Pendiente de confirmar por Encargada de retiros» hasta que ella cuente desde su cuenta.</p>
    </form>
  );
}

/** Encargada de retiros cuenta a ciegas (no ve lo registrado) y comprueba el folio. */
export function FormularioConfirmarRetiro({ retiroId, version, folio }: { retiroId: string; version: number; folio: string }) {
  const [estado, accion, enviando] = useActionState(accionConfirmarRetiro, null);
  const [folioOk, setFolioOk] = useState(estado?.valores?.folioCoincide ?? "");
  const id = (x: string) => `${x}-${retiroId}`;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="confirmar-retiro">
      <Aviso estado={estado} />
      <input type="hidden" name="retiro" value={retiroId} />
      <input type="hidden" name="version" value={version} />
      <Importe estado={estado} campo="importe" id={id("importe")} etiqueta="¿Cuánto contaste en el sobre?"
        ayuda="Escribe lo que contaste. El importe registrado no se muestra antes." />
      <fieldset className="campo campo-grupo">
        <legend>¿El folio del sobre es <span className="mono">{folio}</span>?</legend>
        <label className="opcion-revision">
          <input type="radio" name="folio_coincide" value="si" checked={folioOk === "si"} onChange={() => setFolioOk("si")} />
          <span>Sí, coincide</span>
        </label>
        <label className="opcion-revision">
          <input type="radio" name="folio_coincide" value="no" checked={folioOk === "no"} onChange={() => setFolioOk("no")} />
          <span>No coincide</span>
        </label>
        <ErrorCampo estado={estado} campo="folioCoincide" id={id("folio")} />
      </fieldset>
      {folioOk === "no" ? (
        <div className="campo">
          <label htmlFor={id("motivo")}>Motivo (obligatorio)</label>
          <textarea id={id("motivo")} name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} />
          <span className="sub">El retiro queda «Por revisar» y sus depósitos en pausa.</span>
          <ErrorCampo estado={estado} campo="motivo" id={id("motivo")} />
        </div>
      ) : null}
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Confirmar lo que recibí"}</button>
    </form>
  );
}

/** Su conteo no coincidió: recuento en persona (con quién) o «No coincide» con motivo si no pueden recontar. */
export function FormularioRecontar({ retiroId, version, registrado, inicial, personas }: {
  retiroId: string; version: number; registrado: string; inicial: string; personas: { id: string; nombre: string }[];
}) {
  const [estado, accion, enviando] = useActionState(accionRecontarRetiro, null);
  const [recontaron, setRecontaron] = useState(estado?.valores?.recontaron ?? "");
  const id = (x: string) => `${x}-${retiroId}`;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="recontar-retiro">
      <Aviso estado={estado} />
      <p className="aviso aviso-error" data-testid="no-coincide">
        <strong>No coincide con lo registrado.</strong> Registró Recepción: {pesos.format(Number(registrado))} · Contaste: {pesos.format(Number(inicial))} ·
        Diferencia: <strong>{firmado(cent(inicial) - cent(registrado))}</strong>
      </p>
      <input type="hidden" name="retiro" value={retiroId} />
      <input type="hidden" name="version" value={version} />
      <fieldset className="campo campo-grupo">
        <legend>¿Pudieron recontar en persona?</legend>
        <label className="opcion-revision">
          <input type="radio" name="recontaron" value="si" checked={recontaron === "si"} onChange={() => setRecontaron("si")} />
          <span>Sí, recontamos en persona</span>
        </label>
        <label className="opcion-revision">
          <input type="radio" name="recontaron" value="no" checked={recontaron === "no"} onChange={() => setRecontaron("no")} />
          <span>No pudimos recontar en este momento</span>
        </label>
        <ErrorCampo estado={estado} campo="recontaron" id={id("recontaron")} />
      </fieldset>
      {recontaron === "si" ? (
        <>
          <Importe estado={estado} campo="importe" id={id("importe")} etiqueta="Resultado del recuento" />
          <div className="campo">
            <label htmlFor={id("con")}>¿Con quién recontaste?</label>
            <select id={id("con")} name="con" defaultValue={estado?.valores?.con ?? ""}>
              <option value="">Elige</option>
              {personas.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
            <span className="sub">Su participación cuenta para decidir quién revisa si sigue sin coincidir.</span>
            <ErrorCampo estado={estado} campo="con" id={id("con")} />
          </div>
        </>
      ) : null}
      {recontaron ? (
        <div className="campo">
          <label htmlFor={id("motivo")}>Motivo (obligatorio si no coincide)</label>
          <textarea id={id("motivo")} name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} />
          <span className="sub">Si no coincide, el retiro queda «Por revisar» y solo los depósitos de este folio quedan en pausa.</span>
          <ErrorCampo estado={estado} campo="motivo" id={id("motivo")} />
        </div>
      ) : null}
      <button className="boton boton-principal" type="submit" disabled={enviando || !recontaron}>
        {enviando ? "Registrando…" : recontaron === "no" ? "No coincide · registrar mi conteo" : "Registrar recuento"}
      </button>
    </form>
  );
}

/** Depósito bancario de un folio, o corrección de un depósito anterior (registro nuevo, con motivo). */
export function FormularioDeposito({ codigo, retiroId, porDepositar, corrige }: {
  codigo: string; retiroId: string; porDepositar: string; corrige?: { id: string; importe: string; referencia: string };
}) {
  const [estado, accion, enviando] = useActionState(accionRegistrarDeposito, null);
  const [importe, setImporte] = useState(estado?.valores?.importe ?? "");
  const i = leerImporte(importe);
  const quedan = i.ok ? cent(porDepositar) + (corrige ? cent(corrige.importe) : 0) - cent(i.valor) : null;
  const id = (x: string) => `${x}-${corrige?.id ?? retiroId}`;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid={corrige ? "corregir-deposito" : "registrar-deposito"}>
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="retiro" value={retiroId} />
      {corrige ? <input type="hidden" name="corrige" value={corrige.id} /> : null}
      <p className="sub">Destino: <strong>Depósito bancario</strong> (único destino en esta versión).</p>
      <Importe estado={estado} campo="importe" id={id("importe")} etiqueta={corrige ? "Importe correcto del depósito" : "Importe depositado"} alCambiar={setImporte}
        ayuda={quedan !== null && quedan >= 0 ? (quedan > 0 ? `Depósito parcial: quedarán ${pesos.format(quedan / 100)} de este folio bajo tu responsabilidad.` : "Con este depósito queda completo el folio.") : undefined} />
      <div className="campo">
        <label htmlFor={id("fecha")}>Fecha y hora del depósito</label>
        <input id={id("fecha")} name="fecha" type="datetime-local" defaultValue={estado?.valores?.fecha ?? ""} />
        <ErrorCampo estado={estado} campo="fecha" id={id("fecha")} />
      </div>
      <div className="campo">
        <label htmlFor={id("referencia")}>Referencia del comprobante (obligatoria)</label>
        <input id={id("referencia")} name="referencia" maxLength={60} autoComplete="off" className="mono" defaultValue={estado?.valores?.referencia ?? ""} />
        <span className="sub">Folio o número de operación del comprobante. No se guardan datos de la cuenta bancaria.</span>
        <ErrorCampo estado={estado} campo="referencia" id={id("referencia")} />
      </div>
      {corrige ? (
        <div className="campo">
          <label htmlFor={id("motivo")}>Motivo de la corrección (obligatorio)</label>
          <textarea id={id("motivo")} name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} />
          <span className="sub">El depósito anterior se conserva en el historial; este lo reemplaza.</span>
          <ErrorCampo estado={estado} campo="motivo" id={id("motivo")} />
        </div>
      ) : null}
      <button className="boton boton-principal" type="submit" disabled={enviando}>
        {enviando ? "Registrando…" : corrige ? "Registrar corrección" : `Registrar depósito${i.ok && cent(i.valor) > 0 ? ` de ${pesos.format(Number(i.valor))}` : ""}`}
      </button>
    </form>
  );
}

/** Revisión de una discrepancia: «Aclarada» o «Faltante confirmado», con motivo y monto verificado. */
export function FormularioRevisionRetiro({ codigo, retiroId, version, registrado }: { codigo: string; retiroId: string; version: number; registrado: string }) {
  const [estado, accion, enviando] = useActionState(accionRevisarRetiro, null);
  const id = (x: string) => `${x}-rev-${retiroId}`;
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="revisar-retiro">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="retiro" value={retiroId} />
      <input type="hidden" name="version" value={version} />
      <fieldset className="campo campo-grupo">
        <legend>Resultado</legend>
        <label className="opcion-revision">
          <input type="radio" name="resultado" value="aclarada" defaultChecked={estado?.valores?.resultado === "aclarada"} />
          <span><strong>Aclarada</strong><br /><span className="sub">Se encontró la causa (por ejemplo, un error de captura o de conteo).</span></span>
        </label>
        <label className="opcion-revision">
          <input type="radio" name="resultado" value="faltante_confirmado" defaultChecked={estado?.valores?.resultado === "faltante_confirmado"} />
          <span><strong>Faltante confirmado</strong><br /><span className="sub">El dinero falta: la diferencia pasa a Dirección.</span></span>
        </label>
        <ErrorCampo estado={estado} campo="resultado" id={id("resultado")} />
      </fieldset>
      <Importe estado={estado} campo="monto" id={id("monto")} etiqueta="Monto verificado en el sobre"
        ayuda={`Lo registrado por Recepción fue ${pesos.format(Number(registrado))}. Los depósitos del folio se habilitan por el monto verificado.`} />
      <div className="campo">
        <label htmlFor={id("motivo")}>Motivo (obligatorio)</label>
        <textarea id={id("motivo")} name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} />
        <span className="sub">Queda en el historial con tu cuenta, la fecha y la hora. La salida original y los conteos no cambian.</span>
        <ErrorCampo estado={estado} campo="motivo" id={id("motivo")} />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar revisión"}</button>
    </form>
  );
}

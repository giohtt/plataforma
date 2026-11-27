"use client";

import { useActionState, useState } from "react";
import {
  accionComprobarAnticipo, accionConfirmarAnticipo, accionCorregirGasto, accionDecidirGasto, accionEntregarAnticipo, accionPedirExcedente,
  accionRecibirCambioAnticipo, accionRegistrarComprobante, accionRegistrarPago, accionSolicitarGasto, type EstadoGasto,
} from "@/app/acciones-gastos";
import { NOMBRE_ORIGEN, type LugarAnticipo, type OrigenPago } from "@/lib/datos-gasto";
import type { Categoria, SucursalOpcion } from "@/lib/gastos";

function ErrorCampo({ estado, campo }: { estado: EstadoGasto; campo: string }) {
  const e = estado?.errores?.[campo];
  return e ? <span className="campo-error">{e}</span> : null;
}
function Aviso({ estado }: { estado: EstadoGasto }) {
  return estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null;
}

/** Campos de una versión: concepto, categoría, importe, proveedor y nota. */
function CamposVersion({ estado, categorias, inicial }: {
  estado: EstadoGasto; categorias: Categoria[];
  inicial?: { concepto: string; categoria: string; importe: string; proveedor: string | null; nota: string | null };
}) {
  const v = (c: string, d = "") => estado?.valores?.[c] ?? d;
  return (
    <>
      <div className="campo">
        <label htmlFor="concepto">Qué se va a comprar o pagar</label>
        <input id="concepto" name="concepto" maxLength={120} defaultValue={v("concepto", inicial?.concepto)} aria-invalid={estado?.errores?.concepto ? true : undefined} />
        <ErrorCampo estado={estado} campo="concepto" />
      </div>
      <div className="campos-fila">
        <div className="campo">
          <label htmlFor="categoria">Categoría</label>
          <select id="categoria" name="categoria" defaultValue={v("categoria", inicial?.categoria)} aria-invalid={estado?.errores?.categoria ? true : undefined}>
            <option value="">Elige una categoría…</option>
            {categorias.map((c) => <option key={c.clave} value={c.clave}>{c.nombre}</option>)}
          </select>
          {categorias.some((c) => c.dePrueba) ? <span className="sub">Categorías de prueba: la lista real está pendiente.</span> : null}
          <ErrorCampo estado={estado} campo="categoria" />
        </div>
        <div className="campo">
          <label htmlFor="importe">Importe</label>
          <div className="importe"><span aria-hidden="true">$</span>
            <input id="importe" name="importe" inputMode="decimal" defaultValue={v("importe", inicial?.importe)} aria-invalid={estado?.errores?.importe ? true : undefined} />
          </div>
          <ErrorCampo estado={estado} campo="importe" />
        </div>
      </div>
      <div className="campo">
        <label htmlFor="proveedor">Proveedor o a quién se paga (opcional)</label>
        <input id="proveedor" name="proveedor" maxLength={120} defaultValue={v("proveedor", inicial?.proveedor ?? "")} aria-invalid={estado?.errores?.proveedor ? true : undefined} />
        <ErrorCampo estado={estado} campo="proveedor" />
      </div>
      <div className="campo">
        <label htmlFor="nota">Nota (opcional)</label>
        <textarea id="nota" name="nota" maxLength={300} defaultValue={v("nota", inicial?.nota ?? "")} aria-invalid={estado?.errores?.nota ? true : undefined} />
        <ErrorCampo estado={estado} campo="nota" />
      </div>
    </>
  );
}

export function FormularioSolicitud({ codigo, sucursalId, categorias, sucursales, compras }: {
  codigo: string; sucursalId: string; categorias: Categoria[]; sucursales: SucursalOpcion[];
  compras: { id: string; clave: string; concepto: string }[];
}) {
  const [estado, accion, enviando] = useActionState(accionSolicitarGasto, null);
  const [envio] = useState(() => crypto.randomUUID());
  const [parte, setParte] = useState(estado?.valores?.parte === "si");
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-solicitud">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="envio" value={envio} />
      <CamposVersion estado={estado} categorias={categorias} />
      <div className="campo">
        <label htmlFor="paga">Sucursal que paga</label>
        <select id="paga" name="paga" defaultValue={estado?.valores?.paga ?? sucursalId} aria-invalid={estado?.errores?.paga ? true : undefined}>
          {sucursales.map((s) => <option key={s.id} value={s.id}>{s.id === sucursalId ? `${s.nombre} (esta sucursal)` : s.nombre}</option>)}
        </select>
        <span className="sub">El gasto se carga a esta sucursal; el dinero sale de la que paga.</span>
        <ErrorCampo estado={estado} campo="paga" />
      </div>
      <label className="opcion-revision">
        <input type="checkbox" name="parte" value="si" checked={parte} onChange={(e) => setParte(e.target.checked)} />
        <span>Es parte de una compra ya solicitada</span>
      </label>
      {parte ? (
        <div className="campo">
          <label htmlFor="compra">Compra original</label>
          <select id="compra" name="compra" defaultValue={estado?.valores?.compra ?? ""} aria-invalid={estado?.errores?.compra ? true : undefined}>
            <option value="">Elige la solicitud original…</option>
            {compras.map((c) => <option key={c.id} value={c.id}>{c.clave} · {c.concepto}</option>)}
          </select>
          <span className="sub">Una misma compra no se divide: se suma a la original para los límites.</span>
          <ErrorCampo estado={estado} campo="compra" />
        </div>
      ) : null}
      <p className="sub">Solicitar no mueve dinero ni autoriza el gasto.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Enviando…" : "Enviar solicitud"}</button>
    </form>
  );
}

export function FormularioCorreccion({ codigo, clave, version, categorias, actual }: {
  codigo: string; clave: string; version: number; categorias: Categoria[];
  actual: { concepto: string; categoria: string; importe: string; proveedor: string | null; nota: string | null };
}) {
  const [estado, accion, enviando] = useActionState(accionCorregirGasto, null);
  const [abierto, setAbierto] = useState(false);
  if (!abierto && !estado) {
    return <button className="boton" type="button" onClick={() => setAbierto(true)} data-testid="abrir-correccion">Corregir solicitud</button>;
  }
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-correccion">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="version" value={version} />
      <h3>Corregir solicitud</h3>
      <p className="sub">Se guarda como versión {version + 1}; la versión {version} se conserva.</p>
      <CamposVersion estado={estado} categorias={categorias} inicial={actual} />
      <div className="campo">
        <label htmlFor="motivo">Motivo de la corrección (obligatorio)</label>
        <textarea id="motivo" name="motivo" maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} aria-invalid={estado?.errores?.motivo ? true : undefined} />
        <ErrorCampo estado={estado} campo="motivo" />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Guardando…" : "Guardar corrección"}</button>
    </form>
  );
}

/** Autorizar o rechazar la versión vigente, desde la cuenta de quien decide. Rechazar exige motivo. */
export function FormularioDecision({ codigo, clave, version, importe }: { codigo: string; clave: string; version: number; importe: string }) {
  const [estado, accion, enviando] = useActionState(accionDecidirGasto, null);
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-decision">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="version" value={version} />
      <h3>Decidir · versión {version} · {importe}</h3>
      <div className="campo">
        <label htmlFor="motivo-decision">Motivo (obligatorio para rechazar)</label>
        <textarea id="motivo-decision" name="motivo" maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} aria-invalid={estado?.errores?.motivo ? true : undefined} />
        <ErrorCampo estado={estado} campo="motivo" />
      </div>
      <p className="sub">Se registra con tu cuenta, la fecha y la hora. Autorizar no mueve dinero: el pago se registra aparte.</p>
      <p className="fila-acciones">
        <button className="boton boton-principal" type="submit" name="decision" value="autorizado" disabled={enviando}>Autorizar</button>
        <button className="boton" type="submit" name="decision" value="rechazado" disabled={enviando}>Rechazar</button>
      </p>
    </form>
  );
}

/** Comprobante: ticket, nota o factura (folio opcional), o «sin comprobante» con motivo. Las fotos llegan con el almacenamiento. */
function CamposComprobante({ estado, opcional }: { estado: EstadoGasto; opcional: boolean }) {
  const [tipo, setTipo] = useState(estado?.valores?.tipo ?? "");
  return (
    <fieldset className="campo campo-grupo" data-testid="campos-comprobante">
      <legend>Comprobante</legend>
      <select aria-label="Tipo de comprobante" name="tipo" value={tipo} onChange={(e) => setTipo(e.target.value)} aria-invalid={estado?.errores?.tipo ? true : undefined}>
        {opcional ? <option value="">Lo agrego después</option> : <option value="">Elige…</option>}
        <option value="ticket">Ticket</option>
        <option value="nota">Nota</option>
        <option value="factura">Factura</option>
        <option value="sin">Sin comprobante</option>
      </select>
      <ErrorCampo estado={estado} campo="tipo" />
      {tipo && tipo !== "sin" ? (
        <div className="campo">
          <label htmlFor="folio">Folio o número (opcional)</label>
          <input id="folio" name="folio" maxLength={60} defaultValue={estado?.valores?.folio ?? ""} />
          <ErrorCampo estado={estado} campo="folio" />
        </div>
      ) : null}
      {tipo === "sin" ? (
        <div className="campo">
          <label htmlFor="motivoSin">Por qué no hay comprobante (obligatorio)</label>
          <textarea id="motivoSin" name="motivoSin" maxLength={300} defaultValue={estado?.valores?.motivoSin ?? ""} aria-invalid={estado?.errores?.motivoSin ? true : undefined} />
          <span className="sub">Queda «Sin comprobante · por revisar · Dirección».</span>
          <ErrorCampo estado={estado} campo="motivoSin" />
        </div>
      ) : null}
      <span className="sub">Las fotos del comprobante se agregarán cuando se active el almacenamiento.</span>
    </fieldset>
  );
}

/** Registrar el pago de un gasto autorizado, con los orígenes que esta persona puede usar ahora. */
export function FormularioPago({ codigo, clave, version, autorizado, origenes, proveedor, hoy, deAnticipo }: {
  codigo: string; clave: string; version: number; autorizado: string; origenes: OrigenPago[]; proveedor: string | null; hoy: string;
  /** Excedente de un anticipo: ya se pagó al proveedor ese día con dinero de alguien. */
  deAnticipo?: { clave: string; pagadoEl: string } | null;
}) {
  const [estado, accion, enviando] = useActionState(accionRegistrarPago, null);
  const [origen, setOrigen] = useState(estado?.valores?.origen ?? (deAnticipo ? "dinero_personal" : ""));
  const efectivo = origen === "bolsa_visitas" || origen === "cajon_mensualidades";
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-pago">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="version" value={version} />
      <h3>Registrar el pago</h3>
      {deAnticipo ? (
        <p className="aviso aviso-info" data-testid="pago-excedente-anticipo">
          Es el excedente del anticipo de {deAnticipo.clave}: ya se pagó al proveedor el {deAnticipo.pagadoEl.split("-").reverse().join("/")} con dinero de
          quien recibió el anticipo. Lo registra esa persona como dinero personal y queda pendiente de reembolso; lo que salga de caja para devolvérselo es su reembolso.
        </p>
      ) : null}
      <fieldset className="campo campo-grupo" aria-invalid={estado?.errores?.origen ? true : undefined}>
        <legend>¿De dónde salió el dinero?</legend>
        {origenes.map((o) => (
          <label key={o} className="opcion-revision">
            <input type="radio" name="origen" value={o} checked={origen === o} onChange={() => setOrigen(o)} />
            <span>{NOMBRE_ORIGEN[o]}</span>
          </label>
        ))}
        {!deAnticipo && !origenes.some((o) => o === "bolsa_visitas" || o === "cajon_mensualidades")
          ? <span className="sub">En efectivo solo paga la responsable vigente de la bolsa o el cajón, con el turno abierto.</span> : null}
        <ErrorCampo estado={estado} campo="origen" />
      </fieldset>
      <div className="campos-fila">
        <div className="campo">
          <label htmlFor="importe-pago">Importe pagado</label>
          <div className="importe"><span aria-hidden="true">$</span>
            <input id="importe-pago" name="importe" inputMode="decimal" defaultValue={estado?.valores?.importe ?? autorizado} aria-invalid={estado?.errores?.importe ? true : undefined} />
          </div>
          <span className="sub">Lo realmente pagado; hasta {new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(autorizado))} autorizados.</span>
          <ErrorCampo estado={estado} campo="importe" />
        </div>
        {deAnticipo ? <input type="hidden" name="pagadoEl" value={deAnticipo.pagadoEl} /> : origen && !efectivo ? (
          <div className="campo">
            <label htmlFor="pagadoEl">Fecha del pago</label>
            <input id="pagadoEl" name="pagadoEl" type="date" max={hoy} defaultValue={estado?.valores?.pagadoEl ?? hoy} aria-invalid={estado?.errores?.pagadoEl ? true : undefined} />
            <ErrorCampo estado={estado} campo="pagadoEl" />
          </div>
        ) : null}
      </div>
      {origen === "transferencia" || origen === "tarjeta" ? (
        <div className="campos-fila">
          <div className="campo">
            <label htmlFor="cuenta">{origen === "tarjeta" ? "Tarjeta (nombre corto)" : "Cuenta de origen (nombre corto)"}</label>
            <input id="cuenta" name="cuenta" maxLength={40} defaultValue={estado?.valores?.cuenta ?? ""} aria-invalid={estado?.errores?.cuenta ? true : undefined} />
            <span className="sub">Sin números de cuenta ni de tarjeta.</span>
            <ErrorCampo estado={estado} campo="cuenta" />
          </div>
          <div className="campo">
            <label htmlFor="referencia">{origen === "transferencia" ? "Referencia de la operación" : "Referencia del voucher (opcional)"}</label>
            <input id="referencia" name="referencia" maxLength={60} defaultValue={estado?.valores?.referencia ?? ""} aria-invalid={estado?.errores?.referencia ? true : undefined} />
            <ErrorCampo estado={estado} campo="referencia" />
          </div>
        </div>
      ) : null}
      <div className="campo">
        <label htmlFor="aQuien">A quién se pagó (opcional)</label>
        <input id="aQuien" name="aQuien" maxLength={120} defaultValue={estado?.valores?.aQuien ?? proveedor ?? ""} aria-invalid={estado?.errores?.aQuien ? true : undefined} />
        <ErrorCampo estado={estado} campo="aQuien" />
      </div>
      <CamposComprobante estado={estado} opcional />
      <p className="sub">
        {efectivo ? "La salida se registra una sola vez y baja el esperado de la bolsa (en el cajón se registra; su esperado espera a Open Desk)."
          : origen === "dinero_personal" ? "No sale de caja: queda pendiente de reembolso, que revisa Dirección."
          : origen ? "No toca efectivo." : ""}
      </p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar pago"}</button>
    </form>
  );
}

export function FormularioComprobante({ codigo, clave }: { codigo: string; clave: string }) {
  const [estado, accion, enviando] = useActionState(accionRegistrarComprobante, null);
  const [abierto, setAbierto] = useState(false);
  if (!abierto && !estado) return <button className="boton" type="button" onClick={() => setAbierto(true)} data-testid="abrir-comprobante">Agregar comprobante</button>;
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-comprobante">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <CamposComprobante estado={estado} opcional={false} />
      <button className="boton boton-principal" type="submit" disabled={enviando}>Guardar comprobante</button>
    </form>
  );
}

/** Costó más de lo autorizado: pedir autorización por el excedente (una solicitud ligada a la misma compra). */
export function FormularioExcedente({ codigo, clave, autorizado }: { codigo: string; clave: string; autorizado: string }) {
  const [estado, accion, enviando] = useActionState(accionPedirExcedente, null);
  const [envio] = useState(() => crypto.randomUUID());
  const [abierto, setAbierto] = useState(false);
  if (!abierto && !estado) return <button className="boton" type="button" onClick={() => setAbierto(true)} data-testid="abrir-excedente">¿Costó más? Pedir autorización por el excedente</button>;
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-excedente">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="envio" value={envio} />
      <div className="campo">
        <label htmlFor="importeReal">Cuánto cuesta en realidad</label>
        <div className="importe"><span aria-hidden="true">$</span>
          <input id="importeReal" name="importeReal" inputMode="decimal" defaultValue={estado?.valores?.importeReal ?? ""} aria-invalid={estado?.errores?.importeReal ? true : undefined} />
        </div>
        <span className="sub">Se pide autorización solo por lo que pase de {autorizado}, como parte de la misma compra. Lo autorizado se paga aparte.</span>
        <ErrorCampo estado={estado} campo="importeReal" />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>Pedir autorización por el excedente</button>
    </form>
  );
}

const pesosMx = (v: string) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(v));

/** La responsable vigente entrega un anticipo, por lo autorizado, a otra persona de la sucursal que paga. */
export function FormularioEntregarAnticipo({ codigo, clave, version, autorizado, lugares, personas }: {
  codigo: string; clave: string; version: number; autorizado: string; lugares: LugarAnticipo[]; personas: { id: string; nombre: string }[];
}) {
  const [estado, accion, enviando] = useActionState(accionEntregarAnticipo, null);
  const [abierto, setAbierto] = useState(false);
  if (!abierto && !estado) return <button className="boton" type="button" onClick={() => setAbierto(true)} data-testid="abrir-anticipo">Entregar anticipo para la compra</button>;
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-anticipo">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="version" value={version} />
      <h3>Entregar anticipo de {pesosMx(autorizado)}</h3>
      <fieldset className="campo campo-grupo" aria-invalid={estado?.errores?.lugar ? true : undefined}>
        <legend>¿De dónde sale el anticipo?</legend>
        {lugares.map((l) => (
          <label key={l} className="opcion-revision">
            <input type="radio" name="lugar" value={l} defaultChecked={estado?.valores?.lugar === l || lugares.length === 1} />
            <span>{NOMBRE_ORIGEN[l]}</span>
          </label>
        ))}
        <ErrorCampo estado={estado} campo="lugar" />
      </fieldset>
      <div className="campo">
        <label htmlFor="recibe">Quién lo recibe para comprar</label>
        <select id="recibe" name="recibe" defaultValue={estado?.valores?.recibe ?? ""} aria-invalid={estado?.errores?.recibe ? true : undefined}>
          <option value="">Elige a la persona…</option>
          {personas.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
        <span className="sub">Lo confirma desde su cuenta y queda a su cargo hasta comprobarlo.</span>
        <ErrorCampo estado={estado} campo="recibe" />
      </div>
      <p className="sub">Sale de caja al entregarse y baja el esperado una sola vez. El anticipo es por lo autorizado.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Entregar anticipo"}</button>
    </form>
  );
}

export function FormularioConfirmarAnticipo({ codigo, clave, importe }: { codigo: string; clave: string; importe: string }) {
  const [estado, accion, enviando] = useActionState(accionConfirmarAnticipo, null);
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-confirmar-anticipo">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <p>Cuenta el dinero antes de confirmar. Al confirmar, los {pesosMx(importe)} quedan a tu cargo hasta comprobar la compra.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>Confirmo que recibí {pesosMx(importe)}</button>
    </form>
  );
}

/** Quien recibió el anticipo comprueba la compra: lo pagado al proveedor, cuándo, a quién y su comprobante. */
export function FormularioComprobarAnticipo({ codigo, clave, entregado, proveedor, desde, hoy }: {
  codigo: string; clave: string; entregado: string; proveedor: string | null; desde: string; hoy: string;
}) {
  const [estado, accion, enviando] = useActionState(accionComprobarAnticipo, null);
  const [envio] = useState(() => crypto.randomUUID());
  const [gastado, setGastado] = useState(estado?.valores?.gastado ?? "");
  const g = Number(gastado.replace(/,/g, ""));
  const diferencia = Number.isFinite(g) && g > 0 ? Math.round((g - Number(entregado)) * 100) / 100 : null;
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-comprobar-anticipo">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="envio" value={envio} />
      <h3>Comprobar el anticipo</h3>
      <div className="campos-fila">
        <div className="campo">
          <label htmlFor="gastado">Cuánto se pagó al proveedor</label>
          <div className="importe"><span aria-hidden="true">$</span>
            <input id="gastado" name="gastado" inputMode="decimal" value={gastado} onChange={(e) => setGastado(e.target.value)} aria-invalid={estado?.errores?.gastado ? true : undefined} />
          </div>
          <span className="sub" data-testid="diferencia-anticipo">
            {diferencia === null ? `Recibiste ${pesosMx(entregado)}.`
              : diferencia < 0 ? `Sobran ${pesosMx(String(-diferencia))}: los devuelves a la responsable de caja, que los cuenta y los recibe.`
              : diferencia > 0 ? `Faltan ${pesosMx(String(diferencia))}: se pide autorización por el excedente, como parte de la misma compra.`
              : "Justo lo entregado: no hay cambio."}
          </span>
          <ErrorCampo estado={estado} campo="gastado" />
        </div>
        <div className="campo">
          <label htmlFor="pagadoEl-anticipo">Fecha del pago al proveedor</label>
          <input id="pagadoEl-anticipo" name="pagadoEl" type="date" min={desde} max={hoy} defaultValue={estado?.valores?.pagadoEl ?? hoy} aria-invalid={estado?.errores?.pagadoEl ? true : undefined} />
          <span className="sub">Es la fecha del gasto.</span>
          <ErrorCampo estado={estado} campo="pagadoEl" />
        </div>
      </div>
      <div className="campo">
        <label htmlFor="aQuien-anticipo">A quién se pagó (opcional)</label>
        <input id="aQuien-anticipo" name="aQuien" maxLength={120} defaultValue={estado?.valores?.aQuien ?? proveedor ?? ""} aria-invalid={estado?.errores?.aQuien ? true : undefined} />
        <ErrorCampo estado={estado} campo="aQuien" />
      </div>
      <CamposComprobante estado={estado} opcional={false} />
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Comprobar anticipo"}</button>
    </form>
  );
}

/** La responsable vigente del lugar cuenta y recibe el cambio; puede ser una parte de lo que falta. */
export function FormularioCambioAnticipo({ codigo, clave, pendiente, recibe }: { codigo: string; clave: string; pendiente: string; recibe: string }) {
  const [estado, accion, enviando] = useActionState(accionRecibirCambioAnticipo, null);
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-cambio-anticipo">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <h3>Recibir el cambio de {recibe}</h3>
      <div className="campo">
        <label htmlFor="importe-cambio">Cuánto contaste</label>
        <div className="importe"><span aria-hidden="true">$</span>
          <input id="importe-cambio" name="importe" inputMode="decimal" defaultValue={estado?.valores?.importe ?? ""} aria-invalid={estado?.errores?.importe ? true : undefined} />
        </div>
        <span className="sub">Faltan {pesosMx(pendiente)}. Si te devuelve una parte, registra lo que contaste: el anticipo sigue abierto por el resto. Entra a caja y sube el esperado una sola vez.</span>
        <ErrorCampo estado={estado} campo="importe" />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>Recibir cambio</button>
    </form>
  );
}

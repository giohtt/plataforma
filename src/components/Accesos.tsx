"use client";

import { useActionState, useState } from "react";
import {
  accionCompletarMotivo, accionPedirAutorizacion, accionRegistrarAcceso, accionResolverAutorizacion, accionSinPase,
} from "@/app/acciones-accesos";
import type { AccesosCobro, AutorizacionPendiente, AutorizacionResumen, PaseConAcceso } from "@/lib/accesos";

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", timeStyle: "short" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const nuevaClave = () => crypto.randomUUID();

/** Estado de una autorización como lo ve Recepción: pendiente, aprobada o rechazada, con quién y por qué. */
export function EstadoAutorizacion({ a }: { a: AutorizacionResumen }) {
  if (a.estado === "solicitada") {
    return (
      <span className="estado-acceso estado-pendiente" data-testid="autorizacion-estado">
        Autorización pendiente · pidió {a.solicitadaPor} a las {hora.format(new Date(a.solicitadaEn))}
      </span>
    );
  }
  return (
    <span className={`estado-acceso ${a.estado === "aprobada" ? "estado-bien" : "estado-mal"}`} data-testid="autorizacion-estado">
      {a.estado === "aprobada" ? "Autorizado" : "No autorizado"} por {a.resueltaPor} a las {hora.format(new Date(a.resueltaEn!))} · «{a.motivo}»
    </span>
  );
}

function PaseAcceso({ codigo, operacionId, p, puedeRegistrar }: { codigo: string; operacionId: string; p: PaseConAcceso; puedeRegistrar: boolean }) {
  const [estado, accion, enviando] = useActionState(accionRegistrarAcceso, null);
  const [pedido, pedir, pidiendo] = useActionState(accionPedirAutorizacion, null);
  const [clave] = useState(nuevaClave);
  const volver = `/sucursales/${codigo}/turno/cobros/${operacionId}#entradas`;
  const entrada = p.accesos.find((a) => a.tipo === "entrada");
  const reingresos = p.accesos.filter((a) => a.tipo === "reingreso");
  return (
    <li className="tarjeta-visitante" data-testid="pase-acceso">
      <div className="tarjeta-visitante-datos">
        <strong>{p.orden}. {p.nombre}</strong>
        {entrada ? (
          <span className="estado-acceso estado-bien" data-testid="entrada">
            Entró a las {hora.format(new Date(entrada.en))} · registró {entrada.por}
            {entrada.autorizadaPor ? ` · autorizó ${entrada.autorizadaPor}` : ""}
          </span>
        ) : p.accion === "no_vigente" ? (
          <span className="estado-acceso estado-mal" data-testid="no-vigente">Pase no vigente: cobro cancelado o transferencia no localizada</span>
        ) : p.accion === "otro_dia" ? (
          <span className="estado-acceso estado-mal" data-testid="otro-dia">El pase solo valía el día del cobro</span>
        ) : (
          <span className="sub" data-testid="sin-entrada">Todavía no entra</span>
        )}
        {reingresos.map((r, i) => (
          <span key={i} className="sub" data-testid="reingreso">Reingreso a las {hora.format(new Date(r.en))} · registró {r.por}</span>
        ))}
        {p.autorizacion && !entrada ? <EstadoAutorizacion a={p.autorizacion} /> : null}
        {estado?.error ? <span className="aviso aviso-error" role="alert">{estado.error}</span> : null}
        {pedido?.error ? <span className="aviso aviso-error" role="alert">{pedido.error}</span> : null}
      </div>
      {puedeRegistrar && (p.accion === "entrada" || p.accion === "reingreso") ? (
        <form action={accion}>
          <input type="hidden" name="codigo" value={codigo} />
          <input type="hidden" name="paseId" value={p.paseId} />
          <input type="hidden" name="clave" value={clave} />
          <input type="hidden" name="tipo" value={p.accion} />
          <input type="hidden" name="volver" value={volver} />
          <button className="boton boton-principal" type="submit" disabled={enviando}>
            {p.accion === "entrada" ? "Registrar entrada" : "Registrar reingreso"}
          </button>
        </form>
      ) : null}
      {puedeRegistrar && p.accion === "pedir_autorizacion" ? (
        <form action={pedir} className="formulario formulario-compacto">
          <input type="hidden" name="codigo" value={codigo} />
          <input type="hidden" name="paseId" value={p.paseId} />
          <input type="hidden" name="tipo" value="transferencia_pendiente" />
          <input type="hidden" name="volver" value={volver} />
          <div className="campo">
            <label htmlFor={`nota-${p.paseId}`}>Qué muestra el visitante</label>
            <textarea id={`nota-${p.paseId}`} name="nota" required minLength={5} maxLength={300}
              placeholder="Por ejemplo: muestra el comprobante con la misma clave e importe" />
          </div>
          <button className="boton boton-principal" type="submit" disabled={pidiendo}>Pedir autorización</button>
        </form>
      ) : null}
      {p.accion === "esperando_autorizacion" ? <span className="sub" data-testid="esperando">Esperando respuesta de Encargado</span> : null}
    </li>
  );
}

/** Entrada de cada persona del cobro: un botón por persona, también en cobros grupales. */
export function EntradasDelCobro({ codigo, operacionId, datos }: { codigo: string; operacionId: string; datos: AccesosCobro }) {
  const pendiente = datos.estadoCobro === "pendiente_abono";
  return (
    <section className="tarjeta" id="entradas" aria-labelledby="t-entradas" data-testid="entradas">
      <h2 id="t-entradas" className="titulo-seccion">Entrada de cada persona</h2>
      <p className="sub">
        Registra la apertura manual de cada persona. No cambia el cobro: el cobro y la apertura se consultan por separado.
        El pase vale hoy y solo en esta sucursal; si vuelve hoy, registra un reingreso con el mismo pase, sin cobrar.
      </p>
      {pendiente ? (
        <p className="aviso aviso-info" data-testid="aviso-transferencia">
          El abono de esta transferencia sigue pendiente: para entrar necesita la autorización de Encargado. El cobro sigue pendiente hasta verificar el abono.
        </p>
      ) : null}
      {!datos.turnoAbierto ? <p className="aviso aviso-info">No hay turno abierto: las aperturas se registran durante el turno.</p> : null}
      <ul className="lista-visitantes">
        {datos.pases.map((p) => <PaseAcceso key={p.paseId} codigo={codigo} operacionId={operacionId} p={p} puedeRegistrar={datos.puedeRegistrar} />)}
      </ul>
    </section>
  );
}

const MOTIVOS_DIRECTOS = [
  ["socio_open_desk", "Socio con problema en Open Desk"],
  ["proveedor_mantenimiento", "Proveedor o mantenimiento"],
  ["otro", "Otro (escribe cuál)"],
] as const;

/** Apertura sin pase con un motivo que no requiere autorización. */
export function FormularioSinPase({ codigo }: { codigo: string }) {
  const [estado, accion, enviando] = useActionState(accionSinPase, null);
  const [clave] = useState(nuevaClave);
  return (
    <form action={accion} className="formulario" data-testid="form-sin-pase">
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="volver" value={`/sucursales/${codigo}/turno/accesos`} />
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <div className="campo">
        <label htmlFor="motivo-sin-pase">Motivo</label>
        <select id="motivo-sin-pase" name="motivo" defaultValue="socio_open_desk">
          {MOTIVOS_DIRECTOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
      </div>
      <div className="campo">
        <label htmlFor="detalle-sin-pase">Detalle (obligatorio si es «Otro»)</label>
        <textarea id="detalle-sin-pase" name="detalle" maxLength={300} />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>Registrar apertura sin pase</button>
    </form>
  );
}

/** Visita que normalmente se cobra: pedir autorización. */
export function PedirVisitaSinCobro({ codigo }: { codigo: string }) {
  const [estado, accion, enviando] = useActionState(accionPedirAutorizacion, null);
  return (
    <form action={accion} className="formulario" data-testid="form-visita-sin-cobro">
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="tipo" value="visita_sin_cobro" />
      <input type="hidden" name="volver" value={`/sucursales/${codigo}/turno/accesos`} />
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <div className="campo">
        <label htmlFor="nota-visita">Quién es y por qué no se cobra</label>
        <textarea id="nota-visita" name="nota" required minLength={5} maxLength={300} />
      </div>
      <button className="boton" type="submit" disabled={enviando}>Pedir autorización</button>
    </form>
  );
}

/** Usar una autorización aprobada de «visita que normalmente se cobra» (una sola vez). */
export function UsarAutorizacion({ codigo, a }: { codigo: string; a: AutorizacionPendiente }) {
  const [estado, accion, enviando] = useActionState(accionSinPase, null);
  const [clave] = useState(nuevaClave);
  return (
    <form action={accion}>
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="motivo" value="visita_cobrable" />
      <input type="hidden" name="detalle" value={a.nota} />
      <input type="hidden" name="autorizacionId" value={a.id} />
      <input type="hidden" name="volver" value={`/sucursales/${codigo}/turno/accesos`} />
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <button className="boton boton-principal" type="submit" disabled={enviando}>Registrar apertura autorizada</button>
    </form>
  );
}

/** Emergencia: se registra la apertura primero; el motivo se completa después. */
export function BotonEmergencia({ codigo }: { codigo: string }) {
  const [estado, accion, enviando] = useActionState(accionSinPase, null);
  const [clave] = useState(nuevaClave);
  return (
    <form action={accion} data-testid="form-emergencia">
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="motivo" value="emergencia" />
      <input type="hidden" name="detalle" value="" />
      <input type="hidden" name="volver" value={`/sucursales/${codigo}/turno/accesos`} />
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <button className="boton boton-peligro" type="submit" disabled={enviando}>Registrar apertura de emergencia</button>
    </form>
  );
}

export function CompletarMotivo({ codigo, accesoId, volver }: { codigo: string; accesoId: string; volver: string }) {
  const [estado, accion, enviando] = useActionState(accionCompletarMotivo, null);
  return (
    <form action={accion} className="formulario formulario-compacto" data-testid="form-completar-motivo">
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="id" value={accesoId} />
      <input type="hidden" name="volver" value={volver} />
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <div className="campo">
        <label htmlFor={`detalle-${accesoId}`}>Motivo de la emergencia</label>
        <textarea id={`detalle-${accesoId}`} name="detalle" required minLength={5} maxLength={300} />
      </div>
      <button className="boton" type="submit" disabled={enviando}>Guardar motivo</button>
    </form>
  );
}

/** Encargado (o quien tenga el permiso): aprobar o rechazar desde su sesión, siempre con motivo. */
export function ResolverAutorizacion({ codigo, a }: { codigo: string; a: AutorizacionPendiente }) {
  const [estado, accion, enviando] = useActionState(accionResolverAutorizacion, null);
  return (
    <li className="tarjeta-visitante" data-testid="por-autorizar">
      <div className="tarjeta-visitante-datos">
        <strong>{a.tipo === "transferencia_pendiente" ? `${a.persona} · transferencia pendiente` : "Visita que normalmente se cobra"}</strong>
        {a.tipo === "transferencia_pendiente" ? (
          <span className="sub">
            {pesos.format(Number(a.importe))} por transferencia · referencia {a.referencia} · abono pendiente de verificar
          </span>
        ) : null}
        <span className="sub">Pidió {a.solicitadaPor} el {fechaHora.format(new Date(a.solicitadaEn))}</span>
        <span>«{a.nota}»</span>
        {a.impedimento ? (
          <span className="aviso aviso-info" data-testid="impedimento">
            {a.impedimento === "propia" ? "Tú la pediste: debe resolverla otra persona." : "Tú registraste el cobro: debe resolverla otra persona."}
          </span>
        ) : null}
        {estado?.error ? <span className="aviso aviso-error" role="alert">{estado.error}</span> : null}
      </div>
      {!a.impedimento ? (
        <form action={accion} className="formulario formulario-compacto">
          <input type="hidden" name="codigo" value={codigo} />
          <input type="hidden" name="id" value={a.id} />
          <input type="hidden" name="version" value={a.version} />
          <div className="campo">
            <label htmlFor={`motivo-${a.id}`}>Por qué lo autorizas o no (obligatorio)</label>
            <textarea id={`motivo-${a.id}`} name="motivo" required minLength={5} maxLength={300} />
          </div>
          <p className="fila-acciones">
            <button className="boton boton-principal" type="submit" name="decision" value="aprobar" disabled={enviando}>Autorizar acceso</button>
            <button className="boton" type="submit" name="decision" value="rechazar" disabled={enviando}>No autorizar</button>
          </p>
        </form>
      ) : null}
    </li>
  );
}

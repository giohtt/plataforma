import Link from "next/link";
import { notFound } from "next/navigation";
import {
  FormularioCambioAnticipo, FormularioComprobante, FormularioComprobarAnticipo, FormularioConfirmarAnticipo, FormularioConfirmarReembolso, FormularioCorreccion,
  FormularioDecision, FormularioDecisionReembolso, FormularioEntregarAnticipo, FormularioExcedente, FormularioPago, FormularioPagoReembolso,
  FormularioPresentarReembolso,
} from "@/components/Gastos";
import { obtenerBaseDatos } from "@/lib/db";
import { detalleGasto, NOMBRE_AUTORIZACION_PREVIA, NOMBRE_COMPROBACION, NOMBRE_ESTADO_GASTO, NOMBRE_ORIGEN, NOMBRE_REEMBOLSO, TEXTO_IMPEDIMENTO } from "@/lib/gastos";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Solicitud de gasto · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const AVISO: Record<string, string> = {
  solicitado: "Solicitud registrada. No mueve dinero ni autoriza el gasto.",
  ya_pagado: "Gasto ya pagado registrado. No es aprobarlo ni autorizar un reembolso: lo revisa Dirección.",
  corregido: "Corrección guardada como versión nueva. La anterior se conserva; si estaba decidida, se decide de nuevo.",
  autorizado: "Gasto autorizado desde tu cuenta. Autorizar no mueve dinero.",
  rechazado: "Gasto rechazado con tu motivo. Quien lo solicitó puede corregirlo y enviarlo de nuevo.",
  pagado: "Pago registrado. Si fue en efectivo, la salida quedó registrada una sola vez en el turno.",
  comprobante: "Comprobante registrado.",
  excedente: "Se pidió autorización por el excedente, como parte de la misma compra. Lo autorizado se paga aparte.",
  anticipo: "Anticipo entregado. Salió de caja una sola vez; falta que quien lo recibió lo confirme desde su cuenta.",
  anticipo_recibido: "Recibiste el anticipo: queda a tu cargo hasta comprobar la compra.",
  anticipo_comprobado: "Anticipo comprobado: se pagó justo lo entregado.",
  anticipo_cambio: "Anticipo comprobado. Devuelve el cambio a la responsable de caja: ella lo cuenta y lo recibe.",
  anticipo_excedente: "Anticipo comprobado. Se pidió autorización por el excedente, como parte de la misma compra.",
  cambio_recibido: "Cambio recibido completo: entró a caja una sola vez y el anticipo quedó cerrado.",
  reembolso_autorizado: "Reembolso autorizado desde tu cuenta. Autorizar no mueve dinero: el pago se registra aparte.",
  reembolso_rechazado: "Reembolso rechazado con tu motivo. Quien puso el dinero puede presentarlo de nuevo con información corregida.",
  reembolso_presentado: "Reembolso presentado de nuevo. El rechazo anterior se conserva; lo decide Dirección.",
  reembolso_pagado: "Reembolso pagado una sola vez. Falta que lo confirme quien lo recibe, desde su cuenta.",
  reembolso_recibido: "Confirmaste que recibiste el reembolso: queda liquidado.",
  cambio_parcial: "Devolución parcial recibida: entró a caja una sola vez. El anticipo sigue abierto por lo que falta.",
};
const TIPO_COMPROBANTE = { ticket: "Ticket", nota: "Nota", factura: "Factura" } as const;
const hoyDe = (f: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(f);
const hoyMx = () => hoyDe(new Date());
const CLASE_ESTADO = { por_autorizar: "chip-programada", autorizado: "chip-vigente", rechazado: "chip-revocada", sin_autorizacion_previa: "chip-programada" } as const;

/** Detalle de una solicitud con todas sus versiones. Sin permiso, «No encontrada». */
export default async function Gasto({ params, searchParams }: PageProps<"/sucursales/[codigo]/gastos/[clave]">) {
  const sesion = await requerirSesion();
  const { codigo, clave } = await params;
  const d = await detalleGasto(obtenerBaseDatos()!, sesion.usuarioId, codigo, decodeURIComponent(clave));
  if (!d) notFound();
  const { aviso } = await searchParams;
  const texto = typeof aviso === "string" ? AVISO[aviso] : undefined;
  const g = d.gasto;
  const ultima = d.versiones[d.versiones.length - 1];
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/gastos`}>← Gastos</Link></p>
      <h1 className="cabecera-titulo"><span className="clave-caso" data-testid="clave-gasto">{g.clave}</span> · {g.concepto}</h1>
      {texto ? <p className="aviso aviso-ok" role="status">{texto}</p> : null}
      <section className="tarjeta" data-testid="datos-gasto">
        <p className="estado-gasto" data-testid="estado-gasto">
          <span className={`chip-estado ${CLASE_ESTADO[g.estado]}`}>{NOMBRE_ESTADO_GASTO[g.estado]}</span>
          {g.decididoPor ? ` por ${g.decididoPor}` : ""}{ultima.version > 1 ? ` · versión ${ultima.version}` : ""}
          {g.origenPago && g.estado !== "sin_autorizacion_previa" ? <> · <span className="chip-estado chip-vigente" data-testid="pagado">Pagado</span></> : null}
          {g.autorizacionPrevia && g.autorizacionPrevia !== "comprobada" && g.estado !== "sin_autorizacion_previa" ? (
            <> · <span className="chip-estado chip-programada" data-testid="autorizacion-previa">{NOMBRE_AUTORIZACION_PREVIA[g.autorizacionPrevia]}</span></>
          ) : null}
          {d.anticipo && !d.anticipo.comprobado ? <> · <span className="chip-estado chip-programada" data-testid="anticipo-por-comprobar">Fuera de caja: anticipo por comprobar</span></> : null}
          {d.anticipo && Number(d.anticipo.pendiente) > 0 ? <> · <span className="chip-estado chip-programada" data-testid="cambio-pendiente">Fuera de caja: cambio por devolver {pesos.format(Number(d.anticipo.pendiente))}</span></> : null}
        </p>
        {d.yaPagado ? (
          <p className="aviso aviso-info" data-testid="ya-pagado">
            Se registró después de pagarse ({d.yaPagado.registradoPor} · {fechaHora.format(d.yaPagado.en)}): «{d.yaPagado.motivo}». No se autoriza en la ruta normal;
            lo revisa Dirección (qué decide al revisarlo está por definir).
          </p>
        ) : null}
        {g.motivoDecision ? <p className="sub" data-testid="motivo-decision">Motivo: «{g.motivoDecision}»</p> : null}
        <dl className="datos-expediente">
          <dt>Importe</dt><dd data-testid="importe-gasto">{pesos.format(Number(g.importe))}</dd>
          <dt>Categoría</dt><dd>{g.categoria}</dd>
          <dt>Proveedor</dt><dd>{g.proveedor ?? <span className="sub">Sin indicar</span>}</dd>
          <dt>Sucursal beneficiada</dt><dd>{g.beneficiada}</dd>
          <dt>Sucursal que paga</dt><dd data-testid="paga-gasto">{g.paga}{g.pagaOtra ? " (otra sucursal)" : ""}</dd>
          {g.compraDe ? <><dt>Parte de la compra</dt><dd data-testid="compra-de"><Link href={`/sucursales/${codigo}/gastos/${g.compraDe}`}>{g.compraDe}</Link></dd></> : null}
          {g.partes.length ? (
            <><dt>Partes de esta compra</dt><dd data-testid="partes">{g.partes.map((x) => `${x.clave} (${pesos.format(Number(x.importe))})`).join(", ")}</dd></>
          ) : null}
          {g.partes.length || g.compraDe ? <><dt>Total de la compra</dt><dd data-testid="total-compra">{pesos.format(Number(g.totalCompra))} · se compara con el límite por gasto</dd></> : null}
          {(g.partes.length || g.compraDe) && d.pagosCompra.length ? (
            <><dt>Pagado de la compra</dt>
              <dd data-testid="pagado-compra">{pesos.format(Number(d.totalPagadoCompra))}
                <span className="sub"> · {d.pagosCompra.map((p) => `${p.clave}: ${pesos.format(Number(p.importe))} (${NOMBRE_ORIGEN[p.origen]})`).join(" + ")}</span></dd></>
          ) : null}
          <dt>{d.yaPagado ? "Registró" : "Solicitó"}</dt><dd>{g.solicitadoPor} · {fechaHora.format(g.solicitadoEn)}</dd>
          {g.nota ? <><dt>Nota</dt><dd>{g.nota}</dd></> : null}
        </dl>
        {d.yaPagado ? null : <p className="sub">Solicitar no mueve dinero ni autoriza el gasto.</p>}
        {g.estado === "por_autorizar" ? (
          <div className="aviso aviso-info" data-testid="quien-decide">
            {d.puedenDecidir.length
              ? <>Pueden decidirlo ahora: <strong>{d.puedenDecidir.join(", ")}</strong>. La primera persona que decide lo resuelve.</>
              : <>Nadie tiene todavía facultad suficiente para decidirlo: queda por autorizar.</>}
          </div>
        ) : null}
        {g.estado === "por_autorizar" && g.impedimento === null ? (
          <FormularioDecision codigo={codigo} clave={g.clave} version={ultima.version} importe={pesos.format(Number(g.importe))} />
        ) : g.estado === "por_autorizar" && g.impedimento && g.impedimento !== "sin_facultad" ? (
          <p className="sub" data-testid="impedimento">{TEXTO_IMPEDIMENTO[g.impedimento]}</p>
        ) : null}
        {d.puedePagar.length && d.autorizado ? (
          <FormularioPago codigo={codigo} clave={g.clave} version={ultima.version} autorizado={d.autorizado} origenes={d.puedePagar}
            proveedor={g.proveedor} hoy={hoyMx()} deAnticipo={d.excedenteDeAnticipo} />
        ) : null}
        {d.entregarAnticipo && d.autorizado ? (
          <FormularioEntregarAnticipo codigo={codigo} clave={g.clave} version={ultima.version} autorizado={d.autorizado}
            lugares={d.entregarAnticipo.lugares} personas={d.entregarAnticipo.personas} />
        ) : null}
        {d.puedePedirExcedente && d.autorizado ? <FormularioExcedente codigo={codigo} clave={g.clave} autorizado={pesos.format(Number(d.autorizado))} /> : null}
        {d.puedeCorregir ? (
          <FormularioCorreccion codigo={codigo} clave={g.clave} version={ultima.version} categorias={d.categorias}
            actual={{ concepto: ultima.concepto, categoria: g.categoriaClave, importe: ultima.importe, proveedor: ultima.proveedor, nota: ultima.nota }} />
        ) : null}
      </section>
      {d.anticipo ? (
        <section className="tarjeta" aria-labelledby="t-anticipo" data-testid="anticipo-gasto">
          <h2 id="t-anticipo" className="titulo-seccion">Anticipo</h2>
          <dl className="datos-expediente">
            <dt>Entregado</dt><dd data-testid="anticipo-entregado">{pesos.format(Number(d.anticipo.importe))} · {NOMBRE_ORIGEN[d.anticipo.lugar]}</dd>
            <dt>Entregó</dt><dd>{d.anticipo.entregadoPor} · {fechaHora.format(d.anticipo.en)}</dd>
            <dt>A cargo de</dt><dd data-testid="anticipo-recibe">{d.anticipo.recibe}{d.anticipo.recibidoEn ? ` · confirmó ${fechaHora.format(d.anticipo.recibidoEn)}` : " · falta que confirme que lo recibió"}</dd>
            {d.anticipo.comprobado ? (
              <>
                <dt>Pagado al proveedor</dt><dd data-testid="anticipo-gastado">{pesos.format(Number(d.anticipo.comprobado.gastado))}</dd>
                {Number(d.anticipo.comprobado.cambio) > 0 ? (
                  <><dt>Cambio</dt><dd data-testid="anticipo-cambio">{pesos.format(Number(d.anticipo.comprobado.cambio))}
                    {Number(d.anticipo.devuelto) === 0 ? " · por devolver a caja"
                      : Number(d.anticipo.pendiente) > 0
                      ? ` · devuelto ${pesos.format(Number(d.anticipo.devuelto))} · falta ${pesos.format(Number(d.anticipo.pendiente))}`
                      : " · devuelto completo"}</dd>
                    {d.anticipo.cambios.length ? (
                      <><dt>Devoluciones</dt><dd><ul className="lista-simple" data-testid="devoluciones-cambio">
                        {d.anticipo.cambios.map((c, i) => <li key={i}>{pesos.format(Number(c.importe))} · recibió {c.recibidoPor} · {fechaHora.format(c.en)}</li>)}
                      </ul></dd></>
                    ) : null}</>
                ) : null}
                {Number(d.anticipo.comprobado.excedente) > 0 ? (
                  <><dt>Excedente</dt><dd data-testid="anticipo-excedente">{pesos.format(Number(d.anticipo.comprobado.excedente))}
                    {d.anticipo.comprobado.excedenteClave ? <> · <Link href={`/sucursales/${codigo}/gastos/${d.anticipo.comprobado.excedenteClave}`}>{d.anticipo.comprobado.excedenteClave}</Link> (se autoriza y se paga aparte)</> : null}</dd></>
                ) : null}
              </>
            ) : null}
          </dl>
          {d.puedeConfirmarAnticipo ? <FormularioConfirmarAnticipo codigo={codigo} clave={g.clave} importe={d.anticipo.importe} /> : null}
          {d.puedeComprobarAnticipo ? (
            <FormularioComprobarAnticipo codigo={codigo} clave={g.clave} entregado={d.anticipo.importe} proveedor={g.proveedor} desde={hoyDe(d.anticipo.en)} hoy={hoyMx()} />
          ) : null}
          {d.puedeRecibirCambio && d.anticipo.comprobado ? (
            <FormularioCambioAnticipo codigo={codigo} clave={g.clave} pendiente={d.anticipo.pendiente} recibe={d.anticipo.recibe} />
          ) : null}
          <p className="sub">Lo pagado con el anticipo se cuenta una sola vez: la entrega sale de caja, el cambio vuelve, y el excedente se paga con su propia solicitud.</p>
        </section>
      ) : null}
      {d.pago ? (
        <section className="tarjeta" aria-labelledby="t-pago" data-testid="pago-gasto">
          <h2 id="t-pago" className="titulo-seccion">Pago</h2>
          <dl className="datos-expediente">
            <dt>De dónde salió</dt><dd data-testid="origen-pago">{NOMBRE_ORIGEN[d.pago.origen]}{d.pago.cuenta ? ` · ${d.pago.cuenta}` : ""}</dd>
            <dt>Importe pagado</dt><dd data-testid="importe-pagado">{pesos.format(Number(d.pago.importe))}</dd>
            <dt>Fecha del pago</dt><dd>{d.pago.pagadoEl.split("-").reverse().join("/")}</dd>
            {d.pago.posterior && d.pago.salidaResponsable ? (
              <><dt>Turno</dt><dd data-testid="turno-abierto">Salió del turno abierto (responsable del lugar: {d.pago.salidaResponsable}): una sola salida, que bajó el esperado una vez</dd></>
            ) : null}
            {d.pago.turnoCerrado ? (
              <><dt>Turno</dt><dd data-testid="turno-cerrado">Pago de un turno cerrado ({fechaHora.format(d.pago.turnoCerrado.abierto)} – {fechaHora.format(d.pago.turnoCerrado.cerrado)}): se conservan sus registros y no se descuenta del turno actual</dd></>
            ) : null}
            <dt>Pagó</dt><dd>{d.pago.pagadoPor}{d.pago.registradoPor !== d.pago.pagadoPor ? ` · registró ${d.pago.registradoPor}` : ""} · {fechaHora.format(d.pago.en)}</dd>
            {d.pago.aQuien ? <><dt>A quién se pagó</dt><dd>{d.pago.aQuien}</dd></> : null}
            {d.pago.referencia ? <><dt>Referencia</dt><dd>{d.pago.referencia}</dd></> : null}
            <dt>Comprobación</dt><dd data-testid="comprobacion">{g.comprobacion ? NOMBRE_COMPROBACION[g.comprobacion] : "—"}</dd>
          </dl>
          {d.pago.origen === "dinero_personal" && (d.reembolsoDetalle?.estado === "por_decidir" || d.reembolsoDetalle?.estado === "presentado_de_nuevo") ? <p className="aviso aviso-info" data-testid="reembolso-pendiente">Pagado con dinero personal: pendiente de reembolso. Registrar el pago no autoriza el reembolso; lo revisa Dirección.</p> : null}
          {d.comprobantes.length ? (
            <ul className="lista-simple" data-testid="comprobantes">
              {d.comprobantes.map((c, i) => <li key={i}>{TIPO_COMPROBANTE[c.tipo]}{c.folio ? ` · folio ${c.folio}` : ""} · {c.registradoPor} · {fechaHora.format(c.en)}</li>)}
            </ul>
          ) : null}
          {d.sinComprobante ? <p className="sub" data-testid="sin-comprobante">Sin comprobante: «{d.sinComprobante.motivo}» · {d.sinComprobante.registradoPor} · {fechaHora.format(d.sinComprobante.en)}</p> : null}
          <p className="sub">Las fotos de los comprobantes se agregarán cuando se active el almacenamiento.</p>
          {d.puedeComprobar ? <FormularioComprobante codigo={codigo} clave={g.clave} /> : null}
        </section>
      ) : null}
      {d.reembolsoDetalle ? (
        <section className="tarjeta" aria-labelledby="t-reembolso" data-testid="reembolso-gasto">
          <h2 id="t-reembolso" className="titulo-seccion">Reembolso</h2>
          <p data-testid="estado-reembolso"><span className={`chip-estado ${d.reembolsoDetalle.estado === "recibido" ? "chip-vigente" : d.reembolsoDetalle.estado === "rechazado" ? "chip-revocada" : "chip-programada"}`}>
            {NOMBRE_REEMBOLSO[d.reembolsoDetalle.estado]}</span></p>
          <dl className="datos-expediente">
            <dt>Para</dt><dd>{d.reembolsoDetalle.beneficiario} · pagó {pesos.format(Number(d.reembolsoDetalle.importe))} con su dinero</dd>
            {d.reembolsoDetalle.rondas.length ? (
              <><dt>Decisiones</dt><dd><ul className="lista-simple" data-testid="rondas-reembolso">
                {d.reembolsoDetalle.rondas.map((x, i) => (
                  <li key={i} data-testid={x.tipo === "decision" ? "decision-reembolso" : "reenvio-reembolso"}>
                    {x.tipo === "decision"
                      ? <>{x.decision === "autorizado" ? "Autorizado" : "Rechazado"} por {x.por}{x.sinComprobante ? " · sin comprobante" : ""}</>
                      : <>Presentado de nuevo por {x.por}</>}
                    {" · "}{fechaHora.format(x.en)}{x.motivo ? <><br /><span className="sub">{x.tipo === "decision" ? "Motivo" : "Nota"}: «{x.motivo}»</span></> : null}
                  </li>
                ))}
              </ul></dd></>
            ) : null}
            {d.reembolsoDetalle.pago ? (
              <><dt>Pagado</dt><dd data-testid="pago-reembolso">{pesos.format(Number(d.reembolsoDetalle.pago.importe))} · {NOMBRE_ORIGEN[d.reembolsoDetalle.pago.origen]}{d.reembolsoDetalle.pago.cuenta ? ` · ${d.reembolsoDetalle.pago.cuenta}` : ""} · {d.reembolsoDetalle.pago.pagadoPor} · {fechaHora.format(d.reembolsoDetalle.pago.en)}</dd></>
            ) : null}
            {d.reembolsoDetalle.recibidoEn ? <><dt>Recibido</dt><dd>Confirmó {d.reembolsoDetalle.beneficiario} · {fechaHora.format(d.reembolsoDetalle.recibidoEn)}</dd></> : null}
          </dl>
          {d.puedeDecidirReembolso ? (
            <>
              <div className="aviso aviso-info" data-testid="revision-reembolso">
                <strong>Para decidir</strong>
                <dl className="datos-expediente">
                  <dt>Gasto original</dt>
                  <dd>{d.reembolsoDetalle.revision.clave} · {d.reembolsoDetalle.revision.concepto}
                    {d.reembolsoDetalle.revision.compraDe ? <> · parte de la compra <Link href={`/sucursales/${codigo}/gastos/${d.reembolsoDetalle.revision.compraDe}`}>{d.reembolsoDetalle.revision.compraDe}</Link></> : null}
                    {d.reembolsoDetalle.revision.deAnticipo ? ` · excedente del anticipo de ${d.reembolsoDetalle.revision.deAnticipo}` : ""}</dd>
                  <dt>Puso el dinero</dt><dd>{d.reembolsoDetalle.beneficiario} · {pesos.format(Number(d.reembolsoDetalle.importe))} · el {d.reembolsoDetalle.revision.pagadoEl.split("-").reverse().join("/")}</dd>
                  <dt>Autorización del gasto</dt>
                  <dd>{d.reembolsoDetalle.revision.autorizadoPor
                    ? `${pesos.format(Number(d.reembolsoDetalle.revision.autorizadoImporte))} por ${d.reembolsoDetalle.revision.autorizadoPor} · ${fechaHora.format(d.reembolsoDetalle.revision.autorizadoEn!)}`
                    : "Sin autorización registrada"}</dd>
                  <dt>Comprobantes</dt>
                  <dd data-testid="revision-comprobantes">{d.reembolsoDetalle.revision.comprobantes.length
                    ? d.reembolsoDetalle.revision.comprobantes.map((c) => `${TIPO_COMPROBANTE[c.tipo as keyof typeof TIPO_COMPROBANTE]}${c.folio ? ` · folio ${c.folio}` : ""}`).join(", ")
                    : <strong className="campo-error" data-testid="falta-comprobante">Falta comprobante{d.reembolsoDetalle.revision.sinComprobanteMotivo ? ` · «${d.reembolsoDetalle.revision.sinComprobanteMotivo}»` : ""}: para autorizar, escribe el motivo</strong>}</dd>
                </dl>
              </div>
              <FormularioDecisionReembolso codigo={codigo} clave={g.clave} importe={d.reembolsoDetalle.importe} beneficiario={d.reembolsoDetalle.beneficiario}
                sinComprobante={!d.reembolsoDetalle.revision.comprobantes.length} />
            </>
          ) : null}
          {d.puedePresentarReembolso ? <FormularioPresentarReembolso codigo={codigo} clave={g.clave} /> : null}
          {d.origenesReembolso.length ? (
            <FormularioPagoReembolso codigo={codigo} clave={g.clave} importe={d.reembolsoDetalle.importe} beneficiario={d.reembolsoDetalle.beneficiario} origenes={d.origenesReembolso} />
          ) : null}
          {d.puedeConfirmarReembolso ? <FormularioConfirmarReembolso codigo={codigo} clave={g.clave} importe={d.reembolsoDetalle.importe} /> : null}
          <p className="sub">El reembolso es un paso del mismo dinero, no un gasto nuevo: el gasto ya contó al pagarse. Se paga una sola vez, por lo pagado.</p>
        </section>
      ) : null}
      <section className="tarjeta" aria-labelledby="t-versiones" data-testid="versiones-gasto">
        <h2 id="t-versiones" className="titulo-seccion">Historial de la solicitud</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Fecha y hora</th><th>Qué pasó</th><th>Cuenta</th></tr></thead>
            <tbody>
              {d.versiones.flatMap((v) => {
                const dec = d.decisiones.find((x) => x.version === v.version);
                return [
                  <tr key={`v${v.version}`} data-testid="version-gasto">
                    <td data-etiqueta="Fecha y hora">{fechaHora.format(v.en)}</td>
                    <td data-etiqueta="Qué pasó">
                      {v.version === 1 ? (d.yaPagado ? "Registro de gasto ya pagado" : "Solicitud") : `Corrección · versión ${v.version}`}: {v.concepto} · {v.categoria} · {pesos.format(Number(v.importe))}
                      {v.proveedor ? ` · ${v.proveedor}` : ""}{v.motivo ? <><br /><span className="sub">Motivo: «{v.motivo}»</span></> : null}
                    </td>
                    <td data-etiqueta="Cuenta">{v.registradaPor}</td>
                  </tr>,
                  dec ? (
                    <tr key={`d${v.version}`} data-testid="decision-gasto">
                      <td data-etiqueta="Fecha y hora">{fechaHora.format(dec.en)}</td>
                      <td data-etiqueta="Qué pasó">
                        {dec.decision === "autorizado" ? "Autorizado" : "Rechazado"} · versión {dec.version} · {pesos.format(Number(dec.importe))}
                        {dec.version < ultima.version && dec.decision === "autorizado" ? <span className="sub"> · ya no vale: la solicitud se corrigió después</span> : null}
                        <br /><span className="sub">Con su facultad: {dec.sinLimite ? "sin límite" : `${pesos.format(Number(dec.limite))} por gasto y ${pesos.format(Number(dec.diario))} al día`}</span>
                        {dec.motivo ? <><br /><span className="sub">Motivo: «{dec.motivo}»</span></> : null}
                      </td>
                      <td data-etiqueta="Cuenta">{dec.por}</td>
                    </tr>
                  ) : null,
                ];
              })}
              {d.anticipo ? (
                <tr data-testid="anticipo-historial"><td data-etiqueta="Fecha y hora">{fechaHora.format(d.anticipo.en)}</td>
                  <td data-etiqueta="Qué pasó">Anticipo entregado · {NOMBRE_ORIGEN[d.anticipo.lugar]} · {pesos.format(Number(d.anticipo.importe))} · a {d.anticipo.recibe}</td>
                  <td data-etiqueta="Cuenta">{d.anticipo.entregadoPor}</td></tr>
              ) : null}
              {d.anticipo?.recibidoEn ? (
                <tr><td data-etiqueta="Fecha y hora">{fechaHora.format(d.anticipo.recibidoEn)}</td>
                  <td data-etiqueta="Qué pasó">Confirmó que recibió el anticipo</td><td data-etiqueta="Cuenta">{d.anticipo.recibe}</td></tr>
              ) : null}
              {d.pago ? (
                <tr data-testid="pago-historial">
                  <td data-etiqueta="Fecha y hora">{fechaHora.format(d.pago.en)}</td>
                  <td data-etiqueta="Qué pasó">Pago registrado · {NOMBRE_ORIGEN[d.pago.origen]} · {pesos.format(Number(d.pago.importe))}
                    {d.pago.pagadoEl !== hoyDe(d.pago.en) ? <><br /><span className="sub">Pagado el {d.pago.pagadoEl.split("-").reverse().join("/")}</span></> : null}</td>
                  <td data-etiqueta="Cuenta">{d.pago.registradoPor}</td>
                </tr>
              ) : null}
              {d.comprobantes.map((c, i) => (
                <tr key={`c${i}`}><td data-etiqueta="Fecha y hora">{fechaHora.format(c.en)}</td>
                  <td data-etiqueta="Qué pasó">Comprobante · {TIPO_COMPROBANTE[c.tipo]}{c.folio ? ` · folio ${c.folio}` : ""}</td><td data-etiqueta="Cuenta">{c.registradoPor}</td></tr>
              ))}
              {d.sinComprobante ? (
                <tr><td data-etiqueta="Fecha y hora">{fechaHora.format(d.sinComprobante.en)}</td>
                  <td data-etiqueta="Qué pasó">Sin comprobante · «{d.sinComprobante.motivo}»</td><td data-etiqueta="Cuenta">{d.sinComprobante.registradoPor}</td></tr>
              ) : null}
              {d.reembolsoDetalle?.rondas.map((x, i) => (
                <tr key={`r${i}`}><td data-etiqueta="Fecha y hora">{fechaHora.format(x.en)}</td>
                  <td data-etiqueta="Qué pasó">{x.tipo === "decision" ? `Reembolso ${x.decision === "autorizado" ? "autorizado" : "rechazado"}${x.sinComprobante ? " sin comprobante" : ""}` : "Reembolso presentado de nuevo"}{x.motivo ? ` · «${x.motivo}»` : ""}</td>
                  <td data-etiqueta="Cuenta">{x.por}</td></tr>
              ))}
              {d.reembolsoDetalle?.pago ? (
                <tr><td data-etiqueta="Fecha y hora">{fechaHora.format(d.reembolsoDetalle.pago.en)}</td>
                  <td data-etiqueta="Qué pasó">Reembolso pagado · {NOMBRE_ORIGEN[d.reembolsoDetalle.pago.origen]} · {pesos.format(Number(d.reembolsoDetalle.pago.importe))} · a {d.reembolsoDetalle.beneficiario}</td>
                  <td data-etiqueta="Cuenta">{d.reembolsoDetalle.pago.pagadoPor}</td></tr>
              ) : null}
              {d.reembolsoDetalle?.recibidoEn ? (
                <tr><td data-etiqueta="Fecha y hora">{fechaHora.format(d.reembolsoDetalle.recibidoEn)}</td>
                  <td data-etiqueta="Qué pasó">Confirmó que recibió el reembolso</td><td data-etiqueta="Cuenta">{d.reembolsoDetalle.beneficiario}</td></tr>
              ) : null}
              {d.anticipo?.cambios.map((c, i) => (
                <tr key={`k${i}`}><td data-etiqueta="Fecha y hora">{fechaHora.format(c.en)}</td>
                  <td data-etiqueta="Qué pasó">Cambio del anticipo recibido en caja · {pesos.format(Number(c.importe))}</td>
                  <td data-etiqueta="Cuenta">{c.recibidoPor}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">El historial no se edita ni se borra.</p>
      </section>
    </main>
  );
}

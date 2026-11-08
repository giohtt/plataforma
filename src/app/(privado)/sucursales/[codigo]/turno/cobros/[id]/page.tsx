import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioCancelacion } from "@/components/Cancelaciones";
import { cancelacionesDeCobro, pantallaSolicitud } from "@/lib/cancelaciones";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";
import { NOMBRE_REFERENCIA } from "@/lib/datos-visita";
import { detalleCobro, type EstadoCobro } from "@/lib/visitas";

export const metadata = { title: "Detalle del cobro · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (importe: string) => pesos.format(Number(importe));
const ESTADO: Record<EstadoCobro, string> = {
  confirmado: "Confirmado",
  confirmado_operativamente: "Confirmado operativamente",
  pendiente_abono: "Pendiente de verificar abono",
  abono_verificado: "Abono verificado",
  no_localizado: "No localizado",
  cancelado: "Cancelado",
};
const MEDIO = { efectivo: "en efectivo", tarjeta: "con tarjeta", transferencia: "por transferencia" } as const;
const dia = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/** Detalle de un cobro de visitas: visitantes y sus pases. Sin permiso de ver turnos en la sucursal: «No encontrada». */
export default async function DetalleCobro({ params, searchParams }: PageProps<"/sucursales/[codigo]/turno/cobros/[id]">) {
  const sesion = await requerirSesion();
  const { codigo, id } = await params;
  const sql = obtenerBaseDatos()!;
  const d = await detalleCobro(sql, sesion.usuarioId, codigo, id);
  if (!d) notFound();
  const [cancelaciones, solicitud] = await Promise.all([
    cancelacionesDeCobro(sql, d.cobroId),
    pantallaSolicitud(sql, sesion.usuarioId, codigo, id, leerEntorno()),
  ]);
  const { aviso } = await searchParams;
  const ESTADO_SOLICITUD = { solicitada: "Pendiente de autorizar", aprobada: "Aprobada", rechazada: "Rechazada" } as const;

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Detalle del cobro</h1>
      <p className="sub">Solo datos ficticios.</p>
      {aviso === "solicitada" ? (
        <p className="aviso aviso-ok" role="status">Cancelación solicitada. Nada cambia hasta que otra persona con permiso la autorice.</p>
      ) : null}
      {cancelaciones.comoConservado.length ? (
        <p className="aviso aviso-info" data-testid="es-conservado">
          Este es el cobro que se conserva en lugar de un duplicado
          {cancelaciones.comoConservado.map((c) => (
            <span key={c.operacionId}> · <Link href={`/sucursales/${codigo}/turno/cobros/${c.operacionId}`}>ver duplicado ({c.estado === "aprobada" ? "cancelado" : "cancelación pendiente"})</Link></span>
          ))}
        </p>
      ) : null}
      <section className="tarjeta" aria-labelledby="t-cobro" data-testid="detalle-cobro">
        <h2 id="t-cobro" className="titulo-seccion">
          {d.pases.length} {d.pases.length === 1 ? "persona" : "personas"} · {$(d.total)} {MEDIO[d.formaPago]}
        </h2>
        <dl className="resumen-cobro">
          <dt>Sucursal</dt>
          <dd>{d.sucursal.nombre}</dd>
          <dt>Registrado</dt>
          <dd>{hora.format(d.registradaEn)} por {d.registradaPor}</dd>
          <dt>Estado</dt>
          <dd data-testid="detalle-estado">{ESTADO[d.estado]}</dd>
          {d.formaPago === "transferencia" ? (
            <>
              <dt>{d.tipoReferencia ? NOMBRE_REFERENCIA[d.tipoReferencia] : "Referencia"}</dt>
              <dd data-testid="detalle-referencia">{d.referencia}</dd>
              {d.abonoFecha ? (
                <>
                  <dt>Fecha del abono</dt>
                  <dd data-testid="detalle-abono">{dia.format(new Date(`${d.abonoFecha}T00:00:00Z`))} · verificó {d.verificadoPor}</dd>
                </>
              ) : null}
            </>
          ) : null}
          {d.formaPago === "tarjeta" ? (
            <>
              <dt>Autorización</dt>
              <dd data-testid="detalle-autorizacion">{d.autorizacion}</dd>
              <dt>Liquidación bancaria</dt>
              <dd data-testid="detalle-conciliacion">Pendiente de conciliar</dd>
            </>
          ) : null}
          <dt>Total</dt>
          <dd data-testid="detalle-total"><strong>{$(d.total)}</strong></dd>
          {d.recibido ? (
            <>
              <dt>Recibido</dt>
              <dd>{$(d.recibido)}</dd>
              <dt>Cambio</dt>
              <dd>{$(d.cambio ?? "0")}</dd>
            </>
          ) : null}
          <dt>{d.formaPago === "efectivo" ? "Entró a la bolsa" : "Bolsa de visitas"}</dt>
          <dd data-testid="detalle-bolsa">
            {d.entradaBolsa ? `${$(d.entradaBolsa)} · responsable ${d.responsableBolsa}` : d.formaPago !== "efectivo" ? `No entra efectivo (${d.formaPago})` : "—"}
          </dd>
        </dl>
      </section>
      {d.cambios.length ? (
        <section className="tarjeta" aria-labelledby="t-cambios" data-testid="detalle-cambios">
          <h2 id="t-cambios" className="titulo-seccion">Cambios de estado</h2>
          <ul className="lista-simple">
            {d.cambios.map((c, i) => (
              <li key={i} data-testid="cambio-estado">
                {hora.format(new Date(c.en))} · {ESTADO[c.de]} → <strong>{ESTADO[c.a]}</strong> · {c.usuario}
                {c.abonoFecha ? ` · abono del ${dia.format(new Date(`${c.abonoFecha}T00:00:00Z`))}` : ""}
                {c.motivo ? ` · Motivo: ${c.motivo}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {cancelaciones.propias.length ? (
        <section className="tarjeta" aria-labelledby="t-cancelacion" data-testid="detalle-cancelacion">
          <h2 id="t-cancelacion" className="titulo-seccion">Cancelación por duplicado</h2>
          <ul className="lista-simple">
            {cancelaciones.propias.map((c) => (
              <li key={c.id} data-testid="cancelacion">
                <strong>{ESTADO_SOLICITUD[c.estado]}</strong> · pidió {c.solicitadaPor} el {hora.format(new Date(c.solicitadaEn))} · «{c.explicacion}» ·{" "}
                <Link href={`/sucursales/${codigo}/turno/cobros/${c.conservaOperacionId}`}>cobro que se conserva</Link>
                {c.resueltaPor && c.resueltaEn ? ` · ${c.estado === "aprobada" ? "aprobó" : "rechazó"} ${c.resueltaPor} el ${hora.format(new Date(c.resueltaEn))}` : ""}
                {c.motivoRechazo ? ` · Motivo: ${c.motivoRechazo}` : ""}
                {c.ajuste ? ` · ajuste en la bolsa: ${$(c.ajuste)}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {!solicitud.ok && solicitud.error === "no_responsable" ? (
        <p className="aviso aviso-info" data-testid="cancelacion-no-responsable">
          Si este cobro está duplicado, la cancelación la solicita la responsable de la bolsa de este turno.
        </p>
      ) : null}
      {solicitud.ok ? <FormularioCancelacion codigo={codigo} operacionId={id} total={d.total} candidatos={solicitud.candidatos} /> : null}
      <section className="tarjeta" aria-labelledby="t-pases" data-testid="detalle-pases">
        <h2 id="t-pases" className="titulo-seccion">Visitantes y pases ({d.pases.length})</h2>
        <ul className="lista-visitantes">
          {d.pases.map((p) => (
            <li key={p.id} className="tarjeta-visitante" data-testid="pase">
              <div className="tarjeta-visitante-datos">
                <strong>{p.orden}. {p.nombre}</strong>
                <span className="sub">Tel. {p.telefono ?? "no registrado"} · Ficha de {p.fichaDe}</span>
                <span className="sub">
                  Pase {p.id.slice(0, 8)} · tarifa {$(p.tarifa)} · descuento {$(p.descuento)} · total <strong>{$(p.total)}</strong>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

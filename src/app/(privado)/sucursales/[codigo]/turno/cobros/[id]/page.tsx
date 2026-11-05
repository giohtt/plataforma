import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";
import { detalleCobro } from "@/lib/visitas";

export const metadata = { title: "Detalle del cobro · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (importe: string) => pesos.format(Number(importe));
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/** Detalle de un cobro de visitas: visitantes y sus pases. Sin permiso de ver turnos en la sucursal: «No encontrada». */
export default async function DetalleCobro({ params }: PageProps<"/sucursales/[codigo]/turno/cobros/[id]">) {
  const sesion = await requerirSesion();
  const { codigo, id } = await params;
  const d = await detalleCobro(obtenerBaseDatos()!, sesion.usuarioId, codigo, id);
  if (!d) notFound();

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Detalle del cobro</h1>
      <p className="sub">Solo datos ficticios.</p>
      <section className="tarjeta" aria-labelledby="t-cobro" data-testid="detalle-cobro">
        <h2 id="t-cobro" className="titulo-seccion">
          {d.pases.length} {d.pases.length === 1 ? "persona" : "personas"} · {$(d.total)} {d.formaPago === "tarjeta" ? "con tarjeta" : "en efectivo"}
        </h2>
        <dl className="resumen-cobro">
          <dt>Sucursal</dt>
          <dd>{d.sucursal.nombre}</dd>
          <dt>Registrado</dt>
          <dd>{hora.format(d.registradaEn)} por {d.registradaPor}</dd>
          <dt>Estado</dt>
          <dd data-testid="detalle-estado">{d.estado === "confirmado_operativamente" ? "Confirmado operativamente" : "Confirmado"}</dd>
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
          <dt>{d.formaPago === "tarjeta" ? "Bolsa de visitas" : "Entró a la bolsa"}</dt>
          <dd data-testid="detalle-bolsa">
            {d.entradaBolsa ? `${$(d.entradaBolsa)} · responsable ${d.responsableBolsa}` : d.formaPago === "tarjeta" ? "No entra efectivo (tarjeta)" : "—"}
          </dd>
        </dl>
      </section>
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

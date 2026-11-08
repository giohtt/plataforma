import Link from "next/link";
import { notFound } from "next/navigation";
import { SolicitudPendiente } from "@/components/Cancelaciones";
import { cancelacionesPorAutorizar } from "@/lib/cancelaciones";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Cancelaciones por autorizar · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const AVISO: Record<string, string> = {
  aprobada: "Cancelación aprobada. El cobro duplicado y su pase quedaron cancelados y se registró el ajuste en la bolsa.",
  rechazada: "Cancelación rechazada. El cobro sigue vigente.",
};

/** Solicitudes de cancelación pendientes. Sin la facultad autorizacion.devolucion en la sucursal: «No encontrada». */
export default async function Cancelaciones({ params, searchParams }: PageProps<"/sucursales/[codigo]/cancelaciones">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const r = await cancelacionesPorAutorizar(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!r) notFound();
  const { aviso } = await searchParams;
  const texto = typeof aviso === "string" ? AVISO[aviso] : undefined;
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {r.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Cancelaciones por autorizar</h1>
      <p className="sub">Solo datos ficticios. Puedes autorizar hasta {pesos.format(r.limite)} por cobro.</p>
      {texto ? <p className="aviso aviso-ok" role="status">{texto}</p> : null}
      <section className="tarjeta" aria-labelledby="t-pend" data-testid="solicitudes">
        <h2 id="t-pend" className="titulo-seccion">Pendientes ({r.pendientes.length})</h2>
        {r.pendientes.length ? (
          <ul className="lista-visitantes">{r.pendientes.map((s) => <SolicitudPendiente key={s.id} s={s} codigo={codigo} />)}</ul>
        ) : <p className="sub">No hay solicitudes pendientes.</p>}
      </section>
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { TransferenciaPorVerificarFila } from "@/components/BandejaTransferencias";
import { bandejaTransferencias } from "@/lib/abonos";
import { NOMBRE_REFERENCIA } from "@/lib/datos-visita";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Transferencias por verificar · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" });

const AVISO: Record<string, string> = {
  verificado: "Abono verificado. El cobro pasó de pendiente a verificado.",
  no_localizado: "Marcada como no localizada. Se puede verificar después si aparece el abono.",
};

/**
 * Verificación manual de transferencias de una sucursal: para pruebas y excepciones. Sin el permiso
 * cobro.verificar_abono en la sucursal: «No encontrada».
 */
export default async function Transferencias({ params, searchParams }: PageProps<"/sucursales/[codigo]/transferencias">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const b = await bandejaTransferencias(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!b) notFound();
  const { aviso } = await searchParams;
  const texto = typeof aviso === "string" ? AVISO[aviso] : undefined;
  const pendientes = b.porVerificar.filter((t) => t.estado === "pendiente_abono");
  const noLocalizadas = b.porVerificar.filter((t) => t.estado === "no_localizado");

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {b.sucursal.nombre}</Link></p>
      <h1 className="cabecera-titulo">Transferencias por verificar</h1>
      <p className="sub">
        Solo datos ficticios. Verificación manual para pruebas y excepciones; la conciliación por lote de los movimientos
        bancarios llegará antes de operar en varias sucursales.
      </p>
      {texto ? <p className="aviso aviso-ok" role="status">{texto}</p> : null}

      <section className="tarjeta" aria-labelledby="t-pend" data-testid="pendientes">
        <h2 id="t-pend" className="titulo-seccion">Pendientes de verificar abono ({pendientes.length})</h2>
        {pendientes.length ? (
          <ul className="lista-visitantes">{pendientes.map((t) => <TransferenciaPorVerificarFila key={t.cobroId} t={t} codigo={codigo} hoy={b.hoy} />)}</ul>
        ) : <p className="sub">No hay transferencias pendientes.</p>}
      </section>

      <section className="tarjeta" aria-labelledby="t-nol" data-testid="no-localizadas">
        <h2 id="t-nol" className="titulo-seccion">No localizadas ({noLocalizadas.length})</h2>
        {noLocalizadas.length ? (
          <ul className="lista-visitantes">{noLocalizadas.map((t) => <TransferenciaPorVerificarFila key={t.cobroId} t={t} codigo={codigo} hoy={b.hoy} />)}</ul>
        ) : <p className="sub">No hay transferencias no localizadas.</p>}
      </section>

      <section className="tarjeta" aria-labelledby="t-ver" data-testid="verificadas">
        <h2 id="t-ver" className="titulo-seccion">Verificadas en los últimos 7 días ({b.verificadasRecientes.length})</h2>
        {b.verificadasRecientes.length ? (
          <ul className="lista-simple">
            {b.verificadasRecientes.map((t) => (
              <li key={t.cobroId} data-testid="verificada">
                {pesos.format(Number(t.total))} · {NOMBRE_REFERENCIA[t.tipoReferencia]} {t.referencia} · abono del{" "}
                {t.abonoFecha ? fecha.format(new Date(`${t.abonoFecha}T00:00:00Z`)) : "—"} · verificó {t.verificadoPor} ·{" "}
                <Link href={`/sucursales/${codigo}/turno/cobros/${t.operacionId}`}>Ver detalle</Link>
              </li>
            ))}
          </ul>
        ) : <p className="sub">Todavía no hay transferencias verificadas.</p>}
      </section>
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { CompletarMotivo, ResolverAutorizacion } from "@/components/Accesos";
import { TablaAccesos } from "@/components/RegistroAccesos";
import { revisionAccesos } from "@/lib/accesos";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Accesos por autorizar · Fitnessland" };

const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/**
 * Encargado (autoriza y revisa), Dirección con permiso explícito (autoriza) y Administración (revisa).
 * Sin ninguno de esos permisos en la sucursal: «No encontrada».
 */
export default async function AccesosPorAutorizar({ params, searchParams }: PageProps<"/sucursales/[codigo]/accesos">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const r = await revisionAccesos(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!r) notFound();
  const { aviso } = await searchParams;

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← Sucursal</Link></p>
      <h1 className="cabecera-titulo">{r.puedeAutorizar ? "Accesos por autorizar" : "Registro de accesos"}</h1>
      <p className="sub">Solo datos ficticios. El cobro y la apertura se consultan por separado.</p>
      {aviso === "aprobada" ? <p className="aviso aviso-ok" role="status">Acceso autorizado. Recepción ya puede registrar la entrada.</p> : null}
      {aviso === "rechazada" ? <p className="aviso aviso-ok" role="status">Acceso no autorizado. Recepción ve tu respuesta.</p> : null}

      {r.puedeAutorizar ? (
        <section className="tarjeta" aria-labelledby="t-por-autorizar" data-testid="bandeja-accesos">
          <h2 id="t-por-autorizar" className="titulo-seccion">Pendientes ({r.porAutorizar.length})</h2>
          {r.porAutorizar.length ? (
            <ul className="lista-visitantes">
              {r.porAutorizar.map((a) => <ResolverAutorizacion key={a.id} codigo={codigo} a={a} />)}
            </ul>
          ) : (
            <p className="sub">No hay solicitudes pendientes.</p>
          )}
        </section>
      ) : null}

      <section className="tarjeta" aria-labelledby="t-incidentes" data-testid="incidentes">
        <h2 id="t-incidentes" className="titulo-seccion">Emergencias sin motivo ({r.emergenciasSinMotivo.length})</h2>
        {r.emergenciasSinMotivo.length ? (
          <ul className="lista-visitantes">
            {r.emergenciasSinMotivo.map((a) => (
              <li key={a.id} className="tarjeta-visitante" data-testid="incidente">
                <div className="tarjeta-visitante-datos">
                  <strong>Apertura de emergencia · {fechaHora.format(new Date(a.en))}</strong>
                  <span className="sub">Registró {a.por} · turno abierto el {fechaHora.format(new Date(a.turnoAbiertoEn))}</span>
                </div>
                {r.puedeAutorizar ? <CompletarMotivo codigo={codigo} accesoId={a.id} volver={`/sucursales/${codigo}/accesos`} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="sub">No hay emergencias pendientes de motivo.</p>
        )}
      </section>

      {r.puedeConsultar ? (
        <>
          <section className="tarjeta" aria-labelledby="t-resueltas" data-testid="resueltas">
            <h2 id="t-resueltas" className="titulo-seccion">Autorizaciones resueltas (últimos 7 días)</h2>
            {r.resueltas.length ? (
              <ul className="lista-simple">
                {r.resueltas.map((a) => (
                  <li key={a.id} data-testid="resuelta">
                    <strong>{a.estado === "aprobada" ? "Autorizado" : "No autorizado"}</strong> ·{" "}
                    {a.tipo === "transferencia_pendiente" ? `${a.persona} (transferencia pendiente)` : "visita sin cobro"} · pidió {a.solicitadaPor} ·{" "}
                    {a.estado === "aprobada" ? "autorizó" : "respondió"} {a.resueltaPor} el {fechaHora.format(new Date(a.resueltaEn!))} · «{a.motivo}»
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sub">Ninguna.</p>
            )}
          </section>
          <section className="tarjeta" aria-labelledby="t-recientes" data-testid="registro-accesos">
            <h2 id="t-recientes" className="titulo-seccion">Accesos de los últimos 7 días ({r.recientes.length})</h2>
            <TablaAccesos codigo={codigo} filas={r.recientes} conTurno />
          </section>
        </>
      ) : null}
    </main>
  );
}

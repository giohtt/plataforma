import Link from "next/link";
import { notFound } from "next/navigation";
import { BotonEmergencia, CompletarMotivo, EstadoAutorizacion, FormularioSinPase, PedirVisitaSinCobro, UsarAutorizacion } from "@/components/Accesos";
import { TablaAccesos } from "@/components/RegistroAccesos";
import { pantallaAccesos } from "@/lib/accesos";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Accesos del turno · Fitnessland" };

const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const AVISOS: Record<string, string> = {
  sin_pase: "Apertura sin pase registrada. Queda aparte para revisión.",
  emergencia: "Apertura de emergencia registrada. Escribe el motivo en cuanto puedas.",
  motivo: "Motivo guardado.",
  autorizacion: "Autorización pedida. Encargado la responde desde su sesión; aquí verás si la aprueba o no.",
};

/** Recepción: aperturas sin pase, emergencias y accesos del turno. Sin permiso de registrar aperturas: «No encontrada». */
export default async function AccesosDelTurno({ params, searchParams }: PageProps<"/sucursales/[codigo]/turno/accesos">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const p = await pantallaAccesos(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!p) notFound();
  const { aviso } = await searchParams;
  const volver = `/sucursales/${codigo}/turno/accesos`;

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Accesos del turno</h1>
      <p className="sub">
        Solo datos ficticios. Aquí se registra la apertura manual; la plataforma no abre la puerta. Para las personas con pase,
        registra su entrada o reingreso desde el detalle de su cobro.
      </p>
      {typeof aviso === "string" && AVISOS[aviso] ? <p className="aviso aviso-ok" role="status">{AVISOS[aviso]}</p> : null}

      {p.emergenciasSinMotivo.length ? (
        <section className="tarjeta" aria-labelledby="t-pendientes" data-testid="emergencias-sin-motivo">
          <h2 id="t-pendientes" className="titulo-seccion">Emergencias sin motivo ({p.emergenciasSinMotivo.length})</h2>
          <ul className="lista-visitantes">
            {p.emergenciasSinMotivo.map((a) => (
              <li key={a.id} className="tarjeta-visitante" data-testid="emergencia-pendiente">
                <div className="tarjeta-visitante-datos">
                  <strong>Apertura de emergencia · {fechaHora.format(new Date(a.en))}</strong>
                  <span className="sub">Registró {a.por} · turno abierto el {fechaHora.format(new Date(a.turnoAbiertoEn))}</span>
                </div>
                <CompletarMotivo codigo={codigo} accesoId={a.id} volver={volver} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.turnoAbierto ? (
        <>
          <section className="tarjeta" aria-labelledby="t-emergencia">
            <h2 id="t-emergencia" className="titulo-seccion">Emergencia</h2>
            <p className="sub">Registra la apertura primero; el motivo puede escribirse después. Si cierra el turno sin motivo, queda pendiente para revisión de Encargado.</p>
            <BotonEmergencia codigo={codigo} />
          </section>
          <section className="tarjeta" aria-labelledby="t-sin-pase">
            <h2 id="t-sin-pase" className="titulo-seccion">Apertura sin pase</h2>
            <p className="sub">No crea cobro ni visita y no cambia la bolsa. Queda aparte para revisión.</p>
            <FormularioSinPase codigo={codigo} />
          </section>
          <section className="tarjeta" aria-labelledby="t-cobrable" data-testid="visitas-sin-cobro">
            <h2 id="t-cobrable" className="titulo-seccion">Visita que normalmente se cobra</h2>
            <p className="sub">Necesita la autorización de Encargado antes de abrir.</p>
            {p.visitasSinCobro.length ? (
              <ul className="lista-visitantes">
                {p.visitasSinCobro.map((a) => (
                  <li key={a.id} className="tarjeta-visitante" data-testid="visita-sin-cobro">
                    <div className="tarjeta-visitante-datos">
                      <strong>«{a.nota}»</strong>
                      <EstadoAutorizacion a={a} />
                      {a.usada ? <span className="sub">Apertura registrada.</span> : null}
                    </div>
                    {a.estado === "aprobada" && !a.usada ? <UsarAutorizacion codigo={codigo} a={a} /> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <PedirVisitaSinCobro codigo={codigo} />
          </section>
        </>
      ) : (
        <p className="aviso aviso-info">No hay turno abierto: las aperturas se registran durante el turno.</p>
      )}

      <section className="tarjeta" aria-labelledby="t-del-turno" data-testid="accesos-del-turno">
        <h2 id="t-del-turno" className="titulo-seccion">Accesos de este turno ({p.delTurno.length})</h2>
        <TablaAccesos codigo={codigo} filas={p.delTurno} />
      </section>
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { accionCancelarPreparacionCierre, accionPrepararCierre } from "@/app/acciones-cierre";
import { FormularioCierre } from "@/components/Cierre";
import { pantallaCierre } from "@/lib/cierres";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Cierre del día · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const MOTIVO: Record<string, string> = {
  sin_permiso: "Tu cuenta no puede cerrar el turno en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada.",
  sin_turno: "No hay turno abierto en esta sucursal.",
  no_responsable: "Solo la responsable vigente de la bolsa y del cajón cierra el turno.",
  entrega_en_curso: "Hay un cambio de turno en curso: confírmalo o cancélalo antes de cerrar.",
  retiro_en_preparacion: "Hay un retiro con folio en preparación: confirma la entrega o cancela la preparación antes de cerrar.",
  cancelaciones_pendientes: "Hay solicitudes de cancelación pendientes en este turno: deben resolverse antes de cerrar.",
  sin_preparacion: "Genera los folios de los sobres antes de cerrar.",
  cambio: "El turno cambió mientras tenías la pantalla abierta.",
  bloqueado_produccion: "El cierre del día está desactivado fuera del entorno de pruebas.",
};

/** Cierre del día: la responsable de ambos lugares genera los folios de los sobres, cuenta y cierra. */
export default async function CierreDelDia({ params, searchParams }: PageProps<"/sucursales/[codigo]/turno/cierre">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const { error, cancelados } = await searchParams;
  const p = await pantallaCierre(obtenerBaseDatos()!, sesion.usuarioId, codigo, leerEntorno());
  if (!p.ok && p.error === "no_encontrada") notFound();
  const bolsa = p.ok ? p.lugares.find((l) => l.tipo === "bolsa_visitas")! : null;
  const cajon = p.ok ? p.lugares.find((l) => l.tipo === "cajon_mensualidades")! : null;
  const bloqueado = p.ok && (p.bloqueos.entrega || p.bloqueos.retiro || p.bloqueos.cancelaciones > 0);
  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Cierre del día{p.ok ? ` · ${p.sucursal}` : ""}</h1>
      <p className="sub">
        Solo datos ficticios. La responsable cuenta y cierra los dos lugares; cada lugar va en su sobre, con el folio que genera la
        plataforma. Cerrar termina el turno.
      </p>
      {typeof error === "string" && MOTIVO[error] ? <p className="aviso aviso-error" role="alert">{MOTIVO[error]}</p> : null}
      {typeof cancelados === "string" ? (
        <p className="aviso aviso-ok" role="status">Preparación cancelada. Los folios {cancelados} quedan cancelados y no se vuelven a usar.</p>
      ) : null}
      {!p.ok ? (
        <p className="aviso aviso-info" data-testid="cierre-impedido">{MOTIVO[p.error] ?? "No disponible."}</p>
      ) : (
        <>
          <section className="tarjeta" aria-labelledby="t-antes" data-testid="antes-de-cerrar">
            <h2 id="t-antes" className="titulo-seccion">Antes de cerrar</h2>
            <dl className="cuentas-lugar">
              <dt>Cambio de turno en curso</dt>
              <dd data-testid="bloqueo-entrega">{p.bloqueos.entrega ? <strong>Sí: confírmalo o cancélalo primero</strong> : "Ninguno"}</dd>
              <dt>Retiro con folio en preparación</dt>
              <dd data-testid="bloqueo-retiro">{p.bloqueos.retiro ? <strong>Sí: confirma la entrega o cancela la preparación</strong> : "Ninguno"}</dd>
              <dt>Cancelaciones de cobro por resolver</dt>
              <dd>{p.bloqueos.cancelaciones ? <strong>{p.bloqueos.cancelaciones}</strong> : "Ninguna"}</dd>
              <dt>Retiros pendientes de confirmar o en revisión</dt>
              <dd data-testid="pendiente-retiros">{p.pendientesVisibles.retirosPorConfirmar}</dd>
              <dt>Diferencias e incidencias de efectivo por revisar</dt>
              <dd data-testid="pendiente-diferencias">{p.pendientesVisibles.diferenciasPorRevisar}</dd>
            </dl>
            <p className="sub">Las confirmaciones y diferencias pendientes no impiden cerrar y siguen visibles después del cierre.</p>
          </section>
          <section className="tarjeta" aria-labelledby="t-desglose">
            <h2 id="t-desglose" className="titulo-seccion">Bolsa de visitas</h2>
            <dl className="cuentas-lugar">
              <dt>Contado al abrir</dt><dd>{pesos.format(Number(bolsa!.contadoAlAbrir))}</dd>
              <dt>Cobros en efectivo</dt><dd>+ {pesos.format(Number(bolsa!.entradas))}</dd>
              {Number(bolsa!.ajustes) ? <><dt>Cancelaciones aprobadas</dt><dd>− {pesos.format(-Number(bolsa!.ajustes))}</dd></> : null}
              {Number(bolsa!.retiros) ? <><dt>Retiros a Encargada de retiros</dt><dd>− {pesos.format(-Number(bolsa!.retiros))}</dd></> : null}
              {Number(bolsa!.fondos) ? <><dt>Entradas al fondo fijo</dt><dd>+ {pesos.format(Number(bolsa!.fondos))}</dd></> : null}
              <dt>Efectivo esperado al cerrar</dt><dd><strong>{pesos.format(Number(bolsa!.esperado))}</strong></dd>
              {Number(bolsa!.diferenciaRetiros) ? (
                <><dt>Diferencia ya registrada al retirar</dt>
                  <dd data-testid="cierre-diferencia-retiros">{(Number(bolsa!.diferenciaRetiros) < 0 ? "−" : "+") + pesos.format(Math.abs(Number(bolsa!.diferenciaRetiros)))}</dd></>
              ) : null}
            </dl>
            {Number(bolsa!.diferenciaRetiros) ? (
              <p className="sub">Si sigue presente al cerrar, se vincula a la diferencia del cierre sin duplicarse.</p>
            ) : null}
          </section>
          {!p.configuracion ? (
            <p className="aviso aviso-info" data-testid="sin-configuracion">
              Dirección todavía no define dónde se guardan los sobres ni quién tiene acceso en esta sucursal. No se puede cerrar hasta entonces.
            </p>
          ) : !p.configuracion.accesoCajon ? (
            <p className="aviso aviso-info" data-testid="sin-configuracion-cajon">
              Dirección debe actualizar la custodia de esta sucursal indicando dónde quedan los fondos fijos y quién tiene acceso al cajón. No se puede cerrar hasta entonces.
            </p>
          ) : !p.custodios.length ? (
            <p className="aviso aviso-info" data-testid="sin-custodio">No hay un Encargado de la sucursal que pueda quedar como custodio nocturno.</p>
          ) : bloqueado ? (p.sobres.length ? (
            <form action={accionCancelarPreparacionCierre} className="fila-acciones">
              <input type="hidden" name="codigo" value={codigo} />
              <input type="hidden" name="turno" value={p.turnoId} />
              <button className="boton" type="submit" data-testid="cancelar-preparacion-cierre">Cancelar preparación de los sobres</button>
            </form>
          ) : null) : p.sobres.length !== 2 ? (
            <section className="tarjeta" aria-labelledby="t-folios">
              <h2 id="t-folios" className="titulo-seccion">Folios de los sobres</h2>
              <p className="sub">Genera los folios para anotarlos en los sobres antes de contar y cerrar. No mueve efectivo.</p>
              <form action={accionPrepararCierre}>
                <input type="hidden" name="codigo" value={codigo} />
                <input type="hidden" name="turno" value={p.turnoId} />
                <button className="boton boton-principal" type="submit" data-testid="generar-folios">Generar folios</button>
              </form>
            </section>
          ) : (
            <section className="tarjeta" aria-labelledby="t-cerrar">
              <h2 id="t-cerrar" className="titulo-seccion">Contar y cerrar</h2>
              <FormularioCierre codigo={codigo} turnoId={p.turnoId} usuarioId={sesion.usuarioId} esperadoBolsa={bolsa!.esperado!} contadoCajon={cajon!.contadoAlAbrir}
                sobres={p.sobres} fondos={p.fondos} custodios={p.custodios} apoyos={p.apoyos}
                configuracion={{ lugar: p.configuracion.lugar, acceso: p.configuracion.acceso, lugarFondos: p.configuracion.lugarFondos!, accesoCajon: p.configuracion.accesoCajon!,
                                 guardados: p.configuracion.custodias !== null }}
                caja={p.caja} fuera={p.fuera} />
              <form action={accionCancelarPreparacionCierre} className="fila-acciones">
                <input type="hidden" name="codigo" value={codigo} />
                <input type="hidden" name="turno" value={p.turnoId} />
                <button className="boton" type="submit" data-testid="cancelar-preparacion-cierre">Cancelar preparación</button>
              </form>
              <p className="sub">Si cancelas, el turno sigue abierto y estos folios quedan cancelados sin reutilizarse.</p>
            </section>
          )}
        </>
      )}
    </main>
  );
}

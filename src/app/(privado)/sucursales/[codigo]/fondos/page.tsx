import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { FormularioCambioFondo, FormularioCancelarEntrada, FormularioConfirmarEntrada, FormularioReposicion } from "@/components/Fondos";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { pantallaFondos } from "@/lib/fondos";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Fondos de caja · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const NOMBRE = { bolsa_visitas: "Visitas (bolsa)", cajon_mensualidades: "Mensualidades (cajón)" } as const;
const AVISO: Record<string, string> = {
  monto: "Cambio de monto autorizado. Aplica desde el siguiente cierre.",
  "monto-pendiente": "Cambio de monto autorizado. La entrega queda pendiente hasta que la responsable confirme lo que recibe.",
  reposicion: "Reposición registrada. Queda pendiente hasta que la responsable confirme lo que recibe.",
  recibida: "Confirmaste lo que recibiste: entra al efectivo del lugar en este turno.",
  cancelada: "Entrada cancelada.",
};
const ORIGEN = { entrega_persona: "lo entregó quien autorizó", excedente_cierre: "del excedente del próximo cierre" } as const;
const DESTINO = { sobre_cierre: "al sobre del próximo cierre", retiro: "a Encargada de retiros (flujo de retiros)" } as const;

/** Fondo fijo de caja: montos vigentes, cambios (Dirección), reposiciones (Dirección y Administración) y confirmaciones. */
export default async function Fondos({ params, searchParams }: PageProps<"/sucursales/[codigo]/fondos">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const { aviso } = await searchParams;
  const p = await pantallaFondos(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!p) notFound();
  const produccion = leerEntorno() === "produccion";
  const pendientes = p.entradas.filter((e) => e.estado === "pendiente");
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {p.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Fondos de caja · {p.sucursal}</h1>
      <p className="sub">Solo datos ficticios. Cada fondo se queda separado e identificado en el cajón con llave y se cuenta aparte al cerrar y al abrir.</p>
      {typeof aviso === "string" && AVISO[aviso] ? <p className="aviso aviso-ok" role="status">{AVISO[aviso]}</p> : null}
      <section className="tarjeta" aria-labelledby="t-vigentes" data-testid="fondos-vigentes">
        <h2 id="t-vigentes" className="titulo-seccion">Fondos vigentes</h2>
        <dl className="cuentas-lugar">
          {p.vigentes.map((v) => (
            <Fragment key={v.tipo}><dt>{NOMBRE[v.tipo]}</dt><dd data-testid={`fondo-${v.tipo}`}>{pesos.format(Number(v.monto))}</dd></Fragment>
          ))}
          <dt>Dónde quedan</dt><dd className="dd-largo">{p.custodia.lugarFondos ?? "Sin definir: Dirección lo indica en «Custodia de sobres»"}</dd>
          <dt>Acceso al cajón</dt><dd className="dd-largo">{p.custodia.accesoCajon.length ? p.custodia.accesoCajon.join(" · ") : "Sin definir"}</dd>
          <dt>Llave esta noche</dt><dd className="dd-largo">{p.custodia.custodioLlave ?? "Sin cierre pendiente: la llave está con quien tiene el turno"}</dd>
        </dl>
      </section>
      {pendientes.length ? (
        <section className="tarjeta" aria-labelledby="t-pendientes" data-testid="entradas-pendientes">
          <h2 id="t-pendientes" className="titulo-seccion">Pendientes de recibir</h2>
          {pendientes.map((e) => (
            <div key={e.id} className="tarjeta" data-testid="entrada-pendiente">
              <p><strong>{e.tipo === "aumento" ? "Aumento del fondo" : "Reposición"}</strong> · {NOMBRE[e.lugar]} · {pesos.format(Number(e.importe))}</p>
              <p className="sub">Entrega {e.entrega} · {hora.format(e.registradaEn)} · origen: {e.origen}</p>
              {e.intentos.map((i, n) => (
                <p key={n} className="aviso aviso-error" data-testid="intento-no-coincide">
                  {hora.format(i.en)} · {i.por} declaró recibir {pesos.format(Number(i.declarado))}: no coincide con lo registrado.
                </p>
              ))}
              {produccion ? null : e.puedoConfirmar ? (
                p.turnoAbierto ? <FormularioConfirmarEntrada codigo={codigo} entradaId={e.id} /> : <p className="sub">Se recibe con un turno abierto.</p>
              ) : <p className="sub">La confirma la responsable vigente del lugar (si ella entregó, otra persona autorizada).</p>}
              {!produccion && e.puedoCancelar ? <FormularioCancelarEntrada codigo={codigo} entradaId={e.id} /> : null}
            </div>
          ))}
        </section>
      ) : null}
      {!produccion && p.puedeAutorizar ? (
        <section className="tarjeta" aria-labelledby="t-monto">
          <h2 id="t-monto" className="titulo-seccion">Cambiar el monto</h2>
          <FormularioCambioFondo codigo={codigo} vigentes={p.vigentes} />
        </section>
      ) : null}
      {!produccion && p.puedeReponer ? (
        <section className="tarjeta" aria-labelledby="t-reponer">
          <h2 id="t-reponer" className="titulo-seccion">Reponer un fondo</h2>
          <FormularioReposicion codigo={codigo} />
        </section>
      ) : null}
      <section className="tarjeta" aria-labelledby="t-hist">
        <h2 id="t-hist" className="titulo-seccion">Historial</h2>
        {!p.cambios.length && !p.entradas.length ? <p className="sub">Sin movimientos.</p> : null}
        <ul className="lista-simple" data-testid="historial-fondos">
          {[
            ...p.cambios.map((c) => ({
              en: c.en, id: c.id,
              texto: `${NOMBRE[c.lugar]}: ${pesos.format(Number(c.anterior))} → ${pesos.format(Number(c.monto))} · ${c.origen ? ORIGEN[c.origen] : DESTINO[c.destino!]} · autorizó ${c.autorizadoPor} · «${c.motivo}»`,
            })),
            ...p.entradas.flatMap((e) => e.intentos.map((i, n) => ({
              en: i.en, id: `${e.id}-intento-${n}`,
              texto: `${NOMBRE[e.lugar]}: ${i.por} declaró recibir ${pesos.format(Number(i.declarado))} de ${pesos.format(Number(e.importe))} registrados · no coincidió, no se aplicó`,
            }))),
            ...p.entradas.map((e) => ({
              en: e.resueltaEn ?? e.registradaEn, id: e.id,
              texto: `${NOMBRE[e.lugar]}: ${e.tipo === "aumento" ? "entrega del aumento" : "reposición"} ${pesos.format(Number(e.importe))} · entregó ${e.entrega} · origen: ${e.origen} · `
                + (e.estado === "recibida" ? `recibió ${e.recibidaPor}` : e.estado === "cancelada" ? `cancelada: «${e.motivoCancelacion}»` : "pendiente de recibir"),
            })),
          ].sort((a, b) => b.en.getTime() - a.en.getTime()).map((x) => <li key={x.id}>{hora.format(x.en)} · {x.texto}</li>)}
        </ul>
      </section>
    </main>
  );
}

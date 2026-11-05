import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioApertura } from "@/components/FormularioApertura";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";
import { estadoTurno, type TipoLugar } from "@/lib/turnos";
import { cobrosDelTurno, impedimentoRegistroVisita } from "@/lib/visitas";

export const metadata = { title: "Turno · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const NOMBRE: Record<TipoLugar, string> = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" };

/** Turno de Recepción de la sucursal. Sin permiso de turnos en la sucursal: «No encontrada». */
export default async function Turno({ params, searchParams }: PageProps<"/sucursales/[codigo]/turno">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const e = await estadoTurno(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!e) notFound();
  const { aviso } = await searchParams;
  const t = e.turno;
  const sql = obtenerBaseDatos()!;
  const puedeCobrar = t ? (await impedimentoRegistroVisita(sql, sesion.usuarioId, codigo, leerEntorno())) === null : false;
  const cobros = t ? await cobrosDelTurno(sql, t.id) : [];
  const conTarjeta = cobros.filter((c) => c.formaPago === "tarjeta");
  const totalTarjeta = conTarjeta.reduce((suma, c) => suma + Math.round(Number(c.total) * 100), 0) / 100;

  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {e.sucursal.nombre}</Link></p>
      <h1 className="cabecera-titulo">Turno de Recepción</h1>
      <p className="sub">Solo datos ficticios. Un turno abierto a la vez por sucursal.</p>
      {aviso === "abierto" && t ? <p className="aviso aviso-ok" role="status">Turno abierto.</p> : null}

      {t ? (
        <>
          <section className="tarjeta" data-testid="turno-abierto">
            <h2 className="titulo-seccion">Turno abierto</h2>
            <p>Abierto por <strong>{t.abiertoPor}</strong> · {hora.format(t.abiertoEn)}</p>
            <p className="sub">La entrega al siguiente turno y el cierre llegan en el bloque 5.</p>
            {puedeCobrar ? (
              <p className="fila-acciones">
                <Link className="boton boton-principal" href={`/sucursales/${codigo}/turno/visita`}>Registrar visita</Link>
              </p>
            ) : null}
          </section>
          <div className="lugares-turno">
            {t.lugares.map((l) => (
              <section key={l.tipo} className="tarjeta" data-testid={`lugar-${l.tipo}`} aria-label={NOMBRE[l.tipo]}>
                <h2 className="titulo-seccion">{NOMBRE[l.tipo]}</h2>
                <dl className="cuentas-lugar">
                  <dt>Contado al abrir</dt>
                  <dd data-testid="contado-al-abrir">{pesos.format(Number(l.contadoAlAbrir))}</dd>
                  {l.tipo === "bolsa_visitas" ? (
                    <>
                      <dt>Cobros de visitas en efectivo ({l.cantidadEntradas} {l.cantidadEntradas === 1 ? "cobro" : "cobros"} · {l.visitasEntradas} {l.visitasEntradas === 1 ? "visita" : "visitas"})</dt>
                      <dd data-testid="entradas">+ {pesos.format(Number(l.entradas))}</dd>
                    </>
                  ) : null}
                  <dt>Efectivo esperado</dt>
                  <dd data-testid="esperado" className={l.esperado === null ? "dd-largo" : undefined}>
                    {l.esperado !== null ? <strong>{pesos.format(Number(l.esperado))}</strong> : "No calculado: faltan datos de Open Desk"}
                  </dd>
                </dl>
                <p className="sub">Responsable: <strong>{l.responsable}</strong>, desde {hora.format(l.responsableDesde)}</p>
                {l.tipo === "cajon_mensualidades" ? (
                  <p className="aviso aviso-info" data-testid="no-conciliado">No conciliado: faltan datos de Open Desk</p>
                ) : (
                  <p className="sub">El esperado no es un conteo: el conteo y las diferencias llegan con el cierre (bloque 5).</p>
                )}
              </section>
            ))}
          </div>
          <section className="tarjeta" aria-labelledby="t-tarjeta" data-testid="tarjeta-turno">
            <h2 id="t-tarjeta" className="titulo-seccion">Cobros con tarjeta</h2>
            <dl className="cuentas-lugar">
              <dt>Cobros ({conTarjeta.length} {conTarjeta.length === 1 ? "cobro" : "cobros"} · {(() => { const v = conTarjeta.reduce((n, c) => n + c.personas, 0); return `${v} ${v === 1 ? "visita" : "visitas"}`; })()})</dt>
              <dd data-testid="total-tarjeta">{pesos.format(totalTarjeta)}</dd>
              <dt>Estado</dt>
              <dd>{conTarjeta.length ? "Confirmados operativamente" : "—"}</dd>
              <dt>Liquidación bancaria</dt>
              <dd data-testid="conciliacion-tarjeta">{conTarjeta.length ? "Pendiente de conciliar" : "—"}</dd>
            </dl>
            <p className="sub">La tarjeta no entra a la bolsa de visitas ni cambia su efectivo esperado.</p>
          </section>
          <section className="tarjeta" aria-labelledby="t-cobros" data-testid="cobros-turno">
            <h2 id="t-cobros" className="titulo-seccion">Cobros de visitas de este turno ({cobros.length})</h2>
            {cobros.length ? (
              <ul className="lista-simple">
                {cobros.map((c) => (
                  <li key={c.id} data-testid="cobro-turno">
                    {hora.format(c.registradaEn)} · {c.personas} {c.personas === 1 ? "persona" : "personas"} ·{" "}
                    <strong>{pesos.format(Number(c.total))}</strong>{" "}
                    {c.formaPago === "tarjeta" ? "con tarjeta · confirmado operativamente · liquidación pendiente de conciliar" : "en efectivo"} ·{" "}
                    <Link href={`/sucursales/${codigo}/turno/cobros/${c.id}`}>Ver detalle</Link>
                  </li>
                ))}
              </ul>
            ) : <p className="sub">Todavía no hay cobros de visitas.</p>}
          </section>
        </>
      ) : e.sucursal.inactiva ? (
        <p className="aviso aviso-info">Esta sucursal está desactivada: no se pueden abrir turnos.</p>
      ) : e.puedeAbrir && leerEntorno() !== "produccion" ? (
        <section className="tarjeta" aria-labelledby="t-abrir">
          <h2 id="t-abrir" className="titulo-seccion">Abrir turno en {e.sucursal.nombre}</h2>
          <p className="sub">Cuenta cada lugar por separado y escribe solo el total.</p>
          <FormularioApertura codigo={codigo} responsable={sesion.nombre} />
        </section>
      ) : (
        <p className="aviso aviso-info" data-testid="sin-turno">No hay turno abierto en {e.sucursal.nombre}.</p>
      )}
    </main>
  );
}

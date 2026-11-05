import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioApertura } from "@/components/FormularioApertura";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";
import { estadoTurno, type TipoLugar } from "@/lib/turnos";

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
          </section>
          <div className="lugares-turno">
            {t.lugares.map((l) => (
              <section key={l.tipo} className="tarjeta" data-testid={`lugar-${l.tipo}`} aria-label={NOMBRE[l.tipo]}>
                <h2 className="titulo-seccion">{NOMBRE[l.tipo]}</h2>
                <p className="cifra-reporte"><strong>{pesos.format(Number(l.contadoAlAbrir))}</strong> contado al abrir</p>
                <p className="sub">Responsable: <strong>{l.responsable}</strong>, desde {hora.format(l.responsableDesde)}</p>
                {l.tipo === "cajon_mensualidades" ? (
                  <p className="aviso aviso-info" data-testid="no-conciliado">No conciliado: faltan datos de Open Desk</p>
                ) : null}
              </section>
            ))}
          </div>
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

import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioAperturaCierre, FormularioTerminarApertura } from "@/components/Cierre";
import { pantallaApertura } from "@/lib/cierres";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { conPunto } from "@/lib/formato";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Abrir desde el cierre · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const firmado = (c: number) => (c < 0 ? "−" : c > 0 ? "+" : "") + pesos.format(Math.abs(c) / 100);
const cent = (v: string) => Math.round(Number(v) * 100);
const MOTIVO: Record<string, string> = {
  sin_permiso: "Tu cuenta no puede abrir turno en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada.",
  sin_cierre: "No hay un cierre pendiente de apertura en esta sucursal.",
  otra_persona: "Otra persona ya empezó a abrir desde este cierre: ella termina la apertura.",
  bloqueado_produccion: "La apertura está desactivada fuera del entorno de pruebas.",
};
const VERIFICACION: Record<string, string> = { correcto: "Cerrado y con su folio", abierto: "Abierto o sello roto", otro_folio: "Otro folio", falta: "No está" };

/** Apertura desde el cierre: verificar sobres, contar a ciegas y, si no coincide, recontar con el custodio. */
export default async function AperturaDesdeCierre({ params, searchParams }: PageProps<"/sucursales/[codigo]/turno/apertura">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const { aviso } = await searchParams;
  const p = await pantallaApertura(obtenerBaseDatos()!, sesion.usuarioId, codigo, leerEntorno());
  if (!p.ok && p.error === "no_encontrada") notFound();
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Abrir turno desde el cierre{p.ok ? ` · ${p.sucursal}` : ""}</h1>
      {!p.ok ? (
        <p className="aviso aviso-info" data-testid="apertura-impedida">{MOTIVO[p.error] ?? "No disponible."}</p>
      ) : (
        <>
          <p className="sub">
            Cerró <strong>{p.cierre.cerradoPor}</strong> · {conPunto(hora.format(p.cierre.cerradoEn))} Custodio nocturno: <strong>{p.cierre.custodio}</strong>
            {p.cierre.custodia ? <> · guardó los sobres en {p.cierre.custodia.ubicacion}.</> : <> · <strong>sin confirmar la custodia</strong>.</>}
            {" "}Solo datos ficticios.
          </p>
          {p.cierre.cerradoPorId === sesion.usuarioId ? (
            <p className="aviso aviso-info" data-testid="misma-persona">Tú cerraste este turno. Puedes abrirlo; el historial lo muestra y la revisión la hace alguien que no participó.</p>
          ) : null}
          {p.cierre.sinCustodia ? (
            <p className="aviso aviso-info" data-testid="abierto-sin-custodia">Se abre sin la confirmación del custodio. Motivo: «{p.cierre.sinCustodia}». Queda por revisar.</p>
          ) : null}
          {p.recuento ? (
            <>
              <p className="aviso aviso-error" role="status" data-testid="aviso-recuento">
                {aviso === "recuento" ? "Tu conteo no coincide con el cierre. " : ""}Pide un recuento con {p.cierre.custodio} si está disponible.
              </p>
              <section className="tarjeta">
                <table className="tabla" data-testid="tabla-recuento-apertura">
                  <thead><tr><th>Lugar</th><th>Cerró</th><th>Contaste al abrir</th><th>Diferencia</th></tr></thead>
                  <tbody>
                    {(["bolsa", "cajon"] as const).map((l) => (
                      <tr key={l}>
                        <td data-etiqueta="Lugar">{l === "bolsa" ? "Bolsa de visitas" : "Cajón de mensualidades"}</td>
                        <td data-etiqueta="Cerró">{pesos.format(Number(p.recuento!.cerrado[l]))}</td>
                        <td data-etiqueta="Contaste al abrir">{pesos.format(Number(p.recuento!.inicial[l]))}</td>
                        <td data-etiqueta="Diferencia">{firmado(cent(p.recuento!.inicial[l]) - cent(p.recuento!.cerrado[l]))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="lista-simple">
                  {p.recuento.verificacion.map((s) => (
                    <li key={s.id}>Sobre <span className="mono">{s.folio}</span>: {s.apertura ? VERIFICACION[s.apertura.estado] : "—"}{s.apertura?.motivo ? ` · ${s.apertura.motivo}` : ""}</li>
                  ))}
                </ul>
                <FormularioTerminarApertura codigo={codigo} entregaId={p.cierre.entregaId} version={p.cierre.version} custodio={p.cierre.custodio} />
              </section>
            </>
          ) : (
            <section className="tarjeta">
              <FormularioAperturaCierre codigo={codigo} entregaId={p.cierre.entregaId} version={p.cierre.version} sobres={p.cierre.sobres} apoyos={p.apoyos}
                custodioSinConfirmar={p.cierre.custodia ? null : p.cierre.custodio} />
            </section>
          )}
        </>
      )}
    </main>
  );
}

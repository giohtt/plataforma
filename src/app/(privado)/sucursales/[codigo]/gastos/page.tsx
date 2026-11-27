import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioSolicitud } from "@/components/Gastos";
import { obtenerBaseDatos } from "@/lib/db";
import { pantallaGastos } from "@/lib/gastos";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Gastos · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

/**
 * Gastos de la sucursal (bloque 6, PR 3): solicitar y consultar. Sin gasto.solicitar ni gasto.consultar en la sucursal:
 * «No encontrada». Quien solo solicita ve lo que pidió.
 */
export default async function Gastos({ params }: PageProps<"/sucursales/[codigo]/gastos">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const p = await pantallaGastos(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!p) notFound();
  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={`/sucursales/${p.sucursal.codigo}`}>← {p.sucursal.nombre}</Link></p>
      <h1 className="cabecera-titulo">Gastos · {p.sucursal.nombre}</h1>
      <p className="sub">Solo datos ficticios. Solicitar no mueve dinero ni autoriza el gasto.</p>

      {p.puedeSolicitar ? (
        <details className="tarjeta" data-testid="solicitar-gasto">
          <summary className="titulo-seccion" data-testid="abrir-solicitud">Solicitar gasto</summary>
          <FormularioSolicitud codigo={p.sucursal.codigo} sucursalId={p.sucursal.id} categorias={p.categorias} sucursales={p.sucursalesPaga} compras={p.compras} />
        </details>
      ) : null}

      <section className="tarjeta" aria-labelledby="t-gastos" data-testid="lista-gastos">
        <h2 id="t-gastos" className="titulo-seccion">{p.consultaTodos ? "Solicitudes de la sucursal" : "Tus solicitudes"}</h2>
        {p.gastos.length ? (
          <div className="tabla-desplazable">
            <table className="tabla">
              <thead><tr><th>Clave</th><th>Concepto</th><th>Categoría</th><th>Importe</th><th>Sucursales</th><th>Solicitó</th><th>Estado</th></tr></thead>
              <tbody>
                {p.gastos.map((g) => (
                  <tr key={g.id} data-testid="gasto">
                    <td data-etiqueta="Clave"><Link href={`/sucursales/${p.sucursal.codigo}/gastos/${g.clave}`}><span className="clave-caso">{g.clave}</span></Link></td>
                    <td data-etiqueta="Concepto">{g.concepto}{g.compraDe ? <><br /><span className="sub">Parte de {g.compraDe}</span></> : null}</td>
                    <td data-etiqueta="Categoría">{g.categoria}</td>
                    <td data-etiqueta="Importe" style={{ whiteSpace: "nowrap" }}>{pesos.format(Number(g.importe))}</td>
                    <td data-etiqueta="Sucursales">{g.pagaOtra ? <>Para {g.beneficiada}<br /><span className="sub">Paga {g.paga}</span></> : g.beneficiada}</td>
                    <td data-etiqueta="Solicitó">{g.solicitadoPor}<br /><span className="sub">{fechaHora.format(g.solicitadoEn)}</span></td>
                    <td data-etiqueta="Estado">Solicitado{g.version > 1 ? <><br /><span className="sub">Versión {g.version}</span></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub" data-testid="sin-gastos">No hay solicitudes de gasto.</p>}
      </section>
    </main>
  );
}

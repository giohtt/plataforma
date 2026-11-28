import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { bandejaGastos, NOMBRE_COMPROBACION, NOMBRE_ESTADO_GASTO, NOMBRE_REEMBOLSO, TEXTO_IMPEDIMENTO, type VistaBandeja } from "@/lib/gastos";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Bandeja de gastos · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const VISTAS: [VistaBandeja, string][] = [
  ["tuyos", "Puedes decidir"], ["por_autorizar", "Por autorizar"], ["autorizados", "Autorizados"], ["rechazados", "Rechazados"],
  ["reembolsos", "Reembolsos por decidir"], ["sin_autorizacion", "Pagados sin autorización previa"], ["todos", "Todos"],
];

/**
 * Bandeja de seguimiento (bloque 6, PR 4): todos los gastos de las sucursales donde la persona consulta gastos, aunque
 * los decida otra persona (avisar no es autorizar). Sin gasto.consultar en ninguna sucursal: «No encontrada».
 */
export default async function BandejaGastos({ searchParams }: PageProps<"/gastos">) {
  const sesion = await requerirSesion();
  const { vista } = await searchParams;
  const b = await bandejaGastos(obtenerBaseDatos()!, sesion.usuarioId, typeof vista === "string" ? vista : "");
  if (!b) notFound();
  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href="/">← Inicio</Link></p>
      <h1 className="cabecera-titulo">Bandeja de gastos</h1>
      <p className="sub">Todos los gastos de tus sucursales, aunque los decida otra persona. Verlos aquí no los autoriza. Solo datos ficticios.</p>
      <nav className="filtros-bandeja" aria-label="Vistas" data-testid="vistas-bandeja">
        {VISTAS.map(([v, t]) => (
          <Link key={v} href={`/gastos?vista=${v}`} className={v === b.vista ? "boton boton-chico boton-principal" : "boton boton-chico"}
            aria-current={v === b.vista ? "page" : undefined} data-testid={`vista-${v}`}>
            {t} ({b.cuentas[v]})
          </Link>
        ))}
      </nav>
      <section className="tarjeta" data-testid="bandeja-gastos">
        {b.gastos.length ? (
          <div className="tabla-desplazable">
            <table className="tabla">
              <thead><tr><th>Clave</th><th>Sucursal</th><th>Concepto</th><th>Importe</th><th>Solicitó</th><th>Estado</th></tr></thead>
              <tbody>
                {b.gastos.map((g) => (
                  <tr key={g.id} data-testid="fila-bandeja">
                    <td data-etiqueta="Clave"><Link href={`/sucursales/${g.codigo}/gastos/${g.clave}`}><span className="clave-caso">{g.clave}</span></Link></td>
                    <td data-etiqueta="Sucursal">{g.beneficiada}{g.pagaOtra ? <><br /><span className="sub">Paga {g.paga}</span></> : null}</td>
                    <td data-etiqueta="Concepto">{g.concepto}</td>
                    <td data-etiqueta="Importe" style={{ whiteSpace: "nowrap" }}>{pesos.format(Number(g.importe))}</td>
                    <td data-etiqueta="Solicitó">{g.solicitadoPor}<br /><span className="sub">{fechaHora.format(g.solicitadoEn)}</span></td>
                    <td data-etiqueta="Estado">
                      {NOMBRE_ESTADO_GASTO[g.estado]}{g.origenPago ? " · pagado" : ""}{g.comprobacion && g.comprobacion !== "comprobado" ? <><br /><span className="sub">{NOMBRE_COMPROBACION[g.comprobacion]}</span></> : null}{g.decididoPor ? ` por ${g.decididoPor}` : ""}
                      {g.reembolso ? <><br /><span className="sub" data-testid="reembolso-bandeja">{NOMBRE_REEMBOLSO[g.reembolso]}</span></> : null}
                      {g.estado === "por_autorizar" ? (
                        g.impedimento === null ? <><br /><strong className="sub">Puedes decidirlo</strong></>
                          : g.impedimento !== "sin_facultad" ? <><br /><span className="sub">{TEXTO_IMPEDIMENTO[g.impedimento]}</span></> : null
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub" data-testid="bandeja-vacia">No hay gastos en esta vista.</p>}
      </section>
    </main>
  );
}

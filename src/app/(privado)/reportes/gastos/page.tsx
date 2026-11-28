import Link from "next/link";
import { notFound } from "next/navigation";
import { NOMBRE_AUTORIZACION_PREVIA, NOMBRE_ORIGEN, NOMBRE_REEMBOLSO } from "@/lib/datos-gasto";
import { obtenerBaseDatos } from "@/lib/db";
import { NOMBRE_GRUPO, NOMBRE_VISTA, reporteGastos, VISTAS, type Vista } from "@/lib/reporte-gastos";
import { requerirSesion } from "@/lib/sesion-servidor";
import { $, fecha, hora, texto } from "../caja/comun";
import { PanelDescarga } from "../caja/panel-descarga";

export const metadata = { title: "Gastos · Reportes · Fitnessland" };

const ERRORES: Record<string, string> = {
  no_encontrada: "No consultas gastos en esa sucursal.",
  formato: "Elige Excel o PDF, y resumen o resumen con detalle.",
  bloqueado_produccion: "Las descargas están desactivadas fuera del entorno de pruebas.",
};
const LUGAR: Record<string, string> = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" };
const diaPago = (f: string) => fecha(f);

/**
 * Reporte de gastos (bloque 6, PR 9). Sin «Consultar gastos» en ninguna sucursal (o en la pedida): «No encontrada».
 * Periodo por la fecha del pago al proveedor; nada registrado después del corte.
 */
export default async function ReporteGastosPagina({ searchParams }: PageProps<"/reportes/gastos">) {
  const sesion = await requerirSesion();
  const q = await searchParams;
  const pedida = texto(q.sucursal, 10);
  const vista: Vista = VISTAS.find((v) => v === texto(q.vista, 12)) ?? "estado";
  const r = await reporteGastos(obtenerBaseDatos()!, sesion.usuarioId, {
    codigo: pedida && pedida !== "todas" ? pedida : null, desde: texto(q.desde, 10), hasta: texto(q.hasta, 10), corte: texto(q.corte),
  });
  if (!r) notFound();
  const error = texto(q.error, 30);
  const base = { sucursal: r.codigo ?? "todas", desde: r.desde, hasta: r.hasta, corte: r.corte.toISOString() };
  const enlaceVista = (v: Vista) => `/reportes/gastos?${new URLSearchParams({ ...base, vista: v })}`;
  const nombre = r.codigo === null ? "Todas tus sucursales" : r.sucursales.find((s) => s.codigo === r.codigo)?.nombre ?? r.codigo;

  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={r.codigo ? `/sucursales/${r.codigo}` : "/"}>← {r.codigo ? nombre : "Inicio"}</Link></p>
      <div className="cabecera-caja">
        <div>
          <h1 className="cabecera-titulo">Gastos</h1>
          <p className="sub" data-testid="corte">
            <b>{nombre}</b> · {fecha(r.desde)} al {fecha(r.hasta)} (por la fecha del pago al proveedor) · corte <b>{hora.format(r.corte)}</b>
          </p>
        </div>
        <PanelDescarga sucursal={base.sucursal} desde={r.desde} hasta={r.hasta} corte={base.corte} corteTexto={hora.format(r.corte)}
                       incluidas={[]} excluidas={[]} accion="/reportes/gastos/descargar" detalle="Con detalle (historial de gastos)"
                       aviso="Mismo corte ({corte}) y mismas claves; las fotos no van en el archivo. Queda registrada la descarga." />
      </div>
      {error && ERRORES[error] ? <p className="aviso aviso-error" role="alert" data-testid="error-descarga">{ERRORES[error]}</p> : null}

      <details className="cambiar-caja" data-testid="cambiar">
        <summary>Cambiar sucursal o periodo</summary>
        <form className="filtros-reporte" method="get" action="/reportes/gastos" data-testid="filtros">
          <div className="campo">
            <label htmlFor="sucursal">Sucursal (a la que se carga el gasto)</label>
            <select id="sucursal" name="sucursal" defaultValue={r.codigo ?? "todas"}>
              {r.sucursales.length > 1 ? <option value="todas">Todas mis sucursales</option> : null}
              {r.sucursales.map((s) => <option key={s.codigo} value={s.codigo}>{s.nombre}</option>)}
            </select>
          </div>
          <div className="campo"><label htmlFor="desde">Desde</label><input id="desde" name="desde" type="date" defaultValue={r.desde} required /></div>
          <div className="campo"><label htmlFor="hasta">Hasta</label><input id="hasta" name="hasta" type="date" defaultValue={r.hasta} required /></div>
          <input type="hidden" name="vista" value={vista} />
          <button className="boton" type="submit">Ver</button>
        </form>
      </details>
      {r.periodoInvalido ? (
        <p className="aviso aviso-error" role="alert" data-testid="periodo-invalido">
          El periodo no es válido (fechas incompletas, futuras, «desde» después de «hasta» o más de un año). Se muestran los últimos 7 días.
        </p>
      ) : null}

      <section className="tarjeta" aria-labelledby="t-total" data-testid="resumen-gastos">
        <h2 id="t-total" className="titulo-seccion">Gastado en el periodo</h2>
        <div className="total-caja">
          <div>
            <strong>Total gastado · {r.total.n} {r.total.n === 1 ? "gasto" : "gastos"}</strong>
            <p className="total-limitacion">Cada gasto se suma una sola vez, por lo pagado, aunque tenga varios pendientes. Anticipo y reembolso son pasos del mismo dinero.</p>
          </div>
          <p className="cifra-grande" data-testid="total-gastado">{$(r.total.importe)}</p>
        </div>
        <nav className="pestanas-caja" aria-label="Vistas" data-testid="vistas">
          {VISTAS.map((v) => (
            <Link key={v} prefetch={false} href={enlaceVista(v)} aria-current={v === vista ? "page" : undefined}
                  className={v === vista ? "boton boton-chico boton-principal" : "boton boton-chico"} data-testid={`vista-${v}`}>{NOMBRE_VISTA[v]}</Link>
          ))}
        </nav>
        <ul className="renglones" data-testid={`renglones-${vista}`}>
          {r.vistas[vista].map((x) => (
            <li key={x.etiqueta} data-testid="renglon-vista">
              <span>{x.etiqueta}<span className="renglon-detalle">{x.n} {x.n === 1 ? "gasto" : "gastos"}</span></span>
              <span className="renglon-importe">{$(x.importe)}</span>
            </li>
          ))}
        </ul>
        {!r.vistas[vista].length ? <p className="sub">Sin gastos pagados en el periodo.</p> : null}
        <h3>Aparte, al corte (no se suman al total)</h3>
        <ul className="renglones" data-testid="aparte">
          <li><span>Por autorizar ({r.aparte.porAutorizar.n}) · compromiso</span><span className="renglon-importe sin-corte">{$(r.aparte.porAutorizar.importe)}</span></li>
          <li><span>Autorizados sin pagar ({r.aparte.autorizadosSinPagar.n}) · compromiso</span><span className="renglon-importe sin-corte">{$(r.aparte.autorizadosSinPagar.importe)}</span></li>
          <li data-testid="aparte-anticipos"><span>Fuera de caja: anticipos por comprobar ({r.aparte.anticiposPorComprobar.n})</span><span className="renglon-importe sin-corte">{$(r.aparte.anticiposPorComprobar.importe)}</span></li>
          <li data-testid="aparte-cambio"><span>Fuera de caja: cambio de anticipos por devolver ({r.aparte.cambioPorDevolver.n})</span><span className="renglon-importe sin-corte">{$(r.aparte.cambioPorDevolver.importe)}</span></li>
          <li><span>Rechazados en el periodo ({r.aparte.rechazados.n})</span><span className="renglon-importe sin-corte">{$(r.aparte.rechazados.importe)}</span></li>
        </ul>
      </section>

      <section className="tarjeta" aria-labelledby="t-detalle" data-testid="detalle-gastos">
        <h2 id="t-detalle" className="titulo-seccion">Detalle por clave</h2>
        {r.filas.length ? (
          <div className="tabla-desplazable">
            <table className="tabla">
              <thead><tr><th>Clave</th><th>Concepto</th><th>Se carga a</th><th>Origen</th><th>Autorizó</th><th>Pago al proveedor</th><th>Registrado</th><th>Importe</th><th>Estado</th></tr></thead>
              <tbody>
                {r.filas.map((f) => (
                  <tr key={f.id} data-testid="fila-gasto">
                    <td data-etiqueta="Clave"><Link prefetch={false} href={`/sucursales/${f.codigo}/gastos/${f.clave}`}><span className="clave-caso">{f.clave}</span></Link></td>
                    <td data-etiqueta="Concepto">{f.concepto}<br /><span className="sub">{f.categoria}{f.compraDe ? ` · parte de ${f.compraDe}` : ""}</span></td>
                    <td data-etiqueta="Se carga a">{f.beneficiada}{f.pagaOtra ? <><br /><span className="sub">Pagó {f.paga}</span></> : null}</td>
                    <td data-etiqueta="Origen">{NOMBRE_ORIGEN[f.origen]}{f.origen === "anticipo" && f.lugar ? ` · ${LUGAR[f.lugar]}` : ""}{f.turnoCerrado ? <><br /><span className="sub">Turno cerrado</span></> : null}
                      {f.anticipo ? <><br /><span className="sub">Entregado {hora.format(f.anticipo.entregadoEn)} · comprobado {hora.format(f.anticipo.comprobadoEn)}</span></> : null}</td>
                    <td data-etiqueta="Autorizó">{f.autorizo ?? "Sin autorización"}<br /><span className="sub">{NOMBRE_AUTORIZACION_PREVIA[f.autorizacionPrevia]}</span></td>
                    <td data-etiqueta="Pago al proveedor">{diaPago(f.pagadoEl)}{f.horaDeclarada ? <> · {f.horaDeclarada} <span className="sub">(declarada)</span></> : null}</td>
                    <td data-etiqueta="Registrado">{hora.format(f.registradoEn)}</td>
                    <td data-etiqueta="Importe" style={{ whiteSpace: "nowrap" }}>{$(f.importe)}</td>
                    <td data-etiqueta="Estado" data-testid="estado-gasto-reporte">{NOMBRE_GRUPO[f.grupo]}{f.pendientes.length > 1 ? <><br /><span className="sub">{f.pendientes.join(" · ")}</span></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub">Sin gastos pagados en el periodo.</p>}
        <p className="sub">Las fotos de los comprobantes no van en el Excel ni en el PDF: se consultan aquí con la clave.</p>
      </section>

      <section className="tarjeta" aria-labelledby="t-anticipos" data-testid="anticipos-reporte">
        <h2 id="t-anticipos" className="titulo-seccion">Anticipos</h2>
        {r.anticipos.length ? (
          <ul className="renglones">
            {r.anticipos.map((x) => (
              <li key={x.clave} data-testid="fila-anticipo">
                <span><Link prefetch={false} href={`/sucursales/${x.codigo}/gastos/${x.clave}`} className="mono">{x.clave}</Link> · {x.concepto}
                  <span className="renglon-detalle">
                    Entregado {hora.format(x.entregadoEn)} ({LUGAR[x.lugar]}) a {x.recibe}
                    {x.comprobado ? ` · comprobado ${hora.format(x.comprobado.en)} · pago al proveedor ${diaPago(x.comprobado.pagadoEl)} por ${$(x.comprobado.gastado)}` : ""}
                    {Number(x.cambio) > 0 ? ` · cambio ${$(x.cambio)} (devuelto ${$(x.devuelto)})` : ""}
                    {x.excedente ? ` · excedente ${x.excedente.clave} ${$(x.excedente.importe)} (${x.excedente.estado}${x.excedente.reembolso ? ` · ${NOMBRE_REEMBOLSO[x.excedente.reembolso]}` : ""})` : ""}
                    {" · "}{x.estado}
                  </span>
                </span>
                <span className="renglon-importe">{$(x.entregado)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="sub">Sin anticipos en el periodo ni abiertos al corte.</p>}
      </section>

      <section className="tarjeta" aria-labelledby="t-reembolsos" data-testid="reembolsos-reporte">
        <h2 id="t-reembolsos" className="titulo-seccion">Reembolsos</h2>
        {r.reembolsos.length ? (
          <ul className="renglones">
            {r.reembolsos.map((x) => (
              <li key={x.clave} data-testid="fila-reembolso">
                <span><Link prefetch={false} href={`/sucursales/${x.codigo}/gastos/${x.clave}`} className="mono">{x.clave}</Link> · {x.concepto}
                  <span className="renglon-detalle">Puso el dinero {x.puso} · pagado el {diaPago(x.pagadoEl)} · {NOMBRE_REEMBOLSO[x.estado]}</span>
                </span>
                <span className="renglon-importe">{$(x.importe)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="sub">Sin reembolsos en el periodo ni pendientes al corte.</p>}
        <p className="sub">Un reembolso no es un gasto nuevo: el gasto ya contó cuando se pagó con dinero personal.</p>
      </section>
    </main>
  );
}

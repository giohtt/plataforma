import Link from "next/link";
import { notFound } from "next/navigation";
import { LEYENDA_ANOTADOS } from "@/lib/archivo-caja";
import { obtenerBaseDatos } from "@/lib/db";
import { ETAPA_DIFERENCIA, historialDescargas, nombreLugar, reporteCaja, type CajaSucursal, type ReporteCaja } from "@/lib/reporte-caja";
import { aPesos, centavos, NOTA_RANGOS, RANGOS, resumirCaja, type FilaFolio } from "@/lib/resumen-caja";
import { requerirSesion } from "@/lib/sesion-servidor";
import { $, Anterior, diaCorto, enlaceDetalle, enlaceMas, fecha, hora, Importe, texto } from "../comun";
import { PanelDescarga } from "../panel-descarga";

export const metadata = { title: "Más detalle · Caja y depósitos · Fitnessland" };

const VISTAS = { movimientos: "Movimientos", folio: "Por folio", origen: "Origen y destino", diferencias: "Diferencias", descargas: "Descargas" } as const;
type Vista = keyof typeof VISTAS;
const ETAPAS: Record<string, string> = {
  "1": "1. En la sucursal", "2": "2. Sobres por recoger", "3": "3. Entregado, pendiente de confirmar", "4": "4. Confirmado, por depositar",
  investigar: "Aparte: sobres por investigar", entrada: "Aparte: entradas al fondo sin confirmar",
};

function PorFolio({ r, filas, varias, filtros }: { r: ReporteCaja; filas: FilaFolio[]; varias: boolean; filtros: { etapa?: string; persona?: string; rango?: string; solo?: string } }) {
  const personas = [...new Set(filas.map((f) => f.quien))].sort();
  const vistas = filas.filter((f) => (!filtros.etapa || f.etapa === filtros.etapa) && (!filtros.persona || f.quien === filtros.persona)
    && (!filtros.rango || String(f.rango) === filtros.rango) && (filtros.solo !== "atrasados" || f.atrasado));
  return (
    <section className="tarjeta" data-testid="vista-folio">
      <form className="filtros-reporte" method="get" action="/reportes/caja/mas" data-testid="filtros-folio">
        <input type="hidden" name="sucursal" value={r.codigo ?? "todas"} />
        <input type="hidden" name="desde" value={r.desde} />
        <input type="hidden" name="hasta" value={r.hasta} />
        <input type="hidden" name="corte" value={r.corte.toISOString()} />
        <input type="hidden" name="vista" value="folio" />
        <div className="campo">
          <label htmlFor="etapa">Etapa</label>
          <select id="etapa" name="etapa" defaultValue={filtros.etapa ?? ""}>
            <option value="">Todas</option>
            {Object.entries(ETAPAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor="persona">Quién lo tiene</label>
          <select id="persona" name="persona" defaultValue={filtros.persona ?? ""}>
            <option value="">Todas las personas</option>
            {personas.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor="rango">Antigüedad</label>
          <select id="rango" name="rango" defaultValue={filtros.rango ?? ""}>
            <option value="">Cualquiera</option>
            {RANGOS.map((x, i) => <option key={x} value={String(i)}>{x}</option>)}
          </select>
        </div>
        <label className="casilla"><input type="checkbox" name="solo" value="atrasados" defaultChecked={filtros.solo === "atrasados"} /> Solo con 48 horas o más</label>
        <button className="boton" type="submit">Filtrar</button>
      </form>
      <div className="tabla-desplazable">
        <table className="tabla" data-testid="tabla-folios">
          <thead><tr>{varias ? <th>Sucursal</th> : null}<th>Folio o lugar</th><th>Etapa al corte</th><th>Quién lo tiene</th><th>Desde</th><th>Días</th><th>Antigüedad</th><th>Importe</th></tr></thead>
          <tbody>
            {vistas.map((f, i) => (
              <tr key={i} data-testid={`folio-${f.folio}`} className={f.suma ? undefined : "fila-aparte"}>
                {varias ? <td data-etiqueta="Sucursal">{f.sucursal}</td> : null}
                <td data-etiqueta="Folio o lugar"><span className={f.etapa === "1" || f.etapa === "entrada" ? undefined : "mono"}>{f.folio}</span><Anterior si={f.anterior} /></td>
                <td data-etiqueta="Etapa al corte">{f.etapaTexto}{f.atrasado ? <> · <b className="texto-incompleto">48 horas o más</b></> : null}</td>
                <td data-etiqueta="Quién lo tiene">{f.quien}</td>
                <td data-etiqueta="Desde" className="sin-corte">{f.desde ? diaCorto.format(f.desde) : "—"}</td>
                <td data-etiqueta="Días">{f.dias ?? "—"}</td>
                <td data-etiqueta="Antigüedad">{f.rango === null ? "—" : RANGOS[f.rango]}</td>
                <td data-etiqueta="Importe">
                  <Link prefetch={false} href={enlaceDetalle(r, f.codigo, f.enlace.tipo, f.enlace.id)}>
                    {f.importe === null ? <span className="importe-oculto">{f.estadoImporte}</span> : <strong>{$(f.importe)}</strong>}
                  </Link>
                  {f.importe !== null && f.estadoImporte !== "Contado" ? <span className="sub"> · {f.estadoImporte}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!vistas.length ? <p className="sub">Nada con estos filtros.</p> : null}
      <p className="sub">Cada fila abre su detalle e historial con este mismo corte. Lo de «Aparte» no se suma al total. {NOTA_RANGOS}</p>
    </section>
  );
}

/** Una fila corta por origen; sus depósitos, fechas e historial se abren al seleccionarla. */
function OrigenDestino({ r, c, varias }: { r: ReporteCaja; c: CajaSucursal; varias: boolean }) {
  const suma = (k: "antes" | "durante" | "saldo") => aPesos(c.origenes.reduce((n, o) => n + centavos(o[k]), 0));
  return (
    <section className="tarjeta" data-testid={`origen-${c.codigo}`}>
      {varias ? <h2 className="titulo-seccion">{c.nombre}</h2> : null}
      {c.origenes.length ? (
        <div className="origenes" data-testid="tabla-origen">
          <div className="origen-encabezado"><span>Origen</span><span>Depositado en el periodo</span><span>Saldo al corte</span></div>
          {c.origenes.map((o) => (
            <details key={`${o.clase}-${o.id}`} className="origen" data-testid="origen">
              <summary>
                <span className="origen-titulo">{o.clase === "retiro" ? `Retiro ${o.folios[0]}` : o.texto.split(" · ").slice(0, 2).join(" · ")}<Anterior si={o.anterior} /></span>
                <span className="n">{$(o.durante)}</span>
                <span className="n"><b>{$(o.saldo)}</b></span>
              </summary>
              <div className="origen-cuerpo" data-testid="origen-cuerpo">
                <span>
                  {o.clase === "retiro" ? "Registrado" : "Anotado"} {$(o.registrado)}
                  {Number(o.diferencia) ? <> · diferencia {$(o.diferencia)} ({o.claves.join(", ")})</> : null}
                  {" "}· contado <b>{$(o.contado)}</b> · {o.persona}{o.pausa ? " · en pausa por revisión: aún no se deposita" : ""}
                </span>
                {o.depositos.length ? (
                  <table className="tabla">
                    <thead><tr><th>Depósito</th><th>Referencia</th><th>Importe</th></tr></thead>
                    <tbody>
                      {o.depositos.map((d, i) => (
                        <tr key={i}>
                          <td data-etiqueta="Depósito">{fecha(d.fecha)} · {d.antes ? "antes del periodo" : "durante el periodo"}</td>
                          <td data-etiqueta="Referencia">{d.referencia}</td>
                          <td data-etiqueta="Importe">{$(d.importe)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <span className="sub">Sin depósitos hasta el corte.</span>}
                <span>
                  {o.clase === "recoleccion" && o.folios.length ? <>Sobres {o.folios.join(", ")} · </> : null}
                  <Link prefetch={false} href={enlaceDetalle(r, c.codigo, o.clase, o.id)}>Ver historial</Link>
                </span>
              </div>
            </details>
          ))}
          <div className="origen-encabezado origen-total" data-testid="origen-total">
            <span>Total</span><span data-testid="origen-durante">{$(suma("durante"))}</span><span data-testid="origen-saldo">{$(suma("saldo"))}</span>
          </div>
        </div>
      ) : <p className="sub">Sin depósitos en el periodo ni saldos por depositar al corte.</p>}
      <p className="sub">
        El depositado en el periodo y el saldo coinciden con el resumen. Al abrir una fila: lo anotado, la diferencia con su clave, lo contado y cada depósito
        (antes o durante el periodo). Lo depositado antes del periodo ({$(suma("antes"))}) es solo referencia.
      </p>
    </section>
  );
}

/** Movimientos del periodo: pasos del mismo dinero, no se suman entre sí ni con los saldos. */
function Movimientos({ r, c, varias }: { r: ReporteCaja; c: CajaSucursal; varias: boolean }) {
  const m = c.movimientos;
  return (
    <section className="tarjeta" data-testid={`movimientos-${c.codigo}`}>
      {varias ? <h2 className="titulo-seccion">{c.nombre}</h2> : null}
      <ul className="renglones">
        <li>
          <details>
            <summary>Sobres sellados al cerrar ({m.sellados.n})</summary>
            <ul>{m.lista.sellados.map((x) => <li key={x.id}><Link prefetch={false} href={enlaceDetalle(r, c.codigo, "sobre", x.id)}><span className="mono">{x.folio}</span></Link> · {hora.format(x.en)} · <Importe v={x.anotado} /></li>)}</ul>
          </details>
          {m.sellados.anotado === null ? <span className="importe-oculto">anotado oculto ({m.sellados.ocultos} sin contar)</span> : <span className="renglon-importe">{$(m.sellados.anotado)}</span>}
        </li>
        <li>
          <details>
            <summary>Recogido por Dirección, contado ({m.recogido.n})</summary>
            <ul>{m.lista.recogidas.map((x) => <li key={x.id}><Link prefetch={false} href={enlaceDetalle(r, c.codigo, "recoleccion", x.id)}>{hora.format(x.en)}</Link> · {x.recibe} · {$(x.importe)}</li>)}</ul>
          </details>
          <span className="renglon-importe">{$(m.recogido.importe)}</span>
        </li>
        <li>
          <details>
            <summary>Entregado a Encargada de retiros ({m.retiros.n}: {m.retiros.confirmados} confirmados, {m.retiros.pendientes} por confirmar)</summary>
            <ul>{m.lista.retiros.map((x) => <li key={x.id}><Link prefetch={false} href={enlaceDetalle(r, c.codigo, "retiro", x.id)}><span className="mono">{x.folio}</span></Link> · {hora.format(x.en)} · <Importe v={x.importe} />{x.pendiente ? " · por confirmar" : ""}</li>)}</ul>
          </details>
          <span className="renglon-importe">{$(m.retiros.importe)}{m.retiros.ocultos ? <span className="importe-oculto"> + {m.retiros.ocultos} oculto</span> : null}</span>
        </li>
        <li><span>Entradas al fondo recibidas ({m.entradasFondo.n})</span><span className="renglon-importe">{$(m.entradasFondo.importe)}</span></li>
        <li><span>Depositado en el banco ({m.depositado.n})</span><span className="renglon-importe">{$(m.depositado.importe)}</span></li>
      </ul>
      <p className="sub">
        Son pasos del mismo dinero: no se suman entre sí ni con los saldos. Los cobros de visitas están en el{" "}
        <Link prefetch={false} href={`/reportes/visitas?${new URLSearchParams({ sucursal: c.codigo, desde: r.desde, hasta: r.hasta })}`}>reporte de visitas</Link>;
        las mensualidades no se calculan (faltan datos de Open Desk).
      </p>
    </section>
  );
}

/** Diferencias agrupadas por etapa: por revisar, pendiente de resolución, corrección pendiente y cerradas. */
function Diferencias({ r, c, varias }: { r: ReporteCaja; c: CajaSucursal; varias: boolean }) {
  const neto = aPesos(c.diferencias.filter((d) => d.neto).reduce((n, d) => n + centavos(d.importe), 0));
  const operativo = (d: CajaSucursal["diferencias"][number]) =>
    d.clase === "retiro_importe" ? `/sucursales/${c.codigo}/retiros/${d.id}` : d.clase === "sobre" ? `/sucursales/${c.codigo}/recoleccion` : null;
  const ACCION: Record<string, string> = { por_revisar: "Ir a revisar", pendiente_resolucion: "Ir a resolver", correccion_pendiente: "Ver el caso", cerrada: "Ver el caso" };
  return (
    <section className="tarjeta" data-testid={`diferencias-${c.codigo}`}>
      {varias ? <h2 className="titulo-seccion">{c.nombre}</h2> : null}
      {(["por_revisar", "pendiente_resolucion", "correccion_pendiente", "cerrada"] as const).map((etapa) => {
        const lista = c.diferencias.filter((d) => d.etapa === etapa);
        if (!lista.length) return null;
        return (
          <div key={etapa} data-testid={`etapa-${etapa}`}>
            <h3 className="grupo-etapa">{ETAPA_DIFERENCIA[etapa]}{etapa === "cerrada" ? " (del periodo o de un origen mostrado)" : ""}</h3>
            <ul className="renglones">
              {lista.map((d) => (
                <li key={`${d.clase}-${d.id}`} data-testid="diferencia">
                  <span>
                    <b>{d.clave}</b> · {d.texto}<Anterior si={d.anterior} />
                    <span className="renglon-detalle">
                      {nombreLugar(d.lugar)} · registrada {hora.format(d.registradaEn)} · {d.estado}
                      {d.referencia ? " · solo referencia de su origen (no entra en el neto)" : ""}
                    </span>
                    <span className="renglon-detalle">
                      <Link prefetch={false} href={enlaceDetalle(r, c.codigo, d.enlace.tipo, d.enlace.id)}>Historial al corte</Link>
                      {operativo(d) && etapa !== "cerrada" ? <> · <Link prefetch={false} href={operativo(d)!}>{ACCION[etapa]}</Link></> : null}
                    </span>
                  </span>
                  <span className="renglon-importe">{$(d.importe)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {!c.diferencias.length ? <p className="sub">Sin diferencias del periodo ni anteriores abiertas al corte.</p> : null}
      <p className="sub">
        Ninguna se suma al efectivo ni se descuenta a ninguna persona. Neto de referencia {$(neto)} (el neto no cierra ningún caso).
      </p>
    </section>
  );
}

export default async function MasDetalle({ searchParams }: PageProps<"/reportes/caja/mas">) {
  const sesion = await requerirSesion();
  const q = await searchParams;
  const pedida = texto(q.sucursal, 10);
  const vista: Vista = (Object.keys(VISTAS) as Vista[]).find((v) => v === texto(q.vista, 15)) ?? "movimientos";
  const sql = obtenerBaseDatos()!;
  const r = await reporteCaja(sql, sesion.usuarioId, {
    codigo: pedida && pedida !== "todas" ? pedida : null, desde: texto(q.desde, 10), hasta: texto(q.hasta, 10), corte: texto(q.corte),
  });
  if (!r) notFound();
  const varias = r.filas.length > 1;
  const pedidas = r.filas.map((f) => f.codigo);
  const descargables = r.sucursales.filter((x) => x.descargar && pedidas.includes(x.codigo));
  const noDescargables = r.sucursales.filter((x) => !x.descargar && pedidas.includes(x.codigo));
  const sucursal = r.codigo ?? "todas";
  const volver = `/reportes/caja?${new URLSearchParams({ sucursal, desde: r.desde, hasta: r.hasta, corte: r.corte.toISOString() })}`;
  const folios = r.filas.flatMap((c) => resumirCaja(c, r.corte).folios);
  const descargas = vista === "descargas" ? await historialDescargas(sql, r.filas.map((f) => f.id)) : [];
  const filtros = { etapa: texto(q.etapa, 12), persona: texto(q.persona, 120), rango: texto(q.rango, 1), solo: texto(q.solo, 10) };

  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={volver}>← Caja y depósitos · {r.filas.map((f) => f.nombre).join(", ")} · corte {hora.format(r.corte)}</Link></p>
      <div className="cabecera-caja">
        <div>
          <h1 className="cabecera-titulo">Más detalle</h1>
          <p className="sub" data-testid="corte">
            <b>{r.filas.map((f) => f.nombre).join(", ")}</b> · {fecha(r.desde)} al {fecha(r.hasta)} · corte <b>{hora.format(r.corte)}</b> · mismo corte que el resumen
          </p>
        </div>
        {descargables.length ? (
          <PanelDescarga sucursal={sucursal} desde={r.desde} hasta={r.hasta} corte={r.corte.toISOString()} corteTexto={hora.format(r.corte)}
                         incluidas={descargables.map((x) => x.nombre)} excluidas={noDescargables.map((x) => x.nombre)} />
        ) : null}
      </div>
      {r.filas.some((f) => f.anotadosSinContar) ? <p className="aviso aviso-info">{LEYENDA_ANOTADOS}: no los recoges, por eso los ves.</p> : null}
      <nav className="pestanas-caja" aria-label="Más detalle">
        {(Object.keys(VISTAS) as Vista[]).map((v) => (
          <Link key={v} prefetch={false} href={enlaceMas(r, sucursal, v)} aria-current={v === vista ? "page" : undefined} className={v === vista ? "sel" : undefined}>{VISTAS[v]}</Link>
        ))}
      </nav>
      <h2 className="titulo-seccion">{VISTAS[vista]}</h2>

      {vista === "movimientos" ? r.filas.map((c) => <Movimientos key={c.codigo} r={r} c={c} varias={varias} />) : null}
      {vista === "folio" ? <PorFolio r={r} filas={folios} varias={varias} filtros={filtros} /> : null}
      {vista === "origen" ? r.filas.map((c) => <OrigenDestino key={c.codigo} r={r} c={c} varias={varias} />) : null}
      {vista === "diferencias" ? r.filas.map((c) => <Diferencias key={c.codigo} r={r} c={c} varias={varias} />) : null}
      {vista === "descargas" ? (
        <section className="tarjeta" data-testid="historial-descargas">
          {descargas.length ? (
            <ul className="lista-simple">
              {descargas.map((d, i) => (
                <li key={i}>
                  {hora.format(d.en)} · <b>{d.por}</b> · {d.sucursales.join(", ")} · {fecha(d.desde)} al {fecha(d.hasta)} · corte {hora.format(d.corte)} ·{" "}
                  {d.formato === "xlsx" ? "Excel" : "PDF"} · {d.contenido === "detalle" ? "con detalle" : "resumen"}
                  {d.conOcultos ? " · con importes ocultos" : ""}{d.conAnotados ? ` · «${LEYENDA_ANOTADOS}»` : ""}
                  {d.excluidas.length ? ` · sin ${d.excluidas.join(", ")} (sin permiso de descarga)` : ""}
                </li>
              ))}
            </ul>
          ) : <p className="sub">Nadie ha descargado este reporte.</p>}
          <p className="sub">El historial no se edita ni se borra.</p>
        </section>
      ) : null}
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { LEYENDA_ANOTADOS } from "@/lib/archivo-caja";
import { obtenerBaseDatos } from "@/lib/db";
import { reporteCaja, type CajaSucursal, type ReporteCaja } from "@/lib/reporte-caja";
import { aPesos, NOTA_RANGOS, RANGOS, resumirCaja, resumirVarias, type ResumenCaja } from "@/lib/resumen-caja";
import { requerirSesion } from "@/lib/sesion-servidor";
import { $, enlaceDetalle, enlaceMas, fecha, hora, Importe, Kpi, RecuadroTotal, texto } from "./comun";

export const metadata = { title: "Caja y depósitos · Fitnessland" };

const ERRORES: Record<string, string> = {
  sin_descarga: "No tienes «Descargar el reporte de caja» en esa sucursal.",
  no_encontrada: "No puedes consultar el reporte de caja de esa sucursal.",
  formato: "Elige Excel o PDF, y resumen o resumen con detalle.",
  bloqueado_produccion: "Las descargas están desactivadas fuera del entorno de pruebas.",
};

/** Atajos de periodo (fechas en la Ciudad de México; la semana va de lunes a domingo). */
function atajos(hoy: string) {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const f = (x: Date) => x.toISOString().slice(0, 10);
  const h = d(hoy);
  const lunes = new Date(h.getTime() - ((h.getUTCDay() + 6) % 7) * 86_400_000);
  const domingo = new Date(lunes.getTime() + 6 * 86_400_000);
  const inicioMes = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), 1));
  const finMes = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() + 1, 0));
  const inicioAnterior = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() - 1, 1));
  const finAnterior = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), 0));
  return [
    { nombre: "Hoy", desde: hoy, hasta: hoy },
    { nombre: "Esta semana", desde: f(lunes), hasta: f(domingo) },
    { nombre: "Este mes", desde: f(inicioMes), hasta: f(finMes) },
    { nombre: "Mes anterior", desde: f(inicioAnterior), hasta: f(finAnterior) },
  ];
}

function Resumen({ c, s, r }: { c: CajaSucursal; s: ResumenCaja; r: ReporteCaja }) {
  const m = c.movimientos;
  const mas = (vista: string, extra: Record<string, string> = {}) => enlaceMas(r, c.codigo, vista, extra);
  const ciegas = c.sobres.some((x) => x.oculto) || c.pendientes.some((p) => p.clase === "entrega_sobres" && p.oculto);
  const destinoAtencion: Record<string, string> = {
    atrasados: mas("folio", { solo: "atrasados" }), por_revisar: mas("diferencias"), correcciones: mas("diferencias"),
    investigar: mas("folio", { etapa: "investigar" }), entradas: mas("folio", { etapa: "entrada" }),
  };
  return (
    <>
      <section aria-labelledby="t-custodia" data-testid="custodia">
        <h2 id="t-custodia" className="titulo-seccion">¿Cuánto efectivo hay, dónde está y quién lo tiene?</h2>
        <p className="sub">Saldos <b>al corte</b>. Cada peso aparece en un solo lugar: al pasar al siguiente, sale del anterior.</p>
        <div className="kpis">
          <Kpi testid="kpi-sucursal" etiqueta="En la sucursal" cifra={s.enSucursal} href={mas("folio", { etapa: "1" })} />
          <Kpi testid="kpi-sobres" etiqueta="Sobres por recoger" cifra={s.sobres} href={mas("folio", { etapa: "2" })} />
          <Kpi testid="kpi-pendiente" etiqueta="Entregado, pendiente de confirmar" cifra={s.pendiente} href={mas("folio", { etapa: "3" })} />
          <Kpi testid="kpi-por-depositar" etiqueta="Confirmado, por depositar" cifra={s.porDepositar} href={mas("folio", { etapa: "4" })} />
        </div>
        {ciegas ? (
          <p className="aviso aviso-info" data-testid="aviso-ciegas">
            Como tu cuenta puede recoger sobres aquí, no ves lo anotado de los sobres que aún no cuentas (conteo a ciegas). En cuanto confirmas una
            recolección, lo que contaste aparece en «Confirmado, por depositar».
          </p>
        ) : null}
      </section>

      <RecuadroTotal t={s.total} ocultos={s.ocultos} />

      <div className="kpis">
        <Kpi testid="kpi-depositado" fuera etiqueta="Depositado durante el periodo" href={mas("origen")}
             cifra={{ importe: s.depositado.importe, ocultos: 0, nota: `Ya salió de la custodia: no se suma al total · ${s.depositado.n} ${s.depositado.n === 1 ? "depósito" : "depósitos"}` }} />
      </div>

      <section className="tarjeta" aria-labelledby="t-atencion" data-testid="atencion">
        <h2 id="t-atencion" className="titulo-seccion">Requiere atención</h2>
        <div className="atencion">
          {s.atencion.map((a) => (
            <div key={a.clave} className={`atencion-caso${a.n ? "" : " atencion-ok"}`} data-testid={`atencion-${a.clave}`}>
              <span>{a.texto}</span>
              <b>{a.n}</b>
              {a.n ? <Link prefetch={false} href={destinoAtencion[a.clave]}>{$(a.importe)}</Link> : <span className="sub">Ninguno</span>}
              <span className="sub">{a.nota}</span>
            </div>
          ))}
        </div>
        <p className="sub">Las diferencias, los sobres por investigar y las entradas al fondo sin confirmar van aparte: no se suman ni se restan del efectivo.</p>
      </section>

      <section className="tarjeta" aria-labelledby="t-personas" data-testid="por-persona">
        <h2 id="t-personas" className="titulo-seccion">Por depositar: quién lo tiene y desde cuándo</h2>
        {s.porPersona.length ? (
          <div className="tabla-desplazable">
            <table className="tabla">
              <thead><tr><th>Persona</th>{RANGOS.map((x) => <th key={x}>{x}</th>)}<th>Total</th></tr></thead>
              <tbody>
                {s.porPersona.map((p) => (
                  <tr key={p.persona} data-testid="persona">
                    <td data-etiqueta="Persona">{p.persona}{p.atrasados ? <> · <b className="texto-incompleto">{p.atrasados} con 48 horas o más</b></> : null}</td>
                    {p.rangos.map((v, i) => (
                      <td key={i} data-etiqueta={RANGOS[i]}>{v ? <Link prefetch={false} href={mas("folio", { etapa: "4", persona: p.persona })}>{$(aPesos(v))}</Link> : "—"}</td>
                    ))}
                    <td data-etiqueta="Total"><strong>{$(aPesos(p.total))}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub">Nada por depositar al corte.</p>}
        <p className="sub">{NOTA_RANGOS}</p>
      </section>

      <section className="tarjeta" aria-labelledby="t-durante" data-testid="durante">
        <h2 id="t-durante" className="titulo-seccion">Durante el periodo</h2>
        <p className="sub">Movimientos del {fecha(r.desde)} al {fecha(r.hasta)}, hasta el corte. Son pasos del mismo dinero: <b>no se suman entre sí ni con los saldos</b>.</p>
        <ul className="lista-simple">
          <li>
            <details>
              <summary>Sobres sellados al cerrar ({m.sellados.n}) · {m.sellados.anotado === null ? <span className="importe-oculto">anotado oculto ({m.sellados.ocultos} sin contar)</span> : <strong>{$(m.sellados.anotado)}</strong>}</summary>
              <ul>{m.lista.sellados.map((x) => <li key={x.id}><Link prefetch={false} href={enlaceDetalle(r, c.codigo, "sobre", x.id)}><span className="mono">{x.folio}</span></Link> · {hora.format(x.en)} · <Importe v={x.anotado} /></li>)}</ul>
            </details>
          </li>
          <li>
            <details>
              <summary>Recogido por Dirección, contado ({m.recogido.n}) · <strong>{$(m.recogido.importe)}</strong></summary>
              <ul>{m.lista.recogidas.map((x) => <li key={x.id}><Link prefetch={false} href={enlaceDetalle(r, c.codigo, "recoleccion", x.id)}>{hora.format(x.en)}</Link> · {x.recibe} · {$(x.importe)}</li>)}</ul>
            </details>
          </li>
          <li>
            <details>
              <summary>Entregado a Encargada de retiros ({m.retiros.n}: {m.retiros.confirmados} confirmados, {m.retiros.pendientes} pendientes de confirmar) · <strong>{$(m.retiros.importe)}</strong>{m.retiros.ocultos ? <span className="importe-oculto"> + {m.retiros.ocultos} oculto</span> : null}</summary>
              <ul>{m.lista.retiros.map((x) => <li key={x.id}><Link prefetch={false} href={enlaceDetalle(r, c.codigo, "retiro", x.id)}><span className="mono">{x.folio}</span></Link> · {hora.format(x.en)} · <Importe v={x.importe} />{x.pendiente ? " · pendiente de confirmar" : ""}</li>)}</ul>
            </details>
          </li>
          <li>Entradas al fondo recibidas ({m.entradasFondo.n}) · <strong>{$(m.entradasFondo.importe)}</strong></li>
          <li>Depositado en el banco ({m.depositado.n}) · <Link prefetch={false} href={mas("origen")}><strong>{$(m.depositado.importe)}</strong></Link></li>
        </ul>
        <p className="sub">
          Los cobros de visitas están en el{" "}
          <Link prefetch={false} href={`/reportes/visitas?${new URLSearchParams({ sucursal: c.codigo, desde: r.desde, hasta: r.hasta })}`}>reporte de visitas</Link>;
          las mensualidades no se calculan (faltan datos de Open Desk).
        </p>
      </section>
    </>
  );
}

function VariasSucursales({ r, filas }: { r: ReporteCaja; filas: { c: CajaSucursal; s: ResumenCaja }[] }) {
  const juntas = resumirVarias(filas.map((f) => ({ c: f.c, r: f.s })));
  const q = (codigo: string) => `/reportes/caja?${new URLSearchParams({ sucursal: codigo, desde: r.desde, hasta: r.hasta, corte: r.corte.toISOString() })}`;
  const celda = (x: { importe: string | null; ocultos: number }, extra = "") =>
    x.importe === null ? <span className="importe-oculto">{x.ocultos ? "Oculto: sin contar" : "Sin datos"}</span>
      : <>{$(x.importe)}{x.ocultos ? <span className="importe-oculto"> + {x.ocultos} oculto{x.ocultos === 1 ? "" : "s"}</span> : null}{extra ? <span className="importe-oculto"> {extra}</span> : null}</>;
  return (
    <>
      <section className="tarjeta" aria-labelledby="t-sucursales" data-testid="resumen-sucursales">
        <h2 id="t-sucursales" className="titulo-seccion">Por sucursal</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Sucursal</th><th>En la sucursal</th><th>Sobres por recoger</th><th>Pendiente de confirmar</th><th>Por depositar</th><th>Total al corte</th><th>Depositado en el periodo</th><th>Requiere atención</th></tr></thead>
            <tbody>
              {filas.map(({ c, s }) => (
                <tr key={c.codigo} data-testid={`resumen-${c.codigo}`}>
                  <td data-etiqueta="Sucursal"><Link prefetch={false} href={q(c.codigo)}>{c.nombre}</Link></td>
                  <td data-etiqueta="En la sucursal">{celda(s.enSucursal, s.enSucursal.importe !== null && s.lugaresSinDatos.length ? "+ sin datos" : "")}</td>
                  <td data-etiqueta="Sobres por recoger">{celda(s.sobres)}</td>
                  <td data-etiqueta="Pendiente de confirmar">{celda(s.pendiente)}</td>
                  <td data-etiqueta="Por depositar">{celda(s.porDepositar)}</td>
                  <td data-etiqueta="Total al corte">
                    {s.total.importe === null ? <span className="importe-oculto">Sin datos</span> : <strong>{$(s.total.importe)}</strong>}
                    {s.total.tipo === "subtotal" ? <span className="importe-oculto"> subtotal visible: faltan {s.total.faltan.join(" y ")}</span> : null}
                  </td>
                  <td data-etiqueta="Depositado en el periodo">{$(s.depositado.importe)}</td>
                  <td data-etiqueta="Requiere atención">{s.atencion.filter((a) => a.n).map((a) => `${a.texto}: ${a.n}`).join(" · ") || "Nada"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">Cada sucursal abre su reporte completo, con el mismo periodo y corte.</p>
      </section>
      <RecuadroTotal t={juntas.total} ocultos={filas.reduce((n, f) => n + f.s.ocultos, 0)} />
      <div className="kpis">
        <Kpi testid="kpi-depositado" fuera etiqueta="Depositado durante el periodo"
             cifra={{ importe: juntas.depositado.importe, ocultos: 0, nota: `Ya salió de la custodia: no se suma al total · ${juntas.depositado.n} ${juntas.depositado.n === 1 ? "depósito" : "depósitos"}` }} />
      </div>
    </>
  );
}

/** Solo consulta. Sin «Consultar el reporte de caja» en la sucursal pedida: «No encontrada». */
export default async function ReporteCajaPagina({ searchParams }: PageProps<"/reportes/caja">) {
  const sesion = await requerirSesion();
  const q = await searchParams;
  const pedida = texto(q.sucursal, 10);
  const sql = obtenerBaseDatos()!;
  const base = { desde: texto(q.desde, 10), hasta: texto(q.hasta, 10), corte: texto(q.corte) };
  let r = await reporteCaja(sql, sesion.usuarioId, { codigo: pedida && pedida !== "todas" ? pedida : null, ...base });
  if (!r) notFound();
  // Sin sucursal elegida y con una sola consultable, esa.
  if (!pedida && r.sucursales.length === 1) r = (await reporteCaja(sql, sesion.usuarioId, { codigo: r.sucursales[0].codigo, ...base }))!;
  const una = r.codigo !== null || r.filas.length === 1;
  const codigoUna = r.codigo ?? r.filas[0]?.codigo;
  const pedidas = r.filas.map((f) => f.codigo);
  const descargables = r.sucursales.filter((s) => s.descargar && pedidas.includes(s.codigo));
  const noDescargables = r.sucursales.filter((s) => !s.descargar && pedidas.includes(s.codigo));
  const error = texto(q.error, 30);
  const anotados = r.filas.some((f) => f.anotadosSinContar);
  const resumenes = r.filas.map((c) => ({ c, s: resumirCaja(c, r.corte) }));
  const hoyMx = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(r.generadoEn);
  const sucursalVista = una ? codigoUna! : "todas";
  const mas = (vista: string) => enlaceMas(r, sucursalVista, vista);

  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={codigoUna && una ? `/sucursales/${codigoUna}` : "/"}>← {una && codigoUna ? r.filas[0].nombre : "Inicio"}</Link></p>
      <h1 className="cabecera-titulo">Caja y depósitos</h1>
      <p className="sub">Reporte de caja: cuánto efectivo hay, dónde está y quién lo tiene al corte. Cada importe abre su detalle e historial. Solo consulta. Solo datos ficticios.</p>
      {error && ERRORES[error] ? <p className="aviso aviso-error" role="alert" data-testid="error-descarga">{ERRORES[error]}</p> : null}

      <form className="tarjeta filtros-reporte" method="get" action="/reportes/caja" data-testid="filtros">
        <div className="campo">
          <label htmlFor="sucursal">Sucursal</label>
          <select id="sucursal" name="sucursal" defaultValue={r.codigo ?? "todas"}>
            {r.sucursales.length > 1 ? <option value="todas">Todas mis sucursales</option> : null}
            {r.sucursales.map((s) => <option key={s.codigo} value={s.codigo}>{s.nombre}</option>)}
          </select>
        </div>
        <div className="campo"><label htmlFor="desde">Desde</label><input id="desde" name="desde" type="date" defaultValue={r.desde} required /></div>
        <div className="campo"><label htmlFor="hasta">Hasta</label><input id="hasta" name="hasta" type="date" defaultValue={r.hasta} required /></div>
        <button className="boton" type="submit">Ver</button>
      </form>
      <p className="sub atajos" data-testid="atajos">
        Atajos:{" "}
        {atajos(hoyMx).map((a, i) => (
          <span key={a.nombre}>{i ? " · " : ""}<Link prefetch={false} href={`/reportes/caja?${new URLSearchParams({ sucursal: r.codigo ?? "todas", desde: a.desde, hasta: a.hasta })}`}>{a.nombre}</Link></span>
        ))}
      </p>
      {r.periodoInvalido ? (
        <p className="aviso aviso-error" role="alert" data-testid="periodo-invalido">
          El periodo no es válido (fechas incompletas, futuras, «desde» después de «hasta» o más de un año). Se muestran los últimos 7 días.
        </p>
      ) : null}
      <div className="franja-corte" data-testid="corte">
        <span>{r.filas.map((f) => f.nombre).join(", ")} · {fecha(r.desde)} al {fecha(r.hasta)} · corte <b>{hora.format(r.corte)}</b></span>
        <span>Las cifras son saldos al corte; «Durante el periodo», lo ocurrido en el periodo</span>
      </div>
      {anotados ? <p className="aviso aviso-info" data-testid="leyenda-anotados">{LEYENDA_ANOTADOS}: no los recoges, por eso los ves.</p> : null}

      {una ? <Resumen c={resumenes[0].c} s={resumenes[0].s} r={r} /> : <VariasSucursales r={r} filas={resumenes} />}

      <section className="tarjeta" aria-labelledby="t-mas" data-testid="mas-detalle">
        <h2 id="t-mas" className="titulo-seccion">Más detalle</h2>
        <nav className="pestanas-caja" aria-label="Más detalle">
          <Link prefetch={false} href={mas("folio")} data-testid="ir-folio">Por folio</Link>
          <Link prefetch={false} href={mas("origen")} data-testid="ir-origen">Origen y destino</Link>
          <Link prefetch={false} href={mas("diferencias")} data-testid="ir-diferencias">Diferencias</Link>
          <Link prefetch={false} href={mas("descargas")} data-testid="ir-descargas">Historial de descargas</Link>
        </nav>
        <p className="sub">Cada folio con su etapa, quién lo tiene y su antigüedad; de dónde salió y a dónde fue lo depositado; las diferencias con su clave. Mismo corte.</p>

        {descargables.length ? (
          <form method="post" action="/reportes/caja/descargar" data-testid="descargar">
            <h3>Descargar</h3>
            {noDescargables.length ? (
              <p className="aviso aviso-info" data-testid="descarga-incluidas">
                Se incluyen: <b>{descargables.map((s) => s.nombre).join(", ")}</b>. No se incluyen (sin permiso de descarga):{" "}
                <b>{noDescargables.map((s) => s.nombre).join(", ")}</b>. El archivo se calcula solo con las incluidas.
              </p>
            ) : null}
            <input type="hidden" name="sucursal" value={r.codigo ?? "todas"} />
            <input type="hidden" name="desde" value={r.desde} />
            <input type="hidden" name="hasta" value={r.hasta} />
            <input type="hidden" name="corte" value={r.corte.toISOString()} />
            <fieldset className="campo-grupo">
              <legend className="campo-etiqueta">Formato</legend>
              <label className="casilla"><input type="radio" name="formato" value="xlsx" defaultChecked /> Excel (.xlsx)</label>
              <label className="casilla"><input type="radio" name="formato" value="pdf" /> PDF</label>
            </fieldset>
            <fieldset className="campo-grupo">
              <legend className="campo-etiqueta">Contenido</legend>
              <label className="casilla"><input type="radio" name="contenido" value="resumen" defaultChecked /> Resumen: cifras, por folio, depositado, diferencias y movimientos</label>
              <label className="casilla"><input type="radio" name="contenido" value="detalle" /> Con detalle: además, origen y destino, y el historial de cada folio hasta el corte</label>
            </fieldset>
            <p className="sub">El archivo usa este mismo corte ({hora.format(r.corte)}) y respeta los importes ocultos. Queda registrado en el historial de descargas.</p>
            <button className="boton boton-principal" type="submit" data-testid="boton-descargar">Descargar</button>
          </form>
        ) : null}
      </section>
      <p className="sub">El total está incompleto: faltan las mensualidades de Open Desk. El cuadre completo queda pendiente de esos datos.</p>
    </main>
  );
}

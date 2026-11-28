import Link from "next/link";
import { notFound } from "next/navigation";
import { LEYENDA_ANOTADOS } from "@/lib/archivo-caja";
import { obtenerBaseDatos } from "@/lib/db";
import { TEXTO_PENDIENTE_GASTO } from "@/lib/gastos-caja";
import { reporteCaja, type CajaSucursal, type ReporteCaja } from "@/lib/reporte-caja";
import { lectura, lineaCasos, resumirCaja, resumirVarias, type ResumenCaja } from "@/lib/resumen-caja";
import { requerirSesion } from "@/lib/sesion-servidor";
import { $, enlaceMas, fecha, hora, RecuadroTotal, texto } from "./comun";
import { PanelDescarga } from "./panel-descarga";

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
  return [
    { nombre: "Hoy", desde: hoy, hasta: hoy },
    { nombre: "Esta semana", desde: f(lunes), hasta: f(domingo) },
    { nombre: "Este mes", desde: f(new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), 1))), hasta: f(new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() + 1, 0))) },
    { nombre: "Mes anterior", desde: f(new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() - 1, 1))), hasta: f(new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), 0))) },
  ];
}

const ceros = (lista: string[]) => (lista.length ? `Sin pendientes: ${lista.join(" · ")}.` : null);

/** Una sucursal: tres bloques (efectivo al corte, quién tiene dinero por depositar y pendientes que requieren atención). */
function Resumen({ c, s, r }: { c: CajaSucursal; s: ResumenCaja; r: ReporteCaja }) {
  const mas = (vista: string, extra: Record<string, string> = {}) => enlaceMas(r, c.codigo, vista, extra);
  const l = lectura(s);
  const ciegas = c.sobres.some((x) => x.oculto) || c.pendientes.some((p) => p.oculto);
  const destino: Record<string, string> = {
    atrasados: mas("folio", { solo: "atrasados" }), por_revisar: mas("diferencias"), pendiente_resolucion: mas("diferencias"), correcciones: mas("diferencias"), por_devolver: mas("diferencias"),
    investigar: mas("folio", { etapa: "investigar" }), entradas: mas("folio", { etapa: "entrada" }),
  };
  return (
    <>
      <section className="tarjeta" aria-labelledby="t-efectivo" data-testid="efectivo">
        <h2 id="t-efectivo" className="titulo-seccion">Efectivo al corte</h2>
        <RecuadroTotal t={s.total} ocultos={s.ocultos} />
        <ul className="renglones">
          {l.efectivo.map((x) => (
            <li key={x.clave} data-testid={`renglon-${x.clave}`}>
              <span>{x.etiqueta}<span className="renglon-detalle">{x.detalle}</span></span>
              {x.importe === null
                ? <Link prefetch={false} href={mas("folio", { etapa: x.clave })} className="importe-oculto" data-testid={`renglon-${x.clave}-importe`}>{x.sinImporte}</Link>
                : <Link prefetch={false} href={x.clave === "devolver" ? mas("diferencias") : mas("folio", { etapa: x.clave })} className="renglon-importe" data-testid={`renglon-${x.clave}-importe`}>{$(x.importe)}</Link>}
            </li>
          ))}
        </ul>
        {ceros(l.ceros) ? <p className="sub" data-testid="efectivo-ceros">{ceros(l.ceros)}</p> : null}
        {ciegas ? (
          <p className="aviso aviso-info" data-testid="aviso-ciegas">
            Tu cuenta puede recoger sobres aquí: no ves lo anotado de los sobres que aún no cuentas (conteo a ciegas).
          </p>
        ) : null}
        <p className="sub" data-testid="depositado">
          Ya depositado en el periodo, no se suma: <Link prefetch={false} href={mas("origen")}><b data-testid="depositado-importe">{$(s.depositado.importe)}</b></Link> · {s.depositado.n} {s.depositado.n === 1 ? "depósito" : "depósitos"}
        </p>
      </section>

      <section className="tarjeta" aria-labelledby="t-personas" data-testid="por-persona">
        <h2 id="t-personas" className="titulo-seccion">Quién tiene dinero por depositar</h2>
        {l.personas.length ? (
          <ul className="renglones">
            {l.personas.map((p) => (
              <li key={p.persona} data-testid="persona">
                <span>{p.persona}<span className="renglon-detalle">{p.detalle}</span></span>
                <Link prefetch={false} href={mas("folio", { etapa: "4", persona: p.persona })} className="renglon-importe">{$(p.importe)}</Link>
              </li>
            ))}
          </ul>
        ) : <p className="sub">Nadie tiene dinero por depositar al corte.</p>}
      </section>

      <section className="tarjeta" aria-labelledby="t-atencion" data-testid="atencion">
        <h2 id="t-atencion" className="titulo-seccion">Pendientes que requieren atención</h2>
        {l.atencion.length ? (
          <ul className="renglones">
            {l.atencion.map((a) => (
              <li key={a.clave} data-testid={`atencion-${a.clave}`}>
                <span>
                  <span className="numero-pendiente">{a.n}</span>{a.texto}
                  {a.casos ? <span className="renglon-detalle">{lineaCasos(a)}</span> : null}
                </span>
                {a.clave === "atrasados"
                  ? <Link prefetch={false} href={destino[a.clave]} className="sin-corte">Ver folios</Link>
                  : a.casos
                    ? <Link prefetch={false} href={destino[a.clave]} className="sin-corte">Ver casos</Link>
                    : <Link prefetch={false} href={destino[a.clave]} className="renglon-importe">{$(a.importe)}</Link>}
              </li>
            ))}
          </ul>
        ) : null}
        {ceros(l.atencionCeros) ? <p className="sub" data-testid="atencion-ceros">{ceros(l.atencionCeros)}</p> : null}
      </section>

      <GastosEnCaja c={c} />
    </>
  );
}

/** Gastos que paga esta sucursal: fuera de caja y pendientes al corte, con enlace a cada gasto (bloque 6, PR 9). */
function GastosEnCaja({ c }: { c: CajaSucursal }) {
  const g = c.gastos;
  const fuera = g.fueraDeCaja;
  const conPendientes = g.pendientes.filter((p) => p.n > 0);
  return (
    <section className="tarjeta" aria-labelledby="t-gastos-caja" data-testid="gastos-caja">
      <h2 id="t-gastos-caja" className="titulo-seccion">Gastos</h2>
      <ul className="renglones">
        <li data-testid="fuera-de-caja">
          <span>Fuera de caja: anticipos por comprobar y cambio por devolver
            <span className="renglon-detalle">A cargo de quien recibió el anticipo · no se suma al efectivo en la sucursal
              {fuera.anticipos.n ? ` · ${fuera.anticipos.n} por comprobar (${$(fuera.anticipos.importe)})` : ""}
              {fuera.cambio.n ? ` · ${fuera.cambio.n} con cambio por devolver (${$(fuera.cambio.importe)})` : ""}</span>
          </span>
          <span className="renglon-importe" data-testid="fuera-de-caja-importe">{$(((Math.round(Number(fuera.anticipos.importe) * 100) + Math.round(Number(fuera.cambio.importe) * 100)) / 100).toFixed(2))}</span>
        </li>
        {conPendientes.map((p) => (
          <li key={p.clave} data-testid={`gasto-pendiente-${p.clave}`}>
            <details>
              <summary><span className="numero-pendiente">{p.n}</span>{TEXTO_PENDIENTE_GASTO[p.clave]}</summary>
              <ul>{p.lista.map((x) => (
                <li key={x.clave}><Link prefetch={false} href={`/sucursales/${x.codigo}/gastos/${x.clave}`}><span className="mono">{x.clave}</span></Link> · {x.concepto} · {$(x.importe)} · {x.nota}</li>
              ))}</ul>
            </details>
            <span className="renglon-importe">{$(p.importe)}</span>
          </li>
        ))}
      </ul>
      <p className="sub" data-testid="gastos-pendientes-total">
        {g.totalPendientes.n
          ? <>Gastos con algún pendiente: <b>{g.totalPendientes.n}</b> · <b>{$(g.totalPendientes.importe)}</b>. Un gasto con varios pendientes se suma una sola vez.</>
          : "Sin gastos pendientes al corte."}
        {" "}Las salidas por gastos, anticipos y reembolsos ya están dentro del efectivo de la bolsa o el cajón.
      </p>
    </section>
  );
}

function VariasSucursales({ r, filas }: { r: ReporteCaja; filas: { c: CajaSucursal; s: ResumenCaja }[] }) {
  const juntas = resumirVarias(filas.map((f) => ({ c: f.c, r: f.s })));
  const q = (codigo: string) => `/reportes/caja?${new URLSearchParams({ sucursal: codigo, desde: r.desde, hasta: r.hasta, corte: r.corte.toISOString() })}`;
  return (
    <section className="tarjeta" aria-labelledby="t-efectivo" data-testid="resumen-sucursales">
      <h2 id="t-efectivo" className="titulo-seccion">Efectivo al corte</h2>
      <RecuadroTotal t={juntas.total} ocultos={filas.reduce((n, f) => n + f.s.ocultos, 0)} />
      <ul className="renglones">
        {filas.map(({ c, s }) => {
          const pendientes = s.atencion.reduce((n, a) => n + a.n, 0);
          return (
            <li key={c.codigo} data-testid={`resumen-${c.codigo}`}>
              <span>
                <Link prefetch={false} href={q(c.codigo)}>{c.nombre}</Link>
                <span className="renglon-detalle">
                  {s.total.tipo === "subtotal" ? `Subtotal visible: faltan ${s.total.faltan.join(" y ")}` : s.total.tipo === "sin_datos" ? "Sin ningún importe conocido" : "Total registrado"}
                  {s.porDepositar.n ? ` · por depositar ${$(s.porDepositar.importe!)}` : ""}{pendientes ? ` · ${pendientes} ${pendientes === 1 ? "pendiente" : "pendientes"}` : ""}
                </span>
              </span>
              {s.total.importe === null ? <span className="importe-oculto">Sin datos</span> : <span className="renglon-importe">{$(s.total.importe)}</span>}
            </li>
          );
        })}
      </ul>
      <p className="sub">Ya depositado en el periodo, no se suma: <b>{$(juntas.depositado.importe)}</b> · {juntas.depositado.n} {juntas.depositado.n === 1 ? "depósito" : "depósitos"}. Cada sucursal abre su resumen.</p>
    </section>
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
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={codigoUna && una ? `/sucursales/${codigoUna}` : "/"}>← {una && codigoUna ? r.filas[0].nombre : "Inicio"}</Link></p>
      <div className="cabecera-caja">
        <div>
          <h1 className="cabecera-titulo">Caja y depósitos</h1>
          <p className="sub" data-testid="corte">
            <b>{r.filas.map((f) => f.nombre).join(", ")}</b> · {fecha(r.desde)} al {fecha(r.hasta)} · corte <b>{hora.format(r.corte)}</b>
          </p>
        </div>
        {descargables.length ? (
          <PanelDescarga sucursal={r.codigo ?? "todas"} desde={r.desde} hasta={r.hasta} corte={r.corte.toISOString()} corteTexto={hora.format(r.corte)}
                         incluidas={descargables.map((s) => s.nombre)} excluidas={noDescargables.map((s) => s.nombre)} />
        ) : null}
      </div>
      {error && ERRORES[error] ? <p className="aviso aviso-error" role="alert" data-testid="error-descarga">{ERRORES[error]}</p> : null}

      <details className="cambiar-caja" data-testid="cambiar">
        <summary>Cambiar sucursal o periodo</summary>
        <form className="filtros-reporte" method="get" action="/reportes/caja" data-testid="filtros">
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
        <p className="sub" data-testid="atajos">
          Atajos:{" "}
          {atajos(hoyMx).map((a, i) => (
            <span key={a.nombre}>{i ? " · " : ""}<Link prefetch={false} href={`/reportes/caja?${new URLSearchParams({ sucursal: r.codigo ?? "todas", desde: a.desde, hasta: a.hasta })}`}>{a.nombre}</Link></span>
          ))}
        </p>
      </details>
      {r.periodoInvalido ? (
        <p className="aviso aviso-error" role="alert" data-testid="periodo-invalido">
          El periodo no es válido (fechas incompletas, futuras, «desde» después de «hasta» o más de un año). Se muestran los últimos 7 días.
        </p>
      ) : null}
      {anotados ? <p className="aviso aviso-info" data-testid="leyenda-anotados">{LEYENDA_ANOTADOS}: no los recoges, por eso los ves.</p> : null}

      {una ? <Resumen c={resumenes[0].c} s={resumenes[0].s} r={r} /> : <VariasSucursales r={r} filas={resumenes} />}

      <nav className="pestanas-caja" aria-label="Más detalle" data-testid="mas-detalle">
        <Link prefetch={false} href={mas("movimientos")} data-testid="ir-movimientos">Movimientos del periodo</Link>
        <Link prefetch={false} href={mas("folio")} data-testid="ir-folio">Por folio</Link>
        <Link prefetch={false} href={mas("origen")} data-testid="ir-origen">Origen y destino</Link>
        <Link prefetch={false} href={mas("diferencias")} data-testid="ir-diferencias">Diferencias</Link>
        <Link prefetch={false} href={mas("descargas")} data-testid="ir-descargas">Historial de descargas</Link>
      </nav>
    </main>
  );
}

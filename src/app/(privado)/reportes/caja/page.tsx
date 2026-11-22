import Link from "next/link";
import { notFound } from "next/navigation";
import { LEYENDA_ANOTADOS, textoTotal } from "@/lib/archivo-caja";
import { obtenerBaseDatos } from "@/lib/db";
import { historialDescargas, nombreLugar, reporteCaja, type CajaSucursal, type ReporteCaja } from "@/lib/reporte-caja";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Reporte de caja · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (v: string) => (Number(v) < 0 ? `−${pesos.format(-Number(v))}` : pesos.format(Number(v)));
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const dia = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" });
const fecha = (f: string) => dia.format(new Date(`${f}T00:00:00Z`));
const texto = (v: string | string[] | undefined, max = 40) => (typeof v === "string" ? v.slice(0, max) : undefined);

const ERRORES: Record<string, string> = {
  sin_descarga: "No tienes «Descargar el reporte de caja» en esa sucursal.",
  no_encontrada: "No puedes consultar el reporte de caja de esa sucursal.",
  formato: "Elige Excel o PDF, y resumen o resumen con detalle.",
  bloqueado_produccion: "Las descargas están desactivadas fuera del entorno de pruebas.",
};

type Ctx = { r: ReporteCaja; codigo: string };
/** Enlace al detalle de un importe, con el mismo periodo y el mismo corte. */
function enlace(c: Ctx, tipo: string, id: string) {
  const q = new URLSearchParams({ sucursal: c.codigo, desde: c.r.desde, hasta: c.r.hasta, corte: c.r.corte.toISOString(), tipo, id });
  return `/reportes/caja/detalle?${q}`;
}
function Importe({ v, href, testid }: { v: string | null; href?: string; testid?: string }) {
  if (v === null) return <span className="importe-oculto" data-testid={testid}>Oculto: sin contar</span>;
  return href ? <Link href={href} prefetch={false} data-testid={testid}><strong>{$(v)}</strong></Link> : <strong data-testid={testid}>{$(v)}</strong>;
}
const Anterior = ({ si }: { si: boolean }) => (si ? <> <span className="marca-anterior">Anterior al periodo</span></> : null);

function Total({ c }: { c: Pick<CajaSucursal, "visible" | "ocultos"> }) {
  return (
    <div className="tarjeta tarjeta-oscura total-caja" data-testid="total-caja">
      <div>
        <strong data-testid="total-etiqueta">{c.ocultos > 0 ? "Subtotal visible al corte" : "Total registrado al corte"}</strong>
        <p className="sub">
          {c.ocultos > 0 ? <><b>No es el total:</b> faltan {c.ocultos} con importe oculto hasta contarlos. </> : null}
          <b>Incompleto:</b> el cajón cuenta con su último conteo; faltan las mensualidades de Open Desk.
        </p>
      </div>
      <p className="cifra-grande" data-testid="total-importe">{$(c.visible)}{c.ocultos > 0 ? <span style={{ fontSize: 15 }}> + {c.ocultos} {c.ocultos === 1 ? "oculto" : "ocultos"}</span> : null}</p>
    </div>
  );
}

function Sucursal({ c, ctx }: { c: CajaSucursal; ctx: Ctx }) {
  const m = c.movimientos;
  const sobreOculto = c.sobres.some((s) => s.oculto) || c.pendientes.some((p) => p.clase === "entrega_sobres" && p.oculto);
  return (
    <>
      <section className="tarjeta" aria-labelledby="t-donde" data-testid="donde-esta">
        <h2 id="t-donde" className="titulo-seccion">Dónde está el efectivo al corte</h2>
        <div className="etapas-caja">
          <span>1. Bolsa o cajón</span><span>2. Sobre sellado</span><span>3. Entregado, pendiente de confirmar</span><span>4. Confirmado, por depositar</span><span>5. Depositado</span>
        </div>
        <p className="sub">Cada peso aparece en una sola etapa: al pasar a la siguiente, sale de la anterior. Lo recogido cuenta con lo contado, no con lo anotado.</p>

        <h3>1. En la sucursal</h3>
        <ul className="lista-simple" data-testid="etapa-1">
          {c.lugares.map((l) => (
            <li key={l.lugarId} data-testid={`lugar-${l.tipo}`}>
              <b>{nombreLugar(l.tipo)}</b>{" · "}
              {l.estado === "turno" ? (
                l.tipo === "bolsa_visitas"
                  ? <>esperado (contado al abrir + movimientos){l.responsable ? ` · responsable ${l.responsable}` : ""}</>
                  : <>último conteo: <b>{hora.format(l.base!.en)}</b>, al abrir, por {l.base!.por}{Number(l.movimientos) ? `, más movimientos registrados (${$(l.movimientos)})` : ""}
                      <br /><span className="texto-incompleto">Información incompleta: no incluye las mensualidades cobradas después de ese conteo (faltan datos de Open Desk)</span></>
              ) : l.estado === "cerrado" ? (
                <>guardado al cerrar · contado el {hora.format(l.base!.en)} por {l.base!.por}{l.tipo === "cajon_mensualidades" ? <><br /><span className="texto-incompleto">Información incompleta: faltan datos de mensualidades de Open Desk</span></> : null}</>
              ) : <>sin turnos registrados</>}
              {" · "}{l.importe === null ? "—" : <Importe v={l.importe} href={enlace(ctx, "lugar", l.lugarId)} />}
            </li>
          ))}
        </ul>

        <h3>2. Sobres por recoger</h3>
        {c.sobres.length ? (
          <ul className="lista-simple" data-testid="etapa-2">
            {c.sobres.map((s) => (
              <li key={s.id} data-testid={`sobre-${s.folio}`}>
                Sobre <span className="mono">{s.folio}</span> · {s.donde === "buzon" ? "en el buzón" : s.donde === "caja" ? "en la caja con llave" : "por devolver a la caja"} · {nombreLugar(s.lugar)} · {s.dias} {s.dias === 1 ? "día" : "días"}
                <Anterior si={s.anterior} />{" · "}
                {s.oculto ? <Link href={enlace(ctx, "sobre", s.id)} prefetch={false}><span className="importe-oculto">importe oculto hasta contarlo</span></Link> : <Importe v={s.anotado} href={enlace(ctx, "sobre", s.id)} />}
              </li>
            ))}
          </ul>
        ) : <p className="sub">Ninguno.</p>}
        {sobreOculto ? (
          <p className="aviso aviso-info" data-testid="aviso-ciegas">
            Como tu cuenta puede recoger sobres aquí, no ves lo anotado de los sobres que aún no cuentas (conteo a ciegas). En cuanto confirmas una
            recolección, lo que contaste aparece en la etapa 4.
          </p>
        ) : null}

        <h3>3. Entregado, pendiente de confirmar</h3>
        {c.pendientes.length ? (
          <ul className="lista-simple" data-testid="etapa-3">
            {c.pendientes.map((p) => (
              <li key={p.id} data-testid={`pendiente-${p.id}`}>
                {p.clase === "retiro"
                  ? <>Retiro <span className="mono">{p.folio}</span> · entregado a {p.recibe} el {hora.format(p.en)} por {p.entrego} · «Pendiente de confirmar por Encargada de retiros»</>
                  : <>Sobres {p.folios.join(", ")} · entregados a {p.recibe} el {hora.format(p.en)} por {p.entrego} · pendientes de confirmar</>}
                <Anterior si={p.anterior} />{" · "}<Importe v={p.importe} href={enlace(ctx, p.clase === "retiro" ? "retiro" : "recoleccion", p.id)} />
              </li>
            ))}
          </ul>
        ) : <p className="sub">Nada.</p>}

        <h3>4. Confirmado, por depositar</h3>
        {c.confirmados.length ? (
          <ul className="lista-simple" data-testid="etapa-4">
            {c.confirmados.map((x) => (
              <li key={`${x.clase}-${x.id}`} data-testid={`confirmado-${x.id}`}>
                {x.clase === "recoleccion"
                  ? <>{x.recibe} · {x.buzon ? "recolección del buzón" : "recolección"} del {hora.format(x.desde)} · recogido {$(x.recogido)}, depositado {$(x.depositado)}</>
                  : x.clase === "retiro"
                    ? <>{x.encargada} · retiro <span className="mono">{x.folio}</span> · confirmado {hora.format(x.desde)}{x.aviso ? <> · <b className="texto-incompleto">48 horas o más</b></> : null}</>
                    : <>{x.encargada} · retiro <span className="mono">{x.folio}</span> · en pausa por revisión (no se deposita aún)</>}
                <Anterior si={x.anterior} />{" · "}<Importe v={x.saldo} href={enlace(ctx, x.clase === "recoleccion" ? "recoleccion" : "retiro", x.id)} />
              </li>
            ))}
          </ul>
        ) : <p className="sub">Nada.</p>}
      </section>

      <Total c={c} />

      <section className="tarjeta" aria-labelledby="t-depositado" data-testid="depositado">
        <h2 id="t-depositado" className="titulo-seccion">5. Depositado en el periodo</h2>
        <p className="sub">Ya salió de la custodia: no se suma arriba.</p>
        {c.depositos.length ? (
          <ul className="lista-simple">
            {c.depositos.map((d, i) => (
              <li key={i}>
                {fecha(d.fecha)} · {d.clase === "recoleccion" ? "de una recolección" : <>del retiro <span className="mono">{d.folio}</span></>} · ref. {d.referencia} · registró {d.por}{" · "}
                <Importe v={d.importe} href={enlace(ctx, d.clase, d.origenId)} />
              </li>
            ))}
          </ul>
        ) : <p className="sub">Sin depósitos en el periodo.</p>}
      </section>

      <section className="tarjeta tarjeta-aparte" aria-labelledby="t-aparte" data-testid="aparte">
        <h2 id="t-aparte" className="titulo-seccion">Aparte: diferencias y sobres por investigar</h2>
        <p className="sub"><b>No se suman</b> a «Dónde está»: son lo que falta o sobra contra lo anotado o lo esperado.</p>
        {c.diferencias.length ? (
          <div className="tabla-desplazable">
            <table className="tabla">
              <thead><tr><th>Caso</th><th>Lugar</th><th>Importe</th><th>Estado</th></tr></thead>
              <tbody>
                {c.diferencias.map((d) => (
                  <tr key={`${d.clase}-${d.id}`} data-testid="diferencia">
                    <td data-etiqueta="Caso">{d.texto}<Anterior si={d.anterior} /></td>
                    <td data-etiqueta="Lugar">{nombreLugar(d.lugar)}</td>
                    <td data-etiqueta="Importe">
                      <Link prefetch={false} href={d.enlace.tipo === "entrega" ? `/sucursales/${ctx.codigo}/diferencias/${d.enlace.id}` : enlace(ctx, d.enlace.tipo, d.enlace.id)}>
                        <strong>{$(d.importe)}</strong>
                      </Link>
                    </td>
                    <td data-etiqueta="Estado">{d.abierta ? <span className="chip-estado chip-incompleto">{d.estado}</span> : d.estado}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub">Sin diferencias del periodo ni anteriores abiertas al corte.</p>}
        <p className="sub">
          Del periodo, más las anteriores que siguen abiertas al corte. {c.diferencias.filter((d) => d.abierta).length} abiertas · neto de referencia{" "}
          {$((c.diferencias.filter((d) => d.neto).reduce((n, d) => n + Math.round(Number(d.importe) * 100), 0) / 100).toFixed(2))} (el neto no cierra ningún caso).
        </p>
        <h3>Sobres por investigar</h3>
        {c.investigar.length ? (
          <ul className="lista-simple" data-testid="por-investigar">
            {c.investigar.map((x) => (
              <li key={x.sobreId}>
                Sobre <span className="mono">{x.folio}</span> · {nombreLugar(x.lugar)} · no estaba al abrir el buzón el {hora.format(x.desde)} · por investigar, sin responsable asignado
                <Anterior si={x.anterior} />{" · "}anotado <Importe v={x.anotado} href={enlace(ctx, "sobre", x.sobreId)} />
              </li>
            ))}
          </ul>
        ) : <p className="sub">Ninguno.</p>}
      </section>

      <section className="tarjeta" aria-labelledby="t-movimientos" data-testid="movimientos">
        <h2 id="t-movimientos" className="titulo-seccion">Movimientos del periodo</h2>
        <p className="sub">Son pasos del mismo dinero: <b>no se suman entre sí</b>. Un cobro entra a la bolsa, después va en un sobre, se recoge y se deposita.</p>
        <ul className="lista-simple">
          <li>
            <Link prefetch={false} href={`/reportes/visitas?${new URLSearchParams({ sucursal: ctx.codigo, desde: ctx.r.desde, hasta: ctx.r.hasta })}`}>
              Cobros de visitas en efectivo ({m.cobros.n})
            </Link> · <strong>{$(m.cobros.importe)}</strong>
          </li>
          <li>Cancelaciones y devoluciones en efectivo ({m.cancelaciones.n}) · <strong>{$(m.cancelaciones.importe)}</strong></li>
          <li>Mensualidades · <span className="importe-oculto">No calculado: faltan datos de Open Desk</span></li>
          <li>
            <details>
              <summary>Sobres sellados al cerrar ({m.sellados.n}) · {m.sellados.anotado === null ? <span className="importe-oculto">anotado oculto ({m.sellados.ocultos} sin contar)</span> : <strong>{$(m.sellados.anotado)}</strong>}</summary>
              <ul>{m.lista.sellados.map((x) => <li key={x.id}><Link prefetch={false} href={enlace(ctx, "sobre", x.id)}><span className="mono">{x.folio}</span></Link> · {nombreLugar(x.lugar)} · {hora.format(x.en)} · <Importe v={x.anotado} /></li>)}</ul>
            </details>
          </li>
          <li>
            <details>
              <summary>Recogido por Dirección, contado ({m.recogido.n}) · <strong>{$(m.recogido.importe)}</strong></summary>
              <ul>{m.lista.recogidas.map((x) => <li key={x.id}><Link prefetch={false} href={enlace(ctx, "recoleccion", x.id)}>{hora.format(x.en)}</Link> · {x.recibe} · {$(x.importe)}</li>)}</ul>
            </details>
          </li>
          <li>
            <details>
              <summary>Entregado a Encargada de retiros ({m.retiros.n}: {m.retiros.confirmados} confirmados, {m.retiros.pendientes} pendientes de confirmar) · <strong>{$(m.retiros.importe)}</strong>{m.retiros.ocultos ? <span className="importe-oculto"> + {m.retiros.ocultos} oculto</span> : null}</summary>
              <ul>{m.lista.retiros.map((x) => <li key={x.id}><Link prefetch={false} href={enlace(ctx, "retiro", x.id)}><span className="mono">{x.folio}</span></Link> · {nombreLugar(x.lugar)} · {hora.format(x.en)} · <Importe v={x.importe} />{x.pendiente ? " · pendiente de confirmar" : ""}</li>)}</ul>
            </details>
          </li>
          <li>Depositado ({m.depositado.n}) · <strong>{$(m.depositado.importe)}</strong></li>
        </ul>
      </section>
    </>
  );
}

function VariasSucursales({ r }: { r: ReporteCaja }) {
  const ocultos = r.filas.reduce((n, c) => n + c.ocultos, 0);
  const visible = (r.filas.reduce((n, c) => n + Math.round(Number(c.visible) * 100), 0) / 100).toFixed(2);
  const q = (codigo: string) => `/reportes/caja?${new URLSearchParams({ sucursal: codigo, desde: r.desde, hasta: r.hasta, corte: r.corte.toISOString() })}`;
  const suma = (c: CajaSucursal, f: (c: CajaSucursal) => number) => (f(c) / 100).toFixed(2);
  const c2 = (c: CajaSucursal) => c.sobres.reduce((n, s) => n + Math.round(Number(s.anotado ?? 0) * 100), 0);
  return (
    <>
      <section className="tarjeta" aria-labelledby="t-sucursales" data-testid="resumen-sucursales">
        <h2 id="t-sucursales" className="titulo-seccion">Por sucursal</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Sucursal</th><th>1. En la sucursal</th><th>2. Sobres por recoger</th><th>3. Pendiente de confirmar</th><th>4. Por depositar</th><th>Total o subtotal</th><th>Diferencias abiertas · por investigar</th></tr></thead>
            <tbody>
              {r.filas.map((c) => (
                <tr key={c.codigo} data-testid={`resumen-${c.codigo}`}>
                  <td data-etiqueta="Sucursal"><Link prefetch={false} href={q(c.codigo)}>{c.nombre}</Link></td>
                  <td data-etiqueta="1. En la sucursal">{$(suma(c, (x) => x.lugares.reduce((n, l) => n + Math.round(Number(l.importe ?? 0) * 100), 0)))}</td>
                  <td data-etiqueta="2. Sobres por recoger">{c.sobres.some((s) => s.oculto) ? <span className="importe-oculto">{c.sobres.length} sobres · ocultos</span> : $(suma(c, c2))}</td>
                  <td data-etiqueta="3. Pendiente de confirmar">{$(suma(c, (x) => x.pendientes.reduce((n, p) => n + Math.round(Number(p.importe ?? 0) * 100), 0)))}{c.pendientes.some((p) => p.oculto) ? <span className="importe-oculto"> + ocultos</span> : null}</td>
                  <td data-etiqueta="4. Por depositar">{$(suma(c, (x) => x.confirmados.reduce((n, p) => n + Math.round(Number(p.saldo) * 100), 0)))}</td>
                  <td data-etiqueta="Total o subtotal"><strong>{$(c.visible)}</strong>{c.ocultos ? <span className="importe-oculto"> subtotal visible + {c.ocultos} ocultos</span> : null}</td>
                  <td data-etiqueta="Diferencias abiertas · por investigar">{c.diferencias.filter((d) => d.abierta).length} · {c.investigar.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">Cada sucursal abre su reporte completo, con el mismo periodo y corte.</p>
      </section>
      <Total c={{ visible, ocultos }} />
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
  const ids = r.filas.map((f) => f.id);
  const descargas = await historialDescargas(sql, ids);
  const error = texto(q.error, 30);
  const anotados = r.filas.some((f) => f.anotadosSinContar);

  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={codigoUna && una ? `/sucursales/${codigoUna}` : "/"}>← {una && codigoUna ? r.filas[0].nombre : "Inicio"}</Link></p>
      <h1 className="cabecera-titulo">Reporte de caja</h1>
      <p className="sub">Dónde está registrado el efectivo. Cada importe abre su detalle e historial. Solo consulta. Solo datos ficticios.</p>
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
      {r.periodoInvalido ? (
        <p className="aviso aviso-error" role="alert" data-testid="periodo-invalido">
          El periodo no es válido (fechas incompletas, futuras, «desde» después de «hasta» o más de un año). Se muestran los últimos 7 días.
        </p>
      ) : null}
      <div className="franja-corte" data-testid="corte">
        <span>{r.filas.map((f) => f.nombre).join(", ")} · {fecha(r.desde)} al {fecha(r.hasta)} · corte <b>{hora.format(r.corte)}</b></span>
        <span>«Dónde está» es la foto al corte; «Movimientos», lo ocurrido en el periodo</span>
      </div>
      {anotados ? <p className="aviso aviso-info" data-testid="leyenda-anotados">{LEYENDA_ANOTADOS}: no los recoges, por eso los ves.</p> : null}

      {una ? <Sucursal c={r.filas[0]} ctx={{ r, codigo: r.filas[0].codigo }} /> : <VariasSucursales r={r} />}

      {descargables.length ? (
        <form className="tarjeta" method="post" action="/reportes/caja/descargar" data-testid="descargar">
          <h2 className="titulo-seccion">Descargar el reporte de caja</h2>
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
            <label className="casilla"><input type="radio" name="contenido" value="resumen" defaultChecked /> Resumen: etapas, total o subtotal, diferencias y por investigar</label>
            <label className="casilla"><input type="radio" name="contenido" value="detalle" /> Resumen con detalle: además, cada importe con su historial hasta el corte</label>
          </fieldset>
          <p className="sub">
            El archivo usa este mismo corte ({hora.format(r.corte)}) y respeta los importes ocultos. Queda registrado en el historial de descargas.
          </p>
          <button className="boton boton-principal" type="submit" data-testid="boton-descargar">Descargar</button>
        </form>
      ) : null}

      <section className="tarjeta" aria-labelledby="t-descargas" data-testid="historial-descargas">
        <h2 id="t-descargas" className="titulo-seccion">Historial de descargas</h2>
        {descargas.length ? (
          <ul className="lista-simple">
            {descargas.map((d, i) => (
              <li key={i}>
                {hora.format(d.en)} · <b>{d.por}</b> · {d.sucursales.join(", ")} · {fecha(d.desde)} al {fecha(d.hasta)} · corte {hora.format(d.corte)} ·{" "}
                {d.formato === "xlsx" ? "Excel" : "PDF"} · {d.contenido === "detalle" ? "resumen con detalle" : "resumen"}
                {d.conOcultos ? " · con importes ocultos" : ""}{d.conAnotados ? ` · «${LEYENDA_ANOTADOS}»` : ""}
                {d.excluidas.length ? ` · sin ${d.excluidas.join(", ")} (sin permiso de descarga)` : ""}
              </li>
            ))}
          </ul>
        ) : <p className="sub">Nadie ha descargado este reporte.</p>}
      </section>
      <p className="sub">{textoTotal({ ocultos: 0 }).replace("Total registrado al corte · ", "El total está ")}. El cuadre completo queda pendiente de los datos de Open Desk.</p>
    </main>
  );
}

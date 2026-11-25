import Link from "next/link";
import { notFound } from "next/navigation";
import { LEYENDA_ANOTADOS } from "@/lib/archivo-caja";
import { obtenerBaseDatos } from "@/lib/db";
import { historialDescargas, nombreLugar, reporteCaja, type CajaSucursal, type ReporteCaja } from "@/lib/reporte-caja";
import { aPesos, centavos, NOTA_RANGOS, RANGOS, resumirCaja, type FilaFolio } from "@/lib/resumen-caja";
import { requerirSesion } from "@/lib/sesion-servidor";
import { $, Anterior, diaCorto, enlaceDetalle, enlaceMas, fecha, hora, texto } from "../comun";

export const metadata = { title: "Más detalle · Caja y depósitos · Fitnessland" };

const VISTAS = { folio: "Por folio", origen: "Origen y destino", diferencias: "Diferencias", descargas: "Historial de descargas" } as const;
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

/** Fechas de los depósitos de un origen, con su importe si hubo más de uno. */
function Fechas({ d }: { d: { fecha: string; importe: string }[] }) {
  if (!d.length) return null;
  return <><br /><span className="sub">{d.map((x) => (d.length > 1 ? `${$(x.importe)} el ${fecha(x.fecha)}` : fecha(x.fecha))).join(" · ")}</span></>;
}

function OrigenDestino({ r, c, varias }: { r: ReporteCaja; c: CajaSucursal; varias: boolean }) {
  const suma = (k: "antes" | "durante" | "saldo" | "diferencia") => aPesos(c.origenes.reduce((n, o) => n + centavos(o[k]), 0));
  return (
    <section className="tarjeta" data-testid={`origen-${c.codigo}`}>
      {varias ? <h2 className="titulo-seccion">{c.nombre}</h2> : null}
      {c.origenes.length ? (
        <div className="tabla-desplazable">
          <table className="tabla" data-testid="tabla-origen">
            <thead><tr><th>Origen</th><th>Anotado o registrado</th><th>Diferencia</th><th>Contado</th><th>Depositado antes del periodo</th><th>Depositado durante el periodo</th><th>Saldo al corte</th></tr></thead>
            <tbody>
              {c.origenes.map((o) => (
                <tr key={`${o.clase}-${o.id}`} data-testid="origen">
                  <td data-etiqueta="Origen">
                    <Link prefetch={false} href={enlaceDetalle(r, c.codigo, o.clase, o.id)}>{o.texto}</Link><Anterior si={o.anterior} />
                    {o.clase === "recoleccion" && o.folios.length ? <><br /><span className="sub">Sobres {o.folios.join(", ")}</span></> : null}
                    {o.pausa ? <><br /><span className="sub">En pausa por revisión: aún no se deposita</span></> : null}
                  </td>
                  <td data-etiqueta="Anotado o registrado">{$(o.registrado)}</td>
                  <td data-etiqueta="Diferencia">{Number(o.diferencia) ? <>{$(o.diferencia)} <span className="sub">{o.claves.join(", ")}</span></> : "—"}</td>
                  <td data-etiqueta="Contado">{$(o.contado)}</td>
                  <td data-etiqueta="Depositado antes del periodo">{$(o.antes)}<Fechas d={o.depositos.filter((d) => d.antes)} /></td>
                  <td data-etiqueta="Depositado durante el periodo">{$(o.durante)}<Fechas d={o.depositos.filter((d) => !d.antes)} /></td>
                  <td data-etiqueta="Saldo al corte"><strong>{$(o.saldo)}</strong></td>
                </tr>
              ))}
              <tr data-testid="origen-total">
                <td data-etiqueta="Origen"><b>Total</b></td>
                <td data-etiqueta="Anotado o registrado"></td>
                <td data-etiqueta="Diferencia">{$(suma("diferencia"))} <span className="sub">solo referencia</span></td>
                <td data-etiqueta="Contado"></td>
                <td data-etiqueta="Depositado antes del periodo">{$(suma("antes"))} <span className="sub">solo referencia</span></td>
                <td data-etiqueta="Depositado durante el periodo"><strong data-testid="origen-durante">{$(suma("durante"))}</strong></td>
                <td data-etiqueta="Saldo al corte"><strong data-testid="origen-saldo">{$(suma("saldo"))}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : <p className="sub">Sin depósitos en el periodo ni saldos por depositar al corte.</p>}
      <p className="sub">
        En cada fila: <b>anotado + diferencia = contado</b> y <b>contado = depositado antes + depositado durante + saldo al corte</b>.
        «Depositado durante el periodo» es el depositado del resumen y «Saldo al corte» es «Por depositar»; lo depositado antes del periodo es solo
        referencia y no entra en ninguna cifra del periodo. Las diferencias se ligan por su clave y no se suman.
      </p>
      <h3>Depósitos del periodo</h3>
      {c.depositos.length ? (
        <ul className="lista-simple" data-testid="depositos">
          {c.depositos.map((d, i) => {
            const o = c.origenes.find((x) => x.clase === d.clase && x.id === d.origenId);
            return (
              <li key={i}>
                {fecha(d.fecha)} · ref. {d.referencia} · registró {d.por} · {o ? o.texto : d.clase === "retiro" ? `Retiro ${d.folio}` : "Recolección"} · <strong>{$(d.importe)}</strong>
              </li>
            );
          })}
        </ul>
      ) : <p className="sub">Sin depósitos en el periodo.</p>}
    </section>
  );
}

function Diferencias({ r, c, varias }: { r: ReporteCaja; c: CajaSucursal; varias: boolean }) {
  const neto = aPesos(c.diferencias.filter((d) => d.neto).reduce((n, d) => n + centavos(d.importe), 0));
  return (
    <section className="tarjeta" data-testid={`diferencias-${c.codigo}`}>
      {varias ? <h2 className="titulo-seccion">{c.nombre}</h2> : null}
      {c.diferencias.length ? (
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Clave</th><th>Caso</th><th>Lugar</th><th>Registrada</th><th>Importe</th><th>Estado al corte</th></tr></thead>
            <tbody>
              {c.diferencias.map((d) => (
                <tr key={`${d.clase}-${d.id}`} data-testid="diferencia">
                  <td data-etiqueta="Clave"><b>{d.clave}</b></td>
                  <td data-etiqueta="Caso">{d.texto}<Anterior si={d.anterior} />{d.referencia ? <> <span className="sub">· solo referencia de su origen (no entra en el neto)</span></> : null}</td>
                  <td data-etiqueta="Lugar">{nombreLugar(d.lugar)}</td>
                  <td data-etiqueta="Registrada">{hora.format(d.registradaEn)}</td>
                  <td data-etiqueta="Importe"><Link prefetch={false} href={enlaceDetalle(r, c.codigo, d.enlace.tipo, d.enlace.id)}><strong>{$(d.importe)}</strong></Link></td>
                  <td data-etiqueta="Estado al corte">{d.abierta ? <span className="chip-estado chip-incompleto">{d.estado}</span> : d.estado}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="sub">Sin diferencias del periodo ni anteriores abiertas al corte.</p>}
      <p className="sub">
        Del periodo, más las anteriores abiertas al corte y las de un origen que aparece en «Origen y destino». {c.diferencias.filter((d) => d.abierta).length} abiertas ·
        neto de referencia {$(neto)} (el neto no cierra ningún caso). Las diferencias <b>no se suman</b> a ninguna etapa.
      </p>
    </section>
  );
}

export default async function MasDetalle({ searchParams }: PageProps<"/reportes/caja/mas">) {
  const sesion = await requerirSesion();
  const q = await searchParams;
  const pedida = texto(q.sucursal, 10);
  const vista: Vista = (Object.keys(VISTAS) as Vista[]).find((v) => v === texto(q.vista, 15)) ?? "folio";
  const sql = obtenerBaseDatos()!;
  const r = await reporteCaja(sql, sesion.usuarioId, {
    codigo: pedida && pedida !== "todas" ? pedida : null, desde: texto(q.desde, 10), hasta: texto(q.hasta, 10), corte: texto(q.corte),
  });
  if (!r) notFound();
  const varias = r.filas.length > 1;
  const sucursal = r.codigo ?? "todas";
  const volver = `/reportes/caja?${new URLSearchParams({ sucursal, desde: r.desde, hasta: r.hasta, corte: r.corte.toISOString() })}`;
  const folios = r.filas.flatMap((c) => resumirCaja(c, r.corte).folios);
  const descargas = vista === "descargas" ? await historialDescargas(sql, r.filas.map((f) => f.id)) : [];
  const filtros = { etapa: texto(q.etapa, 12), persona: texto(q.persona, 120), rango: texto(q.rango, 1), solo: texto(q.solo, 10) };

  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={volver}>← Caja y depósitos · {r.filas.map((f) => f.nombre).join(", ")} · corte {hora.format(r.corte)}</Link></p>
      <h1 className="cabecera-titulo">Más detalle</h1>
      <div className="franja-corte" data-testid="corte">
        <span>{r.filas.map((f) => f.nombre).join(", ")} · {fecha(r.desde)} al {fecha(r.hasta)} · corte <b>{hora.format(r.corte)}</b></span>
        <span>Mismo corte que el resumen</span>
      </div>
      {r.filas.some((f) => f.anotadosSinContar) ? <p className="aviso aviso-info">{LEYENDA_ANOTADOS}: no los recoges, por eso los ves.</p> : null}
      <nav className="pestanas-caja" aria-label="Más detalle">
        {(Object.keys(VISTAS) as Vista[]).map((v) => (
          <Link key={v} prefetch={false} href={enlaceMas(r, sucursal, v)} aria-current={v === vista ? "page" : undefined} className={v === vista ? "sel" : undefined}>{VISTAS[v]}</Link>
        ))}
      </nav>
      <h2 className="titulo-seccion">{VISTAS[vista]}</h2>

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

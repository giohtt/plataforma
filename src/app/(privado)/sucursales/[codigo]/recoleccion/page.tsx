import Link from "next/link";
import { notFound } from "next/navigation";
import {
  FormularioCancelarEntregaSobres, FormularioConfirmarRecoleccion, FormularioDeposito, FormularioEntregarSobres, FormularioRevisarDiferenciaSobre,
} from "@/components/Recoleccion";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { pantallaRecoleccion } from "@/lib/recolecciones";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Caja de sobres · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const firmado = (v: string) => { const c = Math.round(Number(v) * 100); return (c < 0 ? "−" : c > 0 ? "+" : "") + pesos.format(Math.abs(c) / 100); };
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const LUGAR = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" } as const;
const MOMENTO = { cierre: "al cerrar", apertura: "al abrir", cambio_turno: "en el cambio de turno", recoleccion: "en la recolección" } as const;
const ESTADO_DIF = {
  por_revisar: "Por revisar (Administración)", aclarada: "Aclarada", faltante_confirmado: "Faltante confirmado",
  sobrante_confirmado: "Sobrante confirmado", incidencia_confirmada: "Incidencia confirmada",
} as const;
const COMO = { correcto: "cerrado y con su folio", abierto: "abierto o con el sello roto", otro_folio: "con otro folio", falta: "no estaba" } as const;
const AVISO: Record<string, string> = {
  entregados: "Entrega registrada. Dirección la confirma desde su cuenta al verificar y contar cada sobre.",
  cancelada: "Entrega cancelada. Los sobres siguen en la caja.",
  deposito: "Depósito registrado.",
  revisada: "Revisión guardada.",
};

/** Caja de sobres: lo guardado, quién tiene la llave, la entrega semanal a Dirección, su conteo y los depósitos. */
export default async function Recoleccion({ params, searchParams }: PageProps<"/sucursales/[codigo]/recoleccion">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const { aviso, diferencias } = await searchParams;
  const p = await pantallaRecoleccion(obtenerBaseDatos()!, sesion.usuarioId, codigo, leerEntorno());
  if (!p.ok && p.error === "no_encontrada") notFound();
  if (!p.ok) {
    return (
      <main className="contenedor contenedor-medio">
        <h1 className="cabecera-titulo">Caja de sobres</h1>
        <p className="aviso aviso-info">La recolección está desactivada fuera del entorno de pruebas.</p>
      </main>
    );
  }
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
  const esRecibe = p.pendiente?.recibeId === sesion.usuarioId;
  const esEntrega = p.pendiente?.entregaPorId === sesion.usuarioId;
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {p.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Caja de sobres · {p.sucursal}</h1>
      <p className="sub">
        Solo datos ficticios. Los sobres se quedan sellados en la caja con llave hasta que Dirección los recoge; la llave pasa con el
        turno. Aviso a partir de los {p.diasAviso} días de guardado cada sobre.
      </p>
      {aviso === "recogida" ? (
        <p className="aviso aviso-ok" role="status" data-testid="aviso-recogida">
          Recolección confirmada{diferencias && diferencias !== "0" ? `: ${diferencias} ${diferencias === "1" ? "sobre queda" : "sobres quedan"} por revisar (Administración)` : ""}.
          Lo recogido queda bajo tu responsabilidad hasta depositarlo.
        </p>
      ) : typeof aviso === "string" && AVISO[aviso] ? <p className="aviso aviso-ok" role="status">{AVISO[aviso]}</p> : null}

      <section className="tarjeta" aria-labelledby="t-caja" data-testid="caja-sobres">
        <h2 id="t-caja" className="titulo-seccion">En la caja ({p.caja.length})</h2>
        <p className="sub" data-testid="llave-caja">
          {p.custodia
            ? <>Llave: <strong>{p.custodia.nombre}</strong> · la recibió {MOMENTO[p.custodia.momento]} · {hora.format(p.custodia.desde)}{p.custodia.llave === "incidencia" ? " · con incidencia" : ""}</>
            : "Todavía no hay una revisión de la caja registrada."}
        </p>
        {p.caja.length ? (
          <table className="tabla" data-testid="tabla-caja">
            <thead><tr><th>Sobre</th><th>Lugar</th><th>Guardado</th><th>Días</th>{p.caja.some((s) => s.importe) ? <th>Anotado</th> : null}<th>Estado</th></tr></thead>
            <tbody>
              {p.caja.map((s) => (
                <tr key={s.id} data-testid={`caja-${s.folio}`}>
                  <td data-etiqueta="Sobre" className="mono">{s.folio}</td>
                  <td data-etiqueta="Lugar">{LUGAR[s.lugar]}</td>
                  <td data-etiqueta="Guardado">{hora.format(s.guardadoEn)} · {s.cerro}</td>
                  <td data-etiqueta="Días">{s.dias}</td>
                  {p.caja.some((x) => x.importe) ? <td data-etiqueta="Anotado">{s.importe ? pesos.format(Number(s.importe)) : "—"}</td> : null}
                  <td data-etiqueta="Estado">
                    {s.enEntrega ? "En entrega a Dirección" : "En la caja"}
                    {s.aviso ? <strong className="campo-error" data-testid={`aviso-${s.folio}`}> · aviso: {p.diasAviso} días o más</strong> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="sub">No hay sobres guardados.</p>}
      </section>

      {p.pendiente ? (
        <section className="tarjeta" aria-labelledby="t-pendiente" data-testid="entrega-pendiente">
          <h2 id="t-pendiente" className="titulo-seccion">Entrega pendiente a Dirección</h2>
          <p className="sub">
            Entrega <strong>{p.pendiente.entregaPor}</strong> a <strong>{p.pendiente.recibe}</strong> · {hora.format(p.pendiente.creadaEn)} ·
            {" "}{p.pendiente.sobres.length} {p.pendiente.sobres.length === 1 ? "sobre" : "sobres"}: {p.pendiente.sobres.map((s) => s.folio).join(", ")}
          </p>
          {esRecibe ? (
            <FormularioConfirmarRecoleccion codigo={codigo} recoleccionId={p.pendiente.id} version={p.pendiente.version} sobres={p.pendiente.sobres} />
          ) : <p className="sub">{p.pendiente.recibe} confirma desde su cuenta al verificar y contar cada sobre.</p>}
          {esRecibe || esEntrega ? <FormularioCancelarEntregaSobres codigo={codigo} recoleccionId={p.pendiente.id} version={p.pendiente.version} /> : null}
        </section>
      ) : p.puedeEntregar && p.caja.length ? (
        <section className="tarjeta" aria-labelledby="t-entregar">
          <h2 id="t-entregar" className="titulo-seccion">Entregar sobres a Dirección</h2>
          <FormularioEntregarSobres codigo={codigo} caja={p.caja} direccion={p.direccion} />
        </section>
      ) : null}

      {p.recolecciones.length ? (
        <section className="tarjeta" aria-labelledby="t-recogido" data-testid="recolecciones">
          <h2 id="t-recogido" className="titulo-seccion">Recogido por Dirección</h2>
          {p.recolecciones.map((r) => (
            <div key={r.id} className="tarjeta" data-testid="recoleccion">
              <p>
                <strong>{hora.format(r.confirmadaEn)}</strong> · entregó {r.entregaPor} · recogió {r.recibe}
              </p>
              <dl className="cuentas-lugar">
                <dt>Recogido</dt><dd data-testid="recogido">{pesos.format(Number(r.recogido))}</dd>
                <dt>Depositado</dt><dd data-testid="depositado">{pesos.format(Number(r.depositado))}</dd>
                <dt>Por depositar</dt><dd data-testid="saldo"><strong>{pesos.format(Number(r.saldo))}</strong>{Number(r.saldo) ? ` · bajo la responsabilidad de ${r.recibe}` : ""}</dd>
              </dl>
              <table className="tabla">
                <thead><tr><th>Sobre</th><th>Anotado al cerrar</th><th>Contado por Dirección</th></tr></thead>
                <tbody>
                  {r.sobres.map((s) => (
                    <tr key={s.folio}><td data-etiqueta="Sobre" className="mono">{s.folio}</td><td data-etiqueta="Anotado">{pesos.format(Number(s.anotado))}</td>
                      <td data-etiqueta="Contado">{pesos.format(Number(s.contado))}</td></tr>
                  ))}
                </tbody>
              </table>
              {r.depositos.length ? (
                <ul className="lista-simple" data-testid="depositos">
                  {r.depositos.map((d, i) => <li key={i}>{d.fecha} · {pesos.format(Number(d.importe))} · ref. {d.referencia} · registró {d.por}</li>)}
                </ul>
              ) : null}
              {r.recibeId === sesion.usuarioId && Number(r.saldo) > 0 ? <FormularioDeposito codigo={codigo} recoleccionId={r.id} saldo={r.saldo} hoy={hoy} /> : null}
              {r.diferencias.map((d) => (
                <div key={d.id} className="tarjeta" data-testid={`diferencia-${d.folio}`}>
                  <p>
                    <strong>Sobre <span className="mono">{d.folio}</span></strong> · anotado {pesos.format(Number(d.anotado))} · contado {pesos.format(Number(d.contado))} ·
                    diferencia <strong>{firmado(d.importe)}</strong>
                    {d.verificacion ? <> · llegó {COMO[d.verificacion.estado]}{d.verificacion.folioVisto ? ` (${d.verificacion.folioVisto})` : ""}: «{d.verificacion.motivo}»</> : null}
                  </p>
                  <p className="sub" data-testid="estado-diferencia">{ESTADO_DIF[d.estado]}{d.revisadaPor ? ` · ${d.revisadaPor}: «${d.motivo}»` : ""}</p>
                  <details>
                    <summary>Cadena de custodia</summary>
                    <ol className="lista-simple" data-testid="cadena">
                      {d.cadena.map((c, i) => <li key={i}>{hora.format(c.en)} · {c.momento} · {c.nombre}{c.estado ? ` · ${COMO[c.estado as keyof typeof COMO] ?? c.estado}` : ""}</li>)}
                    </ol>
                  </details>
                  {d.puedeRevisar ? <FormularioRevisarDiferenciaSobre codigo={codigo} diferenciaId={d.id} importe={d.importe} /> : null}
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : null}
    </main>
  );
}

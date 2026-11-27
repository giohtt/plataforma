import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioCorreccion, FormularioDecision } from "@/components/Gastos";
import { obtenerBaseDatos } from "@/lib/db";
import { detalleGasto, NOMBRE_ESTADO_GASTO, TEXTO_IMPEDIMENTO } from "@/lib/gastos";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Solicitud de gasto · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const AVISO: Record<string, string> = {
  solicitado: "Solicitud registrada. No mueve dinero ni autoriza el gasto.",
  corregido: "Corrección guardada como versión nueva. La anterior se conserva; si estaba decidida, se decide de nuevo.",
  autorizado: "Gasto autorizado desde tu cuenta. Autorizar no mueve dinero.",
  rechazado: "Gasto rechazado con tu motivo. Quien lo solicitó puede corregirlo y enviarlo de nuevo.",
};
const CLASE_ESTADO = { por_autorizar: "chip-programada", autorizado: "chip-vigente", rechazado: "chip-revocada" } as const;

/** Detalle de una solicitud con todas sus versiones. Sin permiso, «No encontrada». */
export default async function Gasto({ params, searchParams }: PageProps<"/sucursales/[codigo]/gastos/[clave]">) {
  const sesion = await requerirSesion();
  const { codigo, clave } = await params;
  const d = await detalleGasto(obtenerBaseDatos()!, sesion.usuarioId, codigo, decodeURIComponent(clave));
  if (!d) notFound();
  const { aviso } = await searchParams;
  const texto = typeof aviso === "string" ? AVISO[aviso] : undefined;
  const g = d.gasto;
  const ultima = d.versiones[d.versiones.length - 1];
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}/gastos`}>← Gastos</Link></p>
      <h1 className="cabecera-titulo"><span className="clave-caso" data-testid="clave-gasto">{g.clave}</span> · {g.concepto}</h1>
      {texto ? <p className="aviso aviso-ok" role="status">{texto}</p> : null}
      <section className="tarjeta" data-testid="datos-gasto">
        <p className="estado-gasto" data-testid="estado-gasto">
          <span className={`chip-estado ${CLASE_ESTADO[g.estado]}`}>{NOMBRE_ESTADO_GASTO[g.estado]}</span>
          {g.decididoPor ? ` por ${g.decididoPor}` : ""}{ultima.version > 1 ? ` · versión ${ultima.version}` : ""}
        </p>
        {g.motivoDecision ? <p className="sub" data-testid="motivo-decision">Motivo: «{g.motivoDecision}»</p> : null}
        <dl className="datos-expediente">
          <dt>Importe</dt><dd data-testid="importe-gasto">{pesos.format(Number(g.importe))}</dd>
          <dt>Categoría</dt><dd>{g.categoria}</dd>
          <dt>Proveedor</dt><dd>{g.proveedor ?? <span className="sub">Sin indicar</span>}</dd>
          <dt>Sucursal beneficiada</dt><dd>{g.beneficiada}</dd>
          <dt>Sucursal que paga</dt><dd data-testid="paga-gasto">{g.paga}{g.pagaOtra ? " (otra sucursal)" : ""}</dd>
          {g.compraDe ? <><dt>Parte de la compra</dt><dd data-testid="compra-de"><Link href={`/sucursales/${codigo}/gastos/${g.compraDe}`}>{g.compraDe}</Link></dd></> : null}
          {g.partes.length ? (
            <><dt>Partes de esta compra</dt><dd data-testid="partes">{g.partes.map((x) => `${x.clave} (${pesos.format(Number(x.importe))})`).join(", ")}</dd></>
          ) : null}
          {g.partes.length || g.compraDe ? <><dt>Total de la compra</dt><dd data-testid="total-compra">{pesos.format(Number(g.totalCompra))} · se compara con el límite por gasto</dd></> : null}
          <dt>Solicitó</dt><dd>{g.solicitadoPor} · {fechaHora.format(g.solicitadoEn)}</dd>
          {g.nota ? <><dt>Nota</dt><dd>{g.nota}</dd></> : null}
        </dl>
        <p className="sub">Solicitar no mueve dinero ni autoriza el gasto.</p>
        {g.estado === "por_autorizar" ? (
          <div className="aviso aviso-info" data-testid="quien-decide">
            {d.puedenDecidir.length
              ? <>Pueden decidirlo ahora: <strong>{d.puedenDecidir.join(", ")}</strong>. La primera persona que decide lo resuelve.</>
              : <>Nadie tiene todavía facultad suficiente para decidirlo: queda por autorizar.</>}
          </div>
        ) : null}
        {g.estado === "por_autorizar" && g.impedimento === null ? (
          <FormularioDecision codigo={codigo} clave={g.clave} version={ultima.version} importe={pesos.format(Number(g.importe))} />
        ) : g.estado === "por_autorizar" && g.impedimento && g.impedimento !== "sin_facultad" ? (
          <p className="sub" data-testid="impedimento">{TEXTO_IMPEDIMENTO[g.impedimento]}</p>
        ) : null}
        {d.puedeCorregir ? (
          <FormularioCorreccion codigo={codigo} clave={g.clave} version={ultima.version} categorias={d.categorias}
            actual={{ concepto: ultima.concepto, categoria: g.categoriaClave, importe: ultima.importe, proveedor: ultima.proveedor, nota: ultima.nota }} />
        ) : null}
      </section>
      <section className="tarjeta" aria-labelledby="t-versiones" data-testid="versiones-gasto">
        <h2 id="t-versiones" className="titulo-seccion">Historial de la solicitud</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Fecha y hora</th><th>Qué pasó</th><th>Cuenta</th></tr></thead>
            <tbody>
              {d.versiones.flatMap((v) => {
                const dec = d.decisiones.find((x) => x.version === v.version);
                return [
                  <tr key={`v${v.version}`} data-testid="version-gasto">
                    <td data-etiqueta="Fecha y hora">{fechaHora.format(v.en)}</td>
                    <td data-etiqueta="Qué pasó">
                      {v.version === 1 ? "Solicitud" : `Corrección · versión ${v.version}`}: {v.concepto} · {v.categoria} · {pesos.format(Number(v.importe))}
                      {v.proveedor ? ` · ${v.proveedor}` : ""}{v.motivo ? <><br /><span className="sub">Motivo: «{v.motivo}»</span></> : null}
                    </td>
                    <td data-etiqueta="Cuenta">{v.registradaPor}</td>
                  </tr>,
                  dec ? (
                    <tr key={`d${v.version}`} data-testid="decision-gasto">
                      <td data-etiqueta="Fecha y hora">{fechaHora.format(dec.en)}</td>
                      <td data-etiqueta="Qué pasó">
                        {dec.decision === "autorizado" ? "Autorizado" : "Rechazado"} · versión {dec.version} · {pesos.format(Number(dec.importe))}
                        {dec.version < ultima.version && dec.decision === "autorizado" ? <span className="sub"> · ya no vale: la solicitud se corrigió después</span> : null}
                        <br /><span className="sub">Con su facultad: {dec.sinLimite ? "sin límite" : `${pesos.format(Number(dec.limite))} por gasto y ${pesos.format(Number(dec.diario))} al día`}</span>
                        {dec.motivo ? <><br /><span className="sub">Motivo: «{dec.motivo}»</span></> : null}
                      </td>
                      <td data-etiqueta="Cuenta">{dec.por}</td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
        <p className="sub">El historial no se edita ni se borra.</p>
      </section>
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { FormularioCorreccion, FormularioResolucion, FormularioRevision, FormularioRevisionIncidencia } from "@/components/RevisionDiferencia";
import { ESTADO_DIFERENCIA, etiquetaDiferencia, NOMBRE_DECISION, NOMBRE_LUGAR, NOMBRE_NIVEL, tiempoPendiente } from "@/lib/datos-diferencia";
import { detalleDiferencias, TIPOS_REFERENCIA_CORRECCION } from "@/lib/diferencias";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Diferencia de efectivo · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const firmado = (v: string) => (Number(v) < 0 ? "−" : Number(v) > 0 ? "+" : "") + pesos.format(Math.abs(Number(v)));
const LUGARES = ["bolsa_visitas", "cajon_mensualidades"] as const;

/** Un cambio de turno: esperado, entregado, recibido y cada diferencia por separado, con el desglose del esperado. */
export default async function CasoDiferencia({ params, searchParams }: PageProps<"/sucursales/[codigo]/diferencias/[entrega]">) {
  const sesion = await requerirSesion();
  const { codigo, entrega } = await params;
  const { aviso } = await searchParams;
  const c = await detalleDiferencias(obtenerBaseDatos()!, sesion.usuarioId, codigo, entrega);
  if (!c) notFound();
  const dif = (lugar: (typeof LUGARES)[number], tipo: "contra_esperado" | "entre_personas") =>
    c.diferencias.find((d) => d.lugar === lugar && d.tipo === tipo);
  const f = c.fueraDeLaBolsa;
  const coincide = c.desglose.calculado === Number(c.lugares.bolsa_visitas.esperado).toFixed(2);
  const k = c.cierre;
  const VERIF = { correcto: "Cerrado y con su folio", abierto: "Abierto o sello roto", otro_folio: "Otro folio", falta: "No está" } as const;
  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={`/sucursales/${codigo}/diferencias`}>← Diferencias de {c.sucursal}</Link></p>
      <h1 className="cabecera-titulo">{k ? "Cierre del día y apertura" : "Cambio de turno"} · {c.sucursal}</h1>
      {k ? (
        <p className="sub" data-testid="encabezado-cierre">
          Cerró <strong>{c.entregaPor}</strong> {hora.format(c.entregadaEn)} · custodio <strong>{k.custodio}</strong> · abrió <strong>{c.recibe}</strong> {hora.format(c.confirmadaEn)}
          {k.mismaPersona ? " · la misma persona cerró y abrió" : ""}
        </p>
      ) : (
        <p className="sub">
          De <strong>{c.entregaPor}</strong> a <strong>{c.recibe}</strong> · entregó {hora.format(c.entregadaEn)} · confirmó {hora.format(c.confirmadaEn)} desde su propia cuenta
        </p>
      )}
      {aviso === "incidencia-revisada" ? <p className="aviso aviso-ok" role="status">Revisión de la incidencia registrada.</p> : null}
      {aviso === "revisada" ? <p className="aviso aviso-ok" role="status">Revisión registrada. Los importes no cambiaron.</p> : null}
      {aviso === "resuelta" ? <p className="aviso aviso-ok" role="status">Decisión de Dirección registrada. Los importes no cambiaron.</p> : null}
      {aviso === "corregida" ? <p className="aviso aviso-ok" role="status">Corrección registrada. El caso quedó cerrado.</p> : null}
      {c.participaste ? (
        <p className="aviso aviso-info" data-testid="participaste">Participaste en esta entrega: su revisión le corresponde a otra persona.</p>
      ) : null}
      <p className="sub" data-testid="nivel-revision">
        Revisa: <strong>{NOMBRE_NIVEL[c.nivel]}</strong>, según quién participó en la entrega
        {c.nivel === "encargado" ? "" : c.nivel === "administracion" ? " (participó alguien con perfil de Encargado)" : " (participó alguien con perfil de Administración)"}.
      </p>
      {LUGARES.map((l) => {
        const x = c.lugares[l];
        const de = dif(l, "contra_esperado");
        const dp = dif(l, "entre_personas");
        return (
          <section key={l} className="tarjeta" data-testid={`caso-${l}`} aria-label={NOMBRE_LUGAR[l]}>
            <h2 className="titulo-seccion">{NOMBRE_LUGAR[l]}</h2>
            <div className="cifras-caso">
              <div className="cifra-caso"><span className="sub">Saldo esperado</span>
                <strong data-testid="cifra-esperado">{x.esperado !== null ? pesos.format(Number(x.esperado)) : "No calculado"}</strong>
                {x.esperado === null ? <span className="sub">Faltan datos de Open Desk</span> : null}</div>
              <div className="cifra-caso"><span className="sub">{k ? "Cerró" : "Entregó"} {c.entregaPor}</span><strong data-testid="cifra-entregado">{pesos.format(Number(x.entregado))}</strong></div>
              <div className="cifra-caso"><span className="sub">{k ? "Abrió" : "Recibió"} {c.recibe}</span><strong data-testid="cifra-recibido">{pesos.format(Number(x.confirmado))}</strong>
                <span className="sub">Primer conteo {pesos.format(Number(x.inicial))}</span></div>
              <div className={`cifra-caso ${!dp ? "cifra-bien" : dp.estado === "aclarada" || dp.estado === "resuelta" ? "cifra-aclarada" : "cifra-mal"}`} data-testid="tarjeta-entre-personas"><span className="sub">{k ? "Diferencia entre cierre y apertura" : "Diferencia entre entrega y recepción"}</span>
                <strong data-testid="cifra-entre-personas">{dp ? firmado(dp.importe) : pesos.format(0)}</strong>
                {dp ? <span className="sub">{etiquetaDiferencia(dp.tipo, dp.importe, !!k)} · {ESTADO_DIFERENCIA[dp.estado]}</span> : null}</div>
            </div>
            <div className={`cifra-caso ${!de ? "" : de.estado === "aclarada" || de.estado === "resuelta" ? "cifra-aclarada" : "cifra-mal"}`} data-testid="cifra-contra-esperado">
              <span className="sub">Diferencia contra el esperado (lo entregado − el esperado)</span>
              <strong>{x.esperado === null ? "No se puede calcular" : de ? firmado(de.importe) : pesos.format(0)}</strong>
              {de ? <span className="sub">{etiquetaDiferencia(de.tipo, de.importe, !!k)} · {ESTADO_DIFERENCIA[de.estado]}</span> : null}
              {l === "bolsa_visitas" ? c.deRetiros.map((r) => (
                <span key={r.retiroId} className="sub" data-testid="de-retiro">
                  {Number(r.presente)
                    ? `Incluye ${firmado(r.presente)} registrados al retirar (folio ${r.folio}, ${hora.format(r.en)}): es la misma diferencia, no se suma otra vez.`
                    : `La diferencia de ${firmado(r.importe)} registrada al retirar (folio ${r.folio}, ${hora.format(r.en)}) ya no está presente en la entrega.`}
                </span>
              )) : null}
            </div>
          </section>
        );
      })}
      {c.nota ? <p className="sub">Nota de quien entregó: {c.nota}</p> : null}
      {c.aclaracion ? <p className="sub" data-testid="aclaracion-caso">{k ? "Motivo o aclaración al abrir" : "Aclaración del recuento"}: {c.aclaracion}</p> : null}
      {k ? (
        <section className="tarjeta" aria-labelledby="t-custodia" data-testid="custodia-caso">
          <h2 id="t-custodia" className="titulo-seccion">Custodia nocturna</h2>
          <dl className="cuentas-lugar">
            <dt>Configuración vigente al cerrar</dt>
            <dd className="dd-largo">{k.configuracion.lugar} · acceso: {k.configuracion.acceso.join(", ")} · definida por {k.configuracion.configuradaPor}</dd>
            <dt>Custodia</dt>
            <dd className="dd-largo">{k.custodia ? `Confirmada por ${k.custodio}: ${k.custodia.ubicacion} · ${hora.format(k.custodia.en)}` : `${k.custodio} no la confirmó antes de abrir`}</dd>
            <dt>Recuento al abrir</dt>
            <dd className="dd-largo">{k.recontadoConCustodio ? `Sí, con ${k.custodio}` : "No"}</dd>
            {k.cajon.lugarFondos ? (
              <>
                <dt>Fondos fijos</dt>
                <dd className="dd-largo" data-testid="caso-fondos">{k.cajon.lugarFondos} · acceso al cajón: {k.cajon.acceso.join(", ")}</dd>
                <dt>Llave del cajón</dt>
                <dd className="dd-largo">{k.custodio}{k.cajon.llave === "incidencia" ? ` · incidencia: «${k.cajon.motivoLlave}»` : k.cajon.llave === "correcta" ? " · cajón cerrado y llave recibida" : ""}</dd>
              </>
            ) : null}
            {k.cerroYCustodio || k.mismaPersona || k.custodioAbrio ? (
              <>
                <dt>Misma persona</dt>
                <dd className="dd-largo" data-testid="caso-misma-persona">
                  {[k.cerroYCustodio ? "cerró y custodió" : null, k.mismaPersona ? "cerró y abrió" : null, k.custodioAbrio && !k.mismaPersona ? "custodió y abrió" : null].filter(Boolean).join(" · ")}
                </dd>
              </>
            ) : null}
          </dl>
          {k.fondos.some((f) => f.cerrado) ? (
            <table className="tabla" data-testid="caso-fondo-sobre">
              <thead><tr><th>Fondo y sobre</th><th>Al cerrar</th><th>Primer conteo al abrir</th><th>Recuento</th></tr></thead>
              <tbody>
                {k.fondos.filter((f) => f.cerrado).flatMap((f) => (["fondo", "sobre"] as const).map((x) => (
                  <tr key={`${f.lugar}-${x}`}>
                    <td data-etiqueta="Fondo y sobre">{x === "fondo" ? "Fondo" : "Sobre"} · {f.lugar === "bolsa_visitas" ? "bolsa" : "cajón"}</td>
                    <td data-etiqueta="Al cerrar">{pesos.format(Number(f.cerrado![x]))}</td>
                    <td data-etiqueta="Primer conteo al abrir">{f.inicial ? pesos.format(Number(f.inicial[x])) : "—"}</td>
                    <td data-etiqueta="Recuento">{f.final ? pesos.format(Number(f.final[x])) : "—"}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          ) : null}
          <table className="tabla">
            <thead><tr><th>Sobre</th><th>Custodio</th><th>Al abrir</th></tr></thead>
            <tbody>
              {k.sobres.map((x) => (
                <tr key={x.folio} data-testid="sobre-caso">
                  <td className="mono" data-etiqueta="Sobre">{x.folio}</td>
                  {[x.custodia, x.apertura].map((v, i) => (
                    <td key={i} data-etiqueta={i ? "Al abrir" : "Custodio"}>{v ? `${VERIF[v.estado]}${v.folioVisto ? ` (${v.folioVisto})` : ""}${v.motivo ? ` · ${v.motivo}` : ""}` : "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="tarjeta" aria-labelledby="t-participacion" data-testid="participacion">
        <h2 id="t-participacion" className="titulo-seccion">Quién participó en el conteo</h2>
        <ul className="lista-simple">
          <li>{k ? "Contó y cerró" : "Contó y entregó"}: <strong>{c.entregaPor}</strong></li>
          {k ? <li>Custodio nocturno: <strong>{k.custodio}</strong></li> : null}
          <li>{k ? "Contó y abrió" : "Contó y recibió"}: <strong>{c.recibe}</strong></li>
          {c.apoyos.map((a) => (
            <li key={a.etapa} data-testid={`apoyo-${a.etapa}`}>
              Apoyo en {a.etapa === "conteo_entrega" ? (k ? "el conteo de quien cerró" : "el conteo de quien entregó") : a.etapa === "conteo_recepcion" ? (k ? "el conteo de quien abrió" : "el conteo de quien recibió") : "el recuento"}:{" "}
              {a.estado === "sin_registro" ? <em>sin registro de apoyo (entrega anterior a este registro)</em>
                : a.estado === "nadie" ? <>nadie más participó (lo declaró {a.declaradoPor})</>
                : <>
                    {a.personas.map((p, i) => (
                      <span key={i}>{i ? ", " : ""}<strong>{p.nombre}</strong> ({p.confirmadoEn ? `confirmó ${hora.format(p.confirmadoEn)}` : "pendiente de confirmar"})</span>
                    ))} · lo declaró {a.declaradoPor}
                  </>}
            </li>
          ))}
        </ul>
        <p className="sub">Quien participó, aunque su apoyo esté pendiente de confirmar, no revisa estas diferencias; su perfil cuenta para decidir quién revisa.</p>
      </section>

      {c.incidencias.length ? (
        <section className="tarjeta" aria-labelledby="t-incidencias" data-testid="incidencias">
          <h2 id="t-incidencias" className="titulo-seccion">Incidencias del cierre</h2>
          <p className="sub">Quedan por revisar aunque el efectivo cuadre. Revisar deja constancia; no cambia ningún importe.</p>
          {c.incidencias.map((i) => (
            <div key={i.id} className="tarjeta" data-testid="incidencia">
              <p>
                <strong>{i.tipo === "custodia_sin_confirmar" ? "Custodia sin confirmar" : i.tipo === "fondo_incompleto" ? "Fondo incompleto" : i.tipo === "llave_custodia" ? "Llave o cajón" : i.tipo === "llave_caja" ? "Llave de la caja de sobres" : i.tipo === "llave_cajon" ? "Llave del cajón de fondos" : i.tipo === "sobre_caja" ? "Sobre de la caja" : "Sello o folio"}</strong>{" "}
                <span className={`chip-estado ${i.revision ? "" : "chip-vencida"}`} data-testid="estado-incidencia">{i.revision ? "Revisada" : "Por revisar"}</span>
              </p>
              <p className="sub">{i.detalle}</p>
              {i.revision ? (
                <p className="sub">Revisó {i.revision.revisadaPor} ({NOMBRE_NIVEL[i.revision.nivel]}) · {hora.format(i.revision.en)} · «{i.revision.motivo}»</p>
              ) : c.puedeRevisar ? (
                <FormularioRevisionIncidencia codigo={codigo} incidenciaId={i.id} />
              ) : (
                <p className="sub">La revisa {NOMBRE_NIVEL[c.nivel]}.</p>
              )}
            </div>
          ))}
        </section>
      ) : null}
      <section className="tarjeta" aria-labelledby="t-revision" data-testid="revisiones">
        <h2 id="t-revision" className="titulo-seccion">Revisión de cada diferencia</h2>
        {c.diferencias.length ? c.diferencias.map((d) => {
          const lo = c.lugares[d.lugar];
          const comparado = d.tipo === "contra_esperado"
            ? `${pesos.format(Number(lo.entregado))} entregados − ${pesos.format(Number(lo.esperado))} esperados`
            : `${pesos.format(Number(lo.confirmado))} ${k ? "al abrir" : "confirmados"} − ${pesos.format(Number(lo.entregado))} ${k ? "al cerrar" : "entregados"}`;
          return (
            <div key={d.id} className="tarjeta" data-testid="diferencia" data-tipo={d.tipo}>
              <p>
                <strong>{NOMBRE_LUGAR[d.lugar]} · {etiquetaDiferencia(d.tipo, d.importe, !!k)}: {firmado(d.importe)}</strong>{" "}
                <span className={`chip-estado ${d.estado === "aclarada" || d.estado === "resuelta" ? "chip-aclarada" : "chip-vencida"}`} data-testid="estado-diferencia">{ESTADO_DIFERENCIA[d.estado]}</span>
              </p>
              <p className="sub">Se compara: {comparado}.</p>
              {d.revision ? (
                <>
                  <p className="sub" data-testid="revision">
                    Revisó <strong>{d.revision.revisadaPor}</strong> ({NOMBRE_NIVEL[d.revision.nivel]}) · {hora.format(d.revision.en)} · Motivo: «{d.revision.motivo}»
                  </p>
                  {/* El tiempo cuenta desde que se confirmó el faltante o sobrante; con la corrección pendiente, el caso sigue abierto. */}
                  {d.pendienteDireccionDesde ? (() => {
                    const t = tiempoPendiente(d.pendienteDireccionDesde);
                    return (
                      <p className="sub" data-testid="tiempo-pendiente">
                        {d.estado === "correccion_pendiente"
                          ? <>Corrección pendiente · Caso abierto desde hace {t.texto}</>
                          : <>Pendiente para Dirección desde hace {t.texto}</>}
                        {t.masDe48 ? <> · <span className="chip-estado chip-vencida" data-testid="aviso-48">Más de 48 horas pendiente</span></> : null}
                      </p>
                    );
                  })() : null}
                  {d.resolucion ? (
                    <p className="sub" data-testid="resolucion">
                      Decidió <strong>{d.resolucion.resueltaPor}</strong> (Dirección) · {hora.format(d.resolucion.en)} · <strong>{NOMBRE_DECISION[d.resolucion.decision]}</strong>
                      {d.resolucion.origen ? <> · Origen: «{d.resolucion.origen}»</> : null} · Motivo: «{d.resolucion.motivo}»
                      {d.resolucion.correccion ? <><br />Corrección: «{d.resolucion.correccion.texto}» · referencia {d.resolucion.correccion.referencia.tipo} {d.resolucion.correccion.referencia.id} · {d.resolucion.correccion.por} · {hora.format(d.resolucion.correccion.en)}</> : null}
                    </p>
                  ) : null}
                  {d.estado === "faltante_confirmado" || d.estado === "sobrante_confirmado" ? (
                    c.puedeResolver ? <FormularioResolucion codigo={codigo} diferenciaId={d.id} importe={d.importe} />
                      : <p className="sub">Pendiente de la decisión de Dirección.</p>
                  ) : d.estado === "correccion_pendiente" ? (
                    c.puedeResolver ? <FormularioCorreccion codigo={codigo} diferenciaId={d.id} tipos={TIPOS_REFERENCIA_CORRECCION} />
                      : <p className="sub">Pendiente de registrar la corrección.</p>
                  ) : null}
                </>
              ) : c.puedeRevisar ? (
                <FormularioRevision codigo={codigo} diferenciaId={d.id} importe={d.importe} />
              ) : (
                <p className="sub">Por revisar por {NOMBRE_NIVEL[c.nivel]}.</p>
              )}
            </div>
          );
        }) : <p className="sub">Esta entrega no tiene diferencias.</p>}
        <p className="sub">Revisar y resolver dejan constancia de lo ocurrido y conservan todos los importes registrados y el saldo de apertura del turno siguiente.</p>
      </section>

      <section className="tarjeta" aria-labelledby="t-desglose" data-testid="desglose">
        <h2 id="t-desglose" className="titulo-seccion">Movimientos que componen el saldo esperado de la bolsa</h2>
        <p className="sub">Turno abierto por {c.desglose.abiertoPor} el {hora.format(c.desglose.abiertoEn)}; movimientos registrados hasta la entrega.</p>
        <div className="tabla-desplazable">
          <table className="tabla tabla-ancha">
            <thead><tr><th>Movimiento</th><th>Detalle</th><th>Importe</th></tr></thead>
            <tbody>
              <tr><td>Contado al abrir</td><td>{hora.format(c.desglose.abiertoEn)} · {c.desglose.abiertoPor}</td><td>{pesos.format(Number(c.desglose.contadoAlAbrir))}</td></tr>
              <tr data-testid="desglose-cobros"><td>Cobros de visitas en efectivo</td>
                <td>{c.desglose.cobros.cuantos} {c.desglose.cobros.cuantos === 1 ? "cobro" : "cobros"} · {c.desglose.cobros.visitas} {c.desglose.cobros.visitas === 1 ? "visita" : "visitas"}</td>
                <td>+ {pesos.format(Number(c.desglose.cobros.importe))}</td></tr>
              <tr data-testid="desglose-cancelaciones"><td>Cancelaciones aprobadas</td>
                <td>{c.desglose.cancelaciones.cuantas} {c.desglose.cancelaciones.cuantas === 1 ? "cobro duplicado" : "cobros duplicados"}</td>
                <td>{Number(c.desglose.cancelaciones.importe) ? `− ${pesos.format(Math.abs(Number(c.desglose.cancelaciones.importe)))}` : pesos.format(0)}</td></tr>
              <tr data-testid="desglose-retiros"><td>Retiros a Encargada de retiros</td>
                <td>{c.desglose.retiros.cuantos ? `${c.desglose.retiros.cuantos} ${c.desglose.retiros.cuantos === 1 ? "retiro" : "retiros"}` : "Ninguno"}</td>
                <td>{Number(c.desglose.retiros.importe) ? `− ${pesos.format(Math.abs(Number(c.desglose.retiros.importe)))}` : pesos.format(0)}</td></tr>
              {c.desglose.fondos.cuantas ? (
                <tr data-testid="desglose-fondos"><td>Entradas al fondo fijo</td>
                  <td>{c.desglose.fondos.cuantas} {c.desglose.fondos.cuantas === 1 ? "entrada" : "entradas"}</td>
                  <td>+ {pesos.format(Number(c.desglose.fondos.importe))}</td></tr>
              ) : null}
              {c.desglose.sobres.cuantos ? (
                <tr data-testid="desglose-sobres"><td>Excedente al sobre de la caja</td>
                  <td>Se guardó sellado hasta la recolección</td>
                  <td>− {pesos.format(Math.abs(Number(c.desglose.sobres.importe)))}</td></tr>
              ) : null}
              <tr><td><strong>Saldo esperado al entregar</strong></td><td></td><td data-testid="desglose-total"><strong>{pesos.format(Number(c.desglose.calculado))}</strong></td></tr>
            </tbody>
          </table>
        </div>
        {!coincide ? (
          <p className="aviso aviso-error" data-testid="desglose-no-coincide">
            El desglose ({pesos.format(Number(c.desglose.calculado))}) no coincide con el esperado guardado al entregar ({pesos.format(Number(c.lugares.bolsa_visitas.esperado))}). Revísalo con Dirección.
          </p>
        ) : null}
        <p className="sub" data-testid="fuera-bolsa">
          <strong>No entran a la bolsa</strong> (no cambian el esperado): tarjeta {pesos.format(Number(f.tarjeta.importe))} ({f.tarjeta.cobros});
          transferencias verificadas {pesos.format(Number(f.transferenciaVerificada.importe))}, pendientes {pesos.format(Number(f.transferenciaPendiente.importe))} y
          no localizadas {pesos.format(Number(f.transferenciaNoLocalizada.importe))}.
        </p>
      </section>
      <section className="tarjeta" aria-labelledby="t-historial" data-testid="historial-caso">
        <h2 id="t-historial" className="titulo-seccion">Historial del caso</h2>
        <div className="tabla-desplazable">
          <table className="tabla tabla-ancha">
            <thead><tr><th>Fecha y hora</th><th>Qué pasó</th><th>Cuenta</th></tr></thead>
            <tbody>
              {c.historial.map((h, i) => (
                <tr key={i} data-testid="evento-caso"><td>{hora.format(h.en)}</td><td>{h.que}</td><td>{h.cuenta}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">El historial no se edita ni se borra.</p>
      </section>
    </main>
  );
}

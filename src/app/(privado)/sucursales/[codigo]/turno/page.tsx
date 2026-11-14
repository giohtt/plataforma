import Link from "next/link";
import { conPunto } from "@/lib/formato";
import { notFound } from "next/navigation";
import { FormularioCancelarEntrega } from "@/components/Entrega";
import { FormularioApertura } from "@/components/FormularioApertura";
import { obtenerBaseDatos } from "@/lib/db";
import { ESTADO_DIFERENCIA } from "@/lib/datos-diferencia";
import { entregaEnCurso, entregaRecibida, type DiferenciaEntrega } from "@/lib/entregas";
import { leerEntorno } from "@/lib/entorno";
import { requerirSesion } from "@/lib/sesion-servidor";
import { resumenAccesosTurno } from "@/lib/accesos";
import { tienePermiso } from "@/lib/permisos";
import { retirosDelTurno } from "@/lib/retiros";
import { estadoTurno, type TipoLugar } from "@/lib/turnos";
import { ventasDelTurno, type Grupo } from "@/lib/ventas";
import { cobrosDelTurno, impedimentoRegistroVisita } from "@/lib/visitas";

export const metadata = { title: "Turno · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const NOMBRE: Record<TipoLugar, string> = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" };

/** Turno de Recepción de la sucursal. Sin permiso de turnos en la sucursal: «No encontrada». */
export default async function Turno({ params, searchParams }: PageProps<"/sucursales/[codigo]/turno">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const e = await estadoTurno(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!e) notFound();
  const { aviso, dif: difRetiro, folio: folioRetiro } = await searchParams;
  const t = e.turno;
  const sql = obtenerBaseDatos()!;
  const puedeCobrar = t ? (await impedimentoRegistroVisita(sql, sesion.usuarioId, codigo, leerEntorno())) === null : false;
  const cobros = t ? await cobrosDelTurno(sql, t.id) : [];
  const accesos = t ? await resumenAccesosTurno(sql, t.id) : null;
  const enCurso = t ? await entregaEnCurso(sql, t.id) : null;
  const recibida = t ? await entregaRecibida(sql, t.id) : null;
  const retiros = t ? await retirosDelTurno(sql, t.id) : [];
  const puedeRetirar = t && !enCurso && leerEntorno() !== "produccion" && !e.sucursal.inactiva
    && t.lugares.some((l) => l.responsableId === sesion.usuarioId)
    && (await tienePermiso(sql, sesion.usuarioId, "caja.retirar", e.sucursal.id));
  const puedeEntregar = t && !enCurso && leerEntorno() !== "produccion" && !e.sucursal.inactiva
    && t.lugares.every((l) => l.responsableId === sesion.usuarioId)
    && (await tienePermiso(sql, sesion.usuarioId, "turno.entregar", e.sucursal.id));
  const firmado = (v: string) => (Number(v) < 0 ? "−" : "+") + pesos.format(Math.abs(Number(v)));
  const dif = (lugar: TipoLugar, tipo: DiferenciaEntrega["tipo"]) => recibida?.diferencias.find((d) => d.lugar === lugar && d.tipo === tipo);
  const [puedeRegistrarAcceso, puedeRevisarAccesos] = await Promise.all([
    tienePermiso(sql, sesion.usuarioId, "acceso.registrar_apertura", e.sucursal.id),
    tienePermiso(sql, sesion.usuarioId, "acceso.consultar", e.sucursal.id),
  ]);
  const conTarjeta = cobros.filter((c) => c.formaPago === "tarjeta");
  const totalTarjeta = conTarjeta.reduce((suma, c) => suma + Math.round(Number(c.total) * 100), 0) / 100;
  const transferencias = cobros.filter((c) => c.formaPago === "transferencia");
  const porEstado = (estado: string) => {
    const lista = transferencias.filter((c) => c.estado === estado);
    return { n: lista.length, total: lista.reduce((suma, c) => suma + Math.round(Number(c.total) * 100), 0) / 100 };
  };
  const [tPend, tVer, tNoLoc] = [porEstado("pendiente_abono"), porEstado("abono_verificado"), porEstado("no_localizado")];
  // Ventas: total confirmado (efectivo, tarjeta y transferencias verificadas); lo demás, aparte.
  const ventas = ventasDelTurno(cobros);
  const cuenta = (g: Grupo) => `${g.cobros} ${g.cobros === 1 ? "cobro" : "cobros"}`;
  const ESTADO_TRANSFERENCIA: Record<string, string> = {
    pendiente_abono: "Pendiente de verificar abono", abono_verificado: "Abono verificado", no_localizado: "No localizado",
  };

  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {e.sucursal.nombre}</Link></p>
      <h1 className="cabecera-titulo">Turno de Recepción</h1>
      <p className="sub">Solo datos ficticios. Un turno abierto a la vez por sucursal.</p>
      {aviso === "abierto" && t ? <p className="aviso aviso-ok" role="status">Turno abierto.</p> : null}
      {aviso === "entregado" && enCurso ? (
        <p className="aviso aviso-ok" role="status">Entrega registrada. Queda pendiente hasta que {enCurso.recibe} cuente y confirme desde su cuenta.</p>
      ) : null}
      {aviso === "entrega-cancelada" ? <p className="aviso aviso-ok" role="status">Entrega cancelada. El turno sigue a tu cargo.</p> : null}
      {aviso === "retiro" ? (
        <p className="aviso aviso-ok" role="status">
          Retiro registrado{typeof folioRetiro === "string" ? ` con el folio ${folioRetiro}` : ""}: la salida ya se descontó. Queda pendiente de confirmar por Encargada de retiros.
          {typeof difRetiro === "string" && /^-?\d+\.\d{2}$/.test(difRetiro) ? ` Se registró una diferencia de ${(Number(difRetiro) < 0 ? "−" : "+") + pesos.format(Math.abs(Number(difRetiro)))} contra el esperado al retirar; se vincula al cambio de turno si sigue presente.` : ""}
        </p>
      ) : null}
      {aviso === "recibido" && recibida ? <p className="aviso aviso-ok" role="status">Turno recibido. Desde ahora eres la responsable de la bolsa y del cajón.</p> : null}

      {t ? (
        <>
          <section className="tarjeta" data-testid="turno-abierto">
            <h2 className="titulo-seccion">Turno abierto</h2>
            <p>Abierto por <strong>{t.abiertoPor}</strong> · {hora.format(t.abiertoEn)}</p>
            <p className="sub">El cierre del día llega en un paso siguiente del bloque 5.</p>
            {puedeCobrar ? (
              <p className="fila-acciones">
                <Link className="boton boton-principal" href={`/sucursales/${codigo}/turno/visita`}>Registrar visita</Link>
              </p>
            ) : null}
          </section>
          {enCurso ? (
            <section className="tarjeta" aria-labelledby="t-entrega" data-testid="entrega-en-curso">
              <h2 id="t-entrega" className="titulo-seccion">Cambio de turno</h2>
              <p className="aviso aviso-info" data-testid="estado-entrega">
                {enCurso.estado === "recuento"
                  ? <>El conteo de <strong>{enCurso.recibe}</strong> no coincidió: recuento pendiente.</>
                  : <>Entrega pendiente de confirmar por <strong>{enCurso.recibe}</strong>.</>}{" "}
                {enCurso.entregaPor} entregó · {conPunto(hora.format(enCurso.creadaEn))} Mientras tanto no se registran cobros.
              </p>
              {enCurso.recibeId === sesion.usuarioId ? (
                <p className="fila-acciones">
                  <Link className="boton boton-principal" href={`/sucursales/${codigo}/turno/recibir`} data-testid="ir-recibir">Recibir el turno</Link>
                </p>
              ) : null}
              {enCurso.entregaPorId === sesion.usuarioId ? (
                <FormularioCancelarEntrega codigo={codigo} entregaId={enCurso.id} version={enCurso.version} />
              ) : null}
            </section>
          ) : puedeEntregar ? (
            <section className="tarjeta" aria-labelledby="t-entrega" data-testid="cambio-turno">
              <h2 id="t-entrega" className="titulo-seccion">Cambio de turno</h2>
              <p className="sub">Cuenta la bolsa y el cajón y entrégalos a la recepcionista que entra. Ella confirma desde su propia cuenta.</p>
              <p className="fila-acciones">
                <Link className="boton" href={`/sucursales/${codigo}/turno/entrega`} data-testid="ir-entregar">Entregar el turno</Link>
              </p>
            </section>
          ) : null}
          {recibida ? (
            <section className="tarjeta" aria-labelledby="t-recibida" data-testid="entrega-recibida">
              <h2 id="t-recibida" className="titulo-seccion">Entrega recibida</h2>
              <p className="sub">
                De <strong>{recibida.entregaPor}</strong> a <strong>{recibida.recibe}</strong> · entregó {hora.format(recibida.creadaEn)} ·
                confirmó {hora.format(recibida.confirmadaEn)}
              </p>
              <p className="sub">En pantallas angostas, desliza la tabla a los lados para ver todas las columnas; el lugar queda fijo.</p>
              <div className="tabla-desplazable" tabIndex={0} aria-label="Entrega recibida: desliza para ver todas las columnas">
                <table className="tabla tabla-ancha">
                  <thead>
                    <tr><th>Lugar</th><th>Esperado</th><th>Entregó</th><th>Primer conteo de quien recibe</th><th>Confirmó</th>
                      <th>Dif. contra el esperado</th><th>Dif. entre ambas personas</th></tr>
                  </thead>
                  <tbody>
                    {(["bolsa_visitas", "cajon_mensualidades"] as const).map((l) => {
                      const k = l === "bolsa_visitas" ? "bolsa" : "cajon";
                      const de = dif(l, "contra_esperado");
                      const dp = dif(l, "entre_personas");
                      return (
                        <tr key={l} data-testid={`recibida-${l}`}>
                          <td>{NOMBRE[l]}</td>
                          <td>{l === "bolsa_visitas" ? pesos.format(Number(recibida.esperadoBolsa)) : "No calculado"}</td>
                          <td>{pesos.format(Number(recibida.entregado[k]))}</td>
                          <td>{pesos.format(Number(recibida.inicial[k]))}</td>
                          <td>{pesos.format(Number(recibida.confirmado[k]))}</td>
                          <td data-testid="dif-esperado">{l === "cajon_mensualidades" ? "No se puede calcular" : de ? <strong>{firmado(de.importe)} · {ESTADO_DIFERENCIA[de.estado]}</strong> : pesos.format(0)}</td>
                          <td data-testid="dif-personas">{dp ? <strong>{firmado(dp.importe)} · {ESTADO_DIFERENCIA[dp.estado]}</strong> : pesos.format(0)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {recibida.nota ? <p className="sub">Nota de quien entregó: {recibida.nota}</p> : null}
              {recibida.aclaracion ? <p className="sub" data-testid="aclaracion">Aclaración del recuento: {recibida.aclaracion}</p> : null}
              <p className="sub">Las diferencias no se corrigen: quedan registradas y se revisan aparte, sin cambiar los importes. Este turno empieza con lo que se confirmó.</p>
            </section>
          ) : null}
          {retiros.length || puedeRetirar ? (
            <section className="tarjeta" aria-labelledby="t-retiros" data-testid="retiros-turno">
              <h2 id="t-retiros" className="titulo-seccion">Retiros a Encargada de retiros</h2>
              {retiros.length ? (
                <div className="tabla-desplazable" tabIndex={0} aria-label="Retiros del turno: desliza para ver todas las columnas">
                  <table className="tabla tabla-ancha">
                    <thead><tr><th>Lugar</th><th>Folio</th><th>Contado</th><th>Deja para cambio</th><th>Se lleva</th><th>Entregó</th><th>Estado</th></tr></thead>
                    <tbody>
                      {retiros.map((r) => (
                        <tr key={r.id} data-testid="retiro-turno" data-folio={r.folio}>
                          <td>{NOMBRE[r.lugar]}</td>
                          <td className="mono">{r.folio}</td>
                          <td>{pesos.format(Number(r.contado))}</td>
                          <td>{pesos.format(Number(r.cambio))}</td>
                          <td>{pesos.format(Number(r.importe))}</td>
                          <td>{r.entregadoPor} · {hora.format(r.entregadoEn)} · a {r.encargada}</td>
                          <td data-testid="estado-retiro"><strong>{r.textoEstado}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="sub">Todavía no hay retiros en este turno.</p>}
              <p className="sub">La salida se descuenta al entregar el sobre. Recepción ve el estado; el detalle de una discrepancia lo revisa quien corresponde.</p>
              {puedeRetirar ? (
                <p className="fila-acciones">
                  <Link className="boton" href={`/sucursales/${codigo}/turno/retiro`} data-testid="ir-retiro">Entregar a Encargada de retiros</Link>
                </p>
              ) : null}
            </section>
          ) : null}
          <div className="lugares-turno">
            {t.lugares.map((l) => (
              <section key={l.tipo} className="tarjeta" data-testid={`lugar-${l.tipo}`} aria-label={NOMBRE[l.tipo]}>
                <h2 className="titulo-seccion">{NOMBRE[l.tipo]}</h2>
                <dl className="cuentas-lugar">
                  <dt>{recibida ? "Recibido en el cambio de turno" : "Contado al abrir"}</dt>
                  <dd data-testid="contado-al-abrir">{pesos.format(Number(l.contadoAlAbrir))}</dd>
                  {l.tipo === "bolsa_visitas" ? (
                    <>
                      <dt>Cobros de visitas en efectivo ({l.cantidadEntradas} {l.cantidadEntradas === 1 ? "cobro" : "cobros"} · {l.visitasEntradas} {l.visitasEntradas === 1 ? "visita" : "visitas"})</dt>
                      <dd data-testid="entradas">+ {pesos.format(Number(l.entradas))}</dd>
                      {l.cantidadAjustes ? (
                        <>
                          <dt>Cancelaciones aprobadas ({l.cantidadAjustes} {l.cantidadAjustes === 1 ? "cobro duplicado" : "cobros duplicados"})</dt>
                          <dd data-testid="ajustes">− {pesos.format(-Number(l.ajustes))}</dd>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {l.cantidadRetiros ? (
                    <>
                      <dt>Retiros a Encargada de retiros ({l.cantidadRetiros})</dt>
                      <dd data-testid="retiros">− {pesos.format(-Number(l.retiros))}</dd>
                    </>
                  ) : null}
                  <dt>Efectivo esperado</dt>
                  <dd data-testid="esperado" className={l.esperado === null ? "dd-largo" : undefined}>
                    {l.esperado !== null ? <strong>{pesos.format(Number(l.esperado))}</strong> : "No calculado: faltan datos de Open Desk"}
                  </dd>
                  {l.cantidadDiferenciasRetiro ? (
                    <>
                      <dt>Diferencia contra el esperado registrada al retirar ({l.cantidadDiferenciasRetiro})</dt>
                      <dd data-testid="diferencia-retiros">{(Number(l.diferenciaRetiros) < 0 ? "−" : "+") + pesos.format(Math.abs(Number(l.diferenciaRetiros)))}</dd>
                    </>
                  ) : null}
                </dl>
                {l.cantidadDiferenciasRetiro ? (
                  <p className="sub">Ya está registrada: en el cambio de turno se vincula a la diferencia contra el esperado si sigue presente, sin duplicarse.</p>
                ) : null}
                <p className="sub">Responsable: <strong>{l.responsable}</strong>, desde {hora.format(l.responsableDesde)}</p>
                {l.tipo === "cajon_mensualidades" ? (
                  <p className="aviso aviso-info" data-testid="no-conciliado">No conciliado: faltan datos de Open Desk</p>
                ) : (
                  <p className="sub">El esperado no es un conteo: se cuenta al entregar el turno.</p>
                )}
              </section>
            ))}
          </div>
          {accesos ? (
            <section className="tarjeta" aria-labelledby="t-accesos" data-testid="accesos-turno">
              <h2 id="t-accesos" className="titulo-seccion">Accesos de este turno (registro de aperturas)</h2>
              <dl className="cuentas-lugar">
                <dt>Entradas con pase</dt>
                <dd data-testid="accesos-entradas">{accesos.entradas}</dd>
                <dt>Reingresos con el mismo pase</dt>
                <dd data-testid="accesos-reingresos">{accesos.reingresos}</dd>
                <dt>Entradas con transferencia pendiente (autorizadas)</dt>
                <dd data-testid="accesos-transferencia">{accesos.conTransferencia}</dd>
                <dt>Aperturas sin pase</dt>
                <dd data-testid="accesos-sin-pase">{accesos.sinPase}</dd>
                <dt>Autorizaciones pendientes</dt>
                <dd data-testid="accesos-pendientes">{accesos.pendientes}</dd>
              </dl>
              {accesos.sinMotivo ? (
                <p className="aviso aviso-info" data-testid="accesos-sin-motivo">
                  {accesos.sinMotivo} {accesos.sinMotivo === 1 ? "apertura de emergencia sin motivo" : "aperturas de emergencia sin motivo"}: escríbelo en «Accesos del turno».
                </p>
              ) : null}
              <p className="sub">Registrar accesos no cambia los cobros, la bolsa ni las ventas.</p>
              <p className="fila-acciones">
                {puedeRegistrarAcceso ? (
                  <Link className="boton" href={`/sucursales/${codigo}/turno/accesos`} data-testid="ir-accesos">Accesos del turno</Link>
                ) : null}
                {puedeRevisarAccesos ? (
                  <Link className="boton" href={`/sucursales/${codigo}/accesos`}>Registro de accesos</Link>
                ) : null}
              </p>
            </section>
          ) : null}
          <section className="tarjeta" aria-labelledby="t-ventas" data-testid="ventas-turno">
            <h2 id="t-ventas" className="titulo-seccion">Ventas de visitas del turno</h2>
            <dl className="cuentas-lugar">
              <dt>Efectivo ({cuenta(ventas.efectivo)})</dt>
              <dd data-testid="ventas-efectivo">{pesos.format(Number(ventas.efectivo.importe))}</dd>
              <dt>Tarjeta ({cuenta(ventas.tarjeta)})</dt>
              <dd data-testid="ventas-tarjeta">{pesos.format(Number(ventas.tarjeta.importe))}</dd>
              <dt>Transferencias verificadas ({cuenta(ventas.transferenciaVerificada)})</dt>
              <dd data-testid="ventas-transferencia">{pesos.format(Number(ventas.transferenciaVerificada.importe))}</dd>
              <dt>Total confirmado ({cuenta(ventas.totalConfirmado)} · {ventas.totalConfirmado.visitas} {ventas.totalConfirmado.visitas === 1 ? "visita" : "visitas"})</dt>
              <dd data-testid="ventas-total"><strong>{pesos.format(Number(ventas.totalConfirmado.importe))}</strong></dd>
            </dl>
            <h3 className="titulo-seccion">No suman al total confirmado</h3>
            <dl className="cuentas-lugar" data-testid="ventas-fuera">
              <dt>Transferencias pendientes de verificar ({cuenta(ventas.transferenciaPendiente)})</dt>
              <dd data-testid="ventas-pendientes">{pesos.format(Number(ventas.transferenciaPendiente.importe))}</dd>
              <dt>Transferencias no localizadas ({cuenta(ventas.transferenciaNoLocalizada)})</dt>
              <dd data-testid="ventas-no-localizadas">{pesos.format(Number(ventas.transferenciaNoLocalizada.importe))}</dd>
            </dl>
            {ventas.cancelados.cobros ? (
              <p className="sub" data-testid="ventas-excluidas">
                Tampoco cuentan {ventas.cancelados.cobros} {ventas.cancelados.cobros === 1 ? "cobro cancelado" : "cobros cancelados"} por duplicado ({pesos.format(Number(ventas.cancelados.importe))}).
              </p>
            ) : null}
            <p className="sub">Una transferencia suma cuando se verifica su abono, aunque antes haya estado pendiente o no localizada. Nada de esto cambia la bolsa de visitas.</p>
          </section>
          <section className="tarjeta" aria-labelledby="t-tarjeta" data-testid="tarjeta-turno">
            <h2 id="t-tarjeta" className="titulo-seccion">Cobros con tarjeta</h2>
            <dl className="cuentas-lugar">
              <dt>Cobros ({conTarjeta.length} {conTarjeta.length === 1 ? "cobro" : "cobros"} · {(() => { const v = conTarjeta.reduce((n, c) => n + c.personas, 0); return `${v} ${v === 1 ? "visita" : "visitas"}`; })()})</dt>
              <dd data-testid="total-tarjeta">{pesos.format(totalTarjeta)}</dd>
              <dt>Estado</dt>
              <dd>{conTarjeta.length ? "Confirmados operativamente" : "—"}</dd>
              <dt>Liquidación bancaria</dt>
              <dd data-testid="conciliacion-tarjeta">{conTarjeta.length ? "Pendiente de conciliar" : "—"}</dd>
            </dl>
            <p className="sub">La tarjeta no entra a la bolsa de visitas ni cambia su efectivo esperado.</p>
          </section>
          <section className="tarjeta" aria-labelledby="t-transf" data-testid="transferencias-turno">
            <h2 id="t-transf" className="titulo-seccion">Transferencias</h2>
            <dl className="cuentas-lugar">
              <dt>Pendientes de verificar abono ({tPend.n})</dt>
              <dd data-testid="transf-pendientes">{pesos.format(tPend.total)}</dd>
              <dt>Abono verificado ({tVer.n})</dt>
              <dd data-testid="transf-verificadas">{pesos.format(tVer.total)}</dd>
              <dt>No localizadas ({tNoLoc.n})</dt>
              <dd data-testid="transf-no-localizadas">{pesos.format(tNoLoc.total)}</dd>
            </dl>
            <p className="sub">Las transferencias no entran a la bolsa de visitas ni cambian su efectivo esperado.</p>
          </section>
          <section className="tarjeta" aria-labelledby="t-cobros" data-testid="cobros-turno">
            <h2 id="t-cobros" className="titulo-seccion">Cobros de visitas de este turno ({cobros.length})</h2>
            {cobros.length ? (
              <ul className="lista-simple">
                {cobros.map((c) => (
                  <li key={c.id} data-testid="cobro-turno">
                    {hora.format(c.registradaEn)} · {c.personas} {c.personas === 1 ? "persona" : "personas"} ·{" "}
                    <strong>{pesos.format(Number(c.total))}</strong>{" "}
                    {c.formaPago === "tarjeta"
                      ? "con tarjeta · confirmado operativamente · liquidación pendiente de conciliar"
                      : c.formaPago === "transferencia"
                      ? `por transferencia · ${ESTADO_TRANSFERENCIA[c.estado]}`
                      : c.estado === "cancelado"
                      ? <>en efectivo · <strong data-testid="marca-cancelado">Cancelado (duplicado)</strong></>
                      : "en efectivo"}
                    {c.cancelacionSolicitada ? <> · <strong data-testid="marca-solicitada">Cancelación solicitada</strong></> : null} ·{" "}
                    <Link href={`/sucursales/${codigo}/turno/cobros/${c.id}`}>Ver detalle</Link>
                  </li>
                ))}
              </ul>
            ) : <p className="sub">Todavía no hay cobros de visitas.</p>}
          </section>
        </>
      ) : e.sucursal.inactiva ? (
        <p className="aviso aviso-info">Esta sucursal está desactivada: no se pueden abrir turnos.</p>
      ) : e.puedeAbrir && leerEntorno() !== "produccion" ? (
        <section className="tarjeta" aria-labelledby="t-abrir">
          <h2 id="t-abrir" className="titulo-seccion">Abrir turno en {e.sucursal.nombre}</h2>
          <p className="sub">Cuenta cada lugar por separado y escribe solo el total.</p>
          <FormularioApertura codigo={codigo} responsable={sesion.nombre} />
        </section>
      ) : (
        <p className="aviso aviso-info" data-testid="sin-turno">No hay turno abierto en {e.sucursal.nombre}.</p>
      )}
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { reporteVisitas, type SaldoTurno, type SucursalReporte } from "@/lib/reporte-visitas";
import { requerirSesion } from "@/lib/sesion-servidor";
import type { Grupo } from "@/lib/ventas";

export const metadata = { title: "Visitas y cobros · Fitnessland" };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const $ = (importe: string) => pesos.format(Number(importe));
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const dia = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" });
const fecha = (f: string) => dia.format(new Date(`${f}T00:00:00Z`));
const texto = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 20) : undefined);

/** Suma de grupos de varias sucursales (en centavos). */
function sumar(grupos: Grupo[]): Grupo {
  const centavos = grupos.reduce((s, g) => s + Math.round(Number(g.importe) * 100), 0);
  return { cobros: grupos.reduce((s, g) => s + g.cobros, 0), visitas: grupos.reduce((s, g) => s + g.visitas, 0), importe: (centavos / 100).toFixed(2) };
}
const cp = (g: Grupo) => `${g.cobros} · ${g.visitas} ${g.visitas === 1 ? "pase" : "pases"}`;

function FilaGrupo({ nombre, g, id, total }: { nombre: string; g: Grupo; id: string; total?: boolean }) {
  return (
    <tr data-testid={id} className={total ? "fila-total" : undefined}>
      <td data-etiqueta="">{total ? <strong>{nombre}</strong> : nombre}</td>
      <td data-etiqueta="Cobros">{g.cobros}</td>
      <td data-etiqueta="Pases">{g.visitas}</td>
      <td data-etiqueta="Importe">{total ? <strong>{$(g.importe)}</strong> : $(g.importe)}</td>
    </tr>
  );
}

function Saldos({ filas }: { filas: { sucursal: string; t: SaldoTurno | null }[] }) {
  return (
    <section className="tarjeta" aria-labelledby="t-saldos" data-testid="saldos-turno">
      <h2 id="t-saldos" className="titulo-seccion">Saldo de la bolsa de visitas por turno</h2>
      <div className="tabla-desplazable">
        <table className="tabla">
          <thead><tr><th>Turno</th><th>Estado</th><th>Movimientos en efectivo</th><th>Efectivo esperado</th></tr></thead>
          <tbody>
            {filas.map(({ sucursal, t }, i) => t ? (
              <tr key={t.turnoId} data-testid="saldo-turno">
                <td data-etiqueta="Turno">{sucursal} · abierto el {hora.format(t.abiertoEn)}{t.cerradoEn ? ` → ${hora.format(t.cerradoEn)}` : ""} · {t.abiertoPor}</td>
                <td data-etiqueta="Estado">{t.cerradoEn ? "Cerrado" : "Abierto"}</td>
                <td data-etiqueta="Movimientos">
                  Contado al abrir {$(t.contadoAlAbrir)} · {t.cantidadEntradas} {t.cantidadEntradas === 1 ? "entrada" : "entradas"} {$(t.entradas)}
                  {t.cantidadAjustes ? ` · ${t.cantidadAjustes} ${t.cantidadAjustes === 1 ? "cancelación" : "cancelaciones"} − ${pesos.format(-Number(t.ajustes))}` : ""}
                </td>
                <td data-etiqueta="Efectivo esperado" data-testid="saldo-esperado">
                  <strong>{$(t.esperado)}</strong> <span className="sub">{t.cerradoEn ? "al cerrar" : "ahora"}</span>
                </td>
              </tr>
            ) : (
              <tr key={`sin-${i}`} data-testid="saldo-sin-turno">
                <td data-etiqueta="Turno">{sucursal}</td>
                <td data-etiqueta="Estado">—</td>
                <td data-etiqueta="Movimientos">Sin turnos en el periodo</td>
                <td data-etiqueta="Efectivo esperado">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sub">
        Un renglón por turno y sin total. El saldo es el del turno completo (ahora si sigue abierto, al cerrar si ya cerró),
        aunque empiece o termine fuera del periodo. Los saldos no se suman: el efectivo entregado al siguiente turno se contaría dos veces.
      </p>
    </section>
  );
}

function Detalle({ s }: { s: SucursalReporte }) {
  const v = s.ventas;
  const sinVerificar = sumar([v.transferenciaPendiente, v.transferenciaNoLocalizada]);
  return (
    <>
      <section className="tarjeta" aria-labelledby="t-confirmados" data-testid="confirmados">
        <h2 id="t-confirmados" className="titulo-seccion">Cobros confirmados</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Forma de pago</th><th>Cobros</th><th>Pases</th><th>Importe</th></tr></thead>
            <tbody>
              <FilaGrupo nombre="Efectivo" g={v.efectivo} id="conf-efectivo" />
              <FilaGrupo nombre="Tarjeta" g={v.tarjeta} id="conf-tarjeta" />
              <FilaGrupo nombre="Transferencias verificadas" g={v.transferenciaVerificada} id="conf-transferencia" />
              <FilaGrupo nombre="Total confirmado" g={v.totalConfirmado} id="conf-total" total />
            </tbody>
          </table>
        </div>
      </section>
      <section className="tarjeta" aria-labelledby="t-sin-verificar" data-testid="sin-verificar">
        <h2 id="t-sin-verificar" className="titulo-seccion">Transferencias sin verificar</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Estado</th><th>Cobros</th><th>Pases</th><th>Importe</th></tr></thead>
            <tbody>
              <FilaGrupo nombre="Pendientes de verificar" g={v.transferenciaPendiente} id="sv-pendientes" />
              <FilaGrupo nombre="No localizadas" g={v.transferenciaNoLocalizada} id="sv-no-localizadas" />
              <FilaGrupo nombre="Total sin verificar" g={sinVerificar} id="sv-total" total />
            </tbody>
          </table>
        </div>
        <p className="sub">No suman al total confirmado. Si se verifican después, el mismo cobro pasa a confirmados y suma una vez.</p>
      </section>
      <section className="tarjeta" aria-labelledby="t-cancelados" data-testid="cancelados">
        <h2 id="t-cancelados" className="titulo-seccion">Cancelados</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Motivo</th><th>Cobros</th><th>Pases</th><th>Importe</th></tr></thead>
            <tbody><FilaGrupo nombre="Cancelados por duplicado" g={v.cancelados} id="cancelados-duplicado" /></tbody>
          </table>
        </div>
        <p className="sub">No cuentan como venta. El ajuste en efectivo ya está descontado en el saldo de su turno.</p>
      </section>
      <section className="tarjeta" aria-labelledby="t-registrados" data-testid="registrados">
        <h2 id="t-registrados" className="titulo-seccion">Todos los cobros registrados en el periodo</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th></th><th>Cobros</th><th>Pases</th></tr></thead>
            <tbody>
              <tr><td>Confirmados</td><td>{v.totalConfirmado.cobros}</td><td>{v.totalConfirmado.visitas}</td></tr>
              <tr><td>Transferencias sin verificar</td><td>{sinVerificar.cobros}</td><td>{sinVerificar.visitas}</td></tr>
              <tr><td>Cancelados</td><td>{v.cancelados.cobros}</td><td>{v.cancelados.visitas}</td></tr>
              <tr className="fila-total" data-testid="registrados-total">
                <td><strong>Total registrado</strong></td><td><strong>{s.registrados.cobros}</strong></td><td><strong>{s.registrados.visitas}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="sub">Incluye los cancelados. Cada cobro tiene sus pases: un cobro grupal de 4 personas es 1 cobro y 4 pases.</p>
      </section>
    </>
  );
}

function VariasSucursales({ filas }: { filas: SucursalReporte[] }) {
  const tot = (f: (s: SucursalReporte) => Grupo) => sumar(filas.map(f));
  return (
    <>
      <section className="tarjeta" aria-labelledby="t-resumen" data-testid="resumen-sucursales">
        <h2 id="t-resumen" className="titulo-seccion">Resumen por sucursal</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead>
              <tr>
                <th>Sucursal</th><th>Confirmados</th><th>Confirmado</th>
                <th>Transferencias sin verificar: pendientes</th><th>Transferencias sin verificar: no localizadas</th>
                <th>Cancelado</th><th>Registrados</th>
              </tr>
            </thead>
            <tbody>
              {[...filas.map((s) => ({ nombre: s.nombre, id: `resumen-${s.codigo}`, v: s.ventas, r: s.registrados, total: false })),
                { nombre: "Todas mis sucursales", id: "resumen-total", total: true,
                  v: { totalConfirmado: tot((s) => s.ventas.totalConfirmado), transferenciaPendiente: tot((s) => s.ventas.transferenciaPendiente),
                       transferenciaNoLocalizada: tot((s) => s.ventas.transferenciaNoLocalizada), cancelados: tot((s) => s.ventas.cancelados) },
                  r: { cobros: filas.reduce((n, s) => n + s.registrados.cobros, 0), visitas: filas.reduce((n, s) => n + s.registrados.visitas, 0) } },
              ].map((f) => (
                <tr key={f.id} data-testid={f.id} className={f.total ? "fila-total" : undefined}>
                  <td data-etiqueta="Sucursal">{f.total ? <strong>{f.nombre}</strong> : f.nombre}</td>
                  <td data-etiqueta="Confirmados">{cp(f.v.totalConfirmado)}</td>
                  <td data-etiqueta="Confirmado">{$(f.v.totalConfirmado.importe)}</td>
                  <td data-etiqueta="Transferencias sin verificar: pendientes">{$(f.v.transferenciaPendiente.importe)} <span className="sub">({f.v.transferenciaPendiente.cobros})</span></td>
                  <td data-etiqueta="Transferencias sin verificar: no localizadas">{$(f.v.transferenciaNoLocalizada.importe)} <span className="sub">({f.v.transferenciaNoLocalizada.cobros})</span></td>
                  <td data-etiqueta="Cancelado">{$(f.v.cancelados.importe)} <span className="sub">({f.v.cancelados.cobros})</span></td>
                  <td data-etiqueta="Registrados">{f.r.cobros} · {f.r.visitas} {f.r.visitas === 1 ? "pase" : "pases"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">Las ventas sí se suman entre sucursales. Los saldos de efectivo no: se muestran por turno.</p>
      </section>
      <section className="tarjeta" aria-labelledby="t-forma" data-testid="forma-pago-sucursales">
        <h2 id="t-forma" className="titulo-seccion">Confirmado por forma de pago</h2>
        <div className="tabla-desplazable">
          <table className="tabla">
            <thead><tr><th>Sucursal</th><th>Efectivo</th><th>Tarjeta</th><th>Transferencias verificadas</th><th>Total</th></tr></thead>
            <tbody>
              {[...filas.map((s) => ({ nombre: s.nombre, id: `forma-${s.codigo}`, v: s.ventas, total: false })),
                { nombre: "Todas mis sucursales", id: "forma-total", total: true,
                  v: { efectivo: tot((s) => s.ventas.efectivo), tarjeta: tot((s) => s.ventas.tarjeta),
                       transferenciaVerificada: tot((s) => s.ventas.transferenciaVerificada), totalConfirmado: tot((s) => s.ventas.totalConfirmado) } },
              ].map((f) => (
                <tr key={f.id} data-testid={f.id} className={f.total ? "fila-total" : undefined}>
                  <td data-etiqueta="Sucursal">{f.total ? <strong>{f.nombre}</strong> : f.nombre}</td>
                  <td data-etiqueta="Efectivo">{$(f.v.efectivo.importe)}</td>
                  <td data-etiqueta="Tarjeta">{$(f.v.tarjeta.importe)}</td>
                  <td data-etiqueta="Transferencias verificadas">{$(f.v.transferenciaVerificada.importe)}</td>
                  <td data-etiqueta="Total"><strong>{$(f.v.totalConfirmado.importe)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** Solo consulta. Sin reporte.visitas en la sucursal pedida (por ejemplo, Recepción, o una sucursal ajena): «No encontrada». */
export default async function ReporteVisitas({ searchParams }: PageProps<"/reportes/visitas">) {
  const sesion = await requerirSesion();
  const q = await searchParams;
  const sucursal = texto(q.sucursal);
  const r = await reporteVisitas(obtenerBaseDatos()!, sesion.usuarioId, {
    codigo: sucursal ? sucursal.slice(0, 10) : null, desde: texto(q.desde), hasta: texto(q.hasta),
  });
  if (!r) notFound();
  const volver = r.codigo ?? (r.sucursales.length === 1 ? r.sucursales[0].codigo : null);
  const una = r.filas.length === 1;
  const saldos = r.filas.flatMap((s): { sucursal: string; t: SaldoTurno | null }[] => (s.turnos.length ? s.turnos.map((t) => ({ sucursal: s.nombre, t })) : [{ sucursal: s.nombre, t: null }]));

  return (
    <main className="contenedor">
      <p className="sub"><Link href={volver ? `/sucursales/${volver}` : "/"}>← {volver ? r.sucursales.find((s) => s.codigo === volver)?.nombre : "Inicio"}</Link></p>
      <h1 className="cabecera-titulo">Visitas y cobros</h1>
      <p className="sub">Solo consulta. Solo datos ficticios. Actualizado: {hora.format(r.generadoEn)}</p>

      <form className="tarjeta filtros-reporte" method="get" action="/reportes/visitas" data-testid="filtros">
        <div className="campo">
          <label htmlFor="sucursal">Sucursal</label>
          {r.sucursales.length > 1 ? (
            <select id="sucursal" name="sucursal" defaultValue={r.codigo ?? ""}>
              <option value="">Todas mis sucursales</option>
              {r.sucursales.map((s) => <option key={s.codigo} value={s.codigo}>{s.nombre}</option>)}
            </select>
          ) : (
            <select id="sucursal" name="sucursal" defaultValue={r.sucursales[0].codigo}>
              <option value={r.sucursales[0].codigo}>{r.sucursales[0].nombre}</option>
            </select>
          )}
        </div>
        <div className="campo">
          <label htmlFor="desde">Desde</label>
          <input id="desde" name="desde" type="date" defaultValue={r.desde} required />
        </div>
        <div className="campo">
          <label htmlFor="hasta">Hasta</label>
          <input id="hasta" name="hasta" type="date" defaultValue={r.hasta} required />
        </div>
        <button className="boton" type="submit">Ver</button>
      </form>
      {r.periodoInvalido ? (
        <p className="aviso aviso-error" role="alert" data-testid="periodo-invalido">
          El periodo no es válido (fechas incompletas, «desde» después de «hasta» o más de un año). Se muestran los últimos 7 días.
        </p>
      ) : null}
      <p className="sub" data-testid="periodo">
        {r.filas.map((s) => s.nombre).join(" y ")} · del {fecha(r.desde)} al {fecha(r.hasta)} · cobros registrados en esas fechas
        (hora de la Ciudad de México), con su estado al consultar.
      </p>

      {una ? <Detalle s={r.filas[0]} /> : <VariasSucursales filas={r.filas} />}
      <Saldos filas={saldos} />
      {!una ? <p className="sub">Al elegir una sola sucursal se ve el detalle por forma de pago, transferencias sin verificar y cancelados.</p> : null}
    </main>
  );
}

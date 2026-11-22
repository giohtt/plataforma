import type postgres from "postgres";
import { esIdentificadorValido } from "@/lib/permisos";
import { periodo } from "@/lib/reporte-visitas";
import type { TipoLugar } from "@/lib/turnos";

/**
 * Reporte de caja por sucursal y periodo (bloque 5; estructura aprobada el 21 nov 2026; solo datos ficticios).
 *
 * «Dónde está el efectivo al corte»: cada peso aparece en UNA sola etapa y, al pasar a la siguiente, sale de la anterior.
 *   1. En la sucursal: bolsa y cajón por separado (en el turno abierto, o lo que quedó guardado al cerrar). El cajón
 *      cuenta con su último conteo y los movimientos registrados después: es información incompleta mientras falten
 *      los datos de mensualidades de Open Desk.
 *   2. Sobres por recoger (en el buzón, en la caja o por devolver a la caja).
 *   3. Entregado, pendiente de confirmar (retiros a Encargada de retiros; sobres entregados a Dirección).
 *   4. Confirmado, por depositar (recolecciones de Dirección; retiros habilitados; retiros en pausa por revisión).
 *   5. Depositado en el periodo: ya salió de la custodia, no se suma a lo anterior.
 * Lo recogido cuenta con lo CONTADO, no con lo anotado. Las diferencias y los sobres por investigar van aparte y no se
 * suman a ninguna etapa. Un saldo de antes del periodo sigue apareciendo mientras esté pendiente al corte
 * («Anterior al periodo»). «Movimientos» es solo lo ocurrido dentro del periodo (pasos del mismo dinero: no se suman).
 *
 * Corte: fin del periodo (o ahora, si el periodo llega a hoy). Los detalles conservan el corte con que se abrieron; lo
 * posterior al corte se marca aparte y no cambia las cifras.
 *
 * Conteo a ciegas: quien puede recoger sobres en la sucursal no ve lo anotado de los sobres que aún no se cuentan
 * (tampoco en detalles, historiales ni archivos). Un sobre por investigar ya no se va a contar: su anotado se ve, como
 * en la pantalla del buzón. Encargada de retiros no ve el importe de un retiro suyo pendiente de
 * confirmar. Con importes ocultos el recuadro es «Subtotal visible», nunca «Total».
 *
 * Permisos individuales (ningún perfil los trae): «reporte.caja» para consultar y «reporte.caja_descargar» para
 * descargar, que además exige poder consultar esa sucursal. Se comprueban en el servidor, dentro de la transacción de
 * solo lectura que arma el reporte. El cuadre completo queda pendiente de los datos de Open Desk.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

const ZONA = "America/Mexico_City";
const cent = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Math.round(Number(v) * 100));
const pesos = (c: number) => (c / 100).toFixed(2);
const HORAS_AVISO = 48;

export type Lugar = {
  lugarId: string;
  tipo: TipoLugar;
  /** turno: hay un turno abierto al corte; cerrado: lo que quedó al cerrar; sin_datos: aún no hay turnos. */
  estado: "turno" | "cerrado" | "sin_datos";
  importe: string | null;
  /** Último conteo antes del corte (al abrir el turno o al cerrar). */
  base: { importe: string; en: Date; por: string; momento: "apertura" | "cierre" } | null;
  /** Movimientos registrados después de ese conteo y hasta el corte (cobros, cancelaciones, retiros, fondo). */
  movimientos: string;
  cuantos: number;
  responsable: string | null;
};
export type SobrePorRecoger = {
  id: string; folio: string; lugar: TipoLugar; guardadoEn: Date; cerro: string;
  donde: "buzon" | "caja" | "por_devolver"; anotado: string | null; oculto: boolean; dias: number; anterior: boolean;
};
export type Pendiente =
  | { clase: "retiro"; id: string; folio: string; lugar: TipoLugar; en: Date; entrego: string; recibe: string; importe: string | null; oculto: boolean; anterior: boolean }
  | { clase: "entrega_sobres"; id: string; folios: string[]; en: Date; entrego: string; recibe: string; importe: string | null; oculto: boolean; anterior: boolean };
export type Confirmado =
  | { clase: "recoleccion"; id: string; recibe: string; desde: Date; buzon: boolean; recogido: string; depositado: string; saldo: string; anterior: boolean }
  | { clase: "retiro"; id: string; folio: string; lugar: TipoLugar; encargada: string; desde: Date; habilitado: string; depositado: string; saldo: string; aviso: boolean; anterior: boolean }
  | { clase: "retiro_pausa"; id: string; folio: string; lugar: TipoLugar; encargada: string; desde: Date; saldo: string; anterior: boolean };
export type Deposito = { clase: "recoleccion" | "retiro"; origenId: string; folio: string | null; por: string; en: Date; fecha: string; referencia: string; importe: string };
export type Diferencia = {
  clase: "turno" | "retiro_esperado" | "retiro_importe" | "sobre";
  id: string;
  /** A qué detalle lleva: el sobre, el retiro o el caso de la entrega (pantalla «Diferencias de efectivo»). */
  enlace: { tipo: "sobre" | "retiro" | "entrega"; id: string };
  texto: string; lugar: TipoLugar; importe: string; estado: string; abierta: boolean; anterior: boolean; registradaEn: Date;
  /** Entra en el neto de referencia (las diferencias «entre ambas personas» no son dinero faltante ni sobrante). */
  neto: boolean;
};
export type PorInvestigar = { sobreId: string; folio: string; lugar: TipoLugar; anotado: string; desde: Date; recoleccionId: string; anterior: boolean };
export type Grupo = { n: number; importe: string };
export type Movimientos = {
  cobros: Grupo; cancelaciones: Grupo; recogido: Grupo; depositado: Grupo;
  sellados: { n: number; anotado: string | null; ocultos: number };
  retiros: { n: number; importe: string; ocultos: number; confirmados: number; pendientes: number };
  /** Lo que hay detrás de cada línea, para abrir su detalle. */
  lista: {
    sellados: { id: string; folio: string; lugar: TipoLugar; en: Date; anotado: string | null }[];
    recogidas: { id: string; en: Date; recibe: string; importe: string }[];
    retiros: { id: string; folio: string; lugar: TipoLugar; en: Date; importe: string | null; pendiente: boolean }[];
  };
};
export type CajaSucursal = {
  id: string; codigo: string; nombre: string;
  /** Puede recoger sobres aquí: no ve lo anotado de los sobres sin contar. */
  recogedor: boolean;
  lugares: Lugar[]; sobres: SobrePorRecoger[]; pendientes: Pendiente[]; confirmados: Confirmado[]; depositos: Deposito[];
  diferencias: Diferencia[]; investigar: PorInvestigar[]; movimientos: Movimientos;
  /** Suma de lo visible en las etapas 1 a 4. Con importes ocultos es un subtotal. */
  visible: string;
  ocultos: number;
  /** Lleva importes anotados de sobres que aún no se cuentan (quien consulta no los recoge). */
  anotadosSinContar: boolean;
};
export type ReporteCaja = {
  sucursales: { codigo: string; nombre: string; descargar: boolean }[];
  codigo: string | null;
  desde: string; hasta: string; periodoInvalido: boolean;
  corte: Date; inicio: Date;
  filas: CajaSucursal[];
  generadoEn: Date;
};

/** Fecha y hora válidas del corte pedido, o null. */
function leerCorte(v: string | undefined): Date | null {
  if (!v || v.length > 40) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Periodo, inicio y corte (fin del periodo o ahora; uno pedido solo si cae dentro del periodo y no es futuro). */
async function ventana(tx: Tx, filtros: { desde?: string; hasta?: string; corte?: string }) {
  const [{ ahora, hoy }] = await tx<{ ahora: Date; hoy: string }[]>`select now() as ahora, (now() at time zone ${ZONA})::date::text as hoy`;
  let p = periodo(filtros.desde, filtros.hasta, hoy);
  if (p.desde > hoy) p = { ...periodo(undefined, undefined, hoy), invalido: true };
  const [{ inicio, fin }] = await tx<{ inicio: Date; fin: Date }[]>`
    select (${p.desde}::date::timestamp at time zone ${ZONA}) as inicio, ((${p.hasta}::date + 1)::timestamp at time zone ${ZONA}) as fin`;
  const maximo = new Date(Math.min(ahora.getTime(), fin.getTime()));
  const pedido = leerCorte(filtros.corte);
  const corte = pedido && pedido >= inicio && pedido <= maximo ? pedido : maximo;
  return { p, inicio, corte, ahora };
}

async function calcularSucursal(tx: Tx, usuarioId: string, s: { id: string; codigo: string; nombre: string }, inicio: Date, corte: Date): Promise<CajaSucursal> {
  const [{ recogedor }] = await tx<{ recogedor: boolean }[]>`select tiene_permiso(${usuarioId}, 'sobre.recoger', ${s.id}) as recogedor`;
  const anterior = (d: Date) => d < inicio;

  // 1. Bolsa y cajón al corte.
  const lugares: Lugar[] = [];
  const [t] = await tx<{ id: string; cerrado_en: Date | null }[]>`
    select id, cerrado_en from turno where sucursal_id = ${s.id} and abierto_en <= ${corte} order by abierto_en desc limit 1`;
  if (t && (t.cerrado_en === null || t.cerrado_en > corte)) {
    const filas = await tx<{ lugar_id: string; tipo: TipoLugar; base: string; en: Date; por: string; movimientos: string; cuantos: number; responsable: string | null }[]>`
      select l.id as lugar_id, l.tipo, c.importe::text as base, c.en, u.nombre as por,
             coalesce((select sum(me.importe) from movimiento_efectivo me where me.turno_id = ${t.id} and me.lugar_id = l.id and me.en <= ${corte}), 0)::numeric(12, 2)::text as movimientos,
             (select count(*)::int from movimiento_efectivo me where me.turno_id = ${t.id} and me.lugar_id = l.id and me.en <= ${corte}) as cuantos,
             (select x.nombre from responsable_lugar r join usuario x on x.id = r.usuario_id
              where r.turno_id = ${t.id} and r.lugar_id = l.id and r.desde <= ${corte} and (r.hasta is null or r.hasta > ${corte})
              order by r.desde desc limit 1) as responsable
      from lugar_efectivo l join conteo_efectivo c on c.lugar_id = l.id and c.turno_id = ${t.id} and c.momento = 'apertura'
      join usuario u on u.id = c.contado_por
      where l.sucursal_id = ${s.id} order by case l.tipo when 'bolsa_visitas' then 0 else 1 end`;
    for (const f of filas) {
      lugares.push({ lugarId: f.lugar_id, tipo: f.tipo, estado: "turno", importe: pesos(cent(f.base) + cent(f.movimientos)),
                     base: { importe: f.base, en: f.en, por: f.por, momento: "apertura" }, movimientos: f.movimientos, cuantos: f.cuantos, responsable: f.responsable });
    }
  } else if (t) {
    const filas = await tx<{ lugar_id: string; tipo: TipoLugar; importe: string; en: Date; por: string }[]>`
      select l.id as lugar_id, l.tipo, ec.importe::text as importe, ec.en, u.nombre as por
      from entrega_turno e join entrega_conteo ec on ec.entrega_id = e.id and ec.tipo = 'entregado'
      join lugar_efectivo l on l.id = ec.lugar_id join usuario u on u.id = ec.contado_por
      where e.id = (select e2.id from entrega_turno e2 where e2.turno_id = ${t.id} and e2.tipo = 'cierre' and e2.estado <> 'cancelada'
                    and e2.creada_en <= ${corte} order by e2.creada_en desc limit 1)
      order by case l.tipo when 'bolsa_visitas' then 0 else 1 end`;
    for (const f of filas) {
      lugares.push({ lugarId: f.lugar_id, tipo: f.tipo, estado: "cerrado", importe: f.importe,
                     base: { importe: f.importe, en: f.en, por: f.por, momento: "cierre" }, movimientos: "0.00", cuantos: 0, responsable: null });
    }
  }
  if (!lugares.length) {
    for (const l of await tx<{ id: string; tipo: TipoLugar }[]>`
      select id, tipo from lugar_efectivo where sucursal_id = ${s.id} order by case tipo when 'bolsa_visitas' then 0 else 1 end`) {
      lugares.push({ lugarId: l.id, tipo: l.tipo, estado: "sin_datos", importe: null, base: null, movimientos: "0.00", cuantos: 0, responsable: null });
    }
  }

  // 2. Sobres sellados al corte que aún no se recogían, no estaban entregados ni por investigar.
  const sobresFilas = await tx<{ id: string; folio: string; lugar: TipoLugar; guardado_en: Date; cerro: string; importe: string; en_buzon: boolean; por_devolver: boolean; contado_ya: boolean; dias: number }[]>`
    select s.id, s.folio, l.tipo as lugar, s.resuelto_en as guardado_en, u.nombre as cerro, s.importe::text as importe,
           (exists (select 1 from sobre_depositado d where d.sobre_id = s.id and d.en <= ${corte})
            or exists (select 1 from traslado_sobre x join traslado_buzon tb on tb.id = x.traslado_id where x.sobre_id = s.id and tb.en <= ${corte})) as en_buzon,
           exists (select 1 from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
                   where x.sobre_id = s.id and r.estado = 'cancelada' and r.resuelta_en <= ${corte}
                     and not exists (select 1 from devolucion_sobre ds join devolucion_recoleccion dr on dr.id = ds.devolucion_id
                                     where ds.sobre_id = s.id and ds.recoleccion_id = r.id and dr.en <= ${corte})) as por_devolver,
           exists (select 1 from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
                   where x.sobre_id = s.id and r.estado = 'confirmada' and x.contado is not null) as contado_ya,
           floor(extract(epoch from ${corte}::timestamptz - s.resuelto_en) / 86400)::int as dias
    from sobre_cierre s join lugar_efectivo l on l.id = s.lugar_id join entrega_turno e on e.id = s.entrega_id join usuario u on u.id = e.entrega_por
    where s.sucursal_id = ${s.id} and s.importe is not null and s.estado in ('usado', 'recogido') and s.resuelto_en <= ${corte}
      and not exists (select 1 from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
                      where x.sobre_id = s.id and r.estado = 'confirmada' and r.resuelta_en <= ${corte} and x.contado is not null)
      and not exists (select 1 from investigacion_sobre i where i.sobre_id = s.id and i.creada_en <= ${corte})
      and not exists (select 1 from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
                      where x.sobre_id = s.id and r.creada_en <= ${corte} and (r.resuelta_en is null or r.resuelta_en > ${corte}))
    order by s.resuelto_en, s.folio`;
  const sobres: SobrePorRecoger[] = sobresFilas.map((f) => {
    const oculto = recogedor && !f.contado_ya;
    return { id: f.id, folio: f.folio, lugar: f.lugar, guardadoEn: f.guardado_en, cerro: f.cerro, donde: f.por_devolver ? "por_devolver" : f.en_buzon ? "buzon" : "caja",
             anotado: oculto ? null : f.importe, oculto, dias: f.dias, anterior: anterior(f.guardado_en) };
  });

  // Retiros entregados hasta el corte (etapas 3 y 4, y su diferencia de importe).
  const retiros = await tx<{
    id: string; folio: string; lugar: TipoLugar; importe: string; entregado_en: Date; encargada_id: string; entrego: string; encargada: string; estado: string;
    habilitado_en: Date | null; reportado_en: Date | null; monto_habilitado: string | null; discrepancia: string | null; contado: string | null; depositado: string; revision: string | null;
  }[]>`
    select r.id, r.folio, l.tipo as lugar, r.importe::text as importe, r.entregado_en, r.encargada_id, a.nombre as entrego, b.nombre as encargada, r.estado,
           r.habilitado_en, r.reportado_en, r.monto_habilitado::text as monto_habilitado, r.discrepancia,
           (select c.importe::text from retiro_conteo c where c.retiro_id = r.id and c.en <= ${corte} order by (c.tipo = 'recuento') desc, c.en desc limit 1) as contado,
           coalesce((select sum(d.importe) from deposito_retiro d where d.retiro_id = r.id and d.en <= ${corte}
                     and not exists (select 1 from deposito_retiro c where c.corrige_id = d.id and c.en <= ${corte})), 0)::numeric(12, 2)::text as depositado,
           (select v.resultado from retiro_revision v where v.retiro_id = r.id and v.en <= ${corte}) as revision
    from retiro r join lugar_efectivo l on l.id = r.lugar_id join usuario a on a.id = r.entregado_por join usuario b on b.id = r.encargada_id
    where r.sucursal_id = ${s.id} and r.entregado_en <= ${corte}
    order by r.entregado_en`;

  // 3. Entregado, pendiente de confirmar.
  const pendientes: Pendiente[] = [];
  const confirmados: Confirmado[] = [];
  const diferencias: Diferencia[] = [];
  for (const r of retiros) {
    const confirmacion = [r.habilitado_en, r.reportado_en].filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime())[0];
    if (!confirmacion || confirmacion > corte) {
      const oculto = r.encargada_id === usuarioId && (r.estado === "pendiente" || r.estado === "recuento");
      pendientes.push({ clase: "retiro", id: r.id, folio: r.folio, lugar: r.lugar, en: r.entregado_en, entrego: r.entrego, recibe: r.encargada,
                        importe: oculto ? null : r.importe, oculto, anterior: anterior(r.entregado_en) });
      continue;
    }
    if (r.habilitado_en && r.habilitado_en <= corte) {
      const saldo = cent(r.monto_habilitado) - cent(r.depositado);
      if (saldo > 0) {
        confirmados.push({ clase: "retiro", id: r.id, folio: r.folio, lugar: r.lugar, encargada: r.encargada, desde: r.habilitado_en, habilitado: r.monto_habilitado!,
                           depositado: r.depositado, saldo: pesos(saldo), aviso: corte.getTime() - r.habilitado_en.getTime() >= HORAS_AVISO * 3_600_000,
                           anterior: anterior(r.entregado_en) });
      }
    } else {
      confirmados.push({ clase: "retiro_pausa", id: r.id, folio: r.folio, lugar: r.lugar, encargada: r.encargada, desde: confirmacion,
                         saldo: r.contado ?? r.importe, anterior: anterior(r.entregado_en) });
    }
    if (r.discrepancia === "importe" && r.reportado_en && r.reportado_en <= corte && r.contado !== null) {
      const abierta = r.revision === null;
      diferencias.push({ clase: "retiro_importe", id: r.id, enlace: { tipo: "retiro", id: r.id },
                         texto: `Retiro ${r.folio} · registrado ${dinero(r.importe)} · contado ${dinero(r.contado)}`, lugar: r.lugar,
                         importe: pesos(cent(r.contado) - cent(r.importe)), estado: abierta ? "Por revisar" : RESULTADO[r.revision!] ?? r.revision!,
                         abierta, anterior: anterior(r.reportado_en), registradaEn: r.reportado_en, neto: true });
    }
  }
  const entregasSobres = await tx<{ id: string; creada_en: Date; entrego: string; recibe: string; folios: string[]; importe: string; confirmada_ya: boolean }[]>`
    select r.id, r.creada_en, a.nombre as entrego, b.nombre as recibe, array_agg(s.folio order by s.resuelto_en, s.folio) as folios,
           sum(s.importe)::numeric(12, 2)::text as importe, r.estado = 'confirmada' as confirmada_ya
    from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id join sobre_cierre s on s.id = x.sobre_id
    join usuario a on a.id = r.entrega_por join usuario b on b.id = r.recibe
    where r.sucursal_id = ${s.id} and not r.buzon and r.creada_en <= ${corte} and (r.resuelta_en is null or r.resuelta_en > ${corte})
    group by r.id, a.nombre, b.nombre order by r.creada_en`;
  for (const r of entregasSobres) {
    const oculto = recogedor && !r.confirmada_ya;
    pendientes.push({ clase: "entrega_sobres", id: r.id, folios: r.folios, en: r.creada_en, entrego: r.entrego, recibe: r.recibe,
                      importe: oculto ? null : r.importe, oculto, anterior: anterior(r.creada_en) });
  }
  pendientes.sort((a, b) => a.en.getTime() - b.en.getTime());

  // 4. Recolecciones confirmadas con saldo por depositar al corte.
  const recolecciones = await tx<{ id: string; resuelta_en: Date; buzon: boolean; recibe: string; recogido: string; depositado: string }[]>`
    select r.id, r.resuelta_en, r.buzon, u.nombre as recibe,
           coalesce((select sum(x.contado) from recoleccion_sobre x where x.recoleccion_id = r.id), 0)::numeric(12, 2)::text as recogido,
           coalesce((select sum(d.importe) from deposito_recoleccion d where d.recoleccion_id = r.id and d.en <= ${corte}), 0)::numeric(12, 2)::text as depositado
    from recoleccion r join usuario u on u.id = r.recibe
    where r.sucursal_id = ${s.id} and r.estado = 'confirmada' and r.resuelta_en <= ${corte}
    order by r.resuelta_en`;
  for (const r of recolecciones) {
    const saldo = cent(r.recogido) - cent(r.depositado);
    if (saldo > 0) {
      confirmados.unshift({ clase: "recoleccion", id: r.id, recibe: r.recibe, desde: r.resuelta_en, buzon: r.buzon, recogido: r.recogido,
                            depositado: r.depositado, saldo: pesos(saldo), anterior: anterior(r.resuelta_en) });
    }
  }

  // 5. Depósitos registrados dentro del periodo.
  const depositos = [...(await tx<Deposito[]>`
    select 'recoleccion' as clase, d.recoleccion_id as "origenId", null::text as folio, u.nombre as por, d.en, d.fecha::text as fecha, d.referencia, d.importe::text as importe
    from deposito_recoleccion d join recoleccion r on r.id = d.recoleccion_id join usuario u on u.id = d.registrado_por
    where r.sucursal_id = ${s.id} and d.en >= ${inicio} and d.en <= ${corte}
    union all
    select 'retiro', d.retiro_id, r.folio, u.nombre, d.en, (d.depositado_en at time zone ${ZONA})::date::text, d.referencia, d.importe::text
    from deposito_retiro d join retiro r on r.id = d.retiro_id join usuario u on u.id = d.registrado_por
    where r.sucursal_id = ${s.id} and d.en >= ${inicio} and d.en <= ${corte}
      and not exists (select 1 from deposito_retiro c where c.corrige_id = d.id and c.en <= ${corte})
    order by 5`)];

  // Aparte: diferencias (del periodo, más las anteriores que siguen abiertas al corte).
  const difTurno = await tx<{ id: string; entrega_id: string; entrega_tipo: string; al_cerrar: boolean; tipo: string; importe: string; registrada_en: Date; lugar: TipoLugar;
                               revision: string | null; decision: string | null; requiere: boolean | null; corregida: boolean | null }[]>`
    select d.id, d.entrega_id, e.tipo as entrega_tipo, d.registrada_en = e.creada_en as al_cerrar, d.tipo, d.importe::text as importe, d.registrada_en, l.tipo as lugar,
           (select v.resultado from revision_diferencia v where v.diferencia_id = d.id and v.en <= ${corte}) as revision,
           x.decision, x.requiere_correccion as requiere, x.correccion_en <= ${corte} as corregida
    from diferencia_efectivo d join entrega_turno e on e.id = d.entrega_id join lugar_efectivo l on l.id = d.lugar_id
    left join resolucion_diferencia x on x.diferencia_id = d.id and x.en <= ${corte}
    where l.sucursal_id = ${s.id} and d.registrada_en <= ${corte}
    order by d.registrada_en`;
  for (const d of difTurno) {
    const momento = d.entrega_tipo === "cambio_turno" ? "Cambio de turno" : d.al_cerrar ? "Cierre" : "Apertura";
    const contra = d.tipo === "contra_esperado" ? (d.entrega_tipo === "cierre" && !d.al_cerrar ? "contra lo cerrado" : "contra el esperado") : "entre ambas personas";
    let estado: string;
    let abierta: boolean;
    if (d.revision === null) [estado, abierta] = ["Por revisar", true];
    else if (d.revision === "aclarada") [estado, abierta] = ["Aclarada", false];
    else if (d.decision === null) [estado, abierta] = [`${RESULTADO[d.revision]} · pendiente para Dirección`, true];
    else if (d.requiere && !d.corregida) [estado, abierta] = ["Resuelta por Dirección · corrección pendiente", true];
    else [estado, abierta] = ["Resuelta por Dirección", false];
    diferencias.push({ clase: "turno", id: d.id, enlace: { tipo: "entrega", id: d.entrega_id }, texto: `${momento} del ${dia(d.registrada_en)} · ${contra}`,
                       lugar: d.lugar, importe: d.importe, estado, abierta, anterior: anterior(d.registrada_en), registradaEn: d.registrada_en, neto: d.tipo === "contra_esperado" });
  }
  // Diferencias contra el esperado al retirar: mientras no se vinculan a la del cambio de turno (después ya están ahí).
  for (const d of await tx<{ id: string; retiro_id: string; folio: string; lugar: TipoLugar; importe: string; registrada_en: Date }[]>`
    select x.id, x.retiro_id, r.folio, l.tipo as lugar, x.importe::text as importe, x.registrada_en
    from diferencia_retiro x join retiro r on r.id = x.retiro_id join lugar_efectivo l on l.id = x.lugar_id
    where r.sucursal_id = ${s.id} and x.registrada_en <= ${corte}
      and not exists (select 1 from diferencia_retiro_entrega v where v.diferencia_retiro_id = x.id and v.en <= ${corte})
    order by x.registrada_en`) {
    diferencias.push({ clase: "retiro_esperado", id: d.id, enlace: { tipo: "retiro", id: d.retiro_id }, texto: `Al retirar ${d.folio} · contra el esperado`,
                       lugar: d.lugar, importe: d.importe, estado: "Se revisa con la entrega del turno", abierta: true, anterior: anterior(d.registrada_en),
                       registradaEn: d.registrada_en, neto: true });
  }
  for (const d of await tx<{ id: string; sobre_id: string; folio: string; lugar: TipoLugar; importe: string; creada_en: Date; incidencia: boolean; revision: string | null; anotado: string; contado: string | null }[]>`
    select ds.id, ds.sobre_id, s.folio, l.tipo as lugar, ds.importe::text as importe, ds.creada_en, ds.verificacion_id is not null as incidencia,
           (select v.resultado from revision_diferencia_sobre v where v.diferencia_id = ds.id and v.en <= ${corte}) as revision,
           s.importe::text as anotado, (select x.contado::text from recoleccion_sobre x where x.recoleccion_id = ds.recoleccion_id and x.sobre_id = ds.sobre_id) as contado
    from diferencia_sobre ds join sobre_cierre s on s.id = ds.sobre_id join lugar_efectivo l on l.id = s.lugar_id
    where s.sucursal_id = ${s.id} and ds.creada_en <= ${corte}
    order by ds.creada_en`) {
    const abierta = d.revision === null;
    const texto = `Sobre ${d.folio}${d.incidencia ? " · llegó abierto o con otro folio" : ""} · anotado ${dinero(d.anotado)}${d.contado ? ` · contado ${dinero(d.contado)}` : ""}`;
    diferencias.push({ clase: "sobre", id: d.id, enlace: { tipo: "sobre", id: d.sobre_id }, texto, lugar: d.lugar, importe: d.importe,
                       estado: abierta ? "Por revisar" : RESULTADO[d.revision!] ?? d.revision!, abierta, anterior: anterior(d.creada_en), registradaEn: d.creada_en, neto: true });
  }
  const difVisibles = diferencias.filter((d) => !d.anterior || d.abierta).sort((a, b) => a.registradaEn.getTime() - b.registradaEn.getTime());

  // Aparte: sobres por investigar (registrados como depositados que no estaban al recoger). No se suman a nada.
  const investigar = (await tx<{ sobre_id: string; folio: string; lugar: TipoLugar; anotado: string; creada_en: Date; recoleccion_id: string }[]>`
    select i.sobre_id, s.folio, l.tipo as lugar, s.importe::text as anotado, i.creada_en, i.recoleccion_id
    from investigacion_sobre i join sobre_cierre s on s.id = i.sobre_id join lugar_efectivo l on l.id = s.lugar_id
    where s.sucursal_id = ${s.id} and i.creada_en <= ${corte} order by i.creada_en`).map((f) => ({
    sobreId: f.sobre_id, folio: f.folio, lugar: f.lugar, anotado: f.anotado, desde: f.creada_en, recoleccionId: f.recoleccion_id, anterior: anterior(f.creada_en),
  }));

  // Movimientos dentro del periodo (pasos del mismo dinero: no se suman entre sí).
  const [m] = await tx<{ cobros: string; n_cobros: number; ajustes: string; n_ajustes: number }[]>`
    select coalesce(sum(me.importe) filter (where me.tipo = 'entrada_cobro_visita'), 0)::numeric(12, 2)::text as cobros,
           (count(*) filter (where me.tipo = 'entrada_cobro_visita'))::int as n_cobros,
           coalesce(sum(me.importe) filter (where me.tipo = 'ajuste_cancelacion_cobro'), 0)::numeric(12, 2)::text as ajustes,
           (count(*) filter (where me.tipo = 'ajuste_cancelacion_cobro'))::int as n_ajustes
    from movimiento_efectivo me join lugar_efectivo l on l.id = me.lugar_id
    where l.sucursal_id = ${s.id} and me.en >= ${inicio} and me.en <= ${corte}`;
  const selLista = await tx<{ id: string; folio: string; lugar: TipoLugar; en: Date; importe: string; contado_ya: boolean }[]>`
    select s.id, s.folio, l.tipo as lugar, s.resuelto_en as en, s.importe::text as importe,
           (exists (select 1 from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
                    where x.sobre_id = s.id and r.estado = 'confirmada' and x.contado is not null)
            or exists (select 1 from investigacion_sobre i where i.sobre_id = s.id)) as contado_ya
    from sobre_cierre s join lugar_efectivo l on l.id = s.lugar_id
    where s.sucursal_id = ${s.id} and s.importe is not null and s.estado in ('usado', 'recogido') and s.resuelto_en >= ${inicio} and s.resuelto_en <= ${corte}
    order by s.resuelto_en, s.folio`;
  const [sel] = await tx<{ n: number; anotado: string; sin_contar: number }[]>`
    select count(*)::int as n, coalesce(sum(s.importe), 0)::numeric(12, 2)::text as anotado,
           (count(*) filter (where not exists (select 1 from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
                                               where x.sobre_id = s.id and r.estado = 'confirmada' and x.contado is not null)
                                 and not exists (select 1 from investigacion_sobre i where i.sobre_id = s.id)))::int as sin_contar
    from sobre_cierre s where s.sucursal_id = ${s.id} and s.importe is not null and s.estado in ('usado', 'recogido')
      and s.resuelto_en >= ${inicio} and s.resuelto_en <= ${corte}`;
  const recogidas = recolecciones.filter((r) => r.resuelta_en >= inicio);
  const retirosPeriodo = retiros.filter((r) => r.entregado_en >= inicio);
  const ocultoRetiro = (r: (typeof retiros)[number]) => r.encargada_id === usuarioId && (r.estado === "pendiente" || r.estado === "recuento");
  const pendientesPeriodo = new Set(pendientes.filter((p) => p.clase === "retiro").map((p) => p.id));
  const movimientos: Movimientos = {
    cobros: { n: m.n_cobros, importe: m.cobros },
    cancelaciones: { n: m.n_ajustes, importe: m.ajustes },
    sellados: { n: sel.n, anotado: recogedor && sel.sin_contar > 0 ? null : sel.anotado, ocultos: recogedor ? sel.sin_contar : 0 },
    recogido: { n: recogidas.length, importe: pesos(recogidas.reduce((n, r) => n + cent(r.recogido), 0)) },
    retiros: {
      n: retirosPeriodo.length, importe: pesos(retirosPeriodo.filter((r) => !ocultoRetiro(r)).reduce((n, r) => n + cent(r.importe), 0)),
      ocultos: retirosPeriodo.filter(ocultoRetiro).length,
      pendientes: retirosPeriodo.filter((r) => pendientesPeriodo.has(r.id)).length,
      confirmados: retirosPeriodo.filter((r) => !pendientesPeriodo.has(r.id)).length,
    },
    depositado: { n: depositos.length, importe: pesos(depositos.reduce((n, d) => n + cent(d.importe), 0)) },
    lista: {
      sellados: selLista.map((x) => ({ id: x.id, folio: x.folio, lugar: x.lugar, en: x.en, anotado: recogedor && !x.contado_ya ? null : x.importe })),
      recogidas: recogidas.map((r) => ({ id: r.id, en: r.resuelta_en, recibe: r.recibe, importe: r.recogido })),
      retiros: retirosPeriodo.map((r) => ({ id: r.id, folio: r.folio, lugar: r.lugar, en: r.entregado_en, importe: ocultoRetiro(r) ? null : r.importe, pendiente: pendientesPeriodo.has(r.id) })),
    },
  };

  const visible = lugares.reduce((n, l) => n + cent(l.importe), 0) + sobres.reduce((n, x) => n + cent(x.anotado), 0)
    + pendientes.reduce((n, p) => n + cent(p.importe), 0) + confirmados.reduce((n, c) => n + cent(c.saldo), 0);
  const ocultos = sobres.filter((x) => x.oculto).length + pendientes.filter((p) => p.oculto).length;
  const sinContar = sobres.length > 0 || entregasSobres.some((r) => !r.confirmada_ya) || sel.sin_contar > 0;
  return {
    id: s.id, codigo: s.codigo, nombre: s.nombre, recogedor, lugares, sobres, pendientes, confirmados, depositos, diferencias: difVisibles, investigar, movimientos,
    visible: pesos(visible), ocultos, anotadosSinContar: !recogedor && sinContar,
  };
}

const RESULTADO: Record<string, string> = {
  aclarada: "Aclarada", faltante_confirmado: "Faltante confirmado", sobrante_confirmado: "Sobrante confirmado", incidencia_confirmada: "Incidencia confirmada",
};
const formatoPesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
export const dinero = (v: string) => formatoPesos.format(Number(v));
const formatoDia = new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, day: "numeric", month: "short" });
const dia = (d: Date) => formatoDia.format(d);

/** Sucursales donde puede consultar, y si en cada una puede descargar (descargar exige también consultar). */
async function sucursalesCaja(tx: Tx, usuarioId: string) {
  return tx<{ id: string; codigo: string; nombre: string; descargar: boolean }[]>`
    select id, codigo, nombre, tiene_permiso(${usuarioId}, 'reporte.caja_descargar', id) as descargar
    from sucursal where tiene_permiso(${usuarioId}, 'reporte.caja', id) order by nombre`;
}

/**
 * Reporte de caja de una sucursal (`codigo`) o de todas las que puede consultar (null). null si no tiene el permiso en
 * ninguna sucursal o pide una que no puede consultar (misma respuesta que si no existiera).
 */
export async function reporteCaja(
  sql: Sql, usuarioId: string, filtros: { codigo: string | null; desde?: string; hasta?: string; corte?: string; soloDescarga?: boolean },
): Promise<ReporteCaja | null> {
  const { codigo } = filtros;
  if (codigo !== null && !/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const sucursales = await sucursalesCaja(tx, usuarioId);
    if (!sucursales.length) return null;
    if (codigo !== null && !sucursales.some((s) => s.codigo === codigo)) return null;
    const v = await ventana(tx, filtros);
    const elegidas = sucursales.filter((s) => (codigo === null || s.codigo === codigo) && (!filtros.soloDescarga || s.descargar));
    const filas: CajaSucursal[] = [];
    for (const s of elegidas) filas.push(await calcularSucursal(tx, usuarioId, s, v.inicio, v.corte));
    return {
      sucursales: sucursales.map(({ codigo, nombre, descargar }) => ({ codigo, nombre, descargar })), codigo,
      desde: v.p.desde, hasta: v.p.hasta, periodoInvalido: v.p.invalido, corte: v.corte, inicio: v.inicio, filas, generadoEn: v.ahora,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Detalle e historial de un importe, con el mismo corte
// ---------------------------------------------------------------------------------------------------------------

export type Evento = { en: Date; texto: string; persona: string | null; despues: boolean };
export type FilaDetalle = { etiqueta: string; valor: string | null; nota?: string };
export type Detalle = {
  tipo: "lugar" | "sobre" | "recoleccion" | "retiro";
  titulo: string;
  subtitulo: string;
  /** Dónde estaba al corte (texto) y su importe al corte, si aplica. */
  alCorte: string;
  importeAlCorte: string | null;
  filas: FilaDetalle[];
  tabla?: { columnas: string[]; filas: { celdas: (string | null)[]; enlace?: { tipo: "sobre" | "retiro"; id: string } }[] };
  eventos: Evento[];
  anterior: boolean;
  oculto: boolean;
  /** Lleva importes anotados de sobres sin contar (quien consulta no los recoge). */
  anotadosSinContar: boolean;
};
export type PantallaDetalle = { sucursal: { codigo: string; nombre: string }; desde: string; hasta: string; corte: Date; inicio: Date; detalle: Detalle };

const TIPOS_DETALLE = ["lugar", "sobre", "recoleccion", "retiro"] as const;
type TipoDetalle = (typeof TIPOS_DETALLE)[number];

export async function detalleCaja(
  sql: Sql, usuarioId: string, filtros: { codigo: string; desde?: string; hasta?: string; corte?: string; tipo: string; id: string },
): Promise<PantallaDetalle | null> {
  if (!/^[A-Z0-9]{2,5}$/.test(filtros.codigo) || !esIdentificadorValido(filtros.id) || !TIPOS_DETALLE.includes(filtros.tipo as TipoDetalle)) return null;
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const s = (await sucursalesCaja(tx, usuarioId)).find((x) => x.codigo === filtros.codigo);
    if (!s) return null;
    const v = await ventana(tx, filtros);
    const caja = await calcularSucursal(tx, usuarioId, s, v.inicio, v.corte);
    const detalle = await armarDetalle(tx, usuarioId, s.id, caja, filtros.tipo as TipoDetalle, filtros.id, v.inicio, v.corte);
    if (!detalle) return null;
    return { sucursal: { codigo: s.codigo, nombre: s.nombre }, desde: v.p.desde, hasta: v.p.hasta, corte: v.corte, inicio: v.inicio, detalle };
  });
}

const NOMBRE_LUGAR: Record<TipoLugar, string> = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" };
export const nombreLugar = (t: TipoLugar) => NOMBRE_LUGAR[t];
const TIPO_MOVIMIENTO: Record<string, string> = {
  entrada_cobro_visita: "Cobro de visita en efectivo", ajuste_cancelacion_cobro: "Cancelación de un cobro", salida_retiro: "Retiro entregado a Encargada de retiros",
  entrada_fondo: "Entrada al fondo de caja", salida_sobre: "Excedente al sobre del cierre",
};
const VERIFICACION: Record<string, string> = { correcto: "cerrado y con su folio", falta: "no estaba", abierto: "llegó abierto o con el sello roto", otro_folio: "traía otro folio" };
const MOMENTO_VERIFICACION: Record<string, string> = {
  custodia: "Custodia al cerrar", cierre: "Revisión de la caja al cerrar", apertura: "Revisión al abrir", cambio_turno: "Revisión en el cambio de turno",
  recoleccion: "Revisión al recoger", devolucion: "Revisión de la devolución",
};

async function armarDetalle(tx: Tx, usuarioId: string, sucursalId: string, caja: CajaSucursal, tipo: TipoDetalle, id: string, inicio: Date, corte: Date): Promise<Detalle | null> {
  const ev = (en: Date, texto: string, persona: string | null = null): Evento => ({ en, texto, persona, despues: en > corte });
  const ordenar = (e: Evento[]) => e.sort((a, b) => a.en.getTime() - b.en.getTime());

  if (tipo === "lugar") {
    const l = caja.lugares.find((x) => x.lugarId === id);
    if (!l) return null;
    const filas: FilaDetalle[] = [];
    const eventos: Evento[] = [];
    if (l.estado === "turno") {
      const [t] = await tx<{ id: string }[]>`
        select t.id from turno t where t.sucursal_id = ${sucursalId} and t.abierto_en <= ${corte} order by t.abierto_en desc limit 1`;
      filas.push({ etiqueta: `Contado al abrir (${fechaHora(l.base!.en)}, ${l.base!.por})`, valor: l.base!.importe });
      for (const mv of await tx<{ tipo: string; importe: string; en: Date; por: string }[]>`
        select me.tipo, me.importe::text as importe, me.en, u.nombre as por from movimiento_efectivo me join usuario u on u.id = me.registrado_por
        where me.turno_id = ${t.id} and me.lugar_id = ${id} order by me.en`) {
        eventos.push(ev(mv.en, `${TIPO_MOVIMIENTO[mv.tipo] ?? mv.tipo}: ${signo(mv.importe)}`, mv.por));
      }
      filas.push({ etiqueta: `Movimientos registrados hasta el corte (${l.cuantos})`, valor: l.movimientos });
      filas.push({ etiqueta: l.tipo === "bolsa_visitas" ? "Esperado al corte" : "Registrado al corte", valor: l.importe,
                   nota: l.tipo === "cajon_mensualidades" ? "Información incompleta: no incluye las mensualidades cobradas después del último conteo (faltan datos de Open Desk)." : undefined });
    } else if (l.estado === "cerrado") {
      filas.push({ etiqueta: `Contado al cerrar (${fechaHora(l.base!.en)}, ${l.base!.por})`, valor: l.importe,
                   nota: "Lo que quedó en este lugar al cerrar (los fondos); los sobres sellados se ven aparte." });
    }
    return {
      tipo, titulo: NOMBRE_LUGAR[l.tipo], subtitulo: caja.nombre,
      alCorte: l.estado === "turno" ? `En el turno abierto${l.responsable ? ` · responsable ${l.responsable}` : ""}` : l.estado === "cerrado" ? "Sucursal cerrada: guardado al cerrar" : "Sin turnos registrados",
      importeAlCorte: l.importe, filas, eventos: ordenar(eventos), anterior: false, oculto: false, anotadosSinContar: false,
    };
  }

  if (tipo === "sobre") {
    const [s] = await tx<{ id: string; folio: string; lugar: TipoLugar; importe: string | null; reservado_en: Date; reservado_por: string; resuelto_en: Date | null; cerro: string | null; contado_ya: boolean }[]>`
      select s.id, s.folio, l.tipo as lugar, s.importe::text as importe, s.reservado_en, a.nombre as reservado_por, s.resuelto_en, b.nombre as cerro,
             (exists (select 1 from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
                      where x.sobre_id = s.id and r.estado = 'confirmada' and x.contado is not null)
              or exists (select 1 from investigacion_sobre i where i.sobre_id = s.id)) as contado_ya
      from sobre_cierre s join lugar_efectivo l on l.id = s.lugar_id join usuario a on a.id = s.reservado_por
      left join entrega_turno e on e.id = s.entrega_id left join usuario b on b.id = e.entrega_por
      where s.id = ${id} and s.sucursal_id = ${sucursalId} and s.importe is not null`;
    if (!s) return null;
    const oculto = caja.recogedor && !s.contado_ya;
    const anotado = oculto ? null : s.importe;
    const eventos: Evento[] = [ev(s.reservado_en, "Generó el folio", s.reservado_por)];
    if (s.resuelto_en) eventos.push(ev(s.resuelto_en, oculto ? "Cerró y anotó el sobre (importe oculto hasta contarlo)" : `Cerró y anotó ${dinero(s.importe!)}`, s.cerro));
    for (const x of await tx<{ momento: string; estado: string; en: Date; por: string; revision: string | null }[]>`
      select v.momento, v.estado, v.en, u.nombre as por, r.momento as revision from verificacion_sobre v left join revision_caja r on r.id = v.revision_id
      join usuario u on u.id = v.verificado_por where v.sobre_id = ${id}`) {
      eventos.push(ev(x.en, `${MOMENTO_VERIFICACION[x.revision ?? x.momento] ?? x.momento}: ${VERIFICACION[x.estado] ?? x.estado}`, x.por));
    }
    for (const x of await tx<{ en: Date; por: string }[]>`select d.en, u.nombre as por from sobre_depositado d join usuario u on u.id = d.depositado_por where d.sobre_id = ${id}`) {
      eventos.push(ev(x.en, "Registró que lo depositó en el buzón", x.por));
    }
    for (const x of await tx<{ en: Date; por: string }[]>`
      select t.en, u.nombre as por from traslado_sobre x join traslado_buzon t on t.id = x.traslado_id join usuario u on u.id = t.por where x.sobre_id = ${id}`) {
      eventos.push(ev(x.en, "Lo trasladó de la caja anterior al buzón", x.por));
    }
    const recs = await tx<{ id: string; buzon: boolean; estado: string; creada_en: Date; resuelta_en: Date | null; entrego: string | null; recibe: string; contado: string | null }[]>`
      select r.id, r.buzon, r.estado, r.creada_en, r.resuelta_en, a.nombre as entrego, b.nombre as recibe, x.contado::text as contado
      from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id left join usuario a on a.id = r.entrega_por join usuario b on b.id = r.recibe
      where x.sobre_id = ${id} order by r.creada_en`;
    for (const r of recs) {
      if (!r.buzon) eventos.push(ev(r.creada_en, `Lo entregó a ${r.recibe} (Dirección)`, r.entrego));
      if (r.estado === "cancelada" && r.resuelta_en) eventos.push(ev(r.resuelta_en, "Entrega cancelada: por devolver a la caja", r.recibe));
      if (r.estado === "confirmada" && r.resuelta_en) {
        eventos.push(ev(r.resuelta_en, r.contado !== null ? `${r.buzon ? "Abrió el buzón y lo recogió" : "Confirmó la recepción"}: contó a ciegas ${dinero(r.contado)}`
                                                          : "No estaba al recoger: por investigar, sin responsable asignado", r.recibe));
        for (const d of await tx<{ en: Date; importe: string; referencia: string; por: string }[]>`
          select d.en, d.importe::text as importe, d.referencia, u.nombre as por from deposito_recoleccion d join usuario u on u.id = d.registrado_por
          where d.recoleccion_id = ${r.id} order by d.en`) {
          eventos.push(ev(d.en, `Depósito de la recolección: ${dinero(d.importe)} · ref. ${d.referencia} (cubre la recolección, no un sobre en particular)`, d.por));
        }
      }
    }
    for (const x of await tx<{ en: Date; por: string }[]>`
      select d.en, u.nombre as por from devolucion_sobre x join devolucion_recoleccion d on d.id = x.devolucion_id join usuario u on u.id = d.recibida_por where x.sobre_id = ${id}`) {
      eventos.push(ev(x.en, "Volvió a la caja (devolución)", x.por));
    }
    for (const x of await tx<{ creada_en: Date; importe: string; resultado: string | null; en: Date | null; por: string | null; propia: boolean }[]>`
      select ds.creada_en, ds.importe::text as importe, v.resultado, v.en, u.nombre as por, v.autorrevision_id is not null as propia
      from diferencia_sobre ds left join revision_diferencia_sobre v on v.diferencia_id = ds.id left join usuario u on u.id = v.revisada_por
      where ds.sobre_id = ${id}`) {
      eventos.push(ev(x.creada_en, `Diferencia registrada: ${signo(x.importe)}`));
      if (x.en) eventos.push(ev(x.en, `Revisó la diferencia: ${RESULTADO[x.resultado!] ?? x.resultado}${x.propia ? " · Revisada por quien participó" : ""}`, x.por));
    }
    // Dónde estaba al corte (la misma clasificación del reporte).
    const enEtapa2 = caja.sobres.find((x) => x.id === id);
    const enEntrega = caja.pendientes.find((p) => p.clase === "entrega_sobres" && p.folios.includes(s.folio));
    const investigado = caja.investigar.find((x) => x.sobreId === id);
    const recogida = recs.find((r) => r.estado === "confirmada" && r.resuelta_en && r.resuelta_en <= corte && r.contado !== null);
    let alCorte: string;
    if (!s.resuelto_en || s.resuelto_en > corte) alCorte = "Aún no se sellaba al corte";
    else if (enEtapa2) alCorte = enEtapa2.donde === "buzon" ? "En el buzón, por recoger" : enEtapa2.donde === "caja" ? "En la caja con llave, por recoger" : "Entrega cancelada: por devolver a la caja";
    else if (enEntrega) alCorte = `Entregado a ${enEntrega.recibe}, pendiente de confirmar`;
    else if (investigado) alCorte = "No estaba al abrir el buzón: por investigar, sin responsable asignado";
    else if (recogida) {
      const c = caja.confirmados.find((x) => x.clase === "recoleccion" && x.id === recogida.id);
      alCorte = c ? `Recogido por ${recogida.recibe} el ${dia(recogida.resuelta_en!)}, dentro de una recolección con ${dinero(c.saldo)} por depositar al corte`
                  : `Recogido por ${recogida.recibe} el ${dia(recogida.resuelta_en!)}; su recolección ya estaba depositada al corte`;
    } else alCorte = "Sin custodia registrada al corte";
    const filas: FilaDetalle[] = [{ etiqueta: "Anotado al cerrar", valor: anotado, nota: oculto ? "Oculto hasta contarlo (conteo a ciegas)." : undefined }];
    if (recogida) filas.push({ etiqueta: `Contado por ${recogida.recibe}`, valor: recogida.contado });
    const dif = caja.diferencias.find((d) => d.clase === "sobre" && d.enlace.id === id);
    if (dif) filas.push({ etiqueta: "Diferencia (aparte, no se suma a ninguna etapa)", valor: dif.importe, nota: dif.estado });
    return {
      tipo, titulo: `Sobre ${s.folio}`, subtitulo: `${NOMBRE_LUGAR[s.lugar]} · ${caja.nombre}${s.resuelto_en ? ` · cerrado el ${dia(s.resuelto_en)}` : ""}`,
      alCorte, importeAlCorte: enEtapa2 ? anotado : enEntrega ? anotado : null, filas, eventos: ordenar(eventos),
      anterior: !!s.resuelto_en && s.resuelto_en < inicio, oculto, anotadosSinContar: !caja.recogedor && !s.contado_ya,
    };
  }

  if (tipo === "recoleccion") {
    const [r] = await tx<{ id: string; buzon: boolean; estado: string; creada_en: Date; resuelta_en: Date | null; entrego: string | null; recibe: string }[]>`
      select r.id, r.buzon, r.estado, r.creada_en, r.resuelta_en, a.nombre as entrego, b.nombre as recibe
      from recoleccion r left join usuario a on a.id = r.entrega_por join usuario b on b.id = r.recibe where r.id = ${id} and r.sucursal_id = ${sucursalId}`;
    if (!r) return null;
    const confirmadaAlCorte = r.estado === "confirmada" && !!r.resuelta_en && r.resuelta_en <= corte;
    const contadaYa = r.estado === "confirmada";
    const oculto = caja.recogedor && !contadaYa;
    const sobres = await tx<{ id: string; folio: string; lugar: TipoLugar; anotado: string; contado: string | null }[]>`
      select s.id, s.folio, l.tipo as lugar, s.importe::text as anotado, x.contado::text as contado
      from recoleccion_sobre x join sobre_cierre s on s.id = x.sobre_id join lugar_efectivo l on l.id = s.lugar_id
      where x.recoleccion_id = ${id} order by s.resuelto_en, s.folio`;
    const depositos = await tx<{ en: Date; fecha: string; importe: string; referencia: string; por: string }[]>`
      select d.en, d.fecha::text as fecha, d.importe::text as importe, d.referencia, u.nombre as por
      from deposito_recoleccion d join usuario u on u.id = d.registrado_por where d.recoleccion_id = ${id} order by d.en`;
    const recogido = sobres.reduce((n, x) => n + cent(x.contado), 0);
    const depositadoCorte = depositos.filter((d) => d.en <= corte).reduce((n, d) => n + cent(d.importe), 0);
    const eventos: Evento[] = [];
    if (!r.buzon) eventos.push(ev(r.creada_en, `Entregó a ${r.recibe} (Dirección): ${sobres.map((x) => x.folio).join(", ")}`, r.entrego));
    if (r.estado === "cancelada" && r.resuelta_en) eventos.push(ev(r.resuelta_en, "Entrega cancelada: los sobres quedan por devolver", r.recibe));
    if (r.estado === "confirmada" && r.resuelta_en) eventos.push(ev(r.resuelta_en, `${r.buzon ? "Abrió el buzón y recogió" : "Confirmó la recepción"}: ${dinero(pesos(recogido))} contados a ciegas`, r.recibe));
    for (const d of depositos) eventos.push(ev(d.en, `Registró un depósito de ${dinero(d.importe)} · ref. ${d.referencia} · fecha ${d.fecha}`, d.por));
    for (const x of await tx<{ folio: string; creada_en: Date; importe: string; resultado: string | null; en: Date | null; por: string | null; propia: boolean }[]>`
      select s.folio, ds.creada_en, ds.importe::text as importe, v.resultado, v.en, u.nombre as por, v.autorrevision_id is not null as propia
      from diferencia_sobre ds join sobre_cierre s on s.id = ds.sobre_id left join revision_diferencia_sobre v on v.diferencia_id = ds.id
      left join usuario u on u.id = v.revisada_por where ds.recoleccion_id = ${id}`) {
      if (x.en) eventos.push(ev(x.en, `Revisó la diferencia de ${x.folio} (${signo(x.importe)}): ${RESULTADO[x.resultado!] ?? x.resultado}${x.propia ? " · Revisada por quien participó" : ""}`, x.por));
    }
    const filas: FilaDetalle[] = confirmadaAlCorte
      ? [{ etiqueta: "Recogido (contado a ciegas)", valor: pesos(recogido) }, { etiqueta: "Depositado hasta el corte", valor: pesos(depositadoCorte) },
         { etiqueta: "Por depositar al corte", valor: pesos(recogido - depositadoCorte) }]
      : [{ etiqueta: "Anotado al cerrar (sobres entregados)", valor: oculto ? null : pesos(sobres.reduce((n, x) => n + cent(x.anotado), 0)),
           nota: oculto ? "Oculto hasta contarlos (conteo a ciegas)." : undefined }];
    if (confirmadaAlCorte) {
      const faltan = sobres.filter((x) => x.contado === null);
      const anotadoTotal = sobres.reduce((n, x) => n + cent(x.anotado), 0);
      const anotadoFaltan = faltan.reduce((n, x) => n + cent(x.anotado), 0);
      filas.unshift({ etiqueta: "Anotado al cerrar", valor: pesos(anotadoTotal) });
      if (faltan.length) filas.splice(1, 0, { etiqueta: `Sobres por investigar (no se suman a lo recogido): ${faltan.map((x) => x.folio).join(", ")}`, valor: pesos(-anotadoFaltan) });
      const difs = anotadoTotal - anotadoFaltan - recogido;
      if (difs !== 0) filas.splice(faltan.length ? 2 : 1, 0, { etiqueta: "Diferencias de los sobres (van aparte)", valor: pesos(-difs) });
    }
    return {
      tipo, titulo: r.buzon ? `Recolección del buzón · ${dia(r.resuelta_en ?? r.creada_en)}` : `Entrega de sobres a ${r.recibe} · ${dia(r.creada_en)}`,
      subtitulo: `${caja.nombre} · ${r.buzon ? `abrió el buzón ${r.recibe}` : `entregó ${r.entrego}`}`,
      alCorte: confirmadaAlCorte ? `Bajo la responsabilidad de ${r.recibe} desde el ${dia(r.resuelta_en!)}` : r.creada_en <= corte ? `Entregado a ${r.recibe}, pendiente de confirmar` : "Aún no se registraba al corte",
      importeAlCorte: confirmadaAlCorte ? pesos(recogido - depositadoCorte) : oculto ? null : pesos(sobres.reduce((n, x) => n + cent(x.anotado), 0)),
      filas,
      tabla: {
        columnas: ["Sobre", "Lugar", "Anotado al cerrar", "Contado"],
        filas: sobres.map((x) => ({ celdas: [x.folio, NOMBRE_LUGAR[x.lugar], oculto ? null : x.anotado, x.contado === null ? (contadaYa ? "No estaba · por investigar" : "—") : x.contado],
                                    enlace: { tipo: "sobre" as const, id: x.id } })),
      },
      eventos: ordenar(eventos), anterior: (r.resuelta_en ?? r.creada_en) < inicio, oculto, anotadosSinContar: !caja.recogedor && !contadaYa,
    };
  }

  // Retiro a Encargada de retiros.
  const [r] = await tx<{ id: string; folio: string; lugar: TipoLugar; importe: string; cambio: string; contado_recepcion: string; entregado_en: Date; entrego: string; encargada: string;
                         encargada_id: string; estado: string; habilitado_en: Date | null; monto_habilitado: string | null; reportado_en: Date | null; motivo: string | null }[]>`
    select r.id, r.folio, l.tipo as lugar, r.importe::text as importe, r.cambio::text as cambio, r.contado::text as contado_recepcion, r.entregado_en,
           a.nombre as entrego, b.nombre as encargada, r.encargada_id, r.estado, r.habilitado_en, r.monto_habilitado::text as monto_habilitado, r.reportado_en, r.motivo
    from retiro r join lugar_efectivo l on l.id = r.lugar_id join usuario a on a.id = r.entregado_por join usuario b on b.id = r.encargada_id
    where r.id = ${id} and r.sucursal_id = ${sucursalId}`;
  if (!r) return null;
  const oculto = r.encargada_id === usuarioId && (r.estado === "pendiente" || r.estado === "recuento");
  const eventos: Evento[] = [ev(r.entregado_en, oculto ? "Entregó el retiro (importe oculto hasta que lo cuentes)" : `Entregó ${dinero(r.importe)} a ${r.encargada}`, r.entrego)];
  for (const c of await tx<{ tipo: string; importe: string; en: Date; por: string; con: string | null; folio: boolean }[]>`
    select c.tipo, c.importe::text as importe, c.en, u.nombre as por, w.nombre as con, c.folio_coincide as folio
    from retiro_conteo c join usuario u on u.id = c.contado_por left join usuario w on w.id = c.recontado_con where c.retiro_id = ${id} order by c.en`) {
    eventos.push(ev(c.en, `${c.tipo === "recuento" ? `Recontó con ${c.con}` : "Contó a ciegas"}: ${dinero(c.importe)}${c.folio ? "" : " · el folio no coincide"}`, c.por));
  }
  if (r.reportado_en) eventos.push(ev(r.reportado_en, `Reportó «No coincide»${r.motivo ? `: «${r.motivo}»` : ""}`, r.encargada));
  for (const v of await tx<{ resultado: string; monto: string; en: Date; por: string; propia: boolean }[]>`
    select v.resultado, v.monto_verificado::text as monto, v.en, u.nombre as por, v.autorrevision_id is not null as propia
    from retiro_revision v join usuario u on u.id = v.revisada_por where v.retiro_id = ${id}`) {
    eventos.push(ev(v.en, `Revisó: ${RESULTADO[v.resultado] ?? v.resultado} · verificado ${dinero(v.monto)}${v.propia ? " · Revisada por quien participó" : ""}`, v.por));
  }
  if (r.habilitado_en) eventos.push(ev(r.habilitado_en, `Depósitos habilitados por ${dinero(r.monto_habilitado!)}`));
  const deps = await tx<{ id: string; importe: string; en: Date; referencia: string; por: string; corrige: string | null }[]>`
    select d.id, d.importe::text as importe, d.en, d.referencia, u.nombre as por, d.corrige_id as corrige
    from deposito_retiro d join usuario u on u.id = d.registrado_por where d.retiro_id = ${id} order by d.en`;
  for (const d of deps) eventos.push(ev(d.en, `${d.corrige ? "Corrigió un depósito" : "Registró un depósito"}: ${dinero(d.importe)} · ref. ${d.referencia}`, d.por));
  const enPendiente = caja.pendientes.find((p) => p.clase === "retiro" && p.id === id);
  const enConfirmado = caja.confirmados.find((c) => (c.clase === "retiro" || c.clase === "retiro_pausa") && c.id === id);
  const alCorte = r.entregado_en > corte ? "Aún no se entregaba al corte"
    : enPendiente ? `Entregado a ${r.encargada}, pendiente de que lo confirme`
    : enConfirmado?.clase === "retiro_pausa" ? `Con ${r.encargada}: en pausa por revisión (no se deposita aún)`
    : enConfirmado ? `Bajo la responsabilidad de ${r.encargada}, por depositar${enConfirmado.clase === "retiro" && enConfirmado.aviso ? " · 48 horas o más con saldo sin destino" : ""}`
    : "Depositado completo al corte";
  const vigentesCorte = deps.filter((d) => d.en <= corte && !deps.some((c) => c.corrige === d.id && c.en <= corte));
  const filas: FilaDetalle[] = [
    { etiqueta: "Entregado por Recepción", valor: oculto ? null : r.importe, nota: oculto ? "Oculto hasta que lo cuentes (conteo a ciegas)." : undefined },
  ];
  if (r.habilitado_en && r.habilitado_en <= corte) {
    filas.push({ etiqueta: "Habilitado para depositar", valor: r.monto_habilitado });
    filas.push({ etiqueta: "Depositado hasta el corte", valor: pesos(vigentesCorte.reduce((n, d) => n + cent(d.importe), 0)) });
  }
  return {
    tipo, titulo: `Retiro ${r.folio}`, subtitulo: `${NOMBRE_LUGAR[r.lugar]} · ${caja.nombre} · entregado el ${dia(r.entregado_en)}`,
    alCorte, importeAlCorte: enPendiente ? enPendiente.importe : enConfirmado ? enConfirmado.saldo : null, filas, eventos: ordenar(eventos),
    anterior: r.entregado_en < inicio, oculto, anotadosSinContar: false,
  };
}

const signo = (v: string) => (Number(v) < 0 ? `−${dinero(String(-Number(v)))}` : `+${dinero(v)}`);
const formatoFechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "medium", timeStyle: "short" });
const fechaHora = (d: Date) => formatoFechaHora.format(d);

// ---------------------------------------------------------------------------------------------------------------
// Descargas
// ---------------------------------------------------------------------------------------------------------------

export type Descarga = { en: Date; por: string; sucursales: string[]; excluidas: string[]; desde: string; hasta: string; corte: Date; formato: string; contenido: string; conOcultos: boolean; conAnotados: boolean };

/** Historial de descargas que incluyen alguna de estas sucursales (lo ve quien puede consultarlas). */
export async function historialDescargas(sql: Sql | Tx, sucursalIds: string[], limite = 20): Promise<Descarga[]> {
  if (!sucursalIds.length) return [];
  return [...(await sql<Descarga[]>`
    select d.en, u.nombre as por,
           (select array_agg(s.nombre order by s.nombre) from sucursal s where s.id = any(d.sucursales)) as sucursales,
           coalesce((select array_agg(s.nombre order by s.nombre) from sucursal s where s.id = any(d.excluidas)), '{}') as excluidas,
           d.desde::text as desde, d.hasta::text as hasta, d.corte, d.formato, d.contenido, d.con_ocultos as "conOcultos", d.con_anotados_sin_contar as "conAnotados"
    from descarga_reporte_caja d join usuario u on u.id = d.usuario_id
    where d.sucursales && ${sucursalIds}::uuid[]
    order by d.en desc limit ${limite}`)];
}

export type ArchivoCaja = { reporte: ReporteCaja; detalles: Map<string, Detalle[]>; excluidas: string[]; formato: "xlsx" | "pdf"; contenido: "resumen" | "detalle"; por: string; en: Date };
export type ErrorDescarga = "no_encontrada" | "sin_descarga" | "formato" | "bloqueado_produccion";

/**
 * Prepara una descarga: solo con las sucursales donde puede consultar Y descargar; con «Todas mis sucursales», las
 * demás quedan fuera y se nombran. Conserva el corte y respeta los importes ocultos (también en detalles e
 * historiales). La descarga queda registrada en su historial.
 */
export async function prepararDescarga(
  sql: Sql, usuarioId: string,
  pedido: { codigo: string | null; desde?: string; hasta?: string; corte?: string; formato: string; contenido: string },
  { entorno }: { entorno: string },
): Promise<{ ok: true; archivo: ArchivoCaja } | { ok: false; error: ErrorDescarga }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if ((pedido.formato !== "xlsx" && pedido.formato !== "pdf") || (pedido.contenido !== "resumen" && pedido.contenido !== "detalle")) return { ok: false, error: "formato" };
  const { codigo } = pedido;
  if (codigo !== null && !/^[A-Z0-9]{2,5}$/.test(codigo)) return { ok: false, error: "no_encontrada" };
  return sql.begin(async (tx) => {
    const sucursales = await sucursalesCaja(tx, usuarioId);
    const pedidas = sucursales.filter((s) => codigo === null || s.codigo === codigo);
    if (!pedidas.length) return { ok: false as const, error: "no_encontrada" as const };
    const incluidas = pedidas.filter((s) => s.descargar);
    if (!incluidas.length) return { ok: false as const, error: "sin_descarga" as const };
    const v = await ventana(tx, pedido);
    const filas: CajaSucursal[] = [];
    const detalles = new Map<string, Detalle[]>();
    for (const s of incluidas) {
      const caja = await calcularSucursal(tx, usuarioId, s, v.inicio, v.corte);
      filas.push(caja);
      if (pedido.contenido === "detalle") {
        const lista: Detalle[] = [];
        const piezas: [TipoDetalle, string][] = [
          ...caja.lugares.filter((l) => l.estado !== "sin_datos").map((l) => ["lugar", l.lugarId] as [TipoDetalle, string]),
          ...caja.sobres.map((x) => ["sobre", x.id] as [TipoDetalle, string]),
          ...caja.pendientes.map((p) => [p.clase === "retiro" ? "retiro" : "recoleccion", p.id] as [TipoDetalle, string]),
          ...caja.confirmados.map((c) => [c.clase === "recoleccion" ? "recoleccion" : "retiro", c.id] as [TipoDetalle, string]),
          ...caja.investigar.map((x) => ["sobre", x.sobreId] as [TipoDetalle, string]),
        ];
        for (const [tipo, id] of piezas) {
          const d = await armarDetalle(tx, usuarioId, s.id, caja, tipo, id, v.inicio, v.corte);
          if (d) lista.push({ ...d, eventos: d.eventos.filter((e) => !e.despues) });
        }
        detalles.set(s.codigo, lista);
      }
    }
    const excluidas = pedidas.filter((s) => !s.descargar);
    const conOcultos = filas.some((f) => f.ocultos > 0);
    const conAnotados = filas.some((f) => f.anotadosSinContar) || [...detalles.values()].some((l) => l.some((d) => d.anotadosSinContar));
    const [{ en, por }] = await tx<{ en: Date; por: string }[]>`
      insert into descarga_reporte_caja (usuario_id, sucursales, excluidas, desde, hasta, corte, formato, contenido, con_ocultos, con_anotados_sin_contar)
      values (${usuarioId}, ${incluidas.map((s) => s.id)}::uuid[], ${excluidas.map((s) => s.id)}::uuid[], ${v.p.desde}, ${v.p.hasta}, ${v.corte},
              ${pedido.formato}, ${pedido.contenido}, ${conOcultos}, ${conAnotados})
      returning en, (select nombre from usuario where id = ${usuarioId}) as por`;
    return {
      ok: true as const,
      archivo: {
        reporte: { sucursales: sucursales.map(({ codigo, nombre, descargar }) => ({ codigo, nombre, descargar })), codigo, desde: v.p.desde, hasta: v.p.hasta,
                   periodoInvalido: v.p.invalido, corte: v.corte, inicio: v.inicio, filas, generadoEn: v.ahora },
        detalles, excluidas: excluidas.map((s) => s.nombre), formato: pedido.formato as "xlsx" | "pdf", contenido: pedido.contenido as "resumen" | "detalle", por, en,
      },
    };
  });
}

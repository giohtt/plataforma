import type postgres from "postgres";
import {
  configuracionVigente, DIAS_AVISO_SOBRE, infoBuzon, leerLlave, leerLlaveRequerida, leerVerificaciones, registrarRevisionCaja, sobresEnCaja, sobresFueraDeCaja,
  type ErrorVerificacion, type InfoBuzon, type LlaveDatos, type Sobre, type SobreEnCaja, type SobreFueraDeCaja, type Verificacion, type VerificacionDatos,
} from "@/lib/cierres";
import { leerImporte } from "@/lib/datos-turno";
import type { Entorno } from "@/lib/entorno";
import type { Receptor } from "@/lib/entregas";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Bloque 5, regla 7: recolección semanal de los sobres guardados (aprobado el 18 nov 2026; solo datos ficticios).
 *
 * 1. Los sobres se quedan sellados en la caja con llave; la custodia (una recepcionista nombrada por Dirección) guarda la
 *    llave, que pasa con el turno. Cada sobre muestra cuántos días lleva guardado; el aviso empieza a los 8 días.
 * 2. Dirección recoge una vez por semana, sin día fijo: la responsable en turno elige qué sobres entrega (los demás
 *    siguen visibles en la caja) y a quién de Dirección. Dirección confirma desde su cuenta: verifica sello y folio y
 *    cuenta cada sobre a ciegas.
 * 3. Si lo contado no coincide con lo anotado al cerrar, o el sobre llega abierto, con otro folio o no está, queda una
 *    diferencia por sobre. La revisa Administración si no participó en la cadena del sobre.
 * 4. Lo recogido queda bajo la responsabilidad de quien lo recogió hasta depositarlo; se registran depósitos parciales
 *    y el saldo pendiente.
 * 5. Ajuste del 18 nov: los sobres entregados y pendientes de confirmar ya no están en la caja (se muestran aparte, con
 *    quién los entregó y quién debe confirmar). Si se cancela la entrega, vuelven a la caja solo al registrar su
 *    devolución física: la responsable en turno los recibe de vuelta y verifica cada uno.
 * 6. Buzón de depósito (18 nov, 19:10): quien cierra deposita cada sobre en el buzón; solo Dirección tiene su llave y lo
 *    abre (sin entrega de la responsable en turno). Al recoger verifica y cuenta a ciegas cada sobre registrado como
 *    depositado. Uno que no aparece queda «por investigar», sin responsable asignado y sin sumarse a lo recogido.
 *    Pendiente de decidir: cómo se cierra la investigación y qué pasa si el sobre aparece después.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

const valido = (codigo: string) => /^[A-Z0-9]{2,5}$/.test(codigo);
const limpiar = (t: string) => t.trim().replace(/\s+/g, " ");
const cent = (v: string) => Math.round(Number(v) * 100);
const pesos = (c: number) => (c / 100).toFixed(2);

export type SobreCaja = SobreEnCaja & { importe: string | null; aviso: boolean };
export type CustodiaCaja = {
  nombre: string; desde: Date; momento: "cierre" | "apertura" | "cambio_turno" | "devolucion";
  /** Llave de la caja de sobres y, por separado, del cajón de los fondos (null si no se registró en ese momento). */
  llave: "correcta" | "incidencia"; llaveCajon: "correcta" | "incidencia" | null;
};

export type RecoleccionPendiente = {
  id: string; version: number; entregaPor: string; entregaPorId: string; recibe: string; recibeId: string; creadaEn: Date;
  sobres: Sobre[];
};
export type Cadena = { momento: string; nombre: string; en: Date; estado: string | null }[];
/** Sobre de una entrega cancelada: si ya volvió físicamente a la caja, sus incidencias y su cadena de custodia. */
export type SobreDevolucion = Sobre & { devuelto: { en: Date; recibio: string } | null; diferencias: DiferenciaSobre[]; cadena: Cadena };
/**
 * Entrega cancelada. La devolución es por sobre: solo los recibidos físicamente vuelven a la caja; los demás siguen
 * pendientes de devolución, con su incidencia y su cadena.
 */
export type EntregaCancelada = {
  id: string; entregaPor: string; devuelve: string; devuelveId: string; canceladaEn: Date; motivo: string; sobres: SobreDevolucion[];
};
export type DevolucionPendiente = EntregaCancelada;
export type DevolucionRegistrada = EntregaCancelada;
/** Problema con la llave de la caja de sobres al recoger o al devolver: lo revisa Administración que no participó. */
export type IncidenciaLlave = {
  id: string; momento: "recoleccion" | "devolucion"; por: string; en: Date; motivo: string;
  estado: "por_revisar" | "aclarada" | "incidencia_confirmada"; revisadaPor: string | null; motivoRevision: string | null; puedeRevisar: boolean;
  /** Esta cuenta participó y la revisaría con su autorización personal (queda marcada). */
  revisarasPropia: boolean;
  /** La revisó quien participó, con su autorización personal. */
  revisadaPropia: boolean;
};
export type EstadoDiferenciaSobre = "por_revisar" | "aclarada" | "faltante_confirmado" | "sobrante_confirmado" | "incidencia_confirmada";
export type DiferenciaSobre = {
  id: string; folio: string; anotado: string; contado: string | null; importe: string;
  verificacion: Verificacion | null; estado: EstadoDiferenciaSobre; motivo: string | null; revisadaPor: string | null;
  /** Personas de la cadena del sobre (cerró, custodió, verificó la caja, entregó, recogió). */
  cadena: Cadena;
  /** Si esta cuenta puede revisarla (Administración que no participó, o que participó con autorización personal vigente). */
  puedeRevisar: boolean;
  revisarasPropia: boolean;
  revisadaPropia: boolean;
};
export type RecoleccionConfirmada = {
  id: string; entregaPor: string | null; recibe: string; recibeId: string; confirmadaEn: Date; buzon: boolean;
  /** contado null: el sobre no estaba en el buzón (por investigar, no suma a lo recogido). */
  sobres: { folio: string; anotado: string; contado: string | null }[];
  recogido: string; depositado: string; saldo: string;
  depositos: { importe: string; fecha: string; referencia: string; por: string; en: Date }[];
  diferencias: DiferenciaSobre[];
};

/** Sobre registrado como depositado que no apareció al recoger del buzón: por investigar, sin responsable asignado. */
export type InvestigacionSobre = {
  id: string; folio: string; lugar: Sobre["lugar"]; anotado: string; depositadoPor: string | null; depositadoEn: Date | null;
  recogio: string; en: Date; motivo: string | null; cadena: Cadena;
};

/** Traslado físico de sobres de la caja anterior al buzón: quién, cuándo y qué folios. */
export type TrasladoBuzon = { id: string; por: string; en: Date; folios: string[] };

export type PantallaRecoleccion =
  | {
      ok: true; sucursal: string; turnoId: string | null;
      caja: SobreCaja[]; custodia: CustodiaCaja | null; diasAviso: number;
      /** Sobres que no están físicamente en la caja: entregados por confirmar o por devolver. */
      fuera: SobreFueraDeCaja[];
      pendiente: RecoleccionPendiente | null;
      porDevolver: DevolucionPendiente[];
      /** La responsable en turno puede entregar sobres (si no hay otra entrega pendiente ni una devolución por registrar). */
      puedeEntregar: boolean;
      /** La responsable en turno recibe las devoluciones (no si ella misma las devuelve). */
      puedeRecibirDevolucion: boolean;
      direccion: Receptor[];
      recolecciones: RecoleccionConfirmada[];
      devoluciones: DevolucionRegistrada[];
      incidenciasLlave: IncidenciaLlave[];
      /** Con buzón: dónde está, quién tiene su llave y cuántos sobres están registrados como depositados. */
      buzon: InfoBuzon | null;
      /** Dirección con la llave del buzón puede recogerlo (los sobres registrados están en «caja», sin lo anotado). */
      puedeRecogerBuzon: boolean;
      investigaciones: InvestigacionSobre[];
      /** Con buzón: sobres guardados antes del buzón que siguen en la caja anterior hasta registrar su traslado. */
      porTrasladar: SobreCaja[];
      /** La responsable en turno registra el traslado físico de esos sobres al buzón. */
      puedeTrasladar: boolean;
      traslados: TrasladoBuzon[];
    }
  | { ok: false; error: "no_encontrada" | "bloqueado_produccion" };

async function sucursalRecoleccion(tx: Tx | Sql, usuarioId: string, codigo: string) {
  if (!valido(codigo)) return null;
  const [s] = await tx<{ id: string; nombre: string; entrega: boolean; recoge: boolean; revisa: boolean; consulta: boolean }[]>`
    select id, nombre, tiene_permiso(${usuarioId}, 'sobre.entregar', id) as entrega, tiene_permiso(${usuarioId}, 'sobre.recoger', id) as recoge,
           tiene_permiso(${usuarioId}, 'diferencia.revisar', id) and exists (select 1 from perfiles_en_sucursal(${usuarioId}, id) r where r = 'administracion') as revisa,
           tiene_permiso(${usuarioId}, 'turno.consultar', id) as consulta
    from sucursal where codigo = ${codigo} and exists (select 1 from perfiles_en_sucursal(${usuarioId}, id))`;
  // Ven la caja quien entrega, quien recoge, Administración (revisa) y quien consulta el turno (sin acciones).
  return s && (s.entrega || s.recoge || s.revisa || s.consulta) ? s : null;
}

/** Dirección de la sucursal que puede recoger (sobre.recoger). */
async function direccionSucursal(tx: Tx | Sql, sucursalId: string): Promise<Receptor[]> {
  return [...(await tx<Receptor[]>`
    select id, nombre from usuario u where activo
      and exists (select 1 from perfiles_en_sucursal(u.id, ${sucursalId}) r where r = 'direccion')
      and tiene_permiso(u.id, 'sobre.recoger', ${sucursalId})
    order by nombre`)];
}

/** Sobres físicamente en la caja, con su aviso (desde los 8 días de guardado). */
async function caja(tx: Tx | Sql, sucursalId: string, verImporte: boolean, donde: "todos" | "buzon" | "por_trasladar" = "todos"): Promise<SobreCaja[]> {
  const sobres = await sobresEnCaja(tx, sucursalId, null, donde);
  if (!sobres.length) return [];
  const extra = await tx<{ id: string; importe: string }[]>`
    select s.id, s.importe::text as importe from sobre_cierre s where s.id in ${tx(sobres.map((x) => x.id))}`;
  return sobres.map((s) => {
    const e = extra.find((x) => x.id === s.id)!;
    // Dirección cuenta a ciegas: no ve lo anotado al cerrar hasta confirmar.
    return { ...s, importe: verImporte ? e.importe : null, aviso: s.dias >= DIAS_AVISO_SOBRE };
  });
}

/** Quién tiene la llave de la caja: la última persona que la recibió (cierre, apertura, cambio de turno o devolución). */
async function custodiaActual(tx: Tx | Sql, sucursalId: string): Promise<CustodiaCaja | null> {
  const [r] = await tx<CustodiaCaja[]>`
    select u.nombre, r.en as desde, r.momento, r.llave, r.llave_cajon as "llaveCajon" from revision_caja r join usuario u on u.id = r.custodio_id
    where r.sucursal_id = ${sucursalId} and r.momento <> 'recoleccion' order by r.en desc, r.id limit 1`;
  return r ?? null;
}

async function sobresDeRecoleccion(tx: Tx | Sql, recoleccionId: string): Promise<Sobre[]> {
  return [...(await tx<Sobre[]>`
    select s.id, l.tipo as lugar, s.folio from recoleccion_sobre x join sobre_cierre s on s.id = x.sobre_id join lugar_efectivo l on l.id = s.lugar_id
    where x.recoleccion_id = ${recoleccionId} order by s.resuelto_en, s.folio`)];
}

/** Sobres de una entrega cancelada que aún no vuelven físicamente a la caja. */
async function sobresPorDevolver(tx: Tx | Sql, recoleccionId: string): Promise<Sobre[]> {
  return [...(await tx<Sobre[]>`
    select s.id, l.tipo as lugar, s.folio from recoleccion_sobre x join sobre_cierre s on s.id = x.sobre_id join lugar_efectivo l on l.id = s.lugar_id
    where x.recoleccion_id = ${recoleccionId}
      and not exists (select 1 from devolucion_sobre d where d.recoleccion_id = x.recoleccion_id and d.sobre_id = x.sobre_id)
    order by s.resuelto_en, s.folio`)];
}

/** Entregas canceladas: con sobres pendientes de devolver (pendientes) o ya devueltas por completo. */
async function entregasCanceladas(tx: Tx | Sql, sucursalId: string, usuarioId: string, pendientes: boolean): Promise<EntregaCancelada[]> {
  const rs = await tx<{ id: string; entrega_por: string; devuelve: string; devuelve_id: string; cancelada_en: Date; motivo: string }[]>`
    select r.id, a.nombre as entrega_por, b.nombre as devuelve, b.id as devuelve_id, r.resuelta_en as cancelada_en, r.motivo_cancelacion as motivo
    from recoleccion r join usuario a on a.id = r.entrega_por join usuario b on b.id = r.recibe
    where r.sucursal_id = ${sucursalId} and r.estado = 'cancelada'
      and exists (select 1 from recoleccion_sobre x where x.recoleccion_id = r.id
                    and not exists (select 1 from devolucion_sobre d where d.recoleccion_id = r.id and d.sobre_id = x.sobre_id)) = ${pendientes}
    order by r.resuelta_en desc limit 20`;
  const revisa = await puedeRevisarSucursal(tx, usuarioId, sucursalId);
  const salida: EntregaCancelada[] = [];
  for (const r of rs) {
    const difs = await diferenciasDe(tx, r.id, usuarioId, revisa);
    const devueltos = await tx<{ sobre_id: string; en: Date; recibio: string }[]>`
      select x.sobre_id, d.en, u.nombre as recibio from devolucion_sobre x join devolucion_recoleccion d on d.id = x.devolucion_id
      join usuario u on u.id = d.recibida_por where x.recoleccion_id = ${r.id}`;
    const sobres: SobreDevolucion[] = [];
    for (const x of await sobresDeRecoleccion(tx, r.id)) {
      const d = devueltos.find((y) => y.sobre_id === x.id);
      sobres.push({
        ...x, devuelto: d ? { en: d.en, recibio: d.recibio } : null,
        diferencias: difs.filter((f) => f.folio === x.folio), cadena: await cadenaSobre(tx, x.id),
      });
    }
    salida.push({ id: r.id, entregaPor: r.entrega_por, devuelve: r.devuelve, devuelveId: r.devuelve_id, canceladaEn: r.cancelada_en, motivo: r.motivo, sobres });
  }
  return salida;
}

/** Problemas con la llave de la caja de sobres al recoger o al devolver, con su revisión. */
async function incidenciasLlave(tx: Tx | Sql, sucursalId: string, usuarioId: string): Promise<IncidenciaLlave[]> {
  const revisa = await puedeRevisarSucursal(tx, usuarioId, sucursalId);
  const filas = await tx<{ id: string; momento: "recoleccion" | "devolucion"; por: string; en: Date; motivo: string; resultado: "aclarada" | "incidencia_confirmada" | null;
                           revisada_por: string | null; motivo_revision: string | null; participo: boolean; autorrevision: string | null; propia: boolean }[]>`
    select i.id, r.momento, u.nombre as por, r.en, r.motivo_llave as motivo, v.resultado, vu.nombre as revisada_por, v.motivo as motivo_revision,
           ${usuarioId}::uuid in (select participantes_recoleccion(i.recoleccion_id)) as participo,
           autorrevision_vigente(${usuarioId}, x.sucursal_id) as autorrevision, v.autorrevision_id is not null as propia
    from incidencia_llave_recoleccion i join revision_caja r on r.id = i.revision_id join usuario u on u.id = r.por
    join recoleccion x on x.id = i.recoleccion_id
    left join revision_incidencia_llave v on v.incidencia_id = i.id left join usuario vu on vu.id = v.revisada_por
    where x.sucursal_id = ${sucursalId} order by r.en desc limit 30`;
  return filas.map((f) => ({
    id: f.id, momento: f.momento, por: f.por, en: f.en, motivo: f.motivo, estado: f.resultado ?? "por_revisar",
    revisadaPor: f.revisada_por, motivoRevision: f.motivo_revision, puedeRevisar: !f.resultado && revisa && (!f.participo || f.autorrevision !== null),
    revisarasPropia: !f.resultado && revisa && f.participo && f.autorrevision !== null, revisadaPropia: f.propia,
  }));
}

async function pendienteDe(tx: Tx | Sql, sucursalId: string): Promise<RecoleccionPendiente | null> {
  const [r] = await tx<{ id: string; version: number; entrega_por: string; entrega_por_id: string; recibe: string; recibe_id: string; creada_en: Date }[]>`
    select r.id, r.version, a.nombre as entrega_por, a.id as entrega_por_id, b.nombre as recibe, b.id as recibe_id, r.creada_en
    from recoleccion r join usuario a on a.id = r.entrega_por join usuario b on b.id = r.recibe
    where r.sucursal_id = ${sucursalId} and r.estado = 'pendiente'`;
  if (!r) return null;
  return {
    id: r.id, version: r.version, entregaPor: r.entrega_por, entregaPorId: r.entrega_por_id, recibe: r.recibe, recibeId: r.recibe_id,
    creadaEn: r.creada_en, sobres: await sobresDeRecoleccion(tx, r.id),
  };
}

const MOMENTO: Record<string, string> = {
  cierre: "Cerró y anotó", custodia: "Custodia al cerrar", apertura: "Abrió y recibió la llave", cambio_turno: "Recibió el turno y la llave",
  recoleccion: "Recogió (Dirección)", entrega: "Entregó a Dirección", caja_cierre: "Recibió la llave al cerrar",
  entrega_pendiente: "Entregó a Dirección (por confirmar)", cancelada: "Entrega cancelada (por devolver)",
  devolucion: "Revisó la devolución", devuelto: "Volvió a la caja (devolución)",
  depositado: "Registró que lo depositó en el buzón", trasladado: "Lo trasladó de la caja anterior al buzón", investigar: "No estaba en el buzón al recoger: por investigar, sin responsable asignado",
};

/** Cadena de custodia de un sobre: quién lo cerró, cada revisión de la caja, quién lo entregó y quién lo recogió. */
async function cadenaSobre(tx: Tx | Sql, sobreId: string) {
  const filas = await tx<{ momento: string; nombre: string; en: Date; estado: string | null }[]>`
    select 'cierre' as momento, u.nombre, s.resuelto_en as en, null::text as estado
    from sobre_cierre s join entrega_turno e on e.id = s.entrega_id join usuario u on u.id = e.entrega_por where s.id = ${sobreId}
    union all
    select case when v.momento = 'custodia' then 'custodia' when r.momento = 'cierre' then 'caja_cierre' else r.momento end, u.nombre, v.en, v.estado
    from verificacion_sobre v left join revision_caja r on r.id = v.revision_id join usuario u on u.id = v.verificado_por where v.sobre_id = ${sobreId}
    union all
    select case r.estado when 'pendiente' then 'entrega_pendiente' else 'entrega' end, u.nombre, r.creada_en, null
    from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
    join usuario u on u.id = r.entrega_por where x.sobre_id = ${sobreId} and not r.buzon
    union all
    select 'cancelada', u.nombre, r.resuelta_en, null from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
    join usuario u on u.id = r.recibe where x.sobre_id = ${sobreId} and r.estado = 'cancelada'
    union all
    select 'devuelto', u.nombre, d.en, null from devolucion_sobre x join devolucion_recoleccion d on d.id = x.devolucion_id
    join usuario u on u.id = d.recibida_por where x.sobre_id = ${sobreId}
    union all
    select 'depositado', u.nombre, d.en, null from sobre_depositado d join usuario u on u.id = d.depositado_por where d.sobre_id = ${sobreId}
    union all
    select 'trasladado', u.nombre, t.en, null from traslado_sobre x join traslado_buzon t on t.id = x.traslado_id
    join usuario u on u.id = t.por where x.sobre_id = ${sobreId}
    union all
    select 'investigar', u.nombre, i.creada_en, null from investigacion_sobre i join recoleccion r on r.id = i.recoleccion_id
    join usuario u on u.id = r.recibe where i.sobre_id = ${sobreId}
    order by 3`;
  return filas.map((f) => ({ ...f, momento: MOMENTO[f.momento] ?? f.momento }));
}

async function recoleccionesConfirmadas(tx: Tx | Sql, sucursalId: string, usuarioId: string): Promise<RecoleccionConfirmada[]> {
  const rs = await tx<{ id: string; entrega_por: string | null; recibe: string; recibe_id: string; resuelta_en: Date; buzon: boolean }[]>`
    select r.id, a.nombre as entrega_por, b.nombre as recibe, b.id as recibe_id, r.resuelta_en, r.buzon
    from recoleccion r left join usuario a on a.id = r.entrega_por join usuario b on b.id = r.recibe
    where r.sucursal_id = ${sucursalId} and r.estado = 'confirmada' order by r.resuelta_en desc limit 20`;
  const revisa = await puedeRevisarSucursal(tx, usuarioId, sucursalId);
  const salida: RecoleccionConfirmada[] = [];
  for (const r of rs) {
    const sobres = await tx<{ folio: string; anotado: string; contado: string | null }[]>`
      select s.folio, s.importe::text as anotado, x.contado::text as contado from recoleccion_sobre x join sobre_cierre s on s.id = x.sobre_id
      where x.recoleccion_id = ${r.id} order by s.resuelto_en, s.folio`;
    const depositos = await tx<{ importe: string; fecha: string; referencia: string; por: string; en: Date }[]>`
      select d.importe::text as importe, d.fecha::text as fecha, d.referencia, u.nombre as por, d.en
      from deposito_recoleccion d join usuario u on u.id = d.registrado_por where d.recoleccion_id = ${r.id} order by d.en`;
    const diferencias = await diferenciasDe(tx, r.id, usuarioId, revisa);
    const recogido = sobres.reduce((n, s) => n + (s.contado === null ? 0 : cent(s.contado)), 0);
    const depositado = depositos.reduce((n, d) => n + cent(d.importe), 0);
    salida.push({
      id: r.id, entregaPor: r.entrega_por, recibe: r.recibe, recibeId: r.recibe_id, confirmadaEn: r.resuelta_en, buzon: r.buzon,
      sobres: [...sobres], recogido: pesos(recogido), depositado: pesos(depositado), saldo: pesos(recogido - depositado),
      depositos: [...depositos], diferencias,
    });
  }
  return salida;
}

async function puedeRevisarSucursal(tx: Tx | Sql, usuarioId: string, sucursalId: string) {
  const [{ revisa }] = await tx<{ revisa: boolean }[]>`
    select tiene_permiso(${usuarioId}, 'diferencia.revisar', ${sucursalId})
           and exists (select 1 from perfiles_en_sucursal(${usuarioId}, ${sucursalId}) r where r = 'administracion') as revisa`;
  return revisa;
}

/** Diferencias por sobre de una recolección (confirmada) o de una devolución (cancelada), con su cadena. */
async function diferenciasDe(tx: Tx | Sql, recoleccionId: string, usuarioId: string, revisa: boolean): Promise<DiferenciaSobre[]> {
    const difs = await tx<{ id: string; sobre_id: string; folio: string; anotado: string; contado: string | null; importe: string;
                            v_estado: Verificacion["estado"] | null; v_folio: string | null; v_motivo: string | null; v_por: string | null; v_en: Date | null;
                            resultado: EstadoDiferenciaSobre | null; motivo: string | null; revisada_por: string | null; participo: boolean;
                            autorrevision: string | null; propia: boolean }[]>`
      select d.id, d.sobre_id, s.folio, s.importe::text as anotado, x.contado::text as contado, d.importe::text as importe,
             v.estado as v_estado, v.folio_visto as v_folio, v.motivo as v_motivo, vu.nombre as v_por, v.en as v_en,
             rv.resultado, rv.motivo, ru.nombre as revisada_por, ${usuarioId}::uuid in (select participantes_sobre(d.sobre_id)) as participo,
             autorrevision_vigente(${usuarioId}, s.sucursal_id) as autorrevision, rv.autorrevision_id is not null as propia
      from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id join recoleccion_sobre x on x.recoleccion_id = d.recoleccion_id and x.sobre_id = d.sobre_id
      left join verificacion_sobre v on v.id = d.verificacion_id left join usuario vu on vu.id = v.verificado_por
      left join revision_diferencia_sobre rv on rv.diferencia_id = d.id left join usuario ru on ru.id = rv.revisada_por
      where d.recoleccion_id = ${recoleccionId} order by s.folio`;
    const diferencias: DiferenciaSobre[] = [];
    for (const d of difs) {
      diferencias.push({
        id: d.id, folio: d.folio, anotado: d.anotado, contado: d.contado, importe: d.importe,
        verificacion: d.v_estado ? { estado: d.v_estado, folioVisto: d.v_folio, motivo: d.v_motivo, por: d.v_por!, en: d.v_en! } : null,
        estado: d.resultado ?? "por_revisar", motivo: d.motivo, revisadaPor: d.revisada_por,
        cadena: await cadenaSobre(tx, d.sobre_id), puedeRevisar: !d.resultado && revisa && (!d.participo || d.autorrevision !== null),
        revisarasPropia: !d.resultado && revisa && d.participo && d.autorrevision !== null, revisadaPropia: d.propia,
      });
    }
    return diferencias;
}

export async function pantallaRecoleccion(sql: Sql, usuarioId: string, codigo: string, entorno: Entorno): Promise<PantallaRecoleccion> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  return sql.begin("read only", async (tx): Promise<PantallaRecoleccion> => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false, error: "no_encontrada" };
    const [t] = await tx<{ id: string; responsable: boolean }[]>`
      select t.id, exists (select 1 from responsable_lugar r where r.turno_id = t.id and r.hasta is null and r.usuario_id = ${usuarioId}) as responsable
      from turno t where t.sucursal_id = ${s.id} and t.cerrado_en is null`;
    const pendiente = await pendienteDe(tx, s.id);
    const porDevolver = await entregasCanceladas(tx, s.id, usuarioId, true);
    // Quien puede recoger (Dirección) cuenta a ciegas: no ve lo anotado de los sobres hasta confirmar su conteo, aunque su
    // cuenta también pueda entregar sobres.
    const ciega = s.recoge;
    const config = await configuracionVigente(tx, s.id);
    const buzon = await infoBuzon(tx, s.id, config);
    return {
      ok: true, sucursal: s.nombre, turnoId: t?.id ?? null,
      caja: await caja(tx, s.id, !ciega, buzon ? "buzon" : "todos"),
      porTrasladar: buzon ? await caja(tx, s.id, !ciega, "por_trasladar") : [],
      puedeTrasladar: Boolean(buzon && t?.responsable && s.entrega),
      traslados: await traslados(tx, s.id), custodia: await custodiaActual(tx, s.id), diasAviso: DIAS_AVISO_SOBRE,
      fuera: await sobresFueraDeCaja(tx, s.id),
      pendiente, porDevolver,
      // Un sobre que no regresa no impide entregar los que sí están en la caja.
      puedeEntregar: Boolean(t?.responsable && s.entrega && !pendiente),
      puedeRecibirDevolucion: Boolean(t?.responsable && s.entrega),
      direccion: await direccionSucursal(tx, s.id),
      recolecciones: await recoleccionesConfirmadas(tx, s.id, usuarioId),
      devoluciones: await entregasCanceladas(tx, s.id, usuarioId, false),
      incidenciasLlave: await incidenciasLlave(tx, s.id, usuarioId),
      buzon, puedeRecogerBuzon: Boolean(buzon && s.recoge && buzon.llave.some((x) => x.id === usuarioId)),
      investigaciones: await investigaciones(tx, s.id),
    };
  });
}

async function traslados(tx: Tx | Sql, sucursalId: string): Promise<TrasladoBuzon[]> {
  return [...(await tx<TrasladoBuzon[]>`
    select t.id, u.nombre as por, t.en,
           array(select s.folio from traslado_sobre x join sobre_cierre s on s.id = x.sobre_id where x.traslado_id = t.id order by s.resuelto_en, s.folio) as folios
    from traslado_buzon t join usuario u on u.id = t.por where t.sucursal_id = ${sucursalId} order by t.en desc limit 20`)];
}

/**
 * La responsable en turno (que tiene la llave de la caja anterior) registra el traslado físico al buzón de los sobres
 * guardados antes del buzón: qué folios trasladó. Guardar la configuración no los da por trasladados; los que no elija
 * siguen en la caja anterior, por trasladar. Primero el turno.
 */
export async function registrarTrasladoBuzon(
  sql: Sql, usuarioId: string, codigo: string, datos: { sobres: string[] }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; trasladados: string[]; pendientes: number } | { ok: false; error: ErrorRecoleccion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const ids = [...new Set(datos.sobres)];
  if (!ids.length || ids.length > 60 || !ids.every(esIdentificadorValido)) return { ok: false, error: "sobres" };
  return sql.begin(async (tx) => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.entrega) return { ok: false as const, error: "sin_permiso" as const };
    const [t] = await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null for update`;
    if (!t) return { ok: false as const, error: "sin_turno" as const };
    await tx`select pg_advisory_xact_lock(hashtext(${"buzon:" + s.id}))`;
    if (!(await configuracionVigente(tx, s.id))?.buzon) return { ok: false as const, error: "sin_permiso" as const };
    const [{ responsable }] = await tx<{ responsable: boolean }[]>`
      select exists (select 1 from responsable_lugar where turno_id = ${t.id} and hasta is null and usuario_id = ${usuarioId}) as responsable`;
    if (!responsable) return { ok: false as const, error: "no_responsable" as const };
    const pendientes = await sobresEnCaja(tx, s.id, null, "por_trasladar");
    if (!ids.every((id) => pendientes.some((p) => p.id === id))) return { ok: false as const, error: "sobres" as const };
    const [x] = await tx<{ id: string }[]>`
      insert into traslado_buzon (sucursal_id, por, turno_id) values (${s.id}, ${usuarioId}, ${t.id}) returning id`;
    for (const id of ids) await tx`insert into traslado_sobre (traslado_id, sobre_id) values (${x.id}, ${id})`;
    const folios = pendientes.filter((p) => ids.includes(p.id)).map((p) => p.folio);
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('traslado_buzon', ${x.id}, 'trasladar',
                     ${tx.json({ sucursal: codigo, folios, siguen_en_la_caja: pendientes.filter((p) => !ids.includes(p.id)).map((p) => p.folio) })}, ${usuarioId})`;
    return { ok: true as const, trasladados: folios, pendientes: pendientes.length - ids.length };
  });
}

/** Sobres por investigar: registrados como depositados que no estaban en el buzón al recoger. Sin responsable asignado. */
async function investigaciones(tx: Tx | Sql, sucursalId: string): Promise<InvestigacionSobre[]> {
  const filas = await tx<{ id: string; sobre_id: string; folio: string; lugar: Sobre["lugar"]; anotado: string; depositado_por: string | null;
                           depositado_en: Date | null; recogio: string; en: Date; motivo: string | null }[]>`
    select i.id, s.id as sobre_id, s.folio, l.tipo as lugar, s.importe::text as anotado, du.nombre as depositado_por, d.en as depositado_en,
           u.nombre as recogio, i.creada_en as en, v.motivo
    from investigacion_sobre i join sobre_cierre s on s.id = i.sobre_id join lugar_efectivo l on l.id = s.lugar_id
    join recoleccion r on r.id = i.recoleccion_id join usuario u on u.id = r.recibe
    join verificacion_sobre v on v.id = i.verificacion_id
    left join sobre_depositado d on d.sobre_id = s.id left join usuario du on du.id = d.depositado_por
    where s.sucursal_id = ${sucursalId} order by i.creada_en desc limit 30`;
  const salida: InvestigacionSobre[] = [];
  for (const f of filas) {
    salida.push({
      id: f.id, folio: f.folio, lugar: f.lugar, anotado: f.anotado, depositadoPor: f.depositado_por, depositadoEn: f.depositado_en,
      recogio: f.recogio, en: f.en, motivo: f.motivo, cadena: await cadenaSobre(tx, f.sobre_id),
    });
  }
  return salida;
}

export type ErrorRecoleccion =
  | "no_encontrada" | "sin_permiso" | "sin_turno" | "no_responsable" | "entrega_en_curso" | "ya_pendiente" | "sobres" | "recibe"
  | "sin_pendiente" | "cambio" | "motivo" | "contado" | "motivo_llave" | "importe" | "fecha" | "referencia" | "saldo" | "resultado"
  | "participaste" | "devolucion_pendiente" | "sin_devolucion" | "devuelve_misma" | "buzon" | "sin_llave_buzon" | "buzon_vacio"
  | ErrorVerificacion | "bloqueado_produccion";

/**
 * La responsable en turno entrega a Dirección los sobres que elige. Primero el turno (mismo orden de bloqueo que cobros,
 * retiros y cambio de turno). Los sobres no elegidos siguen en la caja.
 */
export async function registrarEntregaSobres(
  sql: Sql, usuarioId: string, codigo: string, datos: { sobres: string[]; recibe: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; recoleccionId: string } | { ok: false; error: ErrorRecoleccion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const ids = [...new Set(datos.sobres)];
  if (!ids.length || ids.length > 60 || !ids.every(esIdentificadorValido)) return { ok: false, error: "sobres" };
  if (!esIdentificadorValido(datos.recibe)) return { ok: false, error: "recibe" };
  return sql.begin(async (tx) => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.entrega) return { ok: false as const, error: "sin_permiso" as const };
    // Con buzón no hay entrega: Dirección recoge directamente del buzón.
    if ((await configuracionVigente(tx, s.id))?.buzon) return { ok: false as const, error: "buzon" as const };
    const [t] = await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null for update`;
    if (!t) return { ok: false as const, error: "sin_turno" as const };
    const [r] = await tx<{ responsable: boolean; entrega: boolean }[]>`
      select exists (select 1 from responsable_lugar where turno_id = ${t.id} and hasta is null and usuario_id = ${usuarioId}) as responsable,
             exists (select 1 from entrega_turno where turno_id = ${t.id} and estado in ('pendiente', 'recuento')) as entrega`;
    if (!r.responsable) return { ok: false as const, error: "no_responsable" as const };
    if (r.entrega) return { ok: false as const, error: "entrega_en_curso" as const };
    if (await pendienteDe(tx, s.id)) return { ok: false as const, error: "ya_pendiente" as const };
    if (!(await direccionSucursal(tx, s.id)).some((d) => d.id === datos.recibe) || datos.recibe === usuarioId) {
      return { ok: false as const, error: "recibe" as const };
    }
    const enCaja = await sobresEnCaja(tx, s.id);
    if (!ids.every((id) => enCaja.some((c) => c.id === id))) return { ok: false as const, error: "sobres" as const };
    const [x] = await tx<{ id: string }[]>`
      insert into recoleccion (sucursal_id, turno_id, entrega_por, recibe) values (${s.id}, ${t.id}, ${usuarioId}, ${datos.recibe}) returning id`;
    for (const id of ids) await tx`insert into recoleccion_sobre (recoleccion_id, sobre_id) values (${x.id}, ${id})`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('recoleccion', ${x.id}, 'entregar',
                     ${tx.json({ sucursal: codigo, recibe: datos.recibe, sobres: enCaja.filter((c) => ids.includes(c.id)).map((c) => c.folio),
                                 quedan: enCaja.filter((c) => !ids.includes(c.id)).map((c) => c.folio) })}, ${usuarioId})`;
    return { ok: true as const, recoleccionId: x.id };
  });
}

/**
 * Cancela una entrega de sobres pendiente (quien entregó o quien iba a recibir), con motivo. Los sobres no vuelven a
 * mostrarse en la caja hasta que se registra su devolución física.
 */
export async function cancelarEntregaSobres(
  sql: Sql, usuarioId: string, codigo: string, datos: { recoleccionId: string; version: number; motivo: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorRecoleccion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.recoleccionId)) return { ok: false, error: "sin_pendiente" };
  const motivo = limpiar(datos.motivo);
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  return sql.begin(async (tx) => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    const [r] = await tx<{ id: string; version: number; entrega_por: string; recibe: string }[]>`
      select id, version, entrega_por, recibe from recoleccion
      where id = ${datos.recoleccionId} and sucursal_id = ${s.id} and estado = 'pendiente' for update`;
    if (!r || (r.entrega_por !== usuarioId && r.recibe !== usuarioId)) return { ok: false as const, error: "sin_pendiente" as const };
    if (r.version !== datos.version) return { ok: false as const, error: "cambio" as const };
    await tx`update recoleccion set estado = 'cancelada', resuelta_en = now(), motivo_cancelacion = ${motivo}, version = version + 1 where id = ${r.id}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('recoleccion', ${r.id}, 'cancelar', ${tx.json({ sucursal: codigo })}, ${motivo}, ${usuarioId})`;
    return { ok: true as const };
  });
}

export type ConteoSobre = VerificacionDatos & { contado: string };

/**
 * Dirección confirma desde su cuenta: verifica sello y folio de cada sobre entregado y lo cuenta a ciegas. Los sobres
 * pasan a «recogidos» bajo su responsabilidad hasta depositarse. Cada diferencia o sobre con problema queda por revisar.
 */
export async function confirmarRecoleccion(
  sql: Sql, usuarioId: string, codigo: string,
  datos: {
    recoleccionId: string; version: number; sobres: ConteoSobre[];
    /** Llave de la caja de sobres (Dirección indica si estaba cerrada con llave). */
    llave?: LlaveDatos;
  },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; recogido: string; diferencias: number } | { ok: false; error: ErrorRecoleccion; sobreId?: string }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.recoleccionId)) return { ok: false, error: "sin_pendiente" };
  const llave = leerLlave(datos.llave);
  if (!llave.ok) return { ok: false, error: "motivo_llave" };
  const contados = new Map<string, string>();
  for (const x of datos.sobres) {
    const i = leerImporte(x.contado);
    if (!i.ok) return { ok: false, error: "contado", sobreId: x.sobreId };
    contados.set(x.sobreId, i.valor);
  }
  return sql.begin(async (tx) => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    // Mismo orden de bloqueo: primero el turno (si hay uno abierto), luego la recolección.
    await tx`select id from turno where sucursal_id = ${s.id} and cerrado_en is null for update`;
    const [r] = await tx<{ id: string; version: number; entrega_por: string; recibe: string }[]>`
      select id, version, entrega_por, recibe from recoleccion
      where id = ${datos.recoleccionId} and sucursal_id = ${s.id} and estado = 'pendiente' for update`;
    if (!r || r.recibe !== usuarioId) return { ok: false as const, error: "sin_pendiente" as const };
    if (r.version !== datos.version) return { ok: false as const, error: "cambio" as const };
    const p = (await pendienteDe(tx, s.id))!;
    const v = leerVerificaciones(p.sobres, datos.sobres);
    if (!v.ok) return v;
    const revisionId = await registrarRevisionCaja(tx, {
      sucursalId: s.id, momento: "recoleccion", recoleccionId: r.id, por: usuarioId, custodio: r.entrega_por, llave, llaveCajon: null, filas: v.filas,
    });
    // Un problema con la llave de la caja al recoger queda por revisar (Administración que no participó).
    if (llave.llave === "incidencia") {
      await tx`insert into incidencia_llave_recoleccion (recoleccion_id, revision_id) values (${r.id}, ${revisionId})`;
    }
    const anotados = await tx<{ id: string; importe: string }[]>`
      select id, importe::text as importe from sobre_cierre where id in ${tx(p.sobres.map((x) => x.id))}`;
    for (const x of p.sobres) {
      await tx`update recoleccion_sobre set contado = ${contados.get(x.id)!} where recoleccion_id = ${r.id} and sobre_id = ${x.id}`;
    }
    await tx`update recoleccion set estado = 'confirmada', resuelta_en = now(), version = version + 1 where id = ${r.id}`;
    let diferencias = 0;
    let recogido = 0;
    for (const x of p.sobres) {
      await tx`update sobre_cierre set estado = 'recogido', recoleccion_id = ${r.id} where id = ${x.id}`;
      const contado = cent(contados.get(x.id)!);
      recogido += contado;
      const dif = contado - cent(anotados.find((a) => a.id === x.id)!.importe);
      const f = v.filas.find((y) => y.sobreId === x.id)!;
      const [ver] = f.estado === "correcto" ? [null] : await tx<{ id: string }[]>`
        select id from verificacion_sobre where revision_id = ${revisionId} and sobre_id = ${x.id}`;
      if (dif !== 0 || ver) {
        diferencias++;
        await tx`insert into diferencia_sobre (recoleccion_id, sobre_id, importe, verificacion_id)
                 values (${r.id}, ${x.id}, ${pesos(dif)}, ${ver?.id ?? null})`;
      }
    }
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('recoleccion', ${r.id}, 'confirmar',
                     ${tx.json({ sucursal: codigo, sobres: v.filas.map((f) => ({ ...f, contado: contados.get(f.sobreId) })), recogido: pesos(recogido),
                                 diferencias, llave: llave.llave, motivo_llave: llave.motivo })}, ${usuarioId})`;
    return { ok: true as const, recogido: pesos(recogido), diferencias };
  });
}

/**
 * Dirección (con la llave del buzón) abre el buzón y recoge todos los sobres registrados como depositados: verifica sello
 * y folio de cada uno y lo cuenta a ciegas. Lo recogido queda bajo su responsabilidad hasta depositarlo (depósitos
 * parciales). Un sobre que no está («No está el sobre») queda por investigar, sin atribuir el faltante a nadie y sin
 * sumarse a lo recogido. Una diferencia de importe o un sobre abierto o con otro folio queda por revisar (Administración
 * que no participó), igual que un problema con la llave del buzón.
 */
export async function recogerBuzon(
  sql: Sql, usuarioId: string, codigo: string,
  datos: { sobres: ConteoSobre[]; llave?: LlaveDatos }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; recogido: string; diferencias: number; investigar: number } | { ok: false; error: ErrorRecoleccion; sobreId?: string }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const llave = leerLlaveRequerida(datos.llave);
  if (!llave.ok) return { ok: false, error: "motivo_llave" };
  const contados = new Map<string, string>();
  for (const x of datos.sobres) {
    if (x.estado === "falta") continue;
    const i = leerImporte(x.contado);
    if (!i.ok) return { ok: false, error: "contado", sobreId: x.sobreId };
    contados.set(x.sobreId, i.valor);
  }
  return sql.begin(async (tx) => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    // Un solo recorrido del buzón a la vez por sucursal.
    await tx`select pg_advisory_xact_lock(hashtext(${"buzon:" + s.id}))`;
    const config = await configuracionVigente(tx, s.id);
    if (!config?.buzon) return { ok: false as const, error: "sin_permiso" as const };
    if (!s.recoge || !config.acceso.some((a) => a.id === usuarioId)) return { ok: false as const, error: "sin_llave_buzon" as const };
    // Solo lo que está en el buzón: depositado al cerrar o con su traslado registrado.
    const registrados = await sobresEnCaja(tx, s.id, null, "buzon");
    if (!registrados.length) return { ok: false as const, error: "buzon_vacio" as const };
    const v = leerVerificaciones(registrados, datos.sobres.filter((x) => registrados.some((y) => y.id === x.sobreId)));
    if (!v.ok) return v.error === "sobres" ? { ok: false as const, error: "cambio" as const } : v;
    const presentes = v.filas.filter((f) => f.estado !== "falta");
    const faltan = v.filas.filter((f) => f.estado === "falta");
    const sinConteo = presentes.find((f) => !contados.has(f.sobreId));
    if (sinConteo) return { ok: false as const, error: "contado" as const, sobreId: sinConteo.sobreId };
    const [r] = await tx<{ id: string }[]>`
      insert into recoleccion (sucursal_id, turno_id, entrega_por, recibe, buzon) values (${s.id}, null, null, ${usuarioId}, true) returning id`;
    for (const x of registrados) await tx`insert into recoleccion_sobre (recoleccion_id, sobre_id) values (${r.id}, ${x.id})`;
    const revisionId = await registrarRevisionCaja(tx, {
      sucursalId: s.id, momento: "recoleccion", recoleccionId: r.id, por: usuarioId, custodio: usuarioId, llave, llaveCajon: null, filas: v.filas,
    });
    if (llave.llave === "incidencia") {
      await tx`insert into incidencia_llave_recoleccion (recoleccion_id, revision_id) values (${r.id}, ${revisionId})`;
    }
    for (const f of presentes) {
      await tx`update recoleccion_sobre set contado = ${contados.get(f.sobreId)!} where recoleccion_id = ${r.id} and sobre_id = ${f.sobreId}`;
    }
    await tx`update recoleccion set estado = 'confirmada', resuelta_en = now(), version = version + 1 where id = ${r.id}`;
    const anotados = await tx<{ id: string; importe: string }[]>`
      select id, importe::text as importe from sobre_cierre where id in ${tx(registrados.map((x) => x.id))}`;
    const verificaciones = await tx<{ id: string; sobre_id: string }[]>`select id, sobre_id from verificacion_sobre where revision_id = ${revisionId}`;
    const verDe = (id: string) => verificaciones.find((x) => x.sobre_id === id)!.id;
    let diferencias = 0;
    let recogido = 0;
    for (const f of presentes) {
      await tx`update sobre_cierre set estado = 'recogido', recoleccion_id = ${r.id} where id = ${f.sobreId}`;
      const contado = cent(contados.get(f.sobreId)!);
      recogido += contado;
      const dif = contado - cent(anotados.find((a) => a.id === f.sobreId)!.importe);
      if (dif !== 0 || f.estado !== "correcto") {
        diferencias++;
        await tx`insert into diferencia_sobre (recoleccion_id, sobre_id, importe, verificacion_id)
                 values (${r.id}, ${f.sobreId}, ${pesos(dif)}, ${f.estado === "correcto" ? null : verDe(f.sobreId)})`;
      }
    }
    // Registrado como depositado y no estaba: por investigar, sin responsable asignado (no se resuelve aquí).
    for (const f of faltan) {
      await tx`insert into investigacion_sobre (sobre_id, recoleccion_id, verificacion_id) values (${f.sobreId}, ${r.id}, ${verDe(f.sobreId)})`;
    }
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('recoleccion', ${r.id}, 'recoger_buzon',
                     ${tx.json({ sucursal: codigo, sobres: v.filas.map((f) => ({ ...f, contado: contados.get(f.sobreId) ?? null })), recogido: pesos(recogido),
                                 diferencias, por_investigar: faltan.length, llave_buzon: llave.llave, motivo_llave_buzon: llave.motivo })}, ${usuarioId})`;
    return { ok: true as const, recogido: pesos(recogido), diferencias, investigar: faltan.length };
  });
}

/**
 * Devolución física de una entrega cancelada, por sobre: la responsable en turno recibe de vuelta lo que le entrega
 * quien lo tenía en Dirección y verifica cada sobre pendiente. Solo los recibidos físicamente vuelven a la caja; uno que
 * no regresa («No está el sobre») sigue pendiente de devolución, con su incidencia y su cadena, y puede devolverse
 * después. Un sobre con problema o la llave de la caja con problema quedan por revisar (Administración que no
 * participó). Primero el turno.
 */
export async function registrarDevolucion(
  sql: Sql, usuarioId: string, codigo: string,
  datos: { recoleccionId: string; sobres: VerificacionDatos[]; llave?: LlaveDatos }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; devueltos: number; pendientes: number; incidencias: number } | { ok: false; error: ErrorRecoleccion; sobreId?: string }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.recoleccionId)) return { ok: false, error: "sin_devolucion" };
  const llave = leerLlaveRequerida(datos.llave);
  if (!llave.ok) return { ok: false, error: "motivo_llave" };
  return sql.begin(async (tx) => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.entrega) return { ok: false as const, error: "sin_permiso" as const };
    const [t] = await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null for update`;
    if (!t) return { ok: false as const, error: "sin_turno" as const };
    const [{ responsable }] = await tx<{ responsable: boolean }[]>`
      select exists (select 1 from responsable_lugar where turno_id = ${t.id} and hasta is null and usuario_id = ${usuarioId}) as responsable`;
    if (!responsable) return { ok: false as const, error: "no_responsable" as const };
    const [r] = await tx<{ id: string; recibe: string }[]>`
      select r.id, r.recibe from recoleccion r where r.id = ${datos.recoleccionId} and r.sucursal_id = ${s.id} and r.estado = 'cancelada'
      for update`;
    if (!r) return { ok: false as const, error: "sin_devolucion" as const };
    if (r.recibe === usuarioId) return { ok: false as const, error: "devuelve_misma" as const };
    // Se verifican todos los sobres de esa entrega que siguen pendientes de devolver.
    const sobres = await sobresPorDevolver(tx, r.id);
    if (!sobres.length) return { ok: false as const, error: "sin_devolucion" as const };
    const v = leerVerificaciones(sobres, datos.sobres.filter((x) => sobres.some((y) => y.id === x.sobreId)));
    if (!v.ok) return v;
    const revisionId = await registrarRevisionCaja(tx, {
      sucursalId: s.id, momento: "devolucion", recoleccionId: r.id, por: usuarioId, custodio: usuarioId, llave, llaveCajon: null, filas: v.filas,
    });
    const [d] = await tx<{ id: string }[]>`
      insert into devolucion_recoleccion (recoleccion_id, devuelve_por, recibida_por, turno_id, revision_id)
      values (${r.id}, ${r.recibe}, ${usuarioId}, ${t.id}, ${revisionId}) returning id`;
    // Solo vuelven a la caja los recibidos físicamente.
    const recibidos = v.filas.filter((f) => f.estado !== "falta");
    for (const f of recibidos) {
      await tx`insert into devolucion_sobre (devolucion_id, recoleccion_id, sobre_id) values (${d.id}, ${r.id}, ${f.sobreId})`;
    }
    const problemas = await tx<{ id: string; sobre_id: string }[]>`
      select id, sobre_id from verificacion_sobre where revision_id = ${revisionId} and estado <> 'correcto' order by id`;
    for (const p of problemas) {
      await tx`insert into diferencia_sobre (recoleccion_id, sobre_id, importe, verificacion_id) values (${r.id}, ${p.sobre_id}, 0, ${p.id})`;
    }
    if (llave.llave === "incidencia") {
      await tx`insert into incidencia_llave_recoleccion (recoleccion_id, revision_id) values (${r.id}, ${revisionId})`;
    }
    const pendientes = sobres.length - recibidos.length;
    const incidencias = problemas.length + (llave.llave === "incidencia" ? 1 : 0);
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('recoleccion', ${r.id}, 'devolver',
                     ${tx.json({ sucursal: codigo, devuelve: r.recibe, sobres: v.filas, devueltos: recibidos.map((f) => f.sobreId), pendientes,
                                 llave: llave.llave, motivo_llave: llave.motivo, incidencias })},
                     ${usuarioId})`;
    return { ok: true as const, devueltos: recibidos.length, pendientes, incidencias };
  });
}

/** Quien recogió registra cada depósito (parcial o total) de lo recogido; nunca más que el saldo. */
export async function registrarDepositoRecoleccion(
  sql: Sql, usuarioId: string, codigo: string,
  datos: { recoleccionId: string; importe: string; fecha: string; referencia: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; saldo: string } | { ok: false; error: ErrorRecoleccion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.recoleccionId)) return { ok: false, error: "sin_pendiente" };
  const i = leerImporte(datos.importe);
  if (!i.ok || cent(i.valor) <= 0) return { ok: false, error: "importe" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha) || Number.isNaN(Date.parse(datos.fecha))) return { ok: false, error: "fecha" };
  const referencia = limpiar(datos.referencia);
  if (referencia.length < 3 || referencia.length > 60) return { ok: false, error: "referencia" };
  return sql.begin(async (tx) => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    const [r] = await tx<{ id: string; recibe: string; resuelta: string }[]>`
      select id, recibe, (resuelta_en at time zone 'America/Mexico_City')::date::text as resuelta from recoleccion
      where id = ${datos.recoleccionId} and sucursal_id = ${s.id} and estado = 'confirmada' for update`;
    if (!r || r.recibe !== usuarioId) return { ok: false as const, error: "sin_pendiente" as const };
    // La fecha del depósito no es anterior a la recolección ni futura.
    const [{ hoy }] = await tx<{ hoy: string }[]>`select (now() at time zone 'America/Mexico_City')::date::text as hoy`;
    if (datos.fecha < r.resuelta || datos.fecha > hoy) return { ok: false as const, error: "fecha" as const };
    const [{ saldo }] = await tx<{ saldo: string }[]>`
      select ((select sum(contado) from recoleccion_sobre where recoleccion_id = ${r.id})
              - (select coalesce(sum(importe), 0) from deposito_recoleccion where recoleccion_id = ${r.id}))::numeric(12, 2)::text as saldo`;
    if (cent(i.valor) > cent(saldo)) return { ok: false as const, error: "saldo" as const };
    const [d] = await tx<{ id: string }[]>`
      insert into deposito_recoleccion (recoleccion_id, importe, fecha, referencia, registrado_por)
      values (${r.id}, ${i.valor}, ${datos.fecha}::text::date, ${referencia}, ${usuarioId}) returning id`;
    const nuevo = pesos(cent(saldo) - cent(i.valor));
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('deposito_recoleccion', ${d.id}, 'registrar',
                     ${tx.json({ sucursal: codigo, recoleccion: r.id, importe: i.valor, fecha: datos.fecha, referencia, saldo: nuevo })}, ${usuarioId})`;
    return { ok: true as const, saldo: nuevo };
  });
}

/** Administración revisa la diferencia de un sobre si no participó en su cadena; se conserva la cadena completa. */
export async function revisarDiferenciaSobre(
  sql: Sql, usuarioId: string, codigo: string, datos: { diferenciaId: string; resultado: string; motivo: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorRecoleccion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.diferenciaId)) return { ok: false, error: "no_encontrada" };
  const motivo = limpiar(datos.motivo);
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  if (!["aclarada", "faltante_confirmado", "sobrante_confirmado", "incidencia_confirmada"].includes(datos.resultado)) return { ok: false, error: "resultado" };
  return sql.begin(async (tx) => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.revisa) return { ok: false as const, error: "sin_permiso" as const };
    const [d] = await tx<{ id: string; importe: string; participo: boolean; revisada: boolean; autorrevision: string | null }[]>`
      select d.id, d.importe::text as importe, ${usuarioId}::uuid in (select participantes_sobre(d.sobre_id)) as participo,
             autorrevision_vigente(${usuarioId}, s.sucursal_id) as autorrevision,
             exists (select 1 from revision_diferencia_sobre r where r.diferencia_id = d.id) as revisada
      from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id
      where d.id = ${datos.diferenciaId} and s.sucursal_id = ${s.id} for update of d`;
    if (!d || d.revisada) return { ok: false as const, error: "no_encontrada" as const };
    // Quien participó solo revisa con su autorización personal vigente, y la revisión queda marcada.
    if (d.participo && !d.autorrevision) return { ok: false as const, error: "participaste" as const };
    const autorrevision = d.participo ? d.autorrevision : null;
    const c = cent(d.importe);
    const permitido = c < 0 ? ["aclarada", "faltante_confirmado"] : c > 0 ? ["aclarada", "sobrante_confirmado"] : ["aclarada", "incidencia_confirmada"];
    if (!permitido.includes(datos.resultado)) return { ok: false as const, error: "resultado" as const };
    await tx`insert into revision_diferencia_sobre (diferencia_id, resultado, motivo, revisada_por, autorrevision_id)
             values (${d.id}, ${datos.resultado}, ${motivo}, ${usuarioId}, ${autorrevision})`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('diferencia_sobre', ${d.id}, 'revisar', ${tx.json({ sucursal: codigo, resultado: datos.resultado, revisada_por_quien_participo: autorrevision !== null })}, ${motivo}, ${usuarioId})`;
    return { ok: true as const };
  });
}

/** Administración revisa un problema con la llave al recoger o devolver, si no participó en esa operación. */
export async function revisarIncidenciaLlave(
  sql: Sql, usuarioId: string, codigo: string, datos: { incidenciaId: string; resultado: string; motivo: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorRecoleccion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.incidenciaId)) return { ok: false, error: "no_encontrada" };
  const motivo = limpiar(datos.motivo);
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  if (!["aclarada", "incidencia_confirmada"].includes(datos.resultado)) return { ok: false, error: "resultado" };
  return sql.begin(async (tx) => {
    const s = await sucursalRecoleccion(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.revisa) return { ok: false as const, error: "sin_permiso" as const };
    const [i] = await tx<{ id: string; participo: boolean; revisada: boolean; autorrevision: string | null }[]>`
      select i.id, ${usuarioId}::uuid in (select participantes_recoleccion(i.recoleccion_id)) as participo,
             autorrevision_vigente(${usuarioId}, r.sucursal_id) as autorrevision,
             exists (select 1 from revision_incidencia_llave v where v.incidencia_id = i.id) as revisada
      from incidencia_llave_recoleccion i join recoleccion r on r.id = i.recoleccion_id
      where i.id = ${datos.incidenciaId} and r.sucursal_id = ${s.id} for update of i`;
    if (!i || i.revisada) return { ok: false as const, error: "no_encontrada" as const };
    if (i.participo && !i.autorrevision) return { ok: false as const, error: "participaste" as const };
    const autorrevision = i.participo ? i.autorrevision : null;
    await tx`insert into revision_incidencia_llave (incidencia_id, resultado, motivo, revisada_por, autorrevision_id)
             values (${i.id}, ${datos.resultado}, ${motivo}, ${usuarioId}, ${autorrevision})`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('incidencia_llave_recoleccion', ${i.id}, 'revisar', ${tx.json({ sucursal: codigo, resultado: datos.resultado, revisada_por_quien_participo: autorrevision !== null })}, ${motivo}, ${usuarioId})`;
    return { ok: true as const };
  });
}

/**
 * Para la pantalla de la sucursal: null si la cuenta no ve la caja; si no, cuántos sobres hay guardados, cuántos con
 * aviso y cuántos le toca recoger (Dirección con una entrega pendiente a su nombre).
 */
export async function accesoRecoleccion(sql: Sql, usuarioId: string, sucursalId: string): Promise<{ sobres: number; conAviso: number; porRecoger: number; buzon: boolean } | null> {
  const [s] = await sql<{ codigo: string }[]>`select codigo from sucursal where id = ${sucursalId}`;
  if (!s || !(await sucursalRecoleccion(sql, usuarioId, s.codigo))) return null;
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from recoleccion_sobre x join recoleccion r on r.id = x.recoleccion_id
    where r.sucursal_id = ${sucursalId} and r.estado = 'pendiente' and r.recibe = ${usuarioId}`;
  // Con buzón, Dirección con su llave tiene por recoger todos los sobres registrados como depositados.
  const config = await configuracionVigente(sql, sucursalId);
  const sobres = await sobresEnCaja(sql, sucursalId, null, config?.buzon ? "buzon" : "todos");
  const conLlave = Boolean(config?.buzon && config.acceso.some((a) => a.id === usuarioId))
    && (await sql<{ ok: boolean }[]>`select tiene_permiso(${usuarioId}, 'sobre.recoger', ${sucursalId}) as ok`)[0].ok;
  return {
    sobres: sobres.length, conAviso: sobres.filter((x) => x.dias >= DIAS_AVISO_SOBRE).length,
    porRecoger: config?.buzon ? (conLlave ? sobres.length : 0) : n, buzon: config?.buzon === true,
  };
}

/** Resumen para la tarjeta de la caja en la pantalla del turno y de la sucursal. */
export async function resumenCaja(sql: Sql, sucursalId: string): Promise<{
  sobres: number; conAviso: number; masAntiguo: number | null; porConfirmar: number; porDevolver: number; porInvestigar: number; porTrasladar: number;
  /** Con buzón: los sobres están registrados como depositados (no en una caja con llave que pase con el turno). */
  buzon: boolean;
}> {
  const buzon = (await configuracionVigente(sql, sucursalId))?.buzon === true;
  const sobres = await sobresEnCaja(sql, sucursalId, null, buzon ? "buzon" : "todos");
  const porTrasladar = buzon ? (await sobresEnCaja(sql, sucursalId, null, "por_trasladar")).length : 0;
  const fuera = await sobresFueraDeCaja(sql, sucursalId);
  return {
    sobres: sobres.length, conAviso: sobres.filter((s) => s.dias >= DIAS_AVISO_SOBRE).length,
    masAntiguo: sobres.length ? Math.max(...sobres.map((s) => s.dias)) : null,
    porConfirmar: fuera.filter((f) => f.estado === "por_confirmar").length, porDevolver: fuera.filter((f) => f.estado === "por_devolver").length,
    porInvestigar: (await sql<{ n: number }[]>`
      select count(*)::int as n from investigacion_sobre i join sobre_cierre s on s.id = i.sobre_id where s.sucursal_id = ${sucursalId}`)[0].n,
    buzon, porTrasladar,
  };
}

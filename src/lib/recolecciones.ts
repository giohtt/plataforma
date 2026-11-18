import type postgres from "postgres";
import {
  DIAS_AVISO_SOBRE, leerLlave, leerVerificaciones, registrarRevisionCaja, sobresEnCaja,
  type ErrorVerificacion, type LlaveDatos, type SobreEnCaja, type Verificacion, type VerificacionDatos,
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
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

const valido = (codigo: string) => /^[A-Z0-9]{2,5}$/.test(codigo);
const limpiar = (t: string) => t.trim().replace(/\s+/g, " ");
const cent = (v: string) => Math.round(Number(v) * 100);
const pesos = (c: number) => (c / 100).toFixed(2);

export type SobreCaja = SobreEnCaja & { importe: string | null; aviso: boolean; enEntrega: boolean };
export type CustodiaCaja = { nombre: string; desde: Date; momento: "cierre" | "apertura" | "cambio_turno" | "recoleccion"; llave: "correcta" | "incidencia" };

export type RecoleccionPendiente = {
  id: string; version: number; entregaPor: string; entregaPorId: string; recibe: string; recibeId: string; creadaEn: Date;
  sobres: SobreEnCaja[];
};
export type EstadoDiferenciaSobre = "por_revisar" | "aclarada" | "faltante_confirmado" | "sobrante_confirmado" | "incidencia_confirmada";
export type DiferenciaSobre = {
  id: string; folio: string; anotado: string; contado: string; importe: string;
  verificacion: Verificacion | null; estado: EstadoDiferenciaSobre; motivo: string | null; revisadaPor: string | null;
  /** Personas de la cadena del sobre (cerró, custodió, verificó la caja, entregó, recogió). */
  cadena: { momento: string; nombre: string; en: Date; estado: string | null }[];
  /** Si esta cuenta puede revisarla (Administración que no participó). */
  puedeRevisar: boolean;
};
export type RecoleccionConfirmada = {
  id: string; entregaPor: string; recibe: string; recibeId: string; confirmadaEn: Date;
  sobres: { folio: string; anotado: string; contado: string }[];
  recogido: string; depositado: string; saldo: string;
  depositos: { importe: string; fecha: string; referencia: string; por: string; en: Date }[];
  diferencias: DiferenciaSobre[];
};

export type PantallaRecoleccion =
  | {
      ok: true; sucursal: string; turnoId: string | null;
      caja: SobreCaja[]; custodia: CustodiaCaja | null; diasAviso: number;
      pendiente: RecoleccionPendiente | null;
      /** La responsable en turno puede entregar sobres (si no hay otra entrega pendiente). */
      puedeEntregar: boolean;
      direccion: Receptor[];
      recolecciones: RecoleccionConfirmada[];
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

/** Sobres de la caja con su aviso (desde los 8 días de guardado) y si ya están en una entrega pendiente. */
async function caja(tx: Tx | Sql, sucursalId: string, verImporte: boolean): Promise<SobreCaja[]> {
  const sobres = await sobresEnCaja(tx, sucursalId);
  if (!sobres.length) return [];
  const extra = await tx<{ id: string; importe: string; en_entrega: boolean }[]>`
    select s.id, s.importe::text as importe,
           exists (select 1 from recoleccion_sobre x join recoleccion r on r.id = x.recoleccion_id where x.sobre_id = s.id and r.estado = 'pendiente') as en_entrega
    from sobre_cierre s where s.id in ${tx(sobres.map((x) => x.id))}`;
  return sobres.map((s) => {
    const e = extra.find((x) => x.id === s.id)!;
    // Dirección cuenta a ciegas: no ve lo anotado al cerrar hasta confirmar.
    return { ...s, importe: verImporte ? e.importe : null, aviso: s.dias >= DIAS_AVISO_SOBRE, enEntrega: e.en_entrega };
  });
}

/** Quién tiene la llave de la caja: la última persona que la recibió (cierre, apertura o cambio de turno). */
async function custodiaActual(tx: Tx | Sql, sucursalId: string): Promise<CustodiaCaja | null> {
  const [r] = await tx<CustodiaCaja[]>`
    select u.nombre, r.en as desde, r.momento, r.llave from revision_caja r join usuario u on u.id = r.custodio_id
    where r.sucursal_id = ${sucursalId} and r.momento <> 'recoleccion' order by r.en desc, r.id limit 1`;
  return r ?? null;
}

async function pendienteDe(tx: Tx | Sql, sucursalId: string): Promise<RecoleccionPendiente | null> {
  const [r] = await tx<{ id: string; version: number; entrega_por: string; entrega_por_id: string; recibe: string; recibe_id: string; creada_en: Date }[]>`
    select r.id, r.version, a.nombre as entrega_por, a.id as entrega_por_id, b.nombre as recibe, b.id as recibe_id, r.creada_en
    from recoleccion r join usuario a on a.id = r.entrega_por join usuario b on b.id = r.recibe
    where r.sucursal_id = ${sucursalId} and r.estado = 'pendiente'`;
  if (!r) return null;
  const todos = await sobresEnCaja(tx, sucursalId);
  const ids = (await tx<{ sobre_id: string }[]>`select sobre_id from recoleccion_sobre where recoleccion_id = ${r.id}`).map((x) => x.sobre_id);
  return {
    id: r.id, version: r.version, entregaPor: r.entrega_por, entregaPorId: r.entrega_por_id, recibe: r.recibe, recibeId: r.recibe_id,
    creadaEn: r.creada_en, sobres: todos.filter((s) => ids.includes(s.id)),
  };
}

const MOMENTO: Record<string, string> = {
  cierre: "Cerró y anotó", custodia: "Custodia al cerrar", apertura: "Abrió y recibió la llave", cambio_turno: "Recibió el turno y la llave",
  recoleccion: "Recogió (Dirección)", entrega: "Entregó a Dirección", caja_cierre: "Recibió la llave al cerrar",
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
    select 'entrega', u.nombre, r.creada_en, null from recoleccion r join recoleccion_sobre x on x.recoleccion_id = r.id
    join usuario u on u.id = r.entrega_por where x.sobre_id = ${sobreId} and r.estado = 'confirmada'
    order by 3`;
  return filas.map((f) => ({ ...f, momento: MOMENTO[f.momento] ?? f.momento }));
}

async function recoleccionesConfirmadas(tx: Tx | Sql, sucursalId: string, usuarioId: string): Promise<RecoleccionConfirmada[]> {
  const rs = await tx<{ id: string; entrega_por: string; recibe: string; recibe_id: string; resuelta_en: Date }[]>`
    select r.id, a.nombre as entrega_por, b.nombre as recibe, b.id as recibe_id, r.resuelta_en
    from recoleccion r join usuario a on a.id = r.entrega_por join usuario b on b.id = r.recibe
    where r.sucursal_id = ${sucursalId} and r.estado = 'confirmada' order by r.resuelta_en desc limit 20`;
  const [{ revisa }] = await tx<{ revisa: boolean }[]>`
    select tiene_permiso(${usuarioId}, 'diferencia.revisar', ${sucursalId})
           and exists (select 1 from perfiles_en_sucursal(${usuarioId}, ${sucursalId}) r where r = 'administracion') as revisa`;
  const salida: RecoleccionConfirmada[] = [];
  for (const r of rs) {
    const sobres = await tx<{ folio: string; anotado: string; contado: string }[]>`
      select s.folio, s.importe::text as anotado, x.contado::text as contado from recoleccion_sobre x join sobre_cierre s on s.id = x.sobre_id
      where x.recoleccion_id = ${r.id} order by s.resuelto_en, s.folio`;
    const depositos = await tx<{ importe: string; fecha: string; referencia: string; por: string; en: Date }[]>`
      select d.importe::text as importe, d.fecha::text as fecha, d.referencia, u.nombre as por, d.en
      from deposito_recoleccion d join usuario u on u.id = d.registrado_por where d.recoleccion_id = ${r.id} order by d.en`;
    const difs = await tx<{ id: string; sobre_id: string; folio: string; anotado: string; contado: string; importe: string;
                            v_estado: Verificacion["estado"] | null; v_folio: string | null; v_motivo: string | null; v_por: string | null; v_en: Date | null;
                            resultado: EstadoDiferenciaSobre | null; motivo: string | null; revisada_por: string | null; participo: boolean }[]>`
      select d.id, d.sobre_id, s.folio, s.importe::text as anotado, x.contado::text as contado, d.importe::text as importe,
             v.estado as v_estado, v.folio_visto as v_folio, v.motivo as v_motivo, vu.nombre as v_por, v.en as v_en,
             rv.resultado, rv.motivo, ru.nombre as revisada_por, ${usuarioId}::uuid in (select participantes_sobre(d.sobre_id)) as participo
      from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id join recoleccion_sobre x on x.recoleccion_id = d.recoleccion_id and x.sobre_id = d.sobre_id
      left join verificacion_sobre v on v.id = d.verificacion_id left join usuario vu on vu.id = v.verificado_por
      left join revision_diferencia_sobre rv on rv.diferencia_id = d.id left join usuario ru on ru.id = rv.revisada_por
      where d.recoleccion_id = ${r.id} order by s.folio`;
    const diferencias: DiferenciaSobre[] = [];
    for (const d of difs) {
      diferencias.push({
        id: d.id, folio: d.folio, anotado: d.anotado, contado: d.contado, importe: d.importe,
        verificacion: d.v_estado ? { estado: d.v_estado, folioVisto: d.v_folio, motivo: d.v_motivo, por: d.v_por!, en: d.v_en! } : null,
        estado: d.resultado ?? "por_revisar", motivo: d.motivo, revisadaPor: d.revisada_por,
        cadena: await cadenaSobre(tx, d.sobre_id), puedeRevisar: !d.resultado && revisa && !d.participo,
      });
    }
    const recogido = sobres.reduce((n, s) => n + cent(s.contado), 0);
    const depositado = depositos.reduce((n, d) => n + cent(d.importe), 0);
    salida.push({
      id: r.id, entregaPor: r.entrega_por, recibe: r.recibe, recibeId: r.recibe_id, confirmadaEn: r.resuelta_en,
      sobres: [...sobres], recogido: pesos(recogido), depositado: pesos(depositado), saldo: pesos(recogido - depositado),
      depositos: [...depositos], diferencias,
    });
  }
  return salida;
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
    // Quien recibe en Dirección cuenta a ciegas: no ve lo anotado de los sobres hasta confirmar.
    const ciega = s.recoge && !s.entrega;
    return {
      ok: true, sucursal: s.nombre, turnoId: t?.id ?? null,
      caja: await caja(tx, s.id, !ciega), custodia: await custodiaActual(tx, s.id), diasAviso: DIAS_AVISO_SOBRE,
      pendiente, puedeEntregar: Boolean(t?.responsable && s.entrega && !pendiente),
      direccion: await direccionSucursal(tx, s.id),
      recolecciones: await recoleccionesConfirmadas(tx, s.id, usuarioId),
    };
  });
}

export type ErrorRecoleccion =
  | "no_encontrada" | "sin_permiso" | "sin_turno" | "no_responsable" | "entrega_en_curso" | "ya_pendiente" | "sobres" | "recibe"
  | "sin_pendiente" | "cambio" | "motivo" | "contado" | "motivo_llave" | "importe" | "fecha" | "referencia" | "saldo" | "resultado"
  | "participaste" | ErrorVerificacion | "bloqueado_produccion";

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

/** Cancela una entrega de sobres pendiente (quien entregó o quien iba a recibir), con motivo. Los sobres siguen en la caja. */
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
  datos: { recoleccionId: string; version: number; sobres: ConteoSobre[]; llave?: LlaveDatos },
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
      sucursalId: s.id, momento: "recoleccion", recoleccionId: r.id, por: usuarioId, custodio: r.entrega_por, llave, filas: v.filas,
    });
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
    const [d] = await tx<{ id: string; importe: string; participo: boolean; revisada: boolean }[]>`
      select d.id, d.importe::text as importe, ${usuarioId}::uuid in (select participantes_sobre(d.sobre_id)) as participo,
             exists (select 1 from revision_diferencia_sobre r where r.diferencia_id = d.id) as revisada
      from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id
      where d.id = ${datos.diferenciaId} and s.sucursal_id = ${s.id} for update of d`;
    if (!d || d.revisada) return { ok: false as const, error: "no_encontrada" as const };
    if (d.participo) return { ok: false as const, error: "participaste" as const };
    const c = cent(d.importe);
    const permitido = c < 0 ? ["aclarada", "faltante_confirmado"] : c > 0 ? ["aclarada", "sobrante_confirmado"] : ["aclarada", "incidencia_confirmada"];
    if (!permitido.includes(datos.resultado)) return { ok: false as const, error: "resultado" as const };
    await tx`insert into revision_diferencia_sobre (diferencia_id, resultado, motivo, revisada_por) values (${d.id}, ${datos.resultado}, ${motivo}, ${usuarioId})`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('diferencia_sobre', ${d.id}, 'revisar', ${tx.json({ sucursal: codigo, resultado: datos.resultado })}, ${motivo}, ${usuarioId})`;
    return { ok: true as const };
  });
}

/**
 * Para la pantalla de la sucursal: null si la cuenta no ve la caja; si no, cuántos sobres hay guardados, cuántos con
 * aviso y cuántos le toca recoger (Dirección con una entrega pendiente a su nombre).
 */
export async function accesoRecoleccion(sql: Sql, usuarioId: string, sucursalId: string): Promise<{ sobres: number; conAviso: number; porRecoger: number } | null> {
  const [s] = await sql<{ codigo: string }[]>`select codigo from sucursal where id = ${sucursalId}`;
  if (!s || !(await sucursalRecoleccion(sql, usuarioId, s.codigo))) return null;
  const sobres = await sobresEnCaja(sql, sucursalId);
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from recoleccion_sobre x join recoleccion r on r.id = x.recoleccion_id
    where r.sucursal_id = ${sucursalId} and r.estado = 'pendiente' and r.recibe = ${usuarioId}`;
  return { sobres: sobres.length, conAviso: sobres.filter((x) => x.dias >= DIAS_AVISO_SOBRE).length, porRecoger: n };
}

/** Resumen para la tarjeta de la caja en la pantalla del turno y de la sucursal. */
export async function resumenCaja(sql: Sql, sucursalId: string): Promise<{ sobres: number; conAviso: number; masAntiguo: number | null; pendiente: boolean }> {
  const sobres = await sobresEnCaja(sql, sucursalId);
  const [{ pendiente }] = await sql<{ pendiente: boolean }[]>`
    select exists (select 1 from recoleccion where sucursal_id = ${sucursalId} and estado = 'pendiente') as pendiente`;
  return {
    sobres: sobres.length, conAviso: sobres.filter((s) => s.dias >= DIAS_AVISO_SOBRE).length,
    masAntiguo: sobres.length ? Math.max(...sobres.map((s) => s.dias)) : null, pendiente,
  };
}

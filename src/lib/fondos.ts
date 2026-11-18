import type postgres from "postgres";
import { fondosVigentes } from "@/lib/cierres";
import { leerImporte } from "@/lib/datos-turno";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";
import type { TipoLugar } from "@/lib/turnos";

/**
 * Bloque 5, regla 7: fondo fijo de caja (aprobado el 17 nov 2026; solo datos ficticios).
 *
 * - Solo Dirección autoriza cambios al monto (fondo.autorizar), con de dónde sale el dinero (aumento) o a dónde va
 *   (reducción). Un aumento entregado por una persona queda pendiente hasta que se recibe.
 * - Dirección y Administración registran reposiciones (fondo.reponer) indicando el origen del dinero.
 * - La responsable vigente del lugar confirma desde su cuenta cuánto recibe; si ella misma entregó, confirma otra
 *   persona autorizada (Encargado, Administración o Dirección de la sucursal). Lo recibido entra al efectivo del lugar.
 * - Reponer no cierra la revisión del faltante: esa sigue en «Diferencias de efectivo».
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

const valido = (codigo: string) => /^[A-Z0-9]{2,5}$/.test(codigo);
const limpiar = (t: string) => t.trim().replace(/\s+/g, " ");
const LUGARES: TipoLugar[] = ["bolsa_visitas", "cajon_mensualidades"];

export type EntradaFondo = {
  id: string; lugar: TipoLugar; tipo: "aumento" | "reposicion"; importe: string; origen: string;
  entrega: string; entregaId: string; registradaEn: Date;
  estado: "pendiente" | "recibida" | "cancelada"; recibidaPor: string | null; resueltaEn: Date | null; motivoCancelacion: string | null;
  /** Esta cuenta puede confirmar lo recibido (responsable vigente u otra persona autorizada si ella entregó). */
  puedoConfirmar: boolean;
  /** Esta cuenta la registró y puede cancelarla mientras está pendiente. */
  puedoCancelar: boolean;
};
export type CambioFondo = {
  id: string; lugar: TipoLugar; anterior: string; monto: string; origen: "entrega_persona" | "excedente_cierre" | null;
  destino: "sobre_cierre" | "retiro" | null; motivo: string; autorizadoPor: string; en: Date;
};
export type PantallaFondos = {
  sucursal: string; codigo: string;
  vigentes: { tipo: TipoLugar; monto: string }[];
  custodia: { lugarFondos: string | null; accesoCajon: string[]; custodioLlave: string | null };
  puedeAutorizar: boolean; puedeReponer: boolean;
  turnoAbierto: boolean;
  entradas: EntradaFondo[];
  cambios: CambioFondo[];
};

async function sucursalFondos(tx: Tx | Sql, usuarioId: string, codigo: string) {
  if (!valido(codigo)) return null;
  const [s] = await tx<{ id: string; nombre: string; autoriza: boolean; repone: boolean; direccion: boolean }[]>`
    select id, nombre, tiene_permiso(${usuarioId}, 'fondo.autorizar', id) as autoriza, tiene_permiso(${usuarioId}, 'fondo.reponer', id) as repone,
           exists (select 1 from perfiles_en_sucursal(${usuarioId}, id) r where r = 'direccion') as direccion
    from sucursal where codigo = ${codigo}
      and (tiene_permiso(${usuarioId}, 'turno.consultar', id) or tiene_permiso(${usuarioId}, 'fondo.reponer', id))`;
  return s ?? null;
}

/** ¿Puede esta cuenta confirmar la entrada? Misma regla que la base de datos. */
async function puedeConfirmar(tx: Tx | Sql, usuarioId: string, e: { sucursal_id: string; lugar_id: string; entrega: string }) {
  if (usuarioId === e.entrega) return false;
  const [r] = await tx<{ responsable: string | null; autorizada: boolean }[]>`
    select (select r.usuario_id from responsable_lugar r join turno t on t.id = r.turno_id
            where t.sucursal_id = ${e.sucursal_id} and t.cerrado_en is null and r.lugar_id = ${e.lugar_id} and r.hasta is null) as responsable,
           exists (select 1 from perfiles_en_sucursal(${usuarioId}, ${e.sucursal_id}) p where p in ('encargado', 'administracion', 'direccion')) as autorizada`;
  if (!r.responsable) return false;
  return r.responsable === e.entrega ? r.autorizada : r.responsable === usuarioId;
}

export async function pantallaFondos(sql: Sql, usuarioId: string, codigo: string): Promise<PantallaFondos | null> {
  const s = await sucursalFondos(sql, usuarioId, codigo);
  if (!s) return null;
  const filas = await sql<{ id: string; lugar: TipoLugar; lugar_id: string; sucursal_id: string; tipo: EntradaFondo["tipo"]; importe: string; origen: string;
                            entrega: string; entrega_id: string; registrada_en: Date; estado: EntradaFondo["estado"]; recibida_por: string | null;
                            resuelta_en: Date | null; motivo_cancelacion: string | null }[]>`
    select x.id, l.tipo as lugar, x.lugar_id, x.sucursal_id, x.tipo, x.importe::text as importe, x.origen, u.nombre as entrega, x.entrega as entrega_id,
           x.registrada_en, x.estado, r.nombre as recibida_por, x.resuelta_en, x.motivo_cancelacion
    from entrada_fondo x join lugar_efectivo l on l.id = x.lugar_id join usuario u on u.id = x.entrega left join usuario r on r.id = x.recibida_por
    where x.sucursal_id = ${s.id} order by x.registrada_en desc limit 100`;
  const entradas: EntradaFondo[] = [];
  for (const f of filas) {
    entradas.push({
      id: f.id, lugar: f.lugar, tipo: f.tipo, importe: f.importe, origen: f.origen, entrega: f.entrega, entregaId: f.entrega_id,
      registradaEn: f.registrada_en, estado: f.estado, recibidaPor: f.recibida_por, resueltaEn: f.resuelta_en, motivoCancelacion: f.motivo_cancelacion,
      puedoConfirmar: f.estado === "pendiente" && (await puedeConfirmar(sql, usuarioId, { sucursal_id: f.sucursal_id, lugar_id: f.lugar_id, entrega: f.entrega_id })),
      puedoCancelar: f.estado === "pendiente" && f.entrega_id === usuarioId,
    });
  }
  const cambios = await sql<CambioFondo[]>`
    select f.id, l.tipo as lugar, f.anterior::text as anterior, f.monto::text as monto, f.origen, f.destino, f.motivo, u.nombre as "autorizadoPor", f.en
    from fondo_caja f join lugar_efectivo l on l.id = f.lugar_id join usuario u on u.id = f.autorizado_por
    where f.sucursal_id = ${s.id} order by f.en desc limit 100`;
  const [c] = await sql<{ lugar_fondos: string | null; acceso: string[] | null }[]>`
    select c.lugar_fondos, array(select u.nombre from usuario u where u.id = any(c.acceso_cajon) order by u.nombre) as acceso
    from custodia_configuracion c where c.sucursal_id = ${s.id} order by c.en desc, c.id limit 1`;
  const [k] = await sql<{ custodio: string | null }[]>`
    select u.nombre as custodio from entrega_turno e join turno t on t.id = e.turno_id join usuario u on u.id = e.custodio_id
    where t.sucursal_id = ${s.id} and e.tipo = 'cierre' and e.estado in ('pendiente', 'recuento')`;
  const [t] = await sql<{ abierto: boolean }[]>`select exists (select 1 from turno where sucursal_id = ${s.id} and cerrado_en is null) as abierto`;
  return {
    sucursal: s.nombre, codigo,
    vigentes: (await fondosVigentes(sql, s.id)).map((f) => ({ tipo: f.tipo, monto: f.monto })),
    custodia: { lugarFondos: c?.lugar_fondos ?? null, accesoCajon: c?.acceso ?? [], custodioLlave: k?.custodio ?? null },
    puedeAutorizar: s.autoriza && s.direccion, puedeReponer: s.repone,
    turnoAbierto: t.abierto, entradas, cambios: [...cambios],
  };
}

/** Entradas al fondo pendientes que esta cuenta puede confirmar en la sucursal (para avisar en el turno). */
export async function entradasPorConfirmar(sql: Sql, usuarioId: string, sucursalId: string): Promise<number> {
  const filas = await sql<{ sucursal_id: string; lugar_id: string; entrega: string }[]>`
    select sucursal_id, lugar_id, entrega from entrada_fondo where sucursal_id = ${sucursalId} and estado = 'pendiente'`;
  let n = 0;
  for (const f of filas) if (await puedeConfirmar(sql, usuarioId, f)) n++;
  return n;
}

export type ErrorFondo =
  | "no_encontrada" | "sin_permiso" | "lugar" | "monto" | "sin_cambio" | "origen" | "destino" | "motivo" | "importe" | "cambio"
  | "bloqueado_produccion";

/**
 * Dirección cambia el monto del fondo de un lugar. Aumento: el dinero lo entrega quien autoriza (queda una entrada
 * pendiente de recibir) o sale del excedente del próximo cierre. Reducción: va al sobre del próximo cierre o se
 * retira con el flujo de retiros. Aplica desde el siguiente cierre.
 */
export async function cambiarMontoFondo(
  sql: Sql, usuarioId: string, codigo: string,
  datos: { lugar: string; monto: string; origen: string; destino: string; detalleOrigen: string; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; entradaId: string | null } | { ok: false; error: ErrorFondo }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!LUGARES.includes(datos.lugar as TipoLugar)) return { ok: false, error: "lugar" };
  const m = leerImporte(datos.monto);
  if (!m.ok || Number(m.valor) > 5000) return { ok: false, error: "monto" };
  const monto = m.valor;
  const motivo = limpiar(datos.motivo);
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  return sql.begin(async (tx) => {
    const s = await sucursalFondos(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.autoriza || !s.direccion) return { ok: false as const, error: "sin_permiso" as const };
    // Serializa los cambios de la sucursal.
    await tx`select id from sucursal where id = ${s.id} for update`;
    const vigente = (await fondosVigentes(tx, s.id)).find((f) => f.tipo === datos.lugar)!;
    const anterior = Number(vigente.monto);
    if (Number(monto) === anterior) return { ok: false as const, error: "sin_cambio" as const };
    const aumento = Number(monto) > anterior;
    if (aumento && !["entrega_persona", "excedente_cierre"].includes(datos.origen)) return { ok: false as const, error: "origen" as const };
    if (!aumento && !["sobre_cierre", "retiro"].includes(datos.destino)) return { ok: false as const, error: "destino" as const };
    const detalle = limpiar(datos.detalleOrigen);
    if (aumento && datos.origen === "entrega_persona" && (detalle.length < 5 || detalle.length > 200)) return { ok: false as const, error: "origen" as const };
    const [f] = await tx<{ id: string }[]>`
      insert into fondo_caja (sucursal_id, lugar_id, monto, anterior, origen, destino, motivo, autorizado_por)
      values (${s.id}, ${vigente.lugarId}, ${monto}, ${vigente.monto}, ${aumento ? datos.origen : null}, ${aumento ? null : datos.destino},
              ${motivo}, ${usuarioId}) returning id`;
    let entradaId: string | null = null;
    if (aumento && datos.origen === "entrega_persona") {
      const [x] = await tx<{ id: string }[]>`
        insert into entrada_fondo (sucursal_id, lugar_id, tipo, fondo_id, importe, origen, entrega, registrada_por)
        values (${s.id}, ${vigente.lugarId}, 'aumento', ${f.id}, ${(Number(monto) - anterior).toFixed(2)}, ${detalle}, ${usuarioId}, ${usuarioId})
        returning id`;
      entradaId = x.id;
    }
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('fondo_caja', ${f.id}, 'cambiar_monto',
                     ${tx.json({ sucursal: codigo, lugar: datos.lugar, anterior: vigente.monto, monto, origen: aumento ? datos.origen : null,
                                 destino: aumento ? null : datos.destino, detalle_origen: entradaId ? detalle : null, entrada: entradaId })},
                     ${motivo}, ${usuarioId})`;
    return { ok: true as const, entradaId };
  });
}

/** Dirección o Administración registra la reposición de un fondo, indicando el origen del dinero que entrega. */
export async function registrarReposicion(
  sql: Sql, usuarioId: string, codigo: string, datos: { lugar: string; importe: string; origen: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; entradaId: string } | { ok: false; error: ErrorFondo }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!LUGARES.includes(datos.lugar as TipoLugar)) return { ok: false, error: "lugar" };
  const i = leerImporte(datos.importe);
  if (!i.ok || Number(i.valor) <= 0 || Number(i.valor) > 5000) return { ok: false, error: "importe" };
  const origen = limpiar(datos.origen);
  if (origen.length < 5 || origen.length > 200) return { ok: false, error: "origen" };
  return sql.begin(async (tx) => {
    const s = await sucursalFondos(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    if (!s.repone) return { ok: false as const, error: "sin_permiso" as const };
    const [l] = await tx<{ id: string }[]>`select id from lugar_efectivo where sucursal_id = ${s.id} and tipo = ${datos.lugar}`;
    const [x] = await tx<{ id: string }[]>`
      insert into entrada_fondo (sucursal_id, lugar_id, tipo, importe, origen, entrega, registrada_por)
      values (${s.id}, ${l.id}, 'reposicion', ${i.valor}, ${origen}, ${usuarioId}, ${usuarioId}) returning id`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrada_fondo', ${x.id}, 'registrar_reposicion', ${tx.json({ sucursal: codigo, lugar: datos.lugar, importe: i.valor, origen })}, ${usuarioId})`;
    return { ok: true as const, entradaId: x.id };
  });
}

export type ErrorConfirmacion = "no_encontrada" | "no_pendiente" | "sin_turno" | "no_puedes" | "importe" | "no_coincide" | "bloqueado_produccion";

/**
 * Quien recibe confirma desde su cuenta cuánto recibió. Si no coincide con lo registrado, no se aplica: se aclara con
 * quien entrega (que puede cancelar y registrar de nuevo). Lo recibido entra al efectivo del lugar en el turno.
 */
export async function confirmarEntradaFondo(
  sql: Sql, usuarioId: string, codigo: string, datos: { entradaId: string; recibido: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorConfirmacion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!valido(codigo) || !esIdentificadorValido(datos.entradaId)) return { ok: false, error: "no_encontrada" };
  const r = leerImporte(datos.recibido);
  if (!r.ok) return { ok: false, error: "importe" };
  return sql.begin(async (tx) => {
    // Primero el turno (mismo orden de bloqueo que cobros, retiros y cierres), luego la entrada.
    const [t] = await tx<{ id: string; sucursal_id: string }[]>`
      select t.id, t.sucursal_id from turno t join sucursal s on s.id = t.sucursal_id where s.codigo = ${codigo} and t.cerrado_en is null for update of t`;
    const [e] = await tx<{ id: string; sucursal_id: string; lugar_id: string; entrega: string; importe: string; estado: string; codigo: string }[]>`
      select x.id, x.sucursal_id, x.lugar_id, x.entrega, x.importe::text as importe, x.estado, s.codigo
      from entrada_fondo x join sucursal s on s.id = x.sucursal_id where x.id = ${datos.entradaId} and s.codigo = ${codigo} for update of x`;
    if (!e) return { ok: false as const, error: "no_encontrada" as const };
    if (e.estado !== "pendiente") return { ok: false as const, error: "no_pendiente" as const };
    if (!t) return { ok: false as const, error: "sin_turno" as const };
    if (!(await puedeConfirmar(tx, usuarioId, e))) return { ok: false as const, error: "no_puedes" as const };
    if (Math.round(Number(r.valor) * 100) !== Math.round(Number(e.importe) * 100)) return { ok: false as const, error: "no_coincide" as const };
    const [resp] = await tx<{ usuario_id: string }[]>`
      select usuario_id from responsable_lugar where turno_id = ${t.id} and lugar_id = ${e.lugar_id} and hasta is null`;
    await tx`update entrada_fondo set estado = 'recibida', recibida_por = ${usuarioId}, importe_recibido = ${r.valor}, turno_id = ${t.id}, resuelta_en = now()
             where id = ${e.id}`;
    await tx`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, entrada_fondo_id, responsable_id, registrado_por)
             values (${e.lugar_id}, ${t.id}, 'entrada_fondo', ${e.importe}, ${e.id}, ${resp.usuario_id}, ${usuarioId})`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('entrada_fondo', ${e.id}, 'recibir', ${tx.json({ recibido: r.valor, turno: t.id, responsable: resp.usuario_id })}, ${usuarioId})`;
    return { ok: true as const };
  });
}

/** Quien registró una entrada pendiente la cancela (por ejemplo, si no coincidió lo recibido), con motivo. */
export async function cancelarEntradaFondo(
  sql: Sql, usuarioId: string, codigo: string, datos: { entradaId: string; motivo: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: "no_encontrada" | "no_pendiente" | "motivo" | "bloqueado_produccion" }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!valido(codigo) || !esIdentificadorValido(datos.entradaId)) return { ok: false, error: "no_encontrada" };
  const motivo = limpiar(datos.motivo);
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: string; estado: string; entrega: string }[]>`
      select x.id, x.estado, x.entrega from entrada_fondo x join sucursal s on s.id = x.sucursal_id
      where x.id = ${datos.entradaId} and s.codigo = ${codigo} for update of x`;
    if (!e || e.entrega !== usuarioId) return { ok: false as const, error: "no_encontrada" as const };
    if (e.estado !== "pendiente") return { ok: false as const, error: "no_pendiente" as const };
    await tx`update entrada_fondo set estado = 'cancelada', resuelta_en = now(), motivo_cancelacion = ${motivo} where id = ${e.id}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('entrada_fondo', ${e.id}, 'cancelar', ${tx.json({})}, ${motivo}, ${usuarioId})`;
    return { ok: true as const };
  });
}

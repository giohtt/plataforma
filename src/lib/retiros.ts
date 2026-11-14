import type postgres from "postgres";
import { tiempoPendiente } from "@/lib/datos-diferencia";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";
import { turnoAbiertoDe, type TipoLugar } from "@/lib/turnos";

/**
 * Bloque 5, paso 3: retiros de efectivo a Encargada de retiros (reglas 4 a 6; solo datos ficticios).
 * Reglas indicadas el 13 nov 2026 para la primera versión en pruebas:
 *
 * - Entrega en persona. La responsable vigente del lugar (Recepción, caja.retirar) cuenta, captura cuánto deja para
 *   cambio la Encargada de retiros y registra un folio único por sucursal. Un registro por lugar. La salida se
 *   descuenta al entregar. Recepción sigue cobrando mientras la confirmación está pendiente. No se retira con un
 *   cambio de turno en curso, en una sucursal inactiva ni en producción.
 * - Encargada de retiros (retiro.confirmar) confirma desde su cuenta con conteo a ciegas (el servidor no le envía lo
 *   registrado mientras está pendiente) y comprueba el folio. Si el importe difiere: recuento en persona (con quién) o,
 *   si no pueden recontar, «No coincide» con motivo. Si el folio no coincide: «No coincide» con motivo. Se conservan
 *   el conteo inicial, el recuento y quién participó.
 * - Con discrepancia, «Por revisar»: solo ESE folio queda en pausa para depósitos. Lo que no coincide no se suma a su
 *   saldo: cuenta lo que ella contó. Revisa Encargado si no participó; si participó, Administración; si también,
 *   Dirección. «Aclarada» o «Faltante confirmado» (el faltante queda pendiente para Dirección), ambos con motivo y
 *   monto verificado; los depósitos se habilitan por ese monto.
 * - Único destino: depósito bancario (importe, fecha y referencia obligatoria). Parciales por folio, nunca más del
 *   monto habilitado. Una corrección es un registro nuevo que reemplaza a otro.
 * - Avisos: «Por revisar desde hace…» y, desde 48 horas después de reportar la diferencia, «48 horas o más en
 *   revisión»; saldo sin destino 48 horas después de habilitar los depósitos, aunque haya depósitos parciales.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type EstadoRetiro = "pendiente" | "recuento" | "confirmado" | "por_revisar" | "revisado";
export type Persona = { id: string; nombre: string };

const valido = (codigo: string) => /^[A-Z0-9]{2,5}$/.test(codigo);
const cent = (v: string | number) => Math.round(Number(v) * 100);
const pesos = (c: number) => (c / 100).toFixed(2);

/** Folio del sobre: mayúsculas, números y guiones (3 a 30). Se normaliza a mayúsculas sin espacios. */
export function leerFolio(entrada: string): string | null {
  const f = entrada.trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z0-9][A-Z0-9-]{2,29}$/.test(f) ? f : null;
}

/** «2026-11-14T10:42» (hora de México). */
const FECHA_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// ---------------------------------------------------------------------------------------------------------------
// Recepción: entregar un retiro
// ---------------------------------------------------------------------------------------------------------------

export type ErrorRetiro =
  | "no_encontrada" | "sin_permiso" | "sucursal_inactiva" | "sin_turno" | "no_responsable" | "entrega_en_curso"
  | "lugar" | "cambio_mayor" | "folio" | "folio_repetido" | "encargada" | "cambio" | "bloqueado_produccion";

async function sucursalDe(tx: Tx | Sql, usuarioId: string, codigo: string) {
  if (!valido(codigo)) return null;
  const [s] = await tx<{ id: string; nombre: string; inactiva: boolean; retira: boolean }[]>`
    select id, nombre, estado_operativo = 'inactiva' as inactiva, tiene_permiso(${usuarioId}, 'caja.retirar', id) as retira
    from sucursal where codigo = ${codigo}
      and (tiene_permiso(${usuarioId}, 'turno.consultar', id) or tiene_permiso(${usuarioId}, 'caja.retirar', id))`;
  return s ?? null;
}

/** Encargadas de retiros autorizadas en la sucursal (sin quien entrega). */
async function encargadas(tx: Tx | Sql, sucursalId: string, usuarioId: string): Promise<Persona[]> {
  return [...(await tx<Persona[]>`
    select id, nombre from usuario
    where activo and id <> ${usuarioId} and tiene_permiso(id, 'retiro.confirmar', ${sucursalId})
    order by nombre`)];
}

export type LugarRetiro = {
  tipo: TipoLugar;
  /**
   * Esperado para comparar al retirar: el del turno más las diferencias ya registradas en retiros anteriores del
   * turno, para no registrar dos veces la misma. Solo la bolsa tiene esperado; el cajón no se concilia sin Open Desk.
   */
  esperado: string | null;
  /** Diferencias contra el esperado ya registradas al retirar en este turno. */
  diferenciaRetiros: string;
  responsable: boolean;
  /** Folio generado y reservado para la preparación en curso de este lugar, si la hay. */
  reserva: { id: string; folio: string; en: Date } | null;
};
export type PantallaRetiro =
  | { ok: true; sucursal: string; turnoId: string; lugares: LugarRetiro[]; encargadas: Persona[]; retiros: RetiroDelTurno[] }
  | { ok: false; error: ErrorRetiro };

/** Esperado del turno + diferencias ya registradas al retirar (solo la bolsa). */
function esperadoParaRetiro(l: { esperado: string | null; diferenciaRetiros: string }): string | null {
  return l.esperado === null ? null : pesos(cent(l.esperado) + cent(l.diferenciaRetiros));
}

export async function pantallaRetiro(sql: Sql, usuarioId: string, codigo: string, entorno: Entorno): Promise<PantallaRetiro> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  return sql.begin("read only", async (tx): Promise<PantallaRetiro> => {
    const s = await sucursalDe(tx, usuarioId, codigo);
    if (!s) return { ok: false, error: "no_encontrada" };
    if (!s.retira) return { ok: false, error: "sin_permiso" };
    if (s.inactiva) return { ok: false, error: "sucursal_inactiva" };
    const t = await turnoAbiertoDe(tx, s.id);
    if (!t) return { ok: false, error: "sin_turno" };
    if (!t.lugares.some((l) => l.responsableId === usuarioId)) return { ok: false, error: "no_responsable" };
    if ((await tx`select 1 from entrega_turno where turno_id = ${t.id} and estado in ('pendiente', 'recuento')`).length) {
      return { ok: false, error: "entrega_en_curso" };
    }
    const reservas = await tx<{ id: string; folio: string; en: Date; tipo: TipoLugar }[]>`
      select f.id, f.folio, f.reservado_en as en, l.tipo from folio_retiro f join lugar_efectivo l on l.id = f.lugar_id
      where f.turno_id = ${t.id} and f.estado = 'reservado'`;
    return {
      ok: true, sucursal: s.nombre, turnoId: t.id,
      lugares: t.lugares.map((l) => {
        const r = reservas.find((x) => x.tipo === l.tipo);
        return {
          tipo: l.tipo, esperado: esperadoParaRetiro(l), diferenciaRetiros: l.diferenciaRetiros, responsable: l.responsableId === usuarioId,
          reserva: r ? { id: r.id, folio: r.folio, en: r.en } : null,
        };
      }),
      encargadas: await encargadas(tx, s.id, usuarioId),
      retiros: await retirosDelTurno(tx, t.id),
    };
  });
}

/**
 * Comprobaciones comunes de Recepción y bloqueo del turno (primero el turno, como cobros, cancelaciones y cambio de
 * turno). Devuelve la sucursal, el turno y el lugar del que es responsable vigente.
 */
async function lugarDeRecepcion(tx: Tx, usuarioId: string, codigo: string, turnoId: string, lugar: string) {
  const s = await sucursalDe(tx, usuarioId, codigo);
  if (!s) return { ok: false as const, error: "no_encontrada" as const };
  if (!s.retira) return { ok: false as const, error: "sin_permiso" as const };
  if (s.inactiva) return { ok: false as const, error: "sucursal_inactiva" as const };
  const [t] = await tx<{ id: string }[]>`select id from turno where sucursal_id = ${s.id} and cerrado_en is null for update`;
  if (!t) return { ok: false as const, error: "sin_turno" as const };
  if (t.id !== turnoId) return { ok: false as const, error: "cambio" as const };
  const [l] = await tx<{ id: string; responsable: string }[]>`
    select l.id, r.usuario_id as responsable from lugar_efectivo l
    join responsable_lugar r on r.lugar_id = l.id and r.turno_id = ${t.id} and r.hasta is null
    where l.sucursal_id = ${s.id} and l.tipo = ${lugar}`;
  if (!l || l.responsable !== usuarioId) return { ok: false as const, error: "no_responsable" as const };
  if ((await tx`select 1 from entrega_turno where turno_id = ${t.id} and estado in ('pendiente', 'recuento')`).length) {
    return { ok: false as const, error: "entrega_en_curso" as const };
  }
  return { ok: true as const, s, t, l };
}

/**
 * «Generar folio»: reserva el siguiente folio de la sucursal para la fecha local, por ejemplo TEN-20261113-01, y lo
 * devuelve para anotarlo en el sobre. No mueve efectivo. Si ya hay una preparación abierta para ese lugar y turno,
 * devuelve la misma (un doble clic no gasta otro folio). El consecutivo nunca se reutiliza.
 */
export async function generarFolio(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { turnoId: string; lugar: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; folioId: string; folio: string } | { ok: false; error: ErrorRetiro }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (datos.lugar !== "bolsa_visitas" && datos.lugar !== "cajon_mensualidades") return { ok: false, error: "lugar" };
  if (!esIdentificadorValido(datos.turnoId)) return { ok: false, error: "cambio" };
  return sql.begin(async (tx) => {
    const c = await lugarDeRecepcion(tx, usuarioId, codigo, datos.turnoId, datos.lugar);
    if (!c.ok) return c;
    const [abierta] = await tx<{ id: string; folio: string }[]>`
      select id, folio from folio_retiro where turno_id = ${c.t.id} and lugar_id = ${c.l.id} and estado = 'reservado'`;
    if (abierta) return { ok: true as const, folioId: abierta.id, folio: abierta.folio };
    // El contador por sucursal y fecha se incrementa con bloqueo de fila: dos preparaciones a la vez reciben folios distintos.
    const [n] = await tx<{ fecha: string; iso: string; ultimo: number }[]>`
      insert into folio_retiro_contador (sucursal_id, fecha, ultimo)
      values (${c.s.id}, (now() at time zone 'America/Mexico_City')::date, 1)
      on conflict (sucursal_id, fecha) do update set ultimo = folio_retiro_contador.ultimo + 1
      returning to_char(fecha, 'YYYYMMDD') as fecha, fecha::text as iso, ultimo`;
    const folio = `${codigo}-${n.fecha}-${String(n.ultimo).padStart(2, "0")}`;
    const [f] = await tx<{ id: string }[]>`
      insert into folio_retiro (sucursal_id, fecha, consecutivo, folio, turno_id, lugar_id, reservado_por)
      values (${c.s.id}, ${n.iso}::text::date, ${n.ultimo}, ${folio}, ${c.t.id}, ${c.l.id}, ${usuarioId})
      returning id`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('folio_retiro', ${f.id}, 'generar', ${tx.json({ sucursal: codigo, lugar: datos.lugar, folio })}, ${usuarioId})`;
    return { ok: true as const, folioId: f.id, folio };
  });
}

/** «Cancelar preparación»: el folio queda cancelado, sin salida de efectivo y sin reutilizarse. */
export async function cancelarFolio(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { folioId: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; folio: string } | { ok: false; error: ErrorRetiro }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.folioId)) return { ok: false, error: "folio" };
  return sql.begin(async (tx) => {
    const s = await sucursalDe(tx, usuarioId, codigo);
    if (!s) return { ok: false as const, error: "no_encontrada" as const };
    const [f] = await tx<{ id: string; folio: string; estado: string; reservado_por: string }[]>`
      select id, folio, estado, reservado_por from folio_retiro where id = ${datos.folioId} and sucursal_id = ${s.id} for update`;
    if (!f || f.reservado_por !== usuarioId) return { ok: false as const, error: "folio" as const };
    if (f.estado === "cancelado") return { ok: true as const, folio: f.folio };
    if (f.estado !== "reservado") return { ok: false as const, error: "folio" as const };
    await tx`update folio_retiro set estado = 'cancelado', resuelto_en = now() where id = ${f.id}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('folio_retiro', ${f.id}, 'cancelar', ${tx.json({ sucursal: codigo, folio: f.folio })}, ${usuarioId})`;
    return { ok: true as const, folio: f.folio };
  });
}

/**
 * «Confirmar entrega»: el sobre con el folio generado ya se entregó en persona. Registra lo contado, lo que deja para
 * cambio (lo indica Encargada de retiros) y descuenta la salida (contado − cambio) en la misma transacción. La reserva
 * queda usada.
 */
export async function registrarRetiro(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { turnoId: string; folioId: string; contado: string; cambio: string; encargada: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; retiroId: string; folio: string; diferencia: string | null } | { ok: false; error: ErrorRetiro }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.folioId)) return { ok: false, error: "folio" };
  if (!esIdentificadorValido(datos.encargada)) return { ok: false, error: "encargada" };
  if (!esIdentificadorValido(datos.turnoId)) return { ok: false, error: "cambio" };
  const importe = cent(datos.contado) - cent(datos.cambio);
  if (importe <= 0) return { ok: false, error: "cambio_mayor" };
  return sql.begin(async (tx) => {
    const [reserva] = await tx<{ tipo: TipoLugar }[]>`
      select l.tipo from folio_retiro f join lugar_efectivo l on l.id = f.lugar_id where f.id = ${datos.folioId}`;
    if (!reserva) return { ok: false as const, error: "folio" as const };
    const c = await lugarDeRecepcion(tx, usuarioId, codigo, datos.turnoId, reserva.tipo);
    if (!c.ok) return c;
    const { s, t, l } = c;
    const [f] = await tx<{ id: string; folio: string; estado: string; reservado_por: string; turno_id: string; lugar_id: string }[]>`
      select id, folio, estado, reservado_por, turno_id, lugar_id from folio_retiro where id = ${datos.folioId} and sucursal_id = ${s.id} for update`;
    if (!f || f.reservado_por !== usuarioId || f.turno_id !== t.id || f.lugar_id !== l.id) return { ok: false as const, error: "folio" as const };
    if (f.estado === "usado") {
      // Reintento del mismo envío (por ejemplo, doble clic): devuelve el retiro ya registrado si los datos son los mismos.
      const [previo] = await tx<{ id: string; contado: string; cambio: string; encargada_id: string }[]>`
        select id, contado::text, cambio::text, encargada_id from retiro where folio_retiro_id = ${f.id}`;
      const mismo = previo && cent(previo.contado) === cent(datos.contado) && cent(previo.cambio) === cent(datos.cambio) && previo.encargada_id === datos.encargada;
      if (!mismo) return { ok: false as const, error: "folio_repetido" as const };
      const [d] = await tx<{ importe: string }[]>`select importe::text from diferencia_retiro where retiro_id = ${previo.id}`;
      return { ok: true as const, retiroId: previo.id, folio: f.folio, diferencia: d?.importe ?? null };
    }
    if (f.estado !== "reservado") return { ok: false as const, error: "folio" as const };
    if (!(await encargadas(tx, s.id, usuarioId)).some((e) => e.id === datos.encargada)) {
      return { ok: false as const, error: "encargada" as const };
    }
    const lugar = (await turnoAbiertoDe(tx, s.id))!.lugares.find((x) => x.tipo === reserva.tipo)!;
    const esperado = esperadoParaRetiro(lugar);
    const [r] = await tx<{ id: string }[]>`
      insert into retiro (sucursal_id, turno_id, lugar_id, folio, folio_retiro_id, contado, cambio, importe, esperado, entregado_por, encargada_id)
      values (${s.id}, ${t.id}, ${l.id}, ${f.folio}, ${f.id}, ${datos.contado}, ${datos.cambio}, ${pesos(importe)}, ${esperado},
              ${usuarioId}, ${datos.encargada})
      returning id`;
    await tx`update folio_retiro set estado = 'usado', resuelto_en = now() where id = ${f.id}`;
    // Diferencia contra el esperado al retirar: se registra ahora, una vez, ligada al retiro.
    const dif = esperado === null ? 0 : cent(datos.contado) - cent(esperado);
    if (dif) {
      await tx`insert into diferencia_retiro (retiro_id, turno_id, lugar_id, esperado, contado, importe)
               values (${r.id}, ${t.id}, ${l.id}, ${esperado}, ${datos.contado}, ${pesos(dif)})`;
    }
    await tx`
      insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, retiro_id, responsable_id, registrado_por)
      values (${l.id}, ${t.id}, 'salida_retiro', ${pesos(-importe)}, ${r.id}, ${usuarioId}, ${usuarioId})`;
    await tx`
      insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
      values ('retiro', ${r.id}, 'entregar',
              ${tx.json({ sucursal: codigo, lugar: reserva.tipo, folio: f.folio, contado: datos.contado, cambio: datos.cambio, importe: pesos(importe), encargada: datos.encargada,
                          esperado, diferencia_contra_esperado: dif ? pesos(dif) : null })},
              ${usuarioId})`;
    return { ok: true as const, retiroId: r.id, folio: f.folio, diferencia: dif ? pesos(dif) : null };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Lectura común
// ---------------------------------------------------------------------------------------------------------------

type FilaRetiro = {
  id: string; sucursal_id: string; codigo: string; sucursal: string; turno_id: string; lugar: TipoLugar; folio: string;
  contado: string; cambio: string; importe: string; esperado: string | null;
  entregado_por: string; entregado_por_id: string; encargada: string; encargada_id: string; entregado_en: Date;
  estado: EstadoRetiro; discrepancia: "importe" | "folio" | null; motivo: string | null; reportado_en: Date | null;
  monto_habilitado: string | null; habilitado_en: Date | null; version: number;
  inicial: string | null; inicial_folio: boolean | null; inicial_en: Date | null;
  recuento: string | null; recuento_en: Date | null; recontado_con: string | null;
  depositado: string;
  resultado: "aclarada" | "faltante_confirmado" | null; monto_verificado: string | null; folio_verificado: string | null;
  folio_en_sobre: string | null;
  dif_esperado: string | null; dif_en: Date | null; dif_presente: string | null; dif_entrega_id: string | null; dif_vinculada_en: Date | null;
};

const FILAS = (tx: Tx | Sql, condicion: postgres.PendingQuery<postgres.Row[]>) => tx<FilaRetiro[]>`
  select r.id, r.sucursal_id, s.codigo, s.nombre as sucursal, r.turno_id, l.tipo as lugar, r.folio,
         r.contado::text, r.cambio::text, r.importe::text, r.esperado::text,
         a.nombre as entregado_por, a.id as entregado_por_id, b.nombre as encargada, b.id as encargada_id, r.entregado_en,
         r.estado, r.discrepancia, r.motivo, r.reportado_en, r.monto_habilitado::text, r.habilitado_en, r.version,
         ci.importe::text as inicial, ci.folio_coincide as inicial_folio, ci.en as inicial_en,
         cr.importe::text as recuento, cr.en as recuento_en, uc.nombre as recontado_con,
         (select coalesce(sum(d.importe), 0) from deposito_retiro d where d.retiro_id = r.id
            and not exists (select 1 from deposito_retiro c where c.corrige_id = d.id))::numeric(12, 2)::text as depositado,
         rv.resultado, rv.monto_verificado::text, rv.folio_verificado, r.folio_en_sobre,
         dr.importe::text as dif_esperado, dr.registrada_en as dif_en, dv.presente::text as dif_presente, dv.entrega_id as dif_entrega_id, dv.en as dif_vinculada_en
  from retiro r
  join sucursal s on s.id = r.sucursal_id
  join lugar_efectivo l on l.id = r.lugar_id
  join usuario a on a.id = r.entregado_por
  join usuario b on b.id = r.encargada_id
  left join retiro_conteo ci on ci.retiro_id = r.id and ci.tipo = 'inicial'
  left join retiro_conteo cr on cr.retiro_id = r.id and cr.tipo = 'recuento'
  left join usuario uc on uc.id = cr.recontado_con
  left join retiro_revision rv on rv.retiro_id = r.id
  left join diferencia_retiro dr on dr.retiro_id = r.id
  left join diferencia_retiro_entrega dv on dv.diferencia_retiro_id = dr.id
  where ${condicion}
  order by r.entregado_en desc`;

/** Estado para mostrar. */
export const ESTADO_RETIRO: Record<EstadoRetiro, string> = {
  pendiente: "Pendiente de confirmar por Encargada de retiros",
  recuento: "No coincide · recuento pendiente",
  confirmado: "Confirmado por Encargada de retiros",
  por_revisar: "No coincide · Por revisar",
  revisado: "Revisado",
};

export type Saldo = {
  /** Monto habilitado para depósitos (lo confirmado o verificado) y lo que falta por depositar. */
  habilitado: string | null;
  depositado: string;
  sinDestino: string;
  /** Lo que ella contó en un folio en pausa (no se puede depositar mientras tanto). */
  enPausa: string;
  /** Diferencia por aclarar (lo que contó − lo registrado), fuera de su saldo. */
  porAclarar: string;
  /** Faltante confirmado en la revisión (registrado − verificado), pendiente para Dirección. */
  faltanteDireccion: string;
};

export type Avisos = {
  revision: { texto: string; masDe48: boolean } | null;
  sinDestino: { texto: string; masDe48: boolean } | null;
};

export type ResumenRetiro = {
  id: string; codigo: string; sucursal: string; turnoId: string; lugar: TipoLugar; folio: string;
  entregadoPor: string; entregadoPorId: string; encargada: string; encargadaId: string; entregadoEn: Date;
  estado: EstadoRetiro; textoEstado: string; discrepancia: "importe" | "folio" | null; version: number;
  resultado: "aclarada" | "faltante_confirmado" | null;
  saldo: Saldo; avisos: Avisos;
};

function saldoDe(f: FilaRetiro): Saldo {
  const contado = f.recuento ?? f.inicial;
  const pausa = f.estado === "recuento" || f.estado === "por_revisar";
  const habilitado = f.monto_habilitado;
  return {
    habilitado,
    depositado: f.depositado,
    sinDestino: habilitado === null ? "0.00" : pesos(cent(habilitado) - cent(f.depositado)),
    enPausa: pausa && contado !== null ? contado : "0.00",
    porAclarar: pausa && contado !== null ? pesos(cent(contado) - cent(f.importe)) : "0.00",
    faltanteDireccion: f.resultado === "faltante_confirmado" ? pesos(cent(f.importe) - cent(f.monto_verificado!)) : "0.00",
  };
}

function textoEstado(f: FilaRetiro): string {
  if (f.estado === "revisado") return f.resultado === "faltante_confirmado" ? "Revisado · faltante confirmado, pendiente para Dirección" : "Revisado · aclarada";
  return ESTADO_RETIRO[f.estado];
}

function resumen(f: FilaRetiro, ahora = new Date()): ResumenRetiro {
  const s = saldoDe(f);
  return {
    id: f.id, codigo: f.codigo, sucursal: f.sucursal, turnoId: f.turno_id, lugar: f.lugar, folio: f.folio,
    entregadoPor: f.entregado_por, entregadoPorId: f.entregado_por_id, encargada: f.encargada, encargadaId: f.encargada_id,
    entregadoEn: f.entregado_en, estado: f.estado, textoEstado: textoEstado(f), discrepancia: f.discrepancia, version: f.version,
    resultado: f.resultado, saldo: s,
    avisos: {
      revision: f.estado === "por_revisar" && f.reportado_en ? tiempoPendiente(f.reportado_en, ahora) : null,
      sinDestino: f.habilitado_en && cent(s.sinDestino) > 0 ? tiempoPendiente(f.habilitado_en, ahora) : null,
    },
  };
}

/** Lo que ve Recepción en su turno: estado de cada retiro, sin el detalle de una discrepancia. */
export type RetiroDelTurno = {
  id: string; lugar: TipoLugar; folio: string; contado: string; cambio: string; importe: string;
  entregadoPor: string; encargada: string; entregadoEn: Date; textoEstado: string;
};
export async function retirosDelTurno(tx: Tx | Sql, turnoId: string): Promise<RetiroDelTurno[]> {
  return (await FILAS(tx, tx`r.turno_id = ${turnoId}`)).map((f) => ({
    id: f.id, lugar: f.lugar, folio: f.folio, contado: f.contado, cambio: f.cambio, importe: f.importe,
    entregadoPor: f.entregado_por, encargada: f.encargada, entregadoEn: f.entregado_en,
    textoEstado: f.estado === "revisado" ? "Revisado" : f.estado === "confirmado" ? ESTADO_RETIRO.confirmado : ESTADO_RETIRO[f.estado],
  })).reverse();
}

// ---------------------------------------------------------------------------------------------------------------
// Encargada de retiros: su bandeja, confirmar, recontar, depositar
// ---------------------------------------------------------------------------------------------------------------

/** Pendiente de su conteo: sin el importe registrado (conteo a ciegas). */
export type PorConfirmar = {
  id: string; version: number; codigo: string; sucursal: string; lugar: TipoLugar; folio: string; cambio: string;
  entregadoPor: string; entregadoEn: Date;
};
/** Su conteo no coincidió: ya ve lo registrado y su conteo; recuentan o declara «No coincide». */
export type PorRecontar = PorConfirmar & { registrado: string; inicial: string; personas: Persona[] };

export type Bandeja = {
  porConfirmar: PorConfirmar[];
  porRecontar: PorRecontar[];
  retiros: ResumenRetiro[];
  total: { sinDestino: string; enPausa: string; porAclarar: string };
};

/** Personas de la sucursal con quienes puede recontar (cualquier perfil vigente en la sucursal, sin ella). */
async function personasSucursal(tx: Tx | Sql, sucursalId: string, excluir: string): Promise<Persona[]> {
  return [...(await tx<Persona[]>`
    select id, nombre from usuario u where activo and id <> ${excluir}
      and exists (select 1 from perfiles_en_sucursal(u.id, ${sucursalId}))
    order by nombre`)];
}

/** Bandeja de Encargada de retiros: solo sus retiros, en las sucursales donde tiene retiro.confirmar. null sin permiso. */
export async function bandejaEncargada(sql: Sql, usuarioId: string, ahora = new Date()): Promise<Bandeja | null> {
  const [{ puede }] = await sql<{ puede: boolean }[]>`
    select exists (select 1 from sucursal s where tiene_permiso(${usuarioId}, 'retiro.confirmar', s.id)) as puede`;
  if (!puede) return null;
  const filas = await FILAS(sql, sql`r.encargada_id = ${usuarioId} and tiene_permiso(${usuarioId}, 'retiro.confirmar', r.sucursal_id)`);
  const base = (f: FilaRetiro): PorConfirmar => ({
    id: f.id, version: f.version, codigo: f.codigo, sucursal: f.sucursal, lugar: f.lugar, folio: f.folio, cambio: f.cambio,
    entregadoPor: f.entregado_por, entregadoEn: f.entregado_en,
  });
  const porRecontar: PorRecontar[] = [];
  for (const f of filas.filter((x) => x.estado === "recuento")) {
    porRecontar.push({ ...base(f), registrado: f.importe, inicial: f.inicial!, personas: await personasSucursal(sql, f.sucursal_id, usuarioId) });
  }
  const retiros = filas.filter((f) => f.estado !== "pendiente").map((f) => resumen(f, ahora));
  const suma = (k: keyof Saldo) => pesos(retiros.reduce((n, r) => n + cent(r.saldo[k] ?? 0), 0));
  return {
    porConfirmar: filas.filter((f) => f.estado === "pendiente").map(base),
    porRecontar,
    retiros,
    total: { sinDestino: suma("sinDestino"), enPausa: suma("enPausa"), porAclarar: suma("porAclarar") },
  };
}

/** Cuántos retiros esperan su confirmación en la sucursal (para el botón). null si no confirma retiros ahí. */
export async function retirosPorConfirmar(sql: Sql, usuarioId: string, sucursalId: string): Promise<number | null> {
  const [r] = await sql<{ puede: boolean; n: number }[]>`
    select tiene_permiso(${usuarioId}, 'retiro.confirmar', ${sucursalId}) as puede,
           (select count(*)::int from retiro where sucursal_id = ${sucursalId} and encargada_id = ${usuarioId}
              and estado in ('pendiente', 'recuento')) as n`;
  return r.puede ? r.n : null;
}

export type ErrorConfirmacion =
  | "no_encontrado" | "sin_permiso" | "cambio" | "importe" | "folio" | "folio_sobre" | "motivo" | "persona" | "bloqueado_produccion";

/** Bloquea el retiro (siempre antes que cualquier otra fila) y comprueba que es de ella y sigue en el estado esperado. */
async function retiroDeEncargada(tx: Tx, usuarioId: string, retiroId: string, estado: EstadoRetiro, version: number) {
  const [r] = await tx<{ id: string; sucursal_id: string; importe: string; estado: EstadoRetiro; version: number; encargada_id: string }[]>`
    select id, sucursal_id, importe::text, estado, version, encargada_id from retiro where id = ${retiroId} for update`;
  if (!r || r.encargada_id !== usuarioId) return { ok: false as const, error: "no_encontrado" as const };
  const [{ puede }] = await tx<{ puede: boolean }[]>`select tiene_permiso(${usuarioId}, 'retiro.confirmar', ${r.sucursal_id}) as puede`;
  if (!puede) return { ok: false as const, error: "sin_permiso" as const };
  if (r.estado !== estado || r.version !== version) return { ok: false as const, error: "cambio" as const };
  return { ok: true as const, r };
}

const limpiar = (t: string) => t.trim().replace(/\s+/g, " ");

/**
 * Primer conteo de Encargada de retiros, a ciegas, y si el folio coincide.
 * - Folio no coincide → «No coincide» con motivo; queda por revisar.
 * - Importe igual y folio correcto → confirmado; se habilitan los depósitos por el importe.
 * - Importe distinto → recuento (ya puede ver lo registrado).
 */
export async function confirmarRetiro(
  sql: Sql,
  usuarioId: string,
  datos: { retiroId: string; version: number; importe: string; folioCoincide: boolean; folioEnSobre?: string; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; resultado: "confirmado" | "recuento" | "por_revisar" } | { ok: false; error: ErrorConfirmacion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.retiroId)) return { ok: false, error: "no_encontrado" };
  const motivo = limpiar(datos.motivo);
  const folioEnSobre = datos.folioCoincide ? null : leerFolio(datos.folioEnSobre ?? "");
  if (!datos.folioCoincide && !folioEnSobre) return { ok: false, error: "folio_sobre" };
  if (!datos.folioCoincide && (motivo.length < 5 || motivo.length > 300)) return { ok: false, error: "motivo" };
  return sql.begin(async (tx) => {
    const c = await retiroDeEncargada(tx, usuarioId, datos.retiroId, "pendiente", datos.version);
    if (!c.ok) return c;
    await tx`insert into retiro_conteo (retiro_id, tipo, importe, folio_coincide, contado_por)
             values (${c.r.id}, 'inicial', ${datos.importe}, ${datos.folioCoincide}, ${usuarioId})`;
    const coincide = cent(datos.importe) === cent(c.r.importe);
    let resultado: "confirmado" | "recuento" | "por_revisar";
    if (!datos.folioCoincide) {
      await tx`update retiro set estado = 'por_revisar', discrepancia = 'folio', folio_en_sobre = ${folioEnSobre}, motivo = ${motivo},
                 reportado_en = now(), version = version + 1
               where id = ${c.r.id}`;
      resultado = "por_revisar";
    } else if (coincide) {
      await tx`update retiro set estado = 'confirmado', monto_habilitado = importe, habilitado_en = now(), version = version + 1 where id = ${c.r.id}`;
      resultado = "confirmado";
    } else {
      await tx`update retiro set estado = 'recuento', version = version + 1 where id = ${c.r.id}`;
      resultado = "recuento";
    }
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('retiro', ${c.r.id}, 'confirmar', ${tx.json({ contado: datos.importe, folio_coincide: datos.folioCoincide, folio_en_sobre: folioEnSobre, resultado })},
                     ${datos.folioCoincide ? null : motivo}, ${usuarioId})`;
    return { ok: true as const, resultado };
  });
}

/**
 * Tras un conteo distinto: recuento en persona (con quién) o, si no pueden recontar, «No coincide» con motivo.
 * Si el recuento coincide con lo registrado, se confirma; si no, el motivo es obligatorio y queda por revisar.
 */
export async function recontarRetiro(
  sql: Sql,
  usuarioId: string,
  datos: { retiroId: string; version: number; recontaron: boolean; importe: string | null; con: string | null; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; resultado: "confirmado" | "por_revisar" } | { ok: false; error: ErrorConfirmacion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.retiroId)) return { ok: false, error: "no_encontrado" };
  if (datos.recontaron && datos.importe === null) return { ok: false, error: "importe" };
  if (datos.recontaron && (!datos.con || !esIdentificadorValido(datos.con))) return { ok: false, error: "persona" };
  const motivo = limpiar(datos.motivo);
  return sql.begin(async (tx) => {
    const c = await retiroDeEncargada(tx, usuarioId, datos.retiroId, "recuento", datos.version);
    if (!c.ok) return c;
    const coincide = datos.recontaron && cent(datos.importe!) === cent(c.r.importe);
    if (!coincide && (motivo.length < 5 || motivo.length > 300)) return { ok: false as const, error: "motivo" as const };
    if (datos.recontaron) {
      if (!(await personasSucursal(tx, c.r.sucursal_id, usuarioId)).some((p) => p.id === datos.con)) {
        return { ok: false as const, error: "persona" as const };
      }
      await tx`insert into retiro_conteo (retiro_id, tipo, importe, folio_coincide, contado_por, recontado_con)
               values (${c.r.id}, 'recuento', ${datos.importe}, true, ${usuarioId}, ${datos.con})`;
    }
    if (coincide) {
      await tx`update retiro set estado = 'confirmado', monto_habilitado = importe, habilitado_en = now(), version = version + 1 where id = ${c.r.id}`;
    } else {
      await tx`update retiro set estado = 'por_revisar', discrepancia = 'importe', motivo = ${motivo}, reportado_en = now(), version = version + 1
               where id = ${c.r.id}`;
    }
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('retiro', ${c.r.id}, ${datos.recontaron ? "recontar" : "no_coincide_sin_recuento"},
                     ${tx.json({ recuento: datos.importe, con: datos.con, resultado: coincide ? "confirmado" : "por_revisar" })},
                     ${coincide ? null : motivo}, ${usuarioId})`;
    return { ok: true as const, resultado: coincide ? ("confirmado" as const) : ("por_revisar" as const) };
  });
}

export type ErrorDeposito =
  | "no_encontrado" | "sin_permiso" | "en_pausa" | "importe" | "excede" | "fecha" | "referencia" | "motivo" | "corrige" | "bloqueado_produccion";

/**
 * Depósito bancario de un folio (o corrección de uno anterior, que lo reemplaza con motivo). Solo con el folio
 * habilitado; los depósitos vigentes no pasan del monto habilitado. La base lo respalda.
 */
export async function registrarDeposito(
  sql: Sql,
  usuarioId: string,
  datos: { retiroId: string; importe: string; depositadoEn: string; referencia: string; corrige: string | null; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; depositoId: string } | { ok: false; error: ErrorDeposito }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.retiroId)) return { ok: false, error: "no_encontrado" };
  if (datos.corrige !== null && !esIdentificadorValido(datos.corrige)) return { ok: false, error: "corrige" };
  const referencia = limpiar(datos.referencia);
  const motivo = limpiar(datos.motivo);
  if (cent(datos.importe) <= 0 && datos.corrige === null) return { ok: false, error: "importe" };
  if (referencia.length < 4 || referencia.length > 60) return { ok: false, error: "referencia" };
  if (datos.corrige !== null && (motivo.length < 5 || motivo.length > 300)) return { ok: false, error: "motivo" };
  if (!FECHA_LOCAL.test(datos.depositadoEn)) return { ok: false, error: "fecha" };
  return sql.begin(async (tx) => {
    const [r] = await tx<{ id: string; sucursal_id: string; encargada_id: string; monto_habilitado: string | null; entregado_en: Date }[]>`
      select id, sucursal_id, encargada_id, monto_habilitado::text, entregado_en from retiro where id = ${datos.retiroId} for update`;
    if (!r || r.encargada_id !== usuarioId) return { ok: false as const, error: "no_encontrado" as const };
    const [{ puede, fecha }] = await tx<{ puede: boolean; fecha: Date }[]>`
      select tiene_permiso(${usuarioId}, 'retiro.confirmar', ${r.sucursal_id}) as puede,
             ${datos.depositadoEn}::text::timestamp at time zone 'America/Mexico_City' as fecha`;
    if (!puede) return { ok: false as const, error: "sin_permiso" as const };
    if (r.monto_habilitado === null) return { ok: false as const, error: "en_pausa" as const };
    if (fecha.getTime() > Date.now() + 5 * 60_000 || fecha.getTime() < r.entregado_en.getTime() - 86_400_000) {
      return { ok: false as const, error: "fecha" as const };
    }
    const vigentes = await tx<{ id: string; importe: string }[]>`
      select d.id, d.importe::text from deposito_retiro d where d.retiro_id = ${r.id}
        and not exists (select 1 from deposito_retiro c where c.corrige_id = d.id)`;
    if (datos.corrige !== null && !vigentes.some((d) => d.id === datos.corrige)) return { ok: false as const, error: "corrige" as const };
    const otros = vigentes.filter((d) => d.id !== datos.corrige).reduce((n, d) => n + cent(d.importe), 0);
    if (otros + cent(datos.importe) > cent(r.monto_habilitado)) return { ok: false as const, error: "excede" as const };
    const [d] = await tx<{ id: string }[]>`
      insert into deposito_retiro (retiro_id, importe, depositado_en, referencia, corrige_id, motivo_correccion, registrado_por)
      values (${r.id}, ${datos.importe}, ${fecha}, ${referencia}, ${datos.corrige}, ${datos.corrige ? motivo : null}, ${usuarioId})
      returning id`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('retiro', ${r.id}, ${datos.corrige ? "corregir_deposito" : "depositar"},
                     ${tx.json({ deposito: d.id, importe: datos.importe, depositado_en: datos.depositadoEn, referencia, corrige: datos.corrige })},
                     ${datos.corrige ? motivo : null}, ${usuarioId})`;
    return { ok: true as const, depositoId: d.id };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Consulta por sucursal (Administración y Dirección) y revisión de discrepancias
// ---------------------------------------------------------------------------------------------------------------

export type NivelRetiro = "encargado" | "administracion" | "direccion";

async function accesoSucursal(sql: Tx | Sql, usuarioId: string, codigo: string) {
  if (!valido(codigo)) return null;
  const [s] = await sql<{ id: string; nombre: string; consulta: boolean; revisa: boolean; confirma: boolean }[]>`
    select id, nombre, tiene_permiso(${usuarioId}, 'retiro.consultar', id) as consulta,
           tiene_permiso(${usuarioId}, 'retiro.revisar', id) as revisa,
           tiene_permiso(${usuarioId}, 'retiro.confirmar', id) as confirma
    from sucursal where codigo = ${codigo}`;
  return s && (s.consulta || s.revisa || s.confirma) ? s : null;
}

/** ¿Le toca revisar este retiro? Tiene el perfil del nivel y no participó. */
const LE_TOCA = (sql: Tx | Sql, usuarioId: string) => sql`
  (r.discrepancia is not null and tiene_permiso(${usuarioId}, 'retiro.revisar', r.sucursal_id)
   and exists (select 1 from perfiles_en_sucursal(${usuarioId}, r.sucursal_id) p where p = nivel_revision_retiro(r.id))
   and not (${usuarioId}::uuid in (select participantes_retiro(r.id))))`;

export type ListaRetiros = {
  sucursal: string;
  consulta: boolean;
  retiros: ResumenRetiro[];
  /** Saldo bajo responsabilidad de cada Encargada de retiros en la sucursal (solo Administración y Dirección). */
  porEncargada: { encargada: string; sinDestino: string; enPausa: string; porAclarar: string; faltanteDireccion: string; avisos48: number }[];
};

/**
 * Retiros de la sucursal. Administración y Dirección (retiro.consultar) ven todos y el saldo; quien revisa sin
 * consultar (Encargado) ve solo las discrepancias que le toca revisar o que ya revisó.
 */
export async function listaRetiros(sql: Sql, usuarioId: string, codigo: string, ahora = new Date()): Promise<ListaRetiros | null> {
  const s = await accesoSucursal(sql, usuarioId, codigo);
  if (!s || !(s.consulta || s.revisa)) return null;
  const filas = s.consulta
    ? await FILAS(sql, sql`r.sucursal_id = ${s.id}`)
    : await FILAS(sql, sql`r.sucursal_id = ${s.id} and (${LE_TOCA(sql, usuarioId)}
        or exists (select 1 from retiro_revision x where x.retiro_id = r.id and x.revisada_por = ${usuarioId}))`);
  const retiros = filas.map((f) => resumen(f, ahora));
  const orden = (r: ResumenRetiro) => (r.estado === "por_revisar" ? 0 : r.estado === "recuento" || r.estado === "pendiente" ? 1 : 2);
  retiros.sort((a, b) => orden(a) - orden(b) || b.entregadoEn.getTime() - a.entregadoEn.getTime());
  const porEncargada: ListaRetiros["porEncargada"] = [];
  if (s.consulta) {
    for (const nombre of [...new Set(retiros.map((r) => r.encargada))].sort()) {
      const suyos = retiros.filter((r) => r.encargada === nombre);
      const suma = (k: keyof Saldo) => pesos(suyos.reduce((n, r) => n + cent(r.saldo[k] ?? 0), 0));
      porEncargada.push({
        encargada: nombre, sinDestino: suma("sinDestino"), enPausa: suma("enPausa"), porAclarar: suma("porAclarar"),
        faltanteDireccion: suma("faltanteDireccion"),
        avisos48: suyos.filter((r) => r.avisos.sinDestino?.masDe48 || r.avisos.revision?.masDe48).length,
      });
    }
  }
  return { sucursal: s.nombre, consulta: s.consulta, retiros, porEncargada };
}

/** Retiros por revisar que le tocan en la sucursal (para el botón). null si no consulta ni revisa retiros ahí. */
export async function retirosPorRevisar(sql: Sql, usuarioId: string, sucursalId: string): Promise<number | null> {
  const [r] = await sql<{ puede: boolean; n: number }[]>`
    select tiene_permiso(${usuarioId}, 'retiro.consultar', ${sucursalId}) or tiene_permiso(${usuarioId}, 'retiro.revisar', ${sucursalId}) as puede,
           (select count(*)::int from retiro r where r.sucursal_id = ${sucursalId} and r.estado = 'por_revisar' and ${LE_TOCA(sql, usuarioId)}) as n`;
  return r.puede ? r.n : null;
}

export type Deposito = {
  id: string; importe: string; depositadoEn: Date; referencia: string; registradoPor: string; en: Date;
  corrige: string | null; motivoCorreccion: string | null; vigente: boolean;
};

export type DetalleRetiro = {
  retiro: ResumenRetiro;
  /** null para Encargada de retiros mientras su conteo esté pendiente (conteo a ciegas). */
  registrado: { contado: string; cambio: string; importe: string; esperado: string | null } | null;
  conteos: { inicial: { importe: string; folioCoincide: boolean; en: Date } | null; recuento: { importe: string; con: string; en: Date } | null };
  motivo: string | null;
  reportadoEn: Date | null;
  habilitadoEn: Date | null;
  revision: {
    resultado: "aclarada" | "faltante_confirmado"; motivo: string; montoVerificado: string; folioVerificado: string | null;
    nivel: NivelRetiro; revisadaPor: string; en: Date;
  } | null;
  /** Folio que trae el sobre, si se reportó que no coincide. */
  folioEnSobre: string | null;
  /**
   * Diferencia contra el esperado registrada al retirar (solo la bolsa), y su vínculo con el cambio de turno: la parte
   * que sigue presente en la diferencia contra el esperado de la entrega (mismo caso, sin duplicarse).
   */
  diferenciaEsperado: {
    esperado: string; contado: string; importe: string; en: Date;
    cambioDeTurno: { entregaId: string; presente: string; en: Date } | null;
  } | null;
  participantes: string[];
  nivel: NivelRetiro;
  puedeRevisar: boolean;
  esSuyo: boolean;
  puedeDepositar: boolean;
  depositos: Deposito[];
  historial: { en: Date; que: string; cuenta: string }[];
};

const dinero = (v: string) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const firmado = (v: string) => `${Number(v) < 0 ? "−" : "+"}${dinero(String(Math.abs(Number(v))))}`;
const NOMBRE_LUGAR_CORTO: Record<TipoLugar, string> = { bolsa_visitas: "bolsa", cajon_mensualidades: "cajón" };

/**
 * Detalle de un retiro. Lo ven: Administración y Dirección (retiro.consultar), la Encargada de retiros que lo recibió
 * y, si hay discrepancia, quien le toca revisarla. Recepción no ve el detalle (ve el estado en su turno).
 */
export async function detalleRetiro(sql: Sql, usuarioId: string, codigo: string, retiroId: string, ahora = new Date()): Promise<DetalleRetiro | null> {
  if (!esIdentificadorValido(retiroId)) return null;
  const s = await accesoSucursal(sql, usuarioId, codigo);
  if (!s) return null;
  const [f] = await FILAS(sql, sql`r.id = ${retiroId} and r.sucursal_id = ${s.id}`);
  if (!f) return null;
  const [p] = await sql<{ toca: boolean; nivel: NivelRetiro; participo: boolean }[]>`
    select ${LE_TOCA(sql, usuarioId)} as toca, nivel_revision_retiro(r.id) as nivel,
           ${usuarioId}::uuid in (select participantes_retiro(r.id)) as participo
    from retiro r where r.id = ${f.id}`;
  const esSuyo = f.encargada_id === usuarioId && s.confirma;
  const ya = (await sql`select 1 from retiro_revision where retiro_id = ${f.id} and revisada_por = ${usuarioId}`).length > 0;
  if (!s.consulta && !esSuyo && !(s.revisa && (p.toca || ya))) return null;

  const [rv] = await sql<{ resultado: "aclarada" | "faltante_confirmado"; motivo: string; monto_verificado: string; nivel: NivelRetiro; revisada_por: string; en: Date }[]>`
    select x.resultado, x.motivo, x.monto_verificado::text, x.nivel, u.nombre as revisada_por, x.en
    from retiro_revision x join usuario u on u.id = x.revisada_por where x.retiro_id = ${f.id}`;
  const depositos = await sql<Deposito[]>`
    select d.id, d.importe::text, d.depositado_en as "depositadoEn", d.referencia, u.nombre as "registradoPor", d.en,
           d.corrige_id as corrige, d.motivo_correccion as "motivoCorreccion",
           not exists (select 1 from deposito_retiro c where c.corrige_id = d.id) as vigente
    from deposito_retiro d join usuario u on u.id = d.registrado_por where d.retiro_id = ${f.id} order by d.en`;
  const participantes = (await sql<{ nombre: string }[]>`
    select u.nombre from usuario u where u.id in (select participantes_retiro(${f.id})) order by u.nombre`).map((x) => x.nombre);
  const ciega = esSuyo && f.estado === "pendiente" && !s.consulta;
  const lugar = NOMBRE_LUGAR_CORTO[f.lugar];
  const r = resumen(f, ahora);

  const historial: DetalleRetiro["historial"] = [
    {
      en: f.entregado_en, cuenta: f.entregado_por,
      que: ciega
        ? `Retiro entregado en persona (${lugar}) · sobre ${f.folio}`
        : `Retiro entregado en persona (${lugar}): contado ${dinero(f.contado)} · deja para cambio ${dinero(f.cambio)} · se lleva ${dinero(f.importe)} · sobre ${f.folio}`,
    },
  ];
  if (!ciega && f.dif_esperado !== null) {
    historial.push({
      en: f.dif_en!, cuenta: "La plataforma, al entregar",
      que: `Diferencia contra el esperado al retirar (${lugar}): contado ${dinero(f.contado)} − esperado ${dinero(f.esperado!)} = ${firmado(f.dif_esperado)}. Se registra una vez y se vincula al cambio de turno si sigue presente`,
    });
  }
  if (!ciega && f.dif_vinculada_en) {
    historial.push({
      en: f.dif_vinculada_en, cuenta: "La plataforma, al confirmar el cambio de turno",
      que: cent(f.dif_presente!) === 0
        ? `Cambio de turno: la diferencia de ${firmado(f.dif_esperado!)} registrada al retirar ya no está presente`
        : `Cambio de turno: sigue presente ${firmado(f.dif_presente!)} de esta diferencia en la diferencia contra el esperado de la entrega (mismo caso, sin duplicarse)`,
    });
  }
  if (f.inicial !== null) {
    historial.push({
      en: f.inicial_en!, cuenta: f.encargada,
      que: `Conteo de Encargada de retiros: ${dinero(f.inicial)}${cent(f.inicial) === cent(f.importe) ? " (coincide)" : ` (registrado ${dinero(f.importe)}; ${firmado(pesos(cent(f.inicial) - cent(f.importe)))})`} · folio ${f.inicial_folio ? "coincide" : "no coincide"}`,
    });
  }
  if (f.recuento !== null) {
    historial.push({
      en: f.recuento_en!, cuenta: f.encargada,
      que: `Recuento en persona con ${f.recontado_con}: ${dinero(f.recuento)}${cent(f.recuento) === cent(f.importe) ? " (coincide)" : ` (${firmado(pesos(cent(f.recuento) - cent(f.importe)))})`}`,
    });
  }
  if (f.reportado_en) {
    historial.push({
      en: f.reportado_en, cuenta: f.encargada,
      que: `No coincide (${f.discrepancia === "folio" ? `folio: el sobre trae ${f.folio_en_sobre}` : "importe"}): por revisar; depósitos de este folio en pausa. Motivo: «${f.motivo}»`,
    });
  }
  if (rv) {
    historial.push({
      en: rv.en, cuenta: rv.revisada_por,
      que: `Revisión: ${rv.resultado === "aclarada" ? "Aclarada" : "Faltante confirmado"}${f.folio_verificado ? ` · folio verificado ${f.folio_verificado}` : ""} · monto verificado ${dinero(rv.monto_verificado)}${rv.resultado === "faltante_confirmado" ? ` · faltante ${dinero(pesos(cent(f.importe) - cent(rv.monto_verificado)))} pendiente para Dirección` : ""}. Motivo: «${rv.motivo}»`,
    });
  }
  if (f.habilitado_en) {
    historial.push({ en: f.habilitado_en, cuenta: "La plataforma", que: `Depósitos habilitados por ${dinero(f.monto_habilitado!)}` });
  }
  for (const d of depositos) {
    historial.push({
      en: d.en, cuenta: d.registradoPor,
      que: d.corrige
        ? `Corrección de depósito: ahora ${dinero(d.importe)} del ${fechaCorta(d.depositadoEn)} · referencia ${d.referencia} (reemplaza al anterior). Motivo: «${d.motivoCorreccion}»`
        : `Depósito bancario ${dinero(d.importe)} del ${fechaCorta(d.depositadoEn)} · referencia ${d.referencia}`,
    });
  }
  historial.sort((a, b) => a.en.getTime() - b.en.getTime());

  return {
    retiro: r,
    registrado: ciega ? null : { contado: f.contado, cambio: f.cambio, importe: f.importe, esperado: f.esperado },
    conteos: {
      inicial: f.inicial !== null ? { importe: f.inicial, folioCoincide: f.inicial_folio!, en: f.inicial_en! } : null,
      recuento: f.recuento !== null ? { importe: f.recuento, con: f.recontado_con!, en: f.recuento_en! } : null,
    },
    motivo: f.motivo, reportadoEn: f.reportado_en, habilitadoEn: f.habilitado_en,
    revision: rv ? {
      resultado: rv.resultado, motivo: rv.motivo, montoVerificado: rv.monto_verificado, folioVerificado: f.folio_verificado,
      nivel: rv.nivel, revisadaPor: rv.revisada_por, en: rv.en,
    } : null,
    folioEnSobre: f.folio_en_sobre,
    diferenciaEsperado: ciega || f.dif_esperado === null ? null : {
      esperado: f.esperado!, contado: f.contado, importe: f.dif_esperado, en: f.dif_en!,
      cambioDeTurno: f.dif_entrega_id ? { entregaId: f.dif_entrega_id, presente: f.dif_presente!, en: f.dif_vinculada_en! } : null,
    },
    participantes, nivel: p.nivel,
    puedeRevisar: f.estado === "por_revisar" && p.toca,
    esSuyo,
    puedeDepositar: esSuyo && f.monto_habilitado !== null && cent(r.saldo.sinDestino) > 0,
    depositos: [...depositos],
    historial,
  };
}

const fechaCorta = (d: Date) =>
  new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" }).format(d);

export type ErrorRevisionRetiro =
  | "no_encontrado" | "sin_permiso" | "participaste" | "otro_nivel" | "cambio" | "resultado" | "motivo" | "monto" | "folio_verificado"
  | "bloqueado_produccion";

/**
 * Revisión de una discrepancia: «Aclarada» o «Faltante confirmado», con motivo y monto verificado. Habilita los
 * depósitos del folio por el monto verificado. No cambia la salida ni los conteos.
 */
export async function revisarRetiro(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { retiroId: string; version: number; resultado: string; motivo: string; montoVerificado: string; folioVerificado?: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorRevisionRetiro }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!valido(codigo) || !esIdentificadorValido(datos.retiroId)) return { ok: false, error: "no_encontrado" };
  if (datos.resultado !== "aclarada" && datos.resultado !== "faltante_confirmado") return { ok: false, error: "resultado" };
  const motivo = limpiar(datos.motivo);
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  return sql.begin(async (tx) => {
    const [r] = await tx<{ id: string; sucursal_id: string; codigo: string; importe: string; estado: EstadoRetiro; version: number; folio: string; discrepancia: string | null }[]>`
      select r.id, r.sucursal_id, s.codigo, r.importe::text, r.estado, r.version, r.folio, r.discrepancia
      from retiro r join sucursal s on s.id = r.sucursal_id where r.id = ${datos.retiroId} for update of r`;
    if (!r || r.codigo !== codigo) return { ok: false as const, error: "no_encontrado" as const };
    const [p] = await tx<{ revisa: boolean; nivel: NivelRetiro; tiene_nivel: boolean; participo: boolean }[]>`
      select tiene_permiso(${usuarioId}, 'retiro.revisar', ${r.sucursal_id}) as revisa, nivel_revision_retiro(${r.id}) as nivel,
             exists (select 1 from perfiles_en_sucursal(${usuarioId}, ${r.sucursal_id}) x where x = nivel_revision_retiro(${r.id})) as tiene_nivel,
             ${usuarioId}::uuid in (select participantes_retiro(${r.id})) as participo`;
    if (!p.revisa) return { ok: false as const, error: "sin_permiso" as const };
    if (p.participo) return { ok: false as const, error: "participaste" as const };
    if (!p.tiene_nivel) return { ok: false as const, error: "otro_nivel" as const };
    if (r.estado !== "por_revisar" || r.version !== datos.version) return { ok: false as const, error: "cambio" as const };
    // Con el folio en duda, se habilita solo al verificar que el efectivo corresponde al sobre de este retiro.
    const folioVerificado = r.discrepancia === "folio" ? leerFolio(datos.folioVerificado ?? "") : null;
    if (r.discrepancia === "folio" && folioVerificado !== r.folio) return { ok: false as const, error: "folio_verificado" as const };
    if (datos.resultado === "faltante_confirmado" && cent(datos.montoVerificado) >= cent(r.importe)) {
      return { ok: false as const, error: "monto" as const };
    }
    await tx`insert into retiro_revision (retiro_id, resultado, motivo, monto_verificado, nivel, revisada_por, folio_verificado)
             values (${r.id}, ${datos.resultado}, ${motivo}, ${datos.montoVerificado}, ${p.nivel}, ${usuarioId}, ${folioVerificado})`;
    await tx`update retiro set estado = 'revisado', monto_habilitado = ${datos.montoVerificado}, habilitado_en = now(), version = version + 1
             where id = ${r.id}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
             values ('retiro', ${r.id}, 'revisar', ${tx.json({ resultado: datos.resultado, monto_verificado: datos.montoVerificado, nivel: p.nivel, folio_verificado: folioVerificado })},
                     ${motivo}, ${usuarioId})`;
    return { ok: true as const };
  });
}

export const NOMBRE_NIVEL_RETIRO: Record<NivelRetiro, string> = { encargado: "Encargado", administracion: "Administración", direccion: "Dirección" };

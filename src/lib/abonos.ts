import type postgres from "postgres";
import { DIAS_ABONO_ANTES, type TipoReferencia } from "@/lib/datos-visita";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Verificación manual de abonos de transferencias (bloque 4; solo datos ficticios). Indicado el 5 nov 2026.
 * Sirve para pruebas y excepciones; para operar con varias sucursales se propone la conciliación por lote
 * (docs/conciliacion-transferencias.md).
 *
 * - Verifican quienes tienen cobro.verificar_abono en la sucursal del cobro (hoy, Administración y Dirección).
 * - Nadie verifica un cobro que registró.
 * - «Abono verificado»: hay que confirmar que llegó el importe completo y capturar la fecha del abono.
 * - «No localizado»: con motivo. Un «No localizado» se puede verificar después si aparece.
 * - El estado cambia en el MISMO cobro (no se crea otro) y cada cambio queda en un historial que no se edita.
 * - El mismo abono no se usa en dos cobros: una referencia, de un tipo y con una fecha de abono, se verifica
 *   una sola vez (lo garantiza la base).
 */
type Sql = postgres.Sql;

export type TransferenciaPorVerificar = {
  cobroId: string;
  operacionId: string;
  version: number;
  registradaEn: Date;
  registradaPor: string;
  propia: boolean;
  personas: number;
  visitantes: string[];
  total: string;
  referencia: string;
  tipoReferencia: TipoReferencia;
  referenciaRepetidaConfirmada: boolean;
  estado: "pendiente_abono" | "no_localizado" | "abono_verificado";
  motivoNoLocalizado: string | null;
  abonoFecha: string | null;
  verificadoPor: string | null;
  /** Fecha de la operación en la zona de la sucursal (AAAA-MM-DD), para validar la fecha del abono. */
  fechaOperacion: string;
};

export type BandejaTransferencias = {
  sucursal: { id: string; codigo: string; nombre: string };
  hoy: string;
  porVerificar: TransferenciaPorVerificar[];
  verificadasRecientes: TransferenciaPorVerificar[];
};

async function sucursalVerificable(sql: Sql | postgres.TransactionSql, usuarioId: string, codigo: string) {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  const [s] = await sql<{ id: string; codigo: string; nombre: string; hoy: string }[]>`
    select id, codigo, nombre, (now() at time zone zona_horaria)::date::text as hoy from sucursal
    where codigo = ${codigo} and tiene_permiso(${usuarioId}, 'cobro.verificar_abono', id)`;
  return s ?? null;
}

export async function puedeVerificarAbonos(sql: Sql, usuarioId: string, codigo: string) {
  return (await sucursalVerificable(sql, usuarioId, codigo)) !== null;
}

/** Transferencias de la sucursal pendientes o no localizadas, y las últimas verificadas. null sin permiso. */
export async function bandejaTransferencias(sql: Sql, usuarioId: string, codigo: string): Promise<BandejaTransferencias | null> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const s = await sucursalVerificable(tx, usuarioId, codigo);
    if (!s) return null;
    const filas = await tx<TransferenciaPorVerificar[]>`
      select c.id as "cobroId", o.id as "operacionId", c.version, o.registrada_en as "registradaEn", u.nombre as "registradaPor",
             o.registrada_por = ${usuarioId} as propia, c.importe::text as total, c.referencia, c.tipo_referencia as "tipoReferencia",
             c.referencia_repetida_confirmada as "referenciaRepetidaConfirmada", c.estado,
             c.abono_fecha::text as "abonoFecha", uv.nombre as "verificadoPor",
             (o.registrada_en at time zone s.zona_horaria)::date::text as "fechaOperacion",
             (select h.motivo from cobro_cambio_estado h where h.cobro_id = c.id and h.a = 'no_localizado' order by h.en desc, h.id desc limit 1)
               as "motivoNoLocalizado",
             (select count(*)::int from pase_visita p where p.operacion_id = o.id) as personas,
             (select array_agg(v.nombre order by p.orden) from pase_visita p join visitante v on v.id = p.visitante_id where p.operacion_id = o.id)
               as visitantes
      from cobro_visita c
      join operacion_visita o on o.id = c.operacion_id
      join sucursal s on s.id = o.sucursal_id
      join usuario u on u.id = o.registrada_por
      left join usuario uv on uv.id = c.verificado_por
      where o.sucursal_id = ${s.id} and c.forma_pago = 'transferencia'
        and (c.estado in ('pendiente_abono', 'no_localizado') or c.verificado_en >= now() - interval '7 days')
      order by o.registrada_en`;
    return {
      sucursal: { id: s.id, codigo: s.codigo, nombre: s.nombre },
      hoy: s.hoy,
      porVerificar: filas.filter((f) => f.estado !== "abono_verificado"),
      verificadasRecientes: filas.filter((f) => f.estado === "abono_verificado").reverse(),
    };
  });
}

export type ErrorAbono =
  | "no_encontrada"
  | "propia"
  | "cambio"
  | "importe_incompleto"
  | "fecha_invalida"
  | "abono_usado"
  | "motivo"
  | "bloqueado_produccion";

export type ResultadoAbono = { ok: true } | { ok: false; error: ErrorAbono };

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Mueve el cobro de `de` a `a`, si sigue en la versión que vio quien verifica. */
async function cambiarEstado(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  cobroId: string,
  version: number,
  de: ("pendiente_abono" | "no_localizado")[],
  hacer: (tx: postgres.TransactionSql, c: { importe: string; fechaOperacion: string; hoy: string; sucursalId: string; estado: string }) => Promise<ResultadoAbono>,
  { entorno }: { entorno: Entorno },
): Promise<ResultadoAbono> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(cobroId)) return { ok: false, error: "no_encontrada" };
  try {
    return await sql.begin(async (tx): Promise<ResultadoAbono> => {
      const s = await sucursalVerificable(tx, usuarioId, codigo);
      if (!s) return { ok: false, error: "no_encontrada" };
      const [c] = await tx<{ importe: string; estado: string; version: number; registrada_por: string; fecha_operacion: string }[]>`
        select c.importe::text as importe, c.estado, c.version, o.registrada_por,
               (o.registrada_en at time zone x.zona_horaria)::date::text as fecha_operacion
        from cobro_visita c
        join operacion_visita o on o.id = c.operacion_id
        join sucursal x on x.id = o.sucursal_id
        where c.id = ${cobroId} and o.sucursal_id = ${s.id} and c.forma_pago = 'transferencia'
        for update of c`;
      if (!c) return { ok: false, error: "no_encontrada" };
      if (c.registrada_por === usuarioId) return { ok: false, error: "propia" };
      if (c.version !== version || !de.includes(c.estado as "pendiente_abono")) return { ok: false, error: "cambio" };
      return hacer(tx, { importe: c.importe, fechaOperacion: c.fecha_operacion, hoy: s.hoy, sucursalId: s.id, estado: c.estado });
    });
  } catch (error) {
    // Respaldo: la base no deja verificar dos veces el mismo abono (misma referencia, tipo y fecha).
    if ((error as { code?: string; constraint_name?: string })?.constraint_name === "cobro_abono_unico") return { ok: false, error: "abono_usado" };
    throw error;
  }
}

const sumarDias = (fecha: string, dias: number) => {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/**
 * «Abono verificado». `importe` es lo que llegó según el estado de cuenta: debe ser el importe completo.
 * `fecha` (AAAA-MM-DD) no puede ser futura ni de más de DIAS_ABONO_ANTES días antes de la operación (provisional).
 */
export async function verificarAbono(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  cobroId: string,
  datos: { version: number; fecha: string; importe: string },
  opciones: { entorno: Entorno },
): Promise<ResultadoAbono> {
  return cambiarEstado(sql, usuarioId, codigo, cobroId, datos.version, ["pendiente_abono", "no_localizado"], async (tx, c) => {
    if (Math.round(Number(datos.importe) * 100) !== Math.round(Number(c.importe) * 100)) return { ok: false, error: "importe_incompleto" };
    const f = datos.fecha;
    const valida = FECHA.test(f) && !Number.isNaN(new Date(`${f}T00:00:00Z`).getTime()) && new Date(`${f}T00:00:00Z`).toISOString().startsWith(f);
    if (!valida || f > c.hoy || f < sumarDias(c.fechaOperacion, -DIAS_ABONO_ANTES)) return { ok: false, error: "fecha_invalida" };

    // El mismo abono no se usa dos veces: se avisa antes de llegar al índice único de la base.
    const [usado] = await tx`
      select 1 from cobro_visita x, cobro_visita c
      where c.id = ${cobroId} and x.id <> c.id and x.estado = 'abono_verificado'
        and x.tipo_referencia = c.tipo_referencia and x.referencia = c.referencia and x.abono_fecha = ${f}::date`;
    if (usado) return { ok: false, error: "abono_usado" };

    await tx`
      update cobro_visita set estado = 'abono_verificado', abono_fecha = ${f}::date, abono_importe = importe,
             verificado_por = ${usuarioId}, verificado_en = now(), version = version + 1
      where id = ${cobroId}`;
    await tx`
      insert into cobro_cambio_estado (cobro_id, de, a, abono_fecha, usuario_id, sucursal_id)
      values (${cobroId}, ${c.estado}, 'abono_verificado', ${f}::date, ${usuarioId}, ${c.sucursalId})`;
    return { ok: true };
  }, opciones);
}

/** «No localizado», con motivo (5 a 300 caracteres). Solo desde «Pendiente de verificar abono». */
export async function marcarNoLocalizado(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  cobroId: string,
  datos: { version: number; motivo: string },
  opciones: { entorno: Entorno },
): Promise<ResultadoAbono> {
  const motivo = datos.motivo.trim().replace(/\s+/g, " ");
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  return cambiarEstado(sql, usuarioId, codigo, cobroId, datos.version, ["pendiente_abono"], async (tx, c) => {
    await tx`update cobro_visita set estado = 'no_localizado', version = version + 1 where id = ${cobroId}`;
    await tx`
      insert into cobro_cambio_estado (cobro_id, de, a, motivo, usuario_id, sucursal_id)
      values (${cobroId}, ${c.estado}, 'no_localizado', ${motivo}, ${usuarioId}, ${c.sucursalId})`;
    return { ok: true };
  }, opciones);
}

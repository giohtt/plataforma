import type postgres from "postgres";

/**
 * Prepara directamente en los datos de prueba un duplicado de un cobro en efectivo (misma sucursal, turno, personas,
 * importe y entrada a la bolsa), como el que pudo haber quedado antes de que el servidor rechazara un segundo cobro
 * a quien ya tiene pase de hoy. Solo para probar la cancelación del duplicado.
 */
export async function duplicarCobro(sql: postgres.Sql, operacionId: string): Promise<string> {
  return sql.begin(async (tx) => {
    const [o] = await tx<{ id: string }[]>`
      insert into operacion_visita (clave, sucursal_id, turno_id, registrada_por, total)
      select gen_random_uuid(), sucursal_id, turno_id, registrada_por, total from operacion_visita where id = ${operacionId}
      returning id`;
    const [c] = await tx<{ id: string; original: string }[]>`
      insert into cobro_visita (operacion_id, forma_pago, estado, importe, recibido, cambio)
      select ${o.id}, forma_pago, estado, importe, recibido, cambio from cobro_visita
      where operacion_id = ${operacionId} and forma_pago = 'efectivo' and estado = 'confirmado'
      returning id, (select id from cobro_visita where operacion_id = ${operacionId}) as original`;
    if (!c) throw new Error("Solo se duplica un cobro en efectivo confirmado");
    await tx`
      insert into pase_visita (operacion_id, visitante_id, sucursal_id, tarifa, descuento, total, orden)
      select ${o.id}, visitante_id, sucursal_id, tarifa, descuento, total, orden from pase_visita where operacion_id = ${operacionId}`;
    await tx`
      insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, cobro_id, responsable_id, registrado_por)
      select lugar_id, turno_id, tipo, importe, ${c.id}, responsable_id, registrado_por from movimiento_efectivo
      where cobro_id = ${c.original} and tipo = 'entrada_cobro_visita'`;
    return o.id;
  });
}

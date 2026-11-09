import type { CobroDelTurno } from "@/lib/visitas";

/** Suma de un grupo de cobros: cantidad, visitas e importe (en texto con dos decimales, sumado en centavos). */
export type Grupo = { cobros: number; visitas: number; importe: string };

/**
 * Ventas de visitas de un turno. Indicado el 9 nov 2026:
 *   - el total confirmado suma efectivo y tarjeta vigentes, y solo las transferencias con abono verificado;
 *   - las transferencias pendientes de verificar y las no localizadas se muestran aparte y no suman;
 *   - los cobros cancelados por duplicado no cuentan.
 * Si una transferencia no localizada se verifica después, es el mismo cobro: pasa de un grupo al otro y suma una vez.
 * No cambia la bolsa: el efectivo esperado se calcula con los movimientos de efectivo.
 */
export type VentasTurno = {
  efectivo: Grupo;
  tarjeta: Grupo;
  transferenciaVerificada: Grupo;
  totalConfirmado: Grupo;
  transferenciaPendiente: Grupo;
  transferenciaNoLocalizada: Grupo;
  cancelados: Grupo;
};

function grupo(lista: CobroDelTurno[]): Grupo {
  const centavos = lista.reduce((s, c) => s + Math.round(Number(c.total) * 100), 0);
  return { cobros: lista.length, visitas: lista.reduce((s, c) => s + c.personas, 0), importe: (centavos / 100).toFixed(2) };
}

export function ventasDelTurno(cobros: CobroDelTurno[]): VentasTurno {
  const de = (medio: CobroDelTurno["formaPago"], estados: CobroDelTurno["estado"][]) =>
    cobros.filter((c) => c.formaPago === medio && estados.includes(c.estado));
  const efectivo = de("efectivo", ["confirmado"]);
  const tarjeta = de("tarjeta", ["confirmado_operativamente"]);
  const verificadas = de("transferencia", ["abono_verificado"]);
  return {
    efectivo: grupo(efectivo),
    tarjeta: grupo(tarjeta),
    transferenciaVerificada: grupo(verificadas),
    totalConfirmado: grupo([...efectivo, ...tarjeta, ...verificadas]),
    transferenciaPendiente: grupo(de("transferencia", ["pendiente_abono"])),
    transferenciaNoLocalizada: grupo(de("transferencia", ["no_localizado"])),
    cancelados: grupo(cobros.filter((c) => c.estado === "cancelado")),
  };
}

/** Textos de una diferencia de efectivo. Sin acceso a la base. */
export type TipoDiferencia = "contra_esperado" | "entre_personas";

/** «Faltante contra el esperado», «Sobrante en la entrega»… Negativo es faltante; positivo, sobrante. */
export function etiquetaDiferencia(tipo: TipoDiferencia, importe: string): string {
  const clase = Number(importe) < 0 ? "Faltante" : "Sobrante";
  return `${clase} ${tipo === "contra_esperado" ? "contra el esperado" : "en la entrega"}`;
}

export const NOMBRE_LUGAR = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" } as const;

export const ESTADO_DIFERENCIA = {
  por_revisar: "Por revisar",
  aclarada: "Aclarada",
  faltante_confirmado: "Faltante confirmado · pendiente para Dirección",
  sobrante_confirmado: "Sobrante confirmado · pendiente para Dirección",
  correccion_pendiente: "Resuelta por Dirección · corrección pendiente",
  resuelta: "Resuelta por Dirección · cerrada",
} as const;

export const NOMBRE_DECISION = {
  absorbe_sucursal: "Lo absorbe la sucursal",
  queda_en_bolsa: "Se queda en la bolsa",
  origen_identificado: "Origen identificado",
} as const;

/** «Pendiente hace 3 h» o «hace 2 días 5 h». */
export function tiempoPendiente(desde: Date, ahora = new Date()): { texto: string; masDe48: boolean } {
  const horas = Math.max(0, Math.floor((ahora.getTime() - new Date(desde).getTime()) / 3_600_000));
  const dias = Math.floor(horas / 24);
  const texto = horas < 1 ? "menos de 1 h" : dias ? `${dias} ${dias === 1 ? "día" : "días"}${horas % 24 ? ` ${horas % 24} h` : ""}` : `${horas} h`;
  return { texto, masDe48: horas >= 48 };
}
export type EstadoDiferencia = keyof typeof ESTADO_DIFERENCIA;

/** Opciones de revisión según el signo: faltante → Aclarada o Faltante confirmado; sobrante → Aclarada o Sobrante confirmado. */
export function opcionesRevision(importe: string) {
  const faltante = Number(importe) < 0;
  return [
    { valor: "aclarada", titulo: "Aclarada", ayuda: faltante ? "Se sabe qué pasó y queda documentado." : "Se documentó el origen del excedente." },
    faltante
      ? { valor: "faltante_confirmado", titulo: "Faltante confirmado", ayuda: "El dinero falta. Queda pendiente para Dirección, que decide qué hacer." }
      : { valor: "sobrante_confirmado", titulo: "Sobrante confirmado", ayuda: "El excedente sigue pendiente de resolución por Dirección." },
  ] as const;
}

export const NOMBRE_NIVEL = { encargado: "Encargado", administracion: "Administración", direccion: "Dirección" } as const;

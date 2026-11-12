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
} as const;
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

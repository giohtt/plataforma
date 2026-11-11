/** Textos de una diferencia de efectivo. Sin acceso a la base. */
export type TipoDiferencia = "contra_esperado" | "entre_personas";

/** «Faltante contra el esperado», «Sobrante en la entrega»… Negativo es faltante; positivo, sobrante. */
export function etiquetaDiferencia(tipo: TipoDiferencia, importe: string): string {
  const clase = Number(importe) < 0 ? "Faltante" : "Sobrante";
  return `${clase} ${tipo === "contra_esperado" ? "contra el esperado" : "en la entrega"}`;
}

export const NOMBRE_LUGAR = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" } as const;

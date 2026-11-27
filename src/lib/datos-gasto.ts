/** Textos y tipos de gastos que también usa el navegador (sin acceso a la base). */

/** Por qué una persona no puede decidir un gasto (impedimento_decision_gasto). */
export type Impedimento = "ya_decidido" | "propio" | "de_direccion" | "sin_facultad" | "limite" | "diario";
export type EstadoGasto = "por_autorizar" | "autorizado" | "rechazado";
export const NOMBRE_ESTADO_GASTO: Record<EstadoGasto, string> = {
  por_autorizar: "Por autorizar", autorizado: "Autorizado", rechazado: "Rechazado",
};

export type OrigenPago = "bolsa_visitas" | "cajon_mensualidades" | "transferencia" | "tarjeta" | "dinero_personal";
export const NOMBRE_ORIGEN: Record<OrigenPago, string> = {
  bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades", transferencia: "Transferencia",
  tarjeta: "Tarjeta", dinero_personal: "Dinero personal (pendiente de reembolso)",
};
export type Comprobacion = "por_comprobar" | "comprobado" | "sin_comprobante";
export const NOMBRE_COMPROBACION: Record<Comprobacion, string> = {
  por_comprobar: "Por comprobar", comprobado: "Comprobado", sin_comprobante: "Sin comprobante · por revisar · Dirección",
};

/** Texto para quien no puede decidir un gasto, y a quién le llega. */
export const TEXTO_IMPEDIMENTO: Record<Impedimento, string> = {
  ya_decidido: "Esta versión ya se decidió.",
  propio: "Tú solicitaste este gasto: lo decide otra persona con facultad suficiente.",
  de_direccion: "Lo solicitó Dirección: solo lo decide Dirección.",
  sin_facultad: "No tienes facultad vigente para autorizar gastos aquí (en la sucursal beneficiada y, si es otra, en la que paga).",
  limite: "La compra pasa tu límite por gasto: la decide quien tenga facultad suficiente (Gestión administrativa o Dirección).",
  diario: "Con este gasto pasarías tu acumulado de hoy: lo decide quien tenga facultad suficiente (Gestión administrativa o Dirección).",
};

import { dinero, nombreLugar, type CajaSucursal } from "@/lib/reporte-caja";
import type { TipoLugar } from "@/lib/turnos";

/**
 * «Caja y depósitos» (estructura aprobada el 25 nov 2026; solo datos ficticios). Lo que la pantalla, el Excel y el PDF
 * muestran igual, calculado a partir del reporte al corte (sin consultas: no cambia permisos ni reglas):
 *   - cuatro cifras de custodia (en la sucursal, sobres por recoger, pendiente de confirmar, por depositar);
 *   - «Total registrado al corte» si todo se conoce; «Subtotal visible al corte» si hay importes conocidos y faltan
 *     datos u ocultos (y se dice qué falta); «Sin datos» si no hay ningún importe conocido. Un cero registrado es $0.00;
 *   - lo depositado en el periodo, aparte (ya salió de la custodia);
 *   - «Requiere atención», por depositar por persona y antigüedad (rangos sin traslapes) y la tabla por folio.
 */
const cent = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Math.round(Number(v) * 100));
const pesos = (c: number) => (c / 100).toFixed(2);
const DIA = 86_400_000;

/** Días completos entre dos momentos (0 el mismo día). */
export const diasEntre = (desde: Date, corte: Date) => Math.max(0, Math.floor((corte.getTime() - desde.getTime()) / DIA));

/**
 * Rangos de antigüedad, por días completos y sin traslapes: 0 a 2 días (menos de 3 días completos), 3 a 7 días y más de 7
 * días (8 o más). Se cuentan desde que se confirmó.
 */
export const RANGOS = ["0 a 2 días", "3 a 7 días", "Más de 7 días"] as const;
export const NOTA_RANGOS = "Días completos desde que se confirmó: 0 a 2 (menos de 3 días), 3 a 7, y más de 7 (8 días o más).";
export const rango = (dias: number) => (dias <= 2 ? 0 : dias <= 7 ? 1 : 2);

export const INCOMPLETO = "Incompleto: el cajón cuenta con su último conteo; faltan las mensualidades de Open Desk.";

export type Cifra = {
  /** null: no hay ningún importe conocido (sin datos, o todo oculto). */
  importe: string | null;
  n: number;
  ocultos: number;
  /** Texto corto bajo la cifra. */
  nota: string;
};
export type Total = {
  tipo: "total" | "subtotal" | "sin_datos";
  etiqueta: string;
  importe: string | null;
  /** Qué falta para que sea el total (vacío si es el total). */
  faltan: string[];
  nota: string;
};
export type Atencion = {
  clave: "atrasados" | "por_revisar" | "pendiente_resolucion" | "correcciones" | "investigar" | "entradas"; texto: string; n: number; importe: string; nota: string;
  /** Diferencias: cada caso con su importe (no se suman entre sí: mezclan faltantes y sobrantes). */
  casos?: { texto: string; importe: string }[];
};
export type FilaFolio = {
  sucursal: string; codigo: string;
  folio: string;
  etapa: "1" | "2" | "3" | "4" | "investigar" | "entrada";
  etapaTexto: string;
  quien: string;
  desde: Date | null;
  dias: number | null;
  /** Solo para lo que ya está bajo la responsabilidad de alguien (etapas 2 a 4 y aparte). */
  rango: number | null;
  anterior: boolean;
  importe: string | null;
  estadoImporte: string;
  /** Se suma al total (etapas 1 a 4); lo de «aparte» no. */
  suma: boolean;
  atrasado: boolean;
  enlace: { tipo: string; id: string };
};
export type PorPersona = { persona: string; n: number; rangos: [number, number, number]; total: number; atrasados: number };
export type ResumenCaja = {
  enSucursal: Cifra; sobres: Cifra; pendiente: Cifra; porDepositar: Cifra; total: Total;
  depositado: { importe: string; n: number };
  atencion: Atencion[];
  porPersona: PorPersona[];
  folios: FilaFolio[];
  /** Lugares sin datos (por nombre) e importes ocultos. */
  lugaresSinDatos: TipoLugar[];
  ocultos: number;
  /** Hay algún importe conocido (un lugar con conteo o algún importe visible en las etapas 2 a 4). */
  conocido: boolean;
};

/** «faltan …»: qué impide que sea el total. */
export function textoFaltan(lugares: TipoLugar[] | number, ocultos: number): string[] {
  const f: string[] = [];
  if (typeof lugares === "number") {
    if (lugares) f.push(`${lugares} ${lugares === 1 ? "lugar" : "lugares"} sin datos (sin conteos registrados)`);
  } else if (lugares.length === 2) f.push("los datos de bolsa y cajón (sin conteos registrados)");
  else if (lugares.length === 1) f.push(`los datos ${lugares[0] === "bolsa_visitas" ? "de la bolsa de visitas" : "del cajón de mensualidades"} (sin conteos registrados)`);
  if (ocultos) f.push(`${ocultos} ${ocultos === 1 ? "importe oculto" : "importes ocultos"} (sin contar: conteo a ciegas)`);
  return f;
}

/** La limitación que siempre acompaña al total, con la fecha del último conteo del cajón si la hay. */
export function limitacion(ultimoConteoCajon: Date | null) {
  return ultimoConteoCajon
    ? `Incompleto: faltan las mensualidades de Open Desk; el cajón cuenta con su último conteo (${fechaHora(ultimoConteoCajon)}).`
    : "Incompleto: faltan las mensualidades de Open Desk.";
}
const fechaHora = (d: Date) => new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);

export function armarTotal(visible: string, conocido: boolean, faltan: string[], incompleto = limitacion(null)): Total {
  const lista = faltan.join(" y ");
  if (!conocido) {
    return { tipo: "sin_datos", etiqueta: "Total al corte", importe: null, faltan,
             nota: `Sin datos: no hay ningún importe conocido${lista ? ` (faltan ${lista})` : ""}. No es cero.` };
  }
  if (faltan.length) {
    return { tipo: "subtotal", etiqueta: "Subtotal visible al corte", importe: visible, faltan,
             nota: `No es el total: faltan ${lista}. ${incompleto}` };
  }
  return { tipo: "total", etiqueta: "Total registrado al corte", importe: visible, faltan, nota: incompleto };
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

export function resumirCaja(c: CajaSucursal, corte: Date): ResumenCaja {
  // 1. En la sucursal.
  const conDatos = c.lugares.filter((l) => l.estado !== "sin_datos");
  const lugaresSinDatos = c.lugares.filter((l) => l.estado === "sin_datos").map((l) => l.tipo);
  const cajon = c.lugares.find((l) => l.tipo === "cajon_mensualidades" && l.base);
  const enSucursal: Cifra = {
    importe: conDatos.length ? pesos(conDatos.reduce((n, l) => n + cent(l.importe), 0)) : null, n: c.lugares.length, ocultos: 0,
    nota: !conDatos.length ? "Bolsa y cajón sin turnos ni conteos registrados. No es cero."
      : c.lugares.map((l) => `${l.tipo === "bolsa_visitas" ? "Bolsa" : "Cajón"} ${l.importe === null ? "sin datos" : dinero(l.importe)}`).join(" · "),
  };
  // 2. Sobres por recoger: sin registros al corte, $0.00 y «0 sobres registrados».
  const sobresVisibles = c.sobres.filter((s) => s.anotado !== null);
  const sobresOcultos = c.sobres.length - sobresVisibles.length;
  const sobres: Cifra = {
    importe: c.sobres.length && !sobresVisibles.length ? null : pesos(sobresVisibles.reduce((n, s) => n + cent(s.anotado), 0)),
    n: c.sobres.length, ocultos: sobresOcultos,
    nota: !c.sobres.length ? "0 sobres registrados"
      : `${plural(c.sobres.length, "sobre", "sobres")}${sobresOcultos ? ` · ${sobresOcultos === c.sobres.length ? "importe oculto hasta contarlos" : `${sobresOcultos} con importe oculto`}` : ""}`,
  };
  // 3. Entregado, pendiente de confirmar.
  const pendVisibles = c.pendientes.filter((p) => p.importe !== null);
  const pendOcultos = c.pendientes.length - pendVisibles.length;
  const pendiente: Cifra = {
    importe: c.pendientes.length && !pendVisibles.length ? null : pesos(pendVisibles.reduce((n, p) => n + cent(p.importe), 0)),
    n: c.pendientes.length, ocultos: pendOcultos,
    nota: !c.pendientes.length ? "Nadie tiene entregas sin confirmar"
      : `${plural(c.pendientes.length, "entrega", "entregas")}${pendOcultos ? ` · ${pendOcultos} con importe oculto` : ""}`,
  };
  // 4. Confirmado, por depositar.
  const personas = [...new Set(c.confirmados.map((x) => (x.clase === "recoleccion" ? x.recibe : x.encargada)))];
  const porDepositar: Cifra = {
    importe: pesos(c.confirmados.reduce((n, x) => n + cent(x.saldo), 0)), n: c.confirmados.length, ocultos: 0,
    nota: !c.confirmados.length ? "Nada por depositar" : `${personas.join(", ")} · ${plural(c.confirmados.length, "saldo", "saldos")}`,
  };

  const conocido = conDatos.length > 0 || sobresVisibles.length > 0 || pendVisibles.length > 0 || c.confirmados.length > 0;
  const total = armarTotal(c.visible, conocido, textoFaltan(lugaresSinDatos, c.ocultos), limitacion(cajon?.base?.en ?? null));

  // Requiere atención (aparte: no se suma).
  const atrasados = c.confirmados.filter((x) => x.clase === "retiro" && x.aviso);
  const porRevisar = c.diferencias.filter((d) => d.etapa === "por_revisar");
  const porResolver = c.diferencias.filter((d) => d.etapa === "pendiente_resolucion");
  const correcciones = c.diferencias.filter((d) => d.etapa === "correccion_pendiente");
  const casos = (l: CajaSucursal["diferencias"]) => l.map((d) => ({ texto: textoCaso(d), importe: d.importe }));
  const suma = (l: { importe: string }[]) => pesos(l.reduce((n, x) => n + cent(x.importe), 0));
  const atencion: Atencion[] = [
    { clave: "atrasados", texto: "Retiros con 48 horas o más sin depositar", n: atrasados.length, importe: pesos(atrasados.reduce((n, x) => n + cent(x.saldo), 0)),
      nota: "Ya están en «Por depositar»: no se suman otra vez" },
    { clave: "por_revisar", texto: "Por revisar", n: porRevisar.length, importe: suma(porRevisar), nota: "Nadie las ha revisado", casos: casos(porRevisar) },
    { clave: "pendiente_resolucion", texto: "Pendiente de resolución", n: porResolver.length, importe: suma(porResolver),
      nota: "Confirmadas; falta la decisión de Dirección", casos: casos(porResolver) },
    { clave: "correcciones", texto: "Corrección pendiente", n: correcciones.length, importe: suma(correcciones),
      nota: "Ya tienen decisión; falta completarla", casos: casos(correcciones) },
    { clave: "investigar", texto: "Sobres por investigar", n: c.investigar.length, importe: pesos(c.investigar.reduce((n, x) => n + cent(x.anotado), 0)),
      nota: "Importe anotado; aparte, no se suma" },
    { clave: "entradas", texto: "Entradas al fondo sin confirmar", n: c.entradas.length, importe: suma(c.entradas),
      nota: "Aún las tiene quien las entrega; no se suman" },
  ];

  // Por depositar por persona y antigüedad.
  const mapa = new Map<string, PorPersona>();
  for (const x of c.confirmados) {
    const persona = x.clase === "recoleccion" ? x.recibe : x.encargada;
    const p = mapa.get(persona) ?? { persona, n: 0, rangos: [0, 0, 0], total: 0, atrasados: 0 };
    p.n += 1;
    p.rangos[rango(diasEntre(x.desde, corte))] += cent(x.saldo);
    p.total += cent(x.saldo);
    if (x.clase === "retiro" && x.aviso) p.atrasados += 1;
    mapa.set(persona, p);
  }

  // Por folio: cada importe al corte, en una sola etapa; aparte, lo que no se suma.
  const base = { sucursal: c.nombre, codigo: c.codigo };
  const folios: FilaFolio[] = [];
  for (const l of c.lugares) {
    folios.push({
      ...base, folio: nombreLugar(l.tipo), etapa: "1", etapaTexto: "En la sucursal",
      quien: l.estado === "turno" ? (l.responsable ?? "Turno abierto") : l.estado === "cerrado" ? "Guardado al cerrar" : "—",
      desde: l.base?.en ?? null, dias: l.base ? diasEntre(l.base.en, corte) : null, rango: null, anterior: false, importe: l.importe,
      estadoImporte: l.estado === "sin_datos" ? "Sin datos" : l.estado === "cerrado" ? "Contado al cerrar"
        : l.tipo === "bolsa_visitas" ? "Esperado" : "Último conteo (incompleto)",
      suma: true, atrasado: false, enlace: { tipo: "lugar", id: l.lugarId },
    });
  }
  for (const s of c.sobres) {
    const dias = diasEntre(s.guardadoEn, corte);
    folios.push({
      ...base, folio: s.folio, etapa: "2", etapaTexto: s.donde === "por_devolver" ? "Sobre por devolver a la caja" : "Sobre por recoger",
      quien: s.donde === "buzon" ? "En el buzón" : s.donde === "caja" ? "En la caja con llave" : "Por devolver a la caja",
      desde: s.guardadoEn, dias, rango: rango(dias), anterior: s.anterior, importe: s.anotado, estadoImporte: s.oculto ? "Oculto: sin contar" : "Anotado",
      suma: true, atrasado: false, enlace: { tipo: "sobre", id: s.id },
    });
  }
  for (const p of c.pendientes) {
    const dias = diasEntre(p.en, corte);
    folios.push({
      ...base, folio: p.clase === "retiro" ? p.folio : p.folios.join(", "), etapa: "3", etapaTexto: "Entregado, pendiente de confirmar",
      quien: `${p.recibe} (por confirmar)`, desde: p.en, dias, rango: rango(dias), anterior: p.anterior, importe: p.importe,
      estadoImporte: p.oculto ? "Oculto: sin contar" : p.clase === "retiro" ? "Registrado" : "Anotado",
      suma: true, atrasado: false, enlace: { tipo: p.clase === "retiro" ? "retiro" : "recoleccion", id: p.id },
    });
  }
  for (const x of c.confirmados) {
    const dias = diasEntre(x.desde, corte);
    const o = c.origenes.find((y) => y.clase === (x.clase === "recoleccion" ? "recoleccion" : "retiro") && y.id === x.id);
    folios.push({
      ...base, folio: x.clase === "recoleccion" ? (o?.folios.join(", ") || "Recolección") : x.folio,
      etapa: "4", etapaTexto: x.clase === "retiro_pausa" ? "Confirmado · en pausa por revisión" : "Confirmado, por depositar",
      quien: x.clase === "recoleccion" ? x.recibe : x.encargada, desde: x.desde, dias, rango: rango(dias), anterior: x.anterior, importe: x.saldo,
      estadoImporte: "Contado", suma: true, atrasado: x.clase === "retiro" && x.aviso,
      enlace: { tipo: x.clase === "recoleccion" ? "recoleccion" : "retiro", id: x.id },
    });
  }
  for (const x of c.investigar) {
    const dias = diasEntre(x.desde, corte);
    folios.push({
      ...base, folio: x.folio, etapa: "investigar", etapaTexto: "Aparte · sobre por investigar", quien: "Sin responsable asignado",
      desde: x.desde, dias, rango: rango(dias), anterior: x.anterior, importe: x.anotado, estadoImporte: "Anotado (no se suma)",
      suma: false, atrasado: false, enlace: { tipo: "sobre", id: x.sobreId },
    });
  }
  for (const x of c.entradas) {
    const dias = diasEntre(x.en, corte);
    folios.push({
      ...base, folio: `${x.tipo === "aumento" ? "Aumento del fondo" : "Reposición"} · ${nombreLugar(x.lugar)}`, etapa: "entrada",
      etapaTexto: "Aparte · entrada al fondo sin confirmar", quien: `${x.entrega} (la entrega)`, desde: x.en, dias, rango: rango(dias),
      anterior: x.anterior, importe: x.importe, estadoImporte: "Registrado (no se suma)", suma: false, atrasado: false,
      enlace: { tipo: "entrada_fondo", id: x.id },
    });
  }

  return {
    enSucursal, sobres, pendiente, porDepositar, total,
    depositado: { importe: c.movimientos.depositado.importe, n: c.movimientos.depositado.n },
    atencion, porPersona: [...mapa.values()], folios, lugaresSinDatos, ocultos: c.ocultos, conocido,
  };
}

/** Varias sucursales: suma lo conocido y junta lo que falta (nunca convierte «sin datos» en cero). */
export function resumirVarias(filas: { c: CajaSucursal; r: ResumenCaja }[]) {
  const visible = pesos(filas.reduce((n, f) => n + cent(f.c.visible), 0));
  const lugares = filas.reduce((n, f) => n + f.r.lugaresSinDatos.length, 0);
  const ocultos = filas.reduce((n, f) => n + f.r.ocultos, 0);
  const conocido = filas.some((f) => f.r.conocido);
  return {
    total: armarTotal(visible, conocido, textoFaltan(lugares, ocultos)),
    depositado: { importe: pesos(filas.reduce((n, f) => n + cent(f.r.depositado.importe), 0)), n: filas.reduce((n, f) => n + f.r.depositado.n, 0) },
  };
}

export const centavos = cent;
export const aPesos = pesos;

/**
 * Lo que se lee en la pantalla principal y en la primera página del PDF (aprobado el 25 nov 2026): solo las cifras con
 * algo; lo que está en cero se agrupa en una línea. No repite importes: los retiros con 48 horas o más remiten a
 * «Quién tiene dinero por depositar».
 */
export type Renglon = { clave: string; etiqueta: string; importe: string | null; sinImporte?: string; detalle: string };
export function lectura(s: ResumenCaja) {
  const efectivo: Renglon[] = [{ clave: "1", etiqueta: "En la sucursal", importe: s.enSucursal.importe, sinImporte: "Sin datos", detalle: s.enSucursal.nota }];
  const ceros: string[] = [];
  if (s.sobres.n) efectivo.push({ clave: "2", etiqueta: "Sobres por recoger", importe: s.sobres.importe, sinImporte: "Oculto: sin contar", detalle: s.sobres.nota });
  else ceros.push("0 sobres registrados por recoger");
  if (s.pendiente.n) efectivo.push({ clave: "3", etiqueta: "Entregado, pendiente de confirmar", importe: s.pendiente.importe, sinImporte: "Oculto: sin contar", detalle: s.pendiente.nota });
  else ceros.push("0 entregas por confirmar");
  if (s.porDepositar.n) efectivo.push({ clave: "4", etiqueta: "Confirmado, por depositar", importe: s.porDepositar.importe, detalle: "Quién lo tiene, abajo" });
  else ceros.push("nada por depositar");
  const personas = s.porPersona.map((p) => ({
    persona: p.persona, importe: pesos(p.total), atrasados: p.atrasados,
    detalle: [`${p.n} ${p.n === 1 ? "saldo" : "saldos"}`,
              ...[2, 1, 0].filter((i) => p.rangos[i]).map((i) => `${dinero(pesos(p.rangos[i]))} ${i === 2 ? "con más de 7 días" : i === 1 ? "de 3 a 7 días" : "de 0 a 2 días"}`)].join(" · "),
  }));
  const atencion = s.atencion.filter((a) => a.n);
  const atencionCeros = s.atencion.filter((a) => !a.n).map((a) => a.texto.toLowerCase());
  return { efectivo, ceros, personas, atencion, atencionCeros };
}

/** Nombre corto de un caso de diferencia, para leerlo de un vistazo. */
/** Un caso en una línea, con su clave fija primero: «TEN-D4 · Cambio de turno del 12 nov». */
function textoCaso(d: CajaSucursal["diferencias"][number]) {
  return `${d.clave} · ${descripcionCaso(d)}`;
}
function descripcionCaso(d: CajaSucursal["diferencias"][number]) {
  const dia = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short" }).format(d.registradaEn);
  if (d.clase === "retiro_importe") return `Faltante del retiro ${d.folio}`;
  if (d.clase === "sobre") return `${Number(d.importe) < 0 ? "Faltante" : "Diferencia"} del sobre ${d.folio}`;
  if (d.clase === "retiro_esperado") return `Al retirar ${d.folio}`;
  return `${d.tipoTexto.replace(/ \(.*\)$/, "")} del ${dia}`;
}

/** «−$50.00» / «+$20.00»: el signo siempre visible en una diferencia. */
export const conSigno = (v: string) => (Number(v) < 0 ? `−${dinero(String(-Number(v)))}` : `+${dinero(v)}`);
/** Los casos de un pendiente de diferencias en una línea, cada uno con su importe. */
export const lineaCasos = (a: Atencion) => (a.casos ?? []).map((x) => `${x.texto} ${conSigno(x.importe)}`).join(" · ");

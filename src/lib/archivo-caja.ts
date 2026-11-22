import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { dinero, nombreLugar, type ArchivoCaja, type CajaSucursal, type Detalle } from "@/lib/reporte-caja";

/**
 * Archivos del reporte de caja (Excel y PDF; aprobados el 21 nov 2026). Llevan lo mismo que la pantalla de quien
 * descarga, con el mismo corte: los importes ocultos van como texto («Oculto: sin contar»), nunca como cero; con importes
 * ocultos el recuadro es «Subtotal visible»; siempre se señala que la información está incompleta mientras falten los
 * datos de mensualidades de Open Desk; si lleva importes anotados de sobres sin contar, la leyenda lo dice.
 */
export const OCULTO = "Oculto: sin contar";
export const LEYENDA_ANOTADOS = "Contiene importes anotados de sobres sin contar";
export const LEYENDA_INCOMPLETO = "Información incompleta: el cajón cuenta con su último conteo; faltan los datos de mensualidades de Open Desk (el cuadre completo queda pendiente).";

type Importe = string | null | { texto: string };
type Fila =
  | { tipo: "titulo" | "seccion" | "nota" | "aviso"; texto: string }
  | { tipo: "encabezado"; celdas: string[] }
  | { tipo: "fila" | "total"; celdas: string[]; importe: Importe; gris?: boolean };

const ZONA = "America/Mexico_City";
const fechaHora = (d: Date) => new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "medium", timeStyle: "short" }).format(d);
const fechaCorta = (d: Date) => new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "medium" }).format(d);
const dia = (f: string) => new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${f}T00:00:00Z`));
const marca = (anterior: boolean) => (anterior ? " · Anterior al periodo" : "");
const imp = (v: string | null): Importe => (v === null ? { texto: OCULTO } : v);

/** Total (o subtotal visible) de una sucursal, con su aviso. */
export function textoTotal(c: Pick<CajaSucursal, "ocultos">) {
  return c.ocultos > 0
    ? `Subtotal visible al corte (no es el total: faltan ${c.ocultos} con importe oculto) · incompleto: faltan mensualidades de Open Desk`
    : "Total registrado al corte · incompleto: faltan mensualidades de Open Desk";
}

function filasSucursal(c: CajaSucursal, detalles: Detalle[] | undefined): Fila[] {
  const f: Fila[] = [{ tipo: "titulo", texto: c.nombre }];
  f.push({ tipo: "seccion", texto: "Dónde está el efectivo al corte" }, { tipo: "encabezado", celdas: ["Etapa", "Concepto", "Detalle"] });
  for (const l of c.lugares) {
    const detalle = l.estado === "turno"
      ? `${l.tipo === "bolsa_visitas" ? "Esperado" : "Último conteo"} · contado al abrir ${fechaHora(l.base!.en)} (${l.base!.por}) más movimientos registrados${l.tipo === "cajon_mensualidades" ? " · información incompleta: faltan mensualidades de Open Desk" : ""}`
      : l.estado === "cerrado" ? `Guardado al cerrar · contado ${fechaHora(l.base!.en)} (${l.base!.por})` : "Sin turnos registrados";
    f.push({ tipo: "fila", celdas: ["1. En la sucursal", nombreLugar(l.tipo), detalle], importe: l.importe ?? "0.00" });
  }
  for (const s of c.sobres) {
    const donde = s.donde === "buzon" ? "En el buzón" : s.donde === "caja" ? "En la caja con llave" : "Por devolver a la caja";
    f.push({ tipo: "fila", celdas: ["2. Sobres por recoger", `Sobre ${s.folio}`, `${donde} · ${nombreLugar(s.lugar)} · guardado ${fechaHora(s.guardadoEn)} · ${s.dias} días${marca(s.anterior)}`], importe: imp(s.anotado) });
  }
  for (const p of c.pendientes) {
    f.push(p.clase === "retiro"
      ? { tipo: "fila", celdas: ["3. Entregado, pendiente de confirmar", `Retiro ${p.folio}`, `Entregado a ${p.recibe} el ${fechaHora(p.en)} por ${p.entrego}${marca(p.anterior)}`], importe: imp(p.importe) }
      : { tipo: "fila", celdas: ["3. Entregado, pendiente de confirmar", `Sobres ${p.folios.join(", ")}`, `Entregados a ${p.recibe} el ${fechaHora(p.en)} por ${p.entrego}${marca(p.anterior)}`], importe: imp(p.importe) });
  }
  for (const x of c.confirmados) {
    const [concepto, detalle] = x.clase === "recoleccion"
      ? [`${x.buzon ? "Recolección del buzón" : "Recolección"} · ${x.recibe}`, `Recogido ${dinero(x.recogido)} · depositado ${dinero(x.depositado)} · desde ${fechaHora(x.desde)}${marca(x.anterior)}`]
      : x.clase === "retiro"
        ? [`Retiro ${x.folio} · ${x.encargada}`, `Habilitado ${dinero(x.habilitado)} · depositado ${dinero(x.depositado)} · desde ${fechaHora(x.desde)}${x.aviso ? " · 48 horas o más" : ""}${marca(x.anterior)}`]
        : [`Retiro ${x.folio} · ${x.encargada}`, `En pausa por revisión (no se deposita aún) · desde ${fechaHora(x.desde)}${marca(x.anterior)}`];
    f.push({ tipo: "fila", celdas: ["4. Confirmado, por depositar", concepto, detalle], importe: x.saldo });
  }
  f.push({ tipo: "total", celdas: [textoTotal(c), "", ""], importe: c.visible });
  if (c.ocultos > 0) f.push({ tipo: "nota", texto: `Más ${c.ocultos} con importe oculto hasta contarlos (conteo a ciegas).` });
  f.push({ tipo: "seccion", texto: "5. Depositado en el periodo (ya salió de la custodia: no se suma arriba)" });
  if (!c.depositos.length) f.push({ tipo: "nota", texto: "Sin depósitos en el periodo." });
  for (const d of c.depositos) {
    f.push({ tipo: "fila", celdas: ["Depósito", d.clase === "recoleccion" ? "De una recolección" : `Del retiro ${d.folio}`, `${dia(d.fecha)} · ref. ${d.referencia} · registró ${d.por}`], importe: d.importe });
  }
  f.push({ tipo: "seccion", texto: "Aparte: diferencias (no se suman a ninguna etapa)" });
  if (!c.diferencias.length) f.push({ tipo: "nota", texto: "Sin diferencias del periodo ni anteriores abiertas." });
  for (const d of c.diferencias) {
    f.push({ tipo: "fila", celdas: ["Diferencia", `${d.texto} · ${nombreLugar(d.lugar)}`, `${d.estado}${marca(d.anterior)}`], importe: d.importe });
  }
  f.push({ tipo: "seccion", texto: "Aparte: sobres por investigar (no se suman a ninguna etapa)" });
  if (!c.investigar.length) f.push({ tipo: "nota", texto: "Ninguno." });
  for (const x of c.investigar) {
    f.push({ tipo: "fila", celdas: ["Por investigar", `Sobre ${x.folio} · ${nombreLugar(x.lugar)}`, `No estaba al abrir el buzón el ${fechaHora(x.desde)} · sin responsable asignado · anotado${marca(x.anterior)}`], importe: x.anotado });
  }
  const m = c.movimientos;
  f.push({ tipo: "seccion", texto: "Movimientos del periodo (pasos del mismo dinero: no se suman entre sí)" });
  f.push({ tipo: "fila", celdas: ["Movimiento", `Cobros de visitas en efectivo (${m.cobros.n})`, ""], importe: m.cobros.importe });
  f.push({ tipo: "fila", celdas: ["Movimiento", `Cancelaciones y devoluciones en efectivo (${m.cancelaciones.n})`, ""], importe: m.cancelaciones.importe });
  f.push({ tipo: "fila", celdas: ["Movimiento", "Mensualidades", "No calculado: faltan datos de Open Desk"], importe: { texto: "No calculado" } });
  f.push({ tipo: "fila", celdas: ["Movimiento", `Sobres sellados al cerrar (${m.sellados.n})`, m.sellados.ocultos ? `${m.sellados.ocultos} sin contar: anotado oculto` : "Anotado al cerrar"], importe: imp(m.sellados.anotado) });
  f.push({ tipo: "fila", celdas: ["Movimiento", `Recogido por Dirección, contado (${m.recogido.n})`, ""], importe: m.recogido.importe });
  f.push({ tipo: "fila", celdas: ["Movimiento", `Entregado a Encargada de retiros (${m.retiros.n}: ${m.retiros.confirmados} confirmados, ${m.retiros.pendientes} pendientes de confirmar)`,
                                  m.retiros.ocultos ? `Más ${m.retiros.ocultos} con importe oculto` : ""], importe: m.retiros.importe });
  f.push({ tipo: "fila", celdas: ["Movimiento", `Depositado (${m.depositado.n})`, ""], importe: m.depositado.importe });

  if (detalles?.length) {
    f.push({ tipo: "seccion", texto: "Detalle e historial de cada importe (hasta el corte)" });
    for (const d of detalles) {
      f.push({ tipo: "titulo", texto: `${d.titulo}${d.anterior ? " · Anterior al periodo" : ""}` });
      f.push({ tipo: "nota", texto: `${d.subtitulo} · Al corte: ${d.alCorte}` });
      for (const x of d.filas) f.push({ tipo: "fila", celdas: ["", x.etiqueta, x.nota ?? ""], importe: imp(x.valor) });
      if (d.tabla) {
        f.push({ tipo: "encabezado", celdas: d.tabla.columnas.slice(0, 3) });
        for (const t of d.tabla.filas) {
          const [a, b, c3, d4] = t.celdas;
          f.push({ tipo: "fila", celdas: [a ?? "", b ?? "", c3 === null ? `Anotado: ${OCULTO}` : `Anotado ${dinero(c3)}`], importe: d4 === null ? null : /^-?\d/.test(d4) ? d4 : { texto: d4 } });
        }
      }
      for (const e of d.eventos) f.push({ tipo: "fila", celdas: [fechaHora(e.en), e.texto, e.persona ?? ""], importe: { texto: "" } });
    }
  }
  return f;
}

function filasArchivo(a: ArchivoCaja): Fila[] {
  const r = a.reporte;
  const f: Fila[] = [
    { tipo: "titulo", texto: "Reporte de caja · Solo datos ficticios" },
    { tipo: "nota", texto: `${r.filas.map((x) => x.nombre).join(", ")} · ${dia(r.desde)} al ${dia(r.hasta)} · corte ${fechaHora(r.corte)}` },
    { tipo: "nota", texto: `Descargado por ${a.por} el ${fechaHora(a.en)} · ${a.contenido === "detalle" ? "resumen con detalle" : "resumen"}` },
  ];
  if (a.excluidas.length) f.push({ tipo: "aviso", texto: `No se incluyen (sin permiso de descarga): ${a.excluidas.join(", ")}. El archivo se calculó solo con las incluidas.` });
  const anotados = r.filas.some((x) => x.anotadosSinContar) || [...a.detalles.values()].some((l) => l.some((d) => d.anotadosSinContar));
  if (anotados) f.push({ tipo: "aviso", texto: LEYENDA_ANOTADOS });
  if (r.filas.some((x) => x.ocultos > 0)) f.push({ tipo: "aviso", texto: "Los sobres sin contar van sin importe (conteo a ciegas); por eso el recuadro es un subtotal visible." });
  f.push({ tipo: "aviso", texto: LEYENDA_INCOMPLETO });
  if (r.filas.length > 1) {
    f.push({ tipo: "seccion", texto: "Resumen por sucursal" }, { tipo: "encabezado", celdas: ["Sucursal", "Importes ocultos", "Diferencias abiertas · por investigar"] });
    for (const c of r.filas) {
      f.push({ tipo: "fila", celdas: [c.nombre, c.ocultos ? `${c.ocultos} (subtotal visible)` : "Ninguno",
                                      `${c.diferencias.filter((d) => d.abierta).length} · ${c.investigar.length}`], importe: c.visible });
    }
    const ocultos = r.filas.reduce((n, c) => n + c.ocultos, 0);
    const suma = r.filas.reduce((n, c) => n + Math.round(Number(c.visible) * 100), 0);
    f.push({ tipo: "total", celdas: [textoTotal({ ocultos }), "", ""], importe: (suma / 100).toFixed(2) });
  }
  for (const c of r.filas) f.push(...filasSucursal(c, a.detalles.get(c.codigo)));
  f.push({ tipo: "nota", texto: `Descargado por ${a.por} el ${fechaHora(a.en)} · corte ${fechaHora(r.corte)} · Solo datos ficticios` });
  return f;
}

export function nombreArchivo(a: ArchivoCaja) {
  const s = a.reporte.codigo ?? "todas";
  return `reporte-caja-${s}-${a.reporte.desde}-al-${a.reporte.hasta}.${a.formato}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------------------------------------------

export async function excelCaja(a: ArchivoCaja): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = "Fitnessland · entorno de pruebas";
  const hoja = libro.addWorksheet("Reporte de caja");
  hoja.columns = [{ width: 34 }, { width: 46 }, { width: 70 }, { width: 18 }];
  for (const f of filasArchivo(a)) {
    if ("texto" in f) {
      const fila = hoja.addRow([f.texto]);
      fila.font = { bold: f.tipo !== "nota", size: f.tipo === "titulo" ? 14 : 11, color: f.tipo === "aviso" ? { argb: "FF8A5300" } : undefined };
      if (f.tipo === "seccion") hoja.addRow([]);
      continue;
    }
    if (f.tipo === "encabezado") {
      const fila = hoja.addRow([...f.celdas, "Importe"]);
      fila.font = { bold: true, color: { argb: "FF5F6873" } };
      continue;
    }
    const valor = f.importe === null ? OCULTO : typeof f.importe === "string" ? Number(f.importe) : f.importe.texto;
    const fila = hoja.addRow([...f.celdas, valor]);
    if (typeof valor === "number") fila.getCell(4).numFmt = '"$"#,##0.00;-"$"#,##0.00';
    fila.getCell(4).alignment = { horizontal: "right" };
    if (f.tipo === "total") fila.font = { bold: true };
  }
  return Buffer.from(await libro.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------------------------------------------
// PDF (tamaño carta, fuente estándar)
// ---------------------------------------------------------------------------------------------------------------

/** La fuente estándar del PDF solo escribe el alfabeto latino básico: se sustituyen los símbolos que no tiene. */
function seguro(t: string) {
  return t.replace(/[−–—]/g, "-").replace(/→/g, "->").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

export async function pdfCaja(a: ArchivoCaja): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle("Reporte de caja · Solo datos ficticios");
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const [ancho, alto] = [612, 792];
  const margen = 40;
  const columnaImporte = ancho - margen;
  const anchoTexto = 410;
  let pagina: PDFPage = doc.addPage([ancho, alto]);
  let y = alto - margen;
  const nueva = () => { pagina = doc.addPage([ancho, alto]); y = alto - margen; };
  const lineas = (t: string, fuente: PDFFont, tam: number, max: number) => {
    const palabras = seguro(t).split(/\s+/);
    const salida: string[] = [];
    let actual = "";
    for (const p of palabras) {
      const prueba = actual ? `${actual} ${p}` : p;
      if (fuente.widthOfTextAtSize(prueba, tam) > max && actual) { salida.push(actual); actual = p; } else actual = prueba;
    }
    if (actual) salida.push(actual);
    return salida.length ? salida : [""];
  };
  const escribir = (t: string, fuente: PDFFont, tam: number, color = rgb(0.08, 0.1, 0.12), max = ancho - 2 * margen, x = margen) => {
    for (const l of lineas(t, fuente, tam, max)) {
      if (y < margen + tam) nueva();
      pagina.drawText(l, { x, y, size: tam, font: fuente, color });
      y -= tam + 3;
    }
  };
  for (const f of filasArchivo(a)) {
    if (f.tipo === "titulo") { y -= 6; escribir(f.texto, negrita, 13); continue; }
    if (f.tipo === "seccion") { y -= 8; escribir(f.texto, negrita, 10.5); continue; }
    if (f.tipo === "nota") { escribir(f.texto, normal, 8.5, rgb(0.37, 0.41, 0.45)); continue; }
    if (f.tipo === "aviso") { escribir(f.texto, negrita, 8.5, rgb(0.54, 0.33, 0)); continue; }
    if (f.tipo === "encabezado") { escribir(`${f.celdas.filter(Boolean).join(" · ")}  ·  Importe`, negrita, 8, rgb(0.37, 0.41, 0.45)); continue; }
    if (!("importe" in f)) continue;
    const fuente = f.tipo === "total" ? negrita : normal;
    const texto = f.celdas.filter(Boolean).join(" · ");
    const importe = f.importe === null ? OCULTO : typeof f.importe === "string" ? dinero(f.importe) : f.importe.texto;
    const partes = lineas(texto, fuente, 8.5, anchoTexto);
    if (y < margen + partes.length * 11.5) nueva();
    const yInicio = y;
    for (const l of partes) { pagina.drawText(l, { x: margen, y, size: 8.5, font: fuente }); y -= 11.5; }
    if (importe) {
      const t = seguro(importe);
      pagina.drawText(t, { x: columnaImporte - fuente.widthOfTextAtSize(t, 8.5), y: yInicio, size: 8.5, font: f.importe === null ? normal : fuente });
    }
    y -= 2;
  }
  const paginas = doc.getPages();
  paginas.forEach((p, i) => p.drawText(seguro(`Solo datos ficticios · corte ${fechaCorta(a.reporte.corte)} · página ${i + 1} de ${paginas.length}`),
                                     { x: margen, y: 20, size: 7.5, font: normal, color: rgb(0.45, 0.48, 0.52) }));
  return Buffer.from(await doc.save());
}

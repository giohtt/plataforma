import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { NOMBRE_AUTORIZACION_PREVIA, NOMBRE_ORIGEN, NOMBRE_REEMBOLSO } from "@/lib/datos-gasto";
import { NOMBRE_GRUPO, NOMBRE_VISTA, VISTAS, type ArchivoGastos, type ReporteGastos } from "@/lib/reporte-gastos";

/**
 * Archivos del reporte de gastos (bloque 6, PR 9; acordado el 28 nov 2026). Mismo corte y mismas claves que la
 * pantalla; nada registrado después del corte.
 *   - Excel: hojas «Gastos» (resumen por estado, aparte, vistas y detalle por clave), «Anticipos», «Reembolsos» y, con
 *     detalle, «Historial de gastos» (una fila por evento); además «Notas».
 *   - PDF: las mismas secciones.
 * Las fotos no van dentro del archivo: se indica cuántas hay y se consultan en la plataforma con la clave.
 */
const ZONA = "America/Mexico_City";
const fechaHora = (d: Date) => new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "medium", timeStyle: "short" }).format(d);
const dia = (f: string) => new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${f}T00:00:00Z`));
const formatoPesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const dinero = (v: string) => formatoPesos.format(Number(v));
const LUGAR: Record<string, string> = { bolsa_visitas: "Bolsa de visitas", cajon_mensualidades: "Cajón de mensualidades" };
const ORIGEN_REEMBOLSO: Record<string, string> = { ...LUGAR, transferencia: "Transferencia" };

type Celda = string | { importe: string } | { n: number } | null;
type Columna = { titulo: string; ancho: number; pdf: number; derecha?: boolean };
type Fila = { celdas: Celda[]; negrita?: boolean };
type Tabla = { titulo: string; columnas: Columna[]; filas: Fila[]; nota?: string };
type Hoja = { nombre: string; tablas: Tabla[] };

const c$ = (v: string): Celda => ({ importe: v });

function hojas(a: ArchivoGastos): Hoja[] {
  const r = a.reporte;
  const resumen: Tabla = {
    titulo: "Gastado en el periodo, por estado (cada gasto una vez)",
    columnas: [{ titulo: "Estado", ancho: 50, pdf: 320 }, { titulo: "Gastos", ancho: 10, pdf: 60, derecha: true }, { titulo: "Importe", ancho: 16, pdf: 100, derecha: true }],
    filas: [
      ...r.vistas.estado.map((x) => ({ celdas: [x.etiqueta, { n: x.n }, c$(x.importe)] as Celda[] })),
      { celdas: ["Total gastado en el periodo", { n: r.total.n }, c$(r.total.importe)], negrita: true },
    ],
  };
  const aparte: Tabla = {
    titulo: "Aparte al corte (no se suman al total)",
    columnas: [{ titulo: "Concepto", ancho: 50, pdf: 320 }, { titulo: "Cuántos", ancho: 10, pdf: 60, derecha: true }, { titulo: "Importe", ancho: 16, pdf: 100, derecha: true }],
    filas: [
      { celdas: ["Por autorizar (compromiso)", { n: r.aparte.porAutorizar.n }, c$(r.aparte.porAutorizar.importe)] },
      { celdas: ["Autorizados sin pagar (compromiso)", { n: r.aparte.autorizadosSinPagar.n }, c$(r.aparte.autorizadosSinPagar.importe)] },
      { celdas: ["Fuera de caja: anticipos por comprobar", { n: r.aparte.anticiposPorComprobar.n }, c$(r.aparte.anticiposPorComprobar.importe)] },
      { celdas: ["Fuera de caja: cambio de anticipos por devolver", { n: r.aparte.cambioPorDevolver.n }, c$(r.aparte.cambioPorDevolver.importe)] },
      { celdas: ["Rechazados en el periodo", { n: r.aparte.rechazados.n }, c$(r.aparte.rechazados.importe)] },
    ],
  };
  const vistas: Tabla[] = VISTAS.filter((v) => v !== "estado").map((v) => ({
    titulo: NOMBRE_VISTA[v],
    columnas: [{ titulo: NOMBRE_VISTA[v].replace(/^Por /, "").replace(/^./, (x) => x.toUpperCase()), ancho: 50, pdf: 320 },
               { titulo: "Gastos", ancho: 10, pdf: 60, derecha: true }, { titulo: "Importe", ancho: 16, pdf: 100, derecha: true }],
    filas: [...r.vistas[v].map((x) => ({ celdas: [x.etiqueta, { n: x.n }, c$(x.importe)] as Celda[] })),
            { celdas: ["Total", { n: r.total.n }, c$(r.total.importe)], negrita: true }],
  }));
  const detalle: Tabla = {
    titulo: "Detalle por clave",
    columnas: [
      { titulo: "Clave", ancho: 12, pdf: 46 }, { titulo: "Concepto", ancho: 30, pdf: 90 }, { titulo: "Categoría", ancho: 18, pdf: 56 },
      { titulo: "Sucursal (se carga a)", ancho: 20, pdf: 60 }, { titulo: "Pagó", ancho: 20, pdf: 0 }, { titulo: "Origen", ancho: 22, pdf: 66 },
      { titulo: "Autorizó", ancho: 22, pdf: 60 }, { titulo: "Autorización previa", ancho: 24, pdf: 66 },
      { titulo: "Fecha del pago", ancho: 14, pdf: 52 }, { titulo: "Registrado", ancho: 18, pdf: 60 },
      { titulo: "Anticipo: entrega y comprobación", ancho: 30, pdf: 0 },
      { titulo: "Importe", ancho: 13, pdf: 52, derecha: true }, { titulo: "Estado", ancho: 30, pdf: 0 }, { titulo: "Pendientes", ancho: 40, pdf: 96 },
      { titulo: "Fotos", ancho: 8, pdf: 0, derecha: true },
    ],
    filas: r.filas.map((f) => ({ celdas: [
      f.clave, f.concepto + (f.compraDe ? ` (parte de ${f.compraDe})` : ""), f.categoria, f.beneficiada, f.paga,
      NOMBRE_ORIGEN[f.origen] + (f.lugar && f.origen === "anticipo" ? ` · ${LUGAR[f.lugar]}` : "") + (f.turnoCerrado ? " · turno cerrado" : ""),
      f.autorizo ?? "Sin autorización", NOMBRE_AUTORIZACION_PREVIA[f.autorizacionPrevia],
      f.pagadoEl + (f.horaDeclarada ? ` ${f.horaDeclarada} (declarada)` : ""), fechaHora(f.registradoEn),
      f.anticipo ? `Entregado ${fechaHora(f.anticipo.entregadoEn)} · comprobado ${fechaHora(f.anticipo.comprobadoEn)}` : "",
      c$(f.importe), NOMBRE_GRUPO[f.grupo], f.pendientes.join(" · "), { n: f.fotos },
    ] })),
    nota: "La fecha del pago es la del pago al proveedor. Las fotos no van en el archivo: se consultan en la plataforma con la clave.",
  };
  const anticipos: Tabla = {
    titulo: "Anticipos (entrega y comprobación aparte)",
    columnas: [
      { titulo: "Clave", ancho: 12, pdf: 46 }, { titulo: "Concepto", ancho: 28, pdf: 80 }, { titulo: "Lugar", ancho: 20, pdf: 56 },
      { titulo: "Entregado", ancho: 13, pdf: 50, derecha: true }, { titulo: "Entrega", ancho: 30, pdf: 90 }, { titulo: "Confirmó", ancho: 18, pdf: 0 },
      { titulo: "Comprobación", ancho: 30, pdf: 90 }, { titulo: "Pagado con el anticipo", ancho: 14, pdf: 50, derecha: true },
      { titulo: "Cambio", ancho: 12, pdf: 44, derecha: true }, { titulo: "Cambio devuelto", ancho: 12, pdf: 44, derecha: true },
      { titulo: "Excedente", ancho: 36, pdf: 90 }, { titulo: "Estado al corte", ancho: 32, pdf: 80 },
    ],
    filas: r.anticipos.map((x) => ({ celdas: [
      x.clave, x.concepto, LUGAR[x.lugar], c$(x.entregado), `${fechaHora(x.entregadoEn)} · ${x.entrego} a ${x.recibe}`, x.confirmadoEn ? fechaHora(x.confirmadoEn) : "",
      x.comprobado ? `${fechaHora(x.comprobado.en)} · pago al proveedor ${x.comprobado.pagadoEl} · ${dinero(x.comprobado.gastado)}` : "Por comprobar",
      x.comprobado ? c$(x.comprobado.pagadoConAnticipo) : null, c$(x.cambio), c$(x.devuelto),
      x.excedente ? `${x.excedente.clave} · ${dinero(x.excedente.importe)} · ${x.excedente.estado}${x.excedente.cubiertoPersonal ? ` · cubierto con dinero personal ${dinero(x.excedente.cubiertoPersonal)}` : ""}${x.excedente.reembolso ? ` · ${NOMBRE_REEMBOLSO[x.excedente.reembolso]}` : ""}` : "",
      x.estado,
    ] })),
    nota: "El anticipo y su excedente son pasos del mismo dinero: cada pago se suma una vez en «Gastos».",
  };
  const reembolsos: Tabla = {
    titulo: "Reembolsos (no son gastos nuevos)",
    columnas: [
      { titulo: "Clave", ancho: 12, pdf: 46 }, { titulo: "Gasto original", ancho: 28, pdf: 90 }, { titulo: "Puso el dinero", ancho: 22, pdf: 70 },
      { titulo: "Importe", ancho: 13, pdf: 50, derecha: true }, { titulo: "Fecha del pago", ancho: 14, pdf: 50 },
      { titulo: "Decisión", ancho: 34, pdf: 110 }, { titulo: "Pago del reembolso", ancho: 34, pdf: 110 }, { titulo: "Lo recibió", ancho: 18, pdf: 60 },
      { titulo: "Estado al corte", ancho: 34, pdf: 90 },
    ],
    filas: r.reembolsos.map((x) => ({ celdas: [
      x.clave, x.concepto, x.puso, c$(x.importe), x.pagadoEl,
      x.decision ? `${x.decision.decision === "autorizado" ? "Autorizado" : "Rechazado"} · ronda ${x.decision.ronda} · ${x.decision.por} · ${fechaHora(x.decision.en)}` : "Por decidir",
      x.pago ? `${ORIGEN_REEMBOLSO[x.pago.origen] ?? x.pago.origen} · ${x.pago.por} · ${fechaHora(x.pago.en)}` : "",
      x.recibidoEn ? fechaHora(x.recibidoEn) : "", NOMBRE_REEMBOLSO[x.estado],
    ] })),
  };
  const lista: Hoja[] = [
    { nombre: "Gastos", tablas: [resumen, aparte, ...vistas, detalle] },
    { nombre: "Anticipos", tablas: [anticipos] },
    { nombre: "Reembolsos", tablas: [reembolsos] },
  ];
  if (a.historial) {
    lista.push({ nombre: "Historial de gastos", tablas: [{
      titulo: "Historial de cada gasto hasta el corte (una fila por evento)",
      columnas: [{ titulo: "Clave", ancho: 12, pdf: 50 }, { titulo: "Fecha y hora", ancho: 20, pdf: 90 }, { titulo: "Evento", ancho: 80, pdf: 370 },
                 { titulo: "Persona", ancho: 26, pdf: 110 }, { titulo: "Importe", ancho: 13, pdf: 60, derecha: true }],
      filas: a.historial.map((e) => ({ celdas: [e.clave, fechaHora(e.en), e.evento, e.persona ?? "", e.importe === null ? null : c$(e.importe)] })),
    }] });
  }
  return lista;
}

function notas(a: ArchivoGastos): [string, string][] {
  const r = a.reporte;
  const incluidas = r.codigo === null ? r.sucursales.map((s) => s.nombre).join(", ") : r.sucursales.find((s) => s.codigo === r.codigo)?.nombre ?? r.codigo;
  return [
    ["Reporte", "Gastos · Solo datos ficticios"],
    ["Sucursales (se carga a)", incluidas],
    ["Periodo", `${dia(r.desde)} al ${dia(r.hasta)}, por la fecha del pago al proveedor`],
    ["Corte", fechaHora(r.corte)],
    ["Descargado por", `${a.por} el ${fechaHora(a.en)}`],
    ["Contenido", a.contenido === "detalle" ? "Con detalle (historial de gastos)" : "Resumen"],
    ["Reglas", "Cada gasto se suma una sola vez, por lo pagado, aunque tenga varios pendientes. Anticipo y reembolso son pasos del mismo dinero. Gastos sigue a la sucursal a la que se carga; Caja, a la que paga. Nada registrado después del corte."],
    ["Fotos", "No van en el archivo: se consultan en la plataforma con la clave."],
  ];
}

export function nombreArchivoGastos(a: ArchivoGastos) {
  return `gastos-${a.reporte.codigo ?? "todas"}-${a.reporte.desde}-al-${a.reporte.hasta}.${a.formato}`;
}

const FORMATO_PESOS = '"$"#,##0.00;-"$"#,##0.00';

export async function excelGastos(a: ArchivoGastos): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = "Fitnessland · entorno de pruebas";
  for (const h of hojas(a)) {
    const hoja = libro.addWorksheet(h.nombre, { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const anchos: number[] = [];
    for (const t of h.tablas) t.columnas.forEach((c, i) => { anchos[i] = Math.max(anchos[i] ?? 0, c.ancho); });
    hoja.columns = anchos.map((w) => ({ width: w }));
    for (const [i, t] of h.tablas.entries()) {
      if (i > 0) hoja.addRow([]);
      const titulo = hoja.addRow([t.titulo]);
      titulo.font = { bold: true, size: 12 };
      const cab = hoja.addRow(t.columnas.map((c) => c.titulo));
      cab.font = { bold: true };
      cab.eachCell((celda) => { celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EFE6" } }; });
      const primera = cab.number;
      for (const f of t.filas) {
        const fila = hoja.addRow(f.celdas.map((x) => (x === null ? null : typeof x === "string" ? x : "importe" in x ? Number(x.importe) : x.n)));
        f.celdas.forEach((x, j) => {
          const celda = fila.getCell(j + 1);
          if (x && typeof x === "object" && "importe" in x) celda.numFmt = FORMATO_PESOS;
          if (t.columnas[j]?.derecha) celda.alignment = { horizontal: "right", vertical: "top" };
        });
        fila.alignment = { wrapText: true, vertical: "top" };
        if (f.negrita) fila.font = { bold: true };
      }
      // La tabla grande de cada hoja (el detalle) se puede filtrar.
      if (i === h.tablas.length - 1 && t.filas.length) hoja.autoFilter = { from: { row: primera, column: 1 }, to: { row: primera, column: t.columnas.length } };
      if (t.nota) hoja.addRow([t.nota]).font = { italic: true, color: { argb: "FF5F6368" } };
    }
  }
  const n = libro.addWorksheet("Notas");
  n.columns = [{ width: 28 }, { width: 110 }];
  n.addRow(["Concepto", "Valor"]).font = { bold: true };
  for (const [k, v] of notas(a)) n.addRow([k, v]).alignment = { wrapText: true, vertical: "top" };
  return Buffer.from(await libro.xlsx.writeBuffer());
}

function seguro(t: string) {
  return t.replace(/[−–—]/g, "-").replace(/→/g, "->").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[«»]/g, '"').replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}
const textoCelda = (x: Celda) => (x === null ? "" : typeof x === "string" ? x : "importe" in x ? dinero(x.importe) : String(x.n));

export async function pdfGastos(a: ArchivoGastos): Promise<Buffer> {
  const r: ReporteGastos = a.reporte;
  const doc = await PDFDocument.create();
  doc.setTitle("Gastos · Solo datos ficticios");
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const [ancho, alto] = [792, 612];
  const margen = 36;
  const util = ancho - 2 * margen;
  const tinta = rgb(0.08, 0.1, 0.12);
  const gris = rgb(0.37, 0.41, 0.45);
  let pagina: PDFPage = doc.addPage([ancho, alto]);
  let y = alto - margen;
  const nueva = () => { pagina = doc.addPage([ancho, alto]); y = alto - margen; };
  const lineas = (t: string, fuente: PDFFont, tam: number, max: number) => {
    const salida: string[] = [];
    for (const parrafo of seguro(t).split("\n")) {
      let actual = "";
      for (const palabra of parrafo.split(/\s+/)) {
        const prueba = actual ? `${actual} ${palabra}` : palabra;
        if (fuente.widthOfTextAtSize(prueba, tam) > max && actual) { salida.push(actual); actual = palabra; } else actual = prueba;
      }
      salida.push(actual);
    }
    return salida;
  };
  const escribir = (t: string, fuente: PDFFont, tam: number, color: RGB = tinta) => {
    for (const l of lineas(t, fuente, tam, util)) {
      if (y < margen + tam) nueva();
      pagina.drawText(l, { x: margen, y: y - tam, size: tam, font: fuente, color });
      y -= tam + 3;
    }
  };
  const tabla = (t: Tabla) => {
    const indices = t.columnas.map((c, i) => (c.pdf > 0 ? i : -1)).filter((i) => i >= 0);
    const cols = indices.map((i) => t.columnas[i]);
    const escala = util / cols.reduce((n, c) => n + c.pdf, 0);
    const anchos = cols.map((c) => c.pdf * escala);
    const tam = 7.5;
    const alturaFila = (celdas: string[], fuente: PDFFont) => Math.max(...celdas.map((c, i) => lineas(c, fuente, tam, anchos[i] - 6).length)) * (tam + 2) + 5;
    const fila = (celdas: string[], fuente: PDFFont, fondo?: RGB) => {
      const h = alturaFila(celdas, fuente);
      if (y - h < margen + 14) { nueva(); encabezado(); }
      if (fondo) pagina.drawRectangle({ x: margen, y: y - h, width: util, height: h, color: fondo });
      let x = margen;
      celdas.forEach((c, i) => {
        let yy = y - 3 - tam;
        for (const l of lineas(c, fuente, tam, anchos[i] - 6)) {
          const w = fuente.widthOfTextAtSize(l, tam);
          pagina.drawText(l, { x: cols[i].derecha ? x + anchos[i] - 3 - w : x + 3, y: yy, size: tam, font: fuente, color: tinta });
          yy -= tam + 2;
        }
        x += anchos[i];
      });
      pagina.drawLine({ start: { x: margen, y: y - h }, end: { x: margen + util, y: y - h }, thickness: 0.4, color: rgb(0.85, 0.87, 0.9) });
      y -= h;
    };
    const encabezado = () => fila(cols.map((c) => c.titulo), negrita, rgb(0.91, 0.94, 0.9));
    if (y < margen + 80) nueva();
    y -= 8;
    escribir(t.titulo, negrita, 10.5);
    y -= 2;
    encabezado();
    if (!t.filas.length) escribir("Nada en el periodo ni al corte.", normal, 8, gris);
    for (const f of t.filas) fila(indices.map((i) => textoCelda(f.celdas[i])), f.negrita ? negrita : normal);
    if (t.nota) { y -= 3; escribir(t.nota, normal, 7.5, gris); }
  };
  escribir(`Gastos · ${r.codigo === null ? "todas las sucursales que consultas" : r.sucursales.find((s) => s.codigo === r.codigo)?.nombre ?? r.codigo}`, negrita, 16);
  escribir(`${dia(r.desde)} al ${dia(r.hasta)} (por la fecha del pago al proveedor) · corte ${fechaHora(r.corte)} · Descargado por ${a.por} el ${fechaHora(a.en)} · ${a.contenido === "detalle" ? "con detalle" : "resumen"} · Solo datos ficticios`, normal, 8.5, gris);
  for (const [i, h] of hojas(a).entries()) {
    if (i > 0) nueva();
    escribir(h.nombre, negrita, 13);
    for (const t of h.tablas) tabla(t);
  }
  y -= 10;
  for (const [k, v] of notas(a).slice(-2)) escribir(`${k}: ${v}`, normal, 7.5, gris);
  const paginas = doc.getPages();
  paginas.forEach((pg, i) => pg.drawText(seguro(`Solo datos ficticios · gastos · página ${i + 1} de ${paginas.length}`), { x: margen, y: 18, size: 7.5, font: normal, color: rgb(0.45, 0.48, 0.52) }));
  return Buffer.from(await doc.save());
}

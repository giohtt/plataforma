import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { dinero, nombreLugar, type ArchivoCaja, type CajaSucursal, type Detalle } from "@/lib/reporte-caja";
import { aPesos, centavos, INCOMPLETO, NOTA_RANGOS, RANGOS, resumirCaja, resumirVarias, type ResumenCaja } from "@/lib/resumen-caja";

/**
 * Archivos de «Caja y depósitos» (Excel y PDF; estructura aprobada el 25 nov 2026). Llevan lo mismo que la pantalla de
 * quien descarga, con el mismo corte:
 *   - Excel: una tabla filtrable por hoja («Resumen» con la limitación en la misma fila que cada cifra, «Por persona»,
 *     «Por folio», «Depositado», «Diferencias», «Movimientos», «Notas»; con detalle, además «Origen y destino» e
 *     «Historial», una fila por evento).
 *   - PDF: primera página con las cuatro cifras, el total (o subtotal visible, o «Sin datos») y su limitación; después
 *     las mismas tablas.
 * Los importes ocultos van vacíos con «Oculto: sin contar» y los lugares sin datos con «Sin datos»: nunca como cero. Cada
 * peso aparece una vez: lo depositado en el periodo, una vez en «Depositado»; lo que sigue en custodia, en «Por folio»;
 * las diferencias se ligan por su clave y no se suman. Lo posterior al corte no entra.
 */
export const OCULTO = "Oculto: sin contar";
/** Lugar sin turnos registrados: no hay conteo, lo que no significa que no haya dinero (nunca se muestra como cero). */
export const SIN_DATOS = "Sin datos";
export const LEYENDA_ANOTADOS = "Contiene importes anotados de sobres sin contar";
export const LEYENDA_INCOMPLETO = `Información incompleta. ${INCOMPLETO} El cuadre completo queda pendiente.`;

const ZONA = "America/Mexico_City";
const fechaHora = (d: Date) => new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "medium", timeStyle: "short" }).format(d);
const fechaCorta = (d: Date) => new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "medium" }).format(d);
const iso = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONA }).format(d);
const dia = (f: string) => new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${f}T00:00:00Z`));
const siNo = (b: boolean) => (b ? "Sí" : "No");

/** Una celda: texto, importe en pesos (se suma y se da formato), número o vacía. */
type Celda = string | { importe: string } | { n: number } | null;
const $c = (v: string | null): Celda => (v === null ? null : { importe: v });
type Columna = { titulo: string; ancho: number; pdf: number; derecha?: boolean };
type Fila = { celdas: Celda[]; negrita?: boolean };
type Tabla = { hoja: string; titulo: string; columnas: Columna[]; filas: Fila[]; nota?: string; soloDetalle?: boolean };

// ---------------------------------------------------------------------------------------------------------------
// Tablas de una sucursal (sin la columna «Sucursal»: el Excel la agrega al juntar sucursales)
// ---------------------------------------------------------------------------------------------------------------

function filasResumen(c: CajaSucursal, s: ResumenCaja): Fila[] {
  const f: Fila[] = [];
  for (const l of c.lugares) {
    const estado = l.estado === "sin_datos" ? SIN_DATOS : l.estado === "cerrado" ? "Contado al cerrar" : l.tipo === "bolsa_visitas" ? "Esperado" : "Último conteo";
    const limitacion = l.estado === "sin_datos" ? "Sin turnos ni conteos registrados (no es cero)"
      : l.tipo === "cajon_mensualidades" ? `Incompleto: no incluye mensualidades cobradas después del ${fechaHora(l.base!.en)} (Open Desk)` : "";
    f.push({ celdas: [`En la sucursal · ${nombreLugar(l.tipo).toLowerCase()}`, $c(l.importe), estado, limitacion] });
  }
  const etapa = (concepto: string, x: ResumenCaja["sobres"], estado: string, extra: string[]) => {
    const lim = [x.n === 0 ? `0 ${concepto.startsWith("Sobres") ? "sobres registrados" : "entregas registradas"} al corte` : "",
                 x.ocultos ? `${x.ocultos} sin contar: importe oculto (conteo a ciegas)` : "", ...extra].filter(Boolean).join(" · ");
    f.push({ celdas: [concepto, $c(x.importe), x.importe === null ? OCULTO : x.n === 0 ? "Sin registros" : x.ocultos ? `${estado} (visible)` : estado, lim] });
  };
  const anotados = c.anotadosSinContar && c.sobres.length > 0 ? [LEYENDA_ANOTADOS] : [];
  etapa("Sobres por recoger", s.sobres, "Anotado", anotados);
  etapa("Entregado, pendiente de confirmar", s.pendiente, "Registrado", []);
  const atrasados = s.atencion.find((a) => a.clave === "atrasados")!;
  f.push({ celdas: ["Confirmado, por depositar", $c(s.porDepositar.importe), "Contado", atrasados.n ? `${atrasados.n} con 48 horas o más sin depositar` : ""] });
  f.push({ celdas: [s.total.etiqueta, $c(s.total.importe), s.total.tipo === "sin_datos" ? SIN_DATOS : s.total.tipo === "subtotal" ? "Subtotal visible" : "Total", s.total.nota], negrita: true });
  f.push({ celdas: ["Depositado en el periodo", $c(s.depositado.importe), "Depositado", `No se suma al total: ya salió de la custodia · ${s.depositado.n} ${s.depositado.n === 1 ? "depósito" : "depósitos"}`] });
  for (const a of s.atencion) f.push({ celdas: [`Requiere atención · ${a.texto} (${a.n})`, $c(a.importe), "Aparte", a.nota] });
  return f;
}

function tablasSucursal(c: CajaSucursal, s: ResumenCaja, detalles: Detalle[] | undefined, corte: Date): Tabla[] {
  const tablas: Tabla[] = [];
  tablas.push({
    hoja: "Resumen", titulo: "Resumen al corte",
    columnas: [{ titulo: "Concepto", ancho: 46, pdf: 230 }, { titulo: "Importe", ancho: 15, pdf: 80, derecha: true }, { titulo: "Estado del importe", ancho: 20, pdf: 100 },
               { titulo: "Limitación", ancho: 70, pdf: 310 }],
    filas: filasResumen(c, s),
  });
  tablas.push({
    hoja: "Por persona", titulo: "Por depositar: quién lo tiene y desde cuándo",
    columnas: [{ titulo: "Persona", ancho: 34, pdf: 220 }, ...RANGOS.map((r) => ({ titulo: r, ancho: 15, pdf: 100, derecha: true })),
               { titulo: "Total", ancho: 15, pdf: 100, derecha: true }, { titulo: "Con 48 horas o más", ancho: 18, pdf: 100, derecha: true }],
    filas: s.porPersona.map((p) => ({ celdas: [p.persona, ...p.rangos.map((v) => $c(aPesos(v))), $c(aPesos(p.total)), { n: p.atrasados }] })),
    nota: NOTA_RANGOS,
  });
  tablas.push({
    hoja: "Por folio", titulo: "Por folio (lo que sigue en custodia al corte; lo de «Aparte» no se suma)",
    columnas: [{ titulo: "Folio o lugar", ancho: 30, pdf: 118 }, { titulo: "Etapa al corte", ancho: 34, pdf: 122 }, { titulo: "Quién lo tiene", ancho: 30, pdf: 112 },
               { titulo: "Desde", ancho: 12, pdf: 56 }, { titulo: "Días", ancho: 7, pdf: 30, derecha: true }, { titulo: "Antigüedad", ancho: 14, pdf: 58 },
               { titulo: "Anterior al periodo", ancho: 11, pdf: 44 }, { titulo: "Importe", ancho: 14, pdf: 68, derecha: true },
               { titulo: "Estado del importe", ancho: 24, pdf: 82 }, { titulo: "Se suma al total", ancho: 10, pdf: 30 }],
    filas: s.folios.map((x) => ({ celdas: [x.folio, x.etapaTexto + (x.atrasado ? " · 48 horas o más" : ""), x.quien, x.desde ? iso(x.desde) : "", x.dias === null ? "" : { n: x.dias },
                                           x.rango === null ? "" : RANGOS[x.rango], siNo(x.anterior), $c(x.importe), x.estadoImporte, siNo(x.suma)] })),
  });
  const deps = c.depositos.map((d) => {
    const o = c.origenes.find((x) => x.clase === d.clase && x.id === d.origenId);
    return { celdas: [d.fecha, d.referencia, d.por, d.clase === "retiro" ? "Retiro" : o?.texto.startsWith("Recolección del buzón") ? "Recolección del buzón" : "Recolección de sobres", o ? o.folios.join(", ") : (d.folio ?? ""),
                      $c(o ? o.contado : null), $c(o ? o.antes : null), { importe: d.importe }, $c(o ? o.saldo : null), o ? o.claves.join(", ") : ""] };
  });
  tablas.push({
    hoja: "Depositado", titulo: "Depositado en el periodo (solo se suma «Importe depositado»)",
    columnas: [{ titulo: "Fecha del depósito", ancho: 13, pdf: 58 }, { titulo: "Referencia", ancho: 20, pdf: 90 }, { titulo: "Registró", ancho: 24, pdf: 86 },
               { titulo: "Origen", ancho: 20, pdf: 70 }, { titulo: "Folios del origen", ancho: 34, pdf: 130 }, { titulo: "Contado del origen", ancho: 14, pdf: 60, derecha: true },
               { titulo: "Depositado del origen antes del periodo", ancho: 18, pdf: 66, derecha: true }, { titulo: "Importe depositado", ancho: 14, pdf: 64, derecha: true },
               { titulo: "Saldo del origen al corte", ancho: 14, pdf: 56, derecha: true }, { titulo: "Diferencias del origen", ancho: 14, pdf: 40 }],
    filas: deps,
    nota: "«Contado del origen», lo depositado antes del periodo y el saldo son referencia (un origen puede depositarse en partes). Las diferencias se ligan por su clave, sin importe en esta tabla.",
  });
  tablas.push({
    hoja: "Diferencias", titulo: "Diferencias (aparte: no se suman a ninguna etapa)",
    columnas: [{ titulo: "Clave", ancho: 7, pdf: 32 }, { titulo: "Origen", ancho: 30, pdf: 112 }, { titulo: "Folio", ancho: 20, pdf: 92 }, { titulo: "Lugar", ancho: 22, pdf: 86 },
               { titulo: "Registrada", ancho: 12, pdf: 56 }, { titulo: "Importe", ancho: 12, pdf: 56, derecha: true }, { titulo: "Estado al corte", ancho: 44, pdf: 176 },
               { titulo: "Abierta", ancho: 8, pdf: 34 }, { titulo: "Anterior al periodo", ancho: 11, pdf: 40 }, { titulo: "Cuenta en el neto", ancho: 10, pdf: 36 }],
    filas: c.diferencias.map((d) => ({ celdas: [d.clave, d.tipoTexto, d.folio ?? "", nombreLugar(d.lugar), iso(d.registradaEn), { importe: d.importe }, `Estado al corte: ${d.estado}`,
                                                 siNo(d.abierta), siNo(d.anterior), siNo(d.neto)] })),
    nota: `Neto de referencia: ${dinero(aPesos(c.diferencias.filter((d) => d.neto).reduce((n, d) => n + centavos(d.importe), 0)))} (no cierra ningún caso).`,
  });
  const m = c.movimientos;
  tablas.push({
    hoja: "Movimientos", titulo: "Durante el periodo (pasos del mismo dinero: no se suman entre sí ni con los saldos)",
    columnas: [{ titulo: "Movimiento", ancho: 40, pdf: 260 }, { titulo: "Cantidad", ancho: 10, pdf: 60, derecha: true }, { titulo: "Importe", ancho: 15, pdf: 90, derecha: true },
               { titulo: "Nota", ancho: 60, pdf: 310 }],
    filas: [
      { celdas: ["Sobres sellados al cerrar", { n: m.sellados.n }, $c(m.sellados.anotado), m.sellados.ocultos ? `${m.sellados.ocultos} sin contar: anotado oculto` : "Anotado al cerrar"] },
      { celdas: ["Recogido por Dirección, contado", { n: m.recogido.n }, { importe: m.recogido.importe }, ""] },
      { celdas: ["Entregado a Encargada de retiros", { n: m.retiros.n }, { importe: m.retiros.importe },
                 `${m.retiros.confirmados} confirmados, ${m.retiros.pendientes} pendientes de confirmar${m.retiros.ocultos ? ` · más ${m.retiros.ocultos} con importe oculto` : ""}`] },
      { celdas: ["Entradas al fondo recibidas", { n: m.entradasFondo.n }, { importe: m.entradasFondo.importe }, ""] },
      { celdas: ["Depositado en el banco", { n: m.depositado.n }, { importe: m.depositado.importe }, "Detalle en «Depositado»"] },
      { celdas: ["Mensualidades", "", "No calculado", "Faltan datos de Open Desk"] },
      { celdas: ["Cobros de visitas", "", "", "Están en el reporte de visitas"] },
    ],
  });
  const suma = (k: "antes" | "durante" | "saldo" | "diferencia") => aPesos(c.origenes.reduce((n, o) => n + centavos(o[k]), 0));
  tablas.push({
    hoja: "Origen y destino", titulo: "Origen y destino del dinero (contado = depositado antes + depositado durante + saldo al corte)", soloDetalle: true,
    columnas: [{ titulo: "Origen", ancho: 40, pdf: 170 }, { titulo: "Folios", ancho: 34, pdf: 110 }, { titulo: "Anterior al periodo", ancho: 11, pdf: 40 },
               { titulo: "Anotado o registrado", ancho: 14, pdf: 62, derecha: true }, { titulo: "Diferencia", ancho: 12, pdf: 52, derecha: true },
               { titulo: "Claves", ancho: 10, pdf: 36 }, { titulo: "Contado", ancho: 13, pdf: 60, derecha: true },
               { titulo: "Depositado antes del periodo", ancho: 15, pdf: 64, derecha: true }, { titulo: "Depositado durante el periodo", ancho: 15, pdf: 64, derecha: true },
               { titulo: "Saldo al corte", ancho: 13, pdf: 62, derecha: true }],
    filas: [
      ...c.origenes.map((o) => ({ celdas: [o.texto + (o.pausa ? " · en pausa por revisión" : ""), o.folios.join(", "), siNo(o.anterior), { importe: o.registrado },
                                           { importe: o.diferencia }, o.claves.join(", "), { importe: o.contado }, { importe: o.antes }, { importe: o.durante }, { importe: o.saldo }] as Celda[] })),
      { celdas: ["Total", "", "", "", { importe: suma("diferencia") }, "solo referencia", "", { importe: suma("antes") }, { importe: suma("durante") }, { importe: suma("saldo") }], negrita: true },
    ],
    nota: "«Depositado durante el periodo» es el depositado del resumen y «Saldo al corte» es «Confirmado, por depositar». Lo depositado antes del periodo y la diferencia total son solo referencia.",
  });
  const historial: Fila[] = [];
  for (const d of detalles ?? []) {
    const caso = `${d.titulo}${d.anterior ? " · Anterior al periodo" : ""}`;
    const valor = (v: string | null): Celda => (v !== null ? { importe: v } : d.sinDatos ? SIN_DATOS : d.oculto ? OCULTO : null);
    historial.push({ celdas: [caso, "Al corte", fechaHora(corte), d.alCorte, "", valor(d.importeAlCorte)] });
    for (const x of d.filas) historial.push({ celdas: [caso, "Al corte", "", `${x.etiqueta}${x.nota ? ` · ${x.nota}` : ""}`, "", valor(x.valor)] });
    for (const t of d.tabla?.filas ?? []) {
      const [a, b, c3, d4] = t.celdas;
      historial.push({ celdas: [caso, "Al corte", "", `Sobre ${a} · ${b} · anotado ${c3 === null ? OCULTO : dinero(c3)} · contado al corte: ${d4 === null ? OCULTO : /^-?\d/.test(d4) ? dinero(d4) : d4}`, "", null] });
    }
    for (const e of d.eventos) historial.push({ celdas: [caso, "Evento", fechaHora(e.en), e.texto, e.persona ?? "", null] });
  }
  tablas.push({
    hoja: "Historial", titulo: "Historial de cada folio hasta el corte (una fila por evento)", soloDetalle: true,
    columnas: [{ titulo: "Folio o caso", ancho: 40, pdf: 150 }, { titulo: "Tipo", ancho: 9, pdf: 40 }, { titulo: "Fecha y hora", ancho: 20, pdf: 86 },
               { titulo: "Descripción", ancho: 80, pdf: 290 }, { titulo: "Persona", ancho: 26, pdf: 90 }, { titulo: "Importe", ancho: 14, pdf: 64, derecha: true }],
    filas: historial,
  });
  return tablas;
}

type Preparado = { a: ArchivoCaja; sucursales: { c: CajaSucursal; s: ResumenCaja; tablas: Tabla[] }[]; anotados: boolean; ocultos: boolean };
function preparar(a: ArchivoCaja): Preparado {
  const sucursales = a.reporte.filas.map((c) => {
    const s = resumirCaja(c, a.reporte.corte);
    const tablas = tablasSucursal(c, s, a.detalles.get(c.codigo), a.reporte.corte).filter((t) => a.contenido === "detalle" || !t.soloDetalle);
    return { c, s, tablas };
  });
  const anotados = a.reporte.filas.some((x) => x.anotadosSinContar) || [...a.detalles.values()].some((l) => l.some((d) => d.anotadosSinContar));
  return { a, sucursales, anotados, ocultos: a.reporte.filas.some((x) => x.ocultos > 0) };
}

function notas(p: Preparado): [string, string][] {
  const r = p.a.reporte;
  return [
    ["Reporte", "Caja y depósitos · Solo datos ficticios"],
    ["Sucursales incluidas", r.filas.map((x) => x.nombre).join(", ")],
    ...(p.a.excluidas.length ? [["No se incluyen (sin permiso de descarga)", `${p.a.excluidas.join(", ")}. El archivo se calculó solo con las incluidas.`] as [string, string]] : []),
    ["Periodo", `${dia(r.desde)} al ${dia(r.hasta)}`],
    ["Corte", fechaHora(r.corte)],
    ["Descargado por", `${p.a.por} el ${fechaHora(p.a.en)}`],
    ["Contenido", p.a.contenido === "detalle" ? "Con detalle (origen y destino, historial)" : "Resumen"],
    ...(p.anotados ? [["Leyenda", LEYENDA_ANOTADOS] as [string, string]] : []),
    ...(p.ocultos ? [["Importes ocultos", "Los sobres sin contar van sin importe (conteo a ciegas): por eso el recuadro es un subtotal visible."] as [string, string]] : []),
    ["Limitación", LEYENDA_INCOMPLETO],
    ["Antigüedad", NOTA_RANGOS],
    ["Reglas", "Cada peso aparece una vez: en custodia al corte («Por folio») o ya depositado («Depositado»). Las diferencias, los sobres por investigar y las entradas al fondo sin confirmar van aparte y no se suman. Lo posterior al corte no entra."],
  ];
}

export function nombreArchivo(a: ArchivoCaja) {
  const s = a.reporte.codigo ?? "todas";
  return `caja-y-depositos-${s}-${a.reporte.desde}-al-${a.reporte.hasta}.${a.formato}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Excel: una tabla filtrable por hoja, con la columna «Sucursal»
// ---------------------------------------------------------------------------------------------------------------

const FORMATO_PESOS = '"$"#,##0.00;-"$"#,##0.00';

export async function excelCaja(a: ArchivoCaja): Promise<Buffer> {
  const p = preparar(a);
  const libro = new ExcelJS.Workbook();
  libro.creator = "Fitnessland · entorno de pruebas";
  const hojas = p.sucursales[0]?.tablas ?? [];
  for (const [i, modelo] of hojas.entries()) {
    const hoja = libro.addWorksheet(modelo.hoja, {
      views: [{ state: "frozen", ySplit: 1 }],
      // Al imprimir: horizontal, todas las columnas en el ancho de la hoja y los títulos en cada página.
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:1" },
    });
    const columnas = [{ titulo: "Sucursal", ancho: 18, pdf: 0 }, ...modelo.columnas];
    hoja.columns = columnas.map((c) => ({ width: c.ancho }));
    const titulos = hoja.addRow(columnas.map((c) => c.titulo));
    titulos.font = { bold: true };
    titulos.alignment = { wrapText: true, vertical: "top" };
    titulos.eachCell((celda) => { celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EFE6" } }; });
    const agregar = (sucursal: string, f: Fila) => {
      const fila = hoja.addRow([sucursal, ...f.celdas.map((x) => (x === null ? null : typeof x === "string" ? x : "importe" in x ? Number(x.importe) : x.n))]);
      f.celdas.forEach((x, j) => {
        const celda = fila.getCell(j + 2);
        if (x && typeof x === "object" && "importe" in x) celda.numFmt = FORMATO_PESOS;
        if (columnas[j + 1].derecha) celda.alignment = { horizontal: "right", vertical: "top" };
      });
      fila.alignment = { wrapText: true, vertical: "top" };
      if (f.negrita) fila.font = { bold: true };
    };
    for (const x of p.sucursales) for (const f of x.tablas[i].filas) agregar(x.c.nombre, f);
    if (modelo.hoja === "Resumen" && p.sucursales.length > 1) {
      const juntas = resumirVarias(p.sucursales.map((x) => ({ c: x.c, r: x.s })));
      agregar("Todas las incluidas", { celdas: [juntas.total.etiqueta, $c(juntas.total.importe), juntas.total.tipo === "sin_datos" ? SIN_DATOS : juntas.total.tipo === "subtotal" ? "Subtotal visible" : "Total", juntas.total.nota], negrita: true });
      agregar("Todas las incluidas", { celdas: ["Depositado en el periodo", $c(juntas.depositado.importe), "Depositado", "No se suma al total: ya salió de la custodia"] });
    }
    hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
    // Las filas se ajustan al texto (las columnas no lo cortan).
    hoja.eachRow((fila) => { fila.alignment = { ...fila.alignment, wrapText: true, vertical: "top" }; });
  }
  const n = libro.addWorksheet("Notas", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  n.columns = [{ width: 34 }, { width: 110 }];
  const t = n.addRow(["Concepto", "Valor"]);
  t.font = { bold: true };
  for (const [k, v] of notas(p)) n.addRow([k, v]).alignment = { wrapText: true, vertical: "top" };
  return Buffer.from(await libro.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------------------------------------------
// PDF (carta horizontal, fuente estándar)
// ---------------------------------------------------------------------------------------------------------------

/** La fuente estándar del PDF solo escribe el alfabeto latino básico: se sustituyen los símbolos que no tiene. */
function seguro(t: string) {
  return t.replace(/[−–—]/g, "-").replace(/→/g, "->").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}
const textoCelda = (x: Celda) => (x === null ? "" : typeof x === "string" ? x : "importe" in x ? dinero(x.importe) : String(x.n));

export async function pdfCaja(a: ArchivoCaja): Promise<Buffer> {
  const p = preparar(a);
  const r = a.reporte;
  const doc = await PDFDocument.create();
  doc.setTitle("Caja y depósitos · Solo datos ficticios");
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const [ancho, alto] = [792, 612];
  const margen = 36;
  const util = ancho - 2 * margen;
  const tinta = rgb(0.08, 0.1, 0.12);
  const gris = rgb(0.37, 0.41, 0.45);
  const ocre = rgb(0.54, 0.33, 0);
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
  const escribir = (t: string, fuente: PDFFont, tam: number, color: RGB = tinta, max = util, x = margen) => {
    for (const l of lineas(t, fuente, tam, max)) {
      if (y < margen + tam) nueva();
      pagina.drawText(l, { x, y: y - tam, size: tam, font: fuente, color });
      y -= tam + 3;
    }
  };
  const tabla = (t: Tabla) => {
    const cols = t.columnas.filter((c) => c.pdf > 0);
    const indices = t.columnas.map((c, i) => (c.pdf > 0 ? i : -1)).filter((i) => i >= 0);
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
    if (!t.filas.length) escribir("Nada al corte.", normal, 8, gris);
    for (const f of t.filas) fila(indices.map((i) => textoCelda(f.celdas[i])), f.negrita ? negrita : normal);
    if (t.nota) { y -= 3; escribir(t.nota, normal, 7.5, gris); }
  };
  const cifra = (x: number, ancho0: number, etiqueta: string, importe: string, nota: string) => {
    const h = 58;
    pagina.drawRectangle({ x, y: y - h, width: ancho0, height: h, borderColor: rgb(0.85, 0.87, 0.9), borderWidth: 1, color: rgb(1, 1, 1) });
    pagina.drawText(seguro(etiqueta), { x: x + 8, y: y - 15, size: 8.5, font: negrita, color: gris });
    pagina.drawText(seguro(importe), { x: x + 8, y: y - 34, size: 15, font: negrita, color: tinta });
    lineas(nota, normal, 7, ancho0 - 16).slice(0, 2).forEach((l, i) => pagina.drawText(l, { x: x + 8, y: y - 45 - i * 8, size: 7, font: normal, color: gris }));
  };
  const recuadro = (etiqueta: string, nota: string, importe: string) => {
    const notaL = lineas(nota, normal, 8.5, util - 200);
    const h = 26 + notaL.length * 11;
    if (y - h < margen) nueva();
    pagina.drawRectangle({ x: margen, y: y - h, width: util, height: h, color: rgb(0.13, 0.15, 0.17) });
    pagina.drawText(seguro(etiqueta), { x: margen + 12, y: y - 17, size: 11, font: negrita, color: rgb(1, 1, 1) });
    notaL.forEach((l, i) => pagina.drawText(l, { x: margen + 12, y: y - 30 - i * 11, size: 8.5, font: normal, color: rgb(0.79, 0.81, 0.84) }));
    const t = seguro(importe);
    pagina.drawText(t, { x: margen + util - 12 - negrita.widthOfTextAtSize(t, 18), y: y - h / 2 - 6, size: 18, font: negrita, color: rgb(1, 1, 1) });
    y -= h + 8;
  };
  const cabecera = (titulo: string) => {
    escribir(titulo, negrita, 16);
    escribir(`${dia(r.desde)} al ${dia(r.hasta)} · corte ${fechaHora(r.corte)} · Descargado por ${a.por} el ${fechaHora(a.en)} · ${a.contenido === "detalle" ? "con detalle" : "resumen"} · Solo datos ficticios`, normal, 8.5, gris);
    if (a.excluidas.length) escribir(`No se incluyen (sin permiso de descarga): ${a.excluidas.join(", ")}. El archivo se calculó solo con las incluidas.`, negrita, 8.5, ocre);
    if (p.anotados) escribir(LEYENDA_ANOTADOS, negrita, 8.5, ocre);
    y -= 4;
  };
  const importeO = (x: { importe: string | null; ocultos: number }) => (x.importe === null ? (x.ocultos ? OCULTO : SIN_DATOS) : dinero(x.importe));

  if (p.sucursales.length > 1) {
    cabecera("Caja y depósitos · Todas las incluidas");
    tabla({
      hoja: "", titulo: "Por sucursal",
      columnas: [{ titulo: "Sucursal", ancho: 0, pdf: 130 }, { titulo: "En la sucursal", ancho: 0, pdf: 90, derecha: true }, { titulo: "Sobres por recoger", ancho: 0, pdf: 90, derecha: true },
                 { titulo: "Pendiente de confirmar", ancho: 0, pdf: 90, derecha: true }, { titulo: "Por depositar", ancho: 0, pdf: 90, derecha: true },
                 { titulo: "Total al corte", ancho: 0, pdf: 130 }, { titulo: "Depositado en el periodo", ancho: 0, pdf: 90, derecha: true }],
      filas: p.sucursales.map(({ c, s }) => ({ celdas: [c.nombre, importeO(s.enSucursal), importeO(s.sobres), importeO(s.pendiente), importeO(s.porDepositar),
                                                         `${s.total.importe === null ? SIN_DATOS : dinero(s.total.importe)}${s.total.tipo === "subtotal" ? " · subtotal visible" : ""}`, dinero(s.depositado.importe)] })),
    });
    y -= 8;
    const juntas = resumirVarias(p.sucursales.map((x) => ({ c: x.c, r: x.s })));
    recuadro(juntas.total.etiqueta, juntas.total.nota, juntas.total.importe === null ? SIN_DATOS : dinero(juntas.total.importe));
    escribir(`Depositado en el periodo (ya salió de la custodia, no se suma): ${dinero(juntas.depositado.importe)} · ${juntas.depositado.n} depósitos`, normal, 9);
  }
  for (const [i, { c, s, tablas }] of p.sucursales.entries()) {
    if (i > 0 || p.sucursales.length > 1) nueva();
    cabecera(`Caja y depósitos · ${c.nombre}`);
    const w = (util - 3 * 10) / 4;
    [["En la sucursal", s.enSucursal], ["Sobres por recoger", s.sobres], ["Pendiente de confirmar", s.pendiente], ["Por depositar", s.porDepositar]]
      .forEach(([et, x], j) => { const k = x as ResumenCaja["sobres"]; cifra(margen + j * (w + 10), w, et as string, importeO(k), k.nota); });
    y -= 66;
    recuadro(s.total.etiqueta, s.total.nota, s.total.importe === null ? SIN_DATOS : dinero(s.total.importe) + (s.ocultos ? ` + ${s.ocultos} ocultos` : ""));
    escribir(`Depositado en el periodo (ya salió de la custodia, no se suma): ${dinero(s.depositado.importe)} · ${s.depositado.n} ${s.depositado.n === 1 ? "depósito" : "depósitos"}`, negrita, 9);
    escribir(`Requiere atención: ${s.atencion.map((x) => `${x.texto.toLowerCase()}: ${x.n}${x.n ? ` (${dinero(x.importe)})` : ""}`).join(" · ")}`, normal, 8.5);
    for (const t of tablas) {
      if (t.hoja === "Resumen") continue;
      tabla(t);
    }
  }
  y -= 10;
  for (const [k, v] of notas(p).slice(-4)) escribir(`${k}: ${v}`, normal, 7.5, gris);
  const paginas = doc.getPages();
  paginas.forEach((pg, i) => pg.drawText(seguro(`Solo datos ficticios · corte ${fechaCorta(r.corte)} · página ${i + 1} de ${paginas.length}`),
                                       { x: margen, y: 18, size: 7.5, font: normal, color: rgb(0.45, 0.48, 0.52) }));
  return Buffer.from(await doc.save());
}

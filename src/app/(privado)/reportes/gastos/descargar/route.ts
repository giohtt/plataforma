import { excelGastos, nombreArchivoGastos, pdfGastos } from "@/lib/archivo-gastos";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { prepararDescargaGastos } from "@/lib/reporte-gastos";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

/**
 * Descarga del reporte de gastos (Excel o PDF; bloque 6, PR 9). Se pide por POST desde el reporte, con el mismo periodo
 * y corte que se ve en pantalla. El servidor vuelve a comprobar qué sucursales consulta, calcula el archivo con ellas
 * y registra la descarga.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  // Solo desde este mismo sitio (la cookie de sesión tampoco viaja en un envío desde otro sitio).
  // Igual que las acciones del servidor: el host del origen debe ser el de este sitio.
  const origen = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origen && (!host || new URL(origen).host !== host)) return new Response("Origen no permitido", { status: 403 });
  // Las redirecciones vuelven al mismo sitio desde el que se pidió.
  const base = origen ?? url.origin;
  const sesion = await obtenerSesionActual();
  if (!sesion) return Response.redirect(new URL("/iniciar-sesion", base), 303);
  const sql = obtenerBaseDatos();
  if (!sql) return new Response("Sin base de datos", { status: 503 });

  const datos = await request.formData();
  const texto = (campo: string, max: number) => {
    const v = datos.get(campo);
    return typeof v === "string" ? v.slice(0, max) : "";
  };
  const sucursal = texto("sucursal", 10);
  const pedido = {
    codigo: sucursal === "todas" ? null : sucursal, desde: texto("desde", 10) || undefined, hasta: texto("hasta", 10) || undefined,
    corte: texto("corte", 40) || undefined, formato: texto("formato", 5), contenido: texto("contenido", 10),
  };
  const r = await prepararDescargaGastos(sql, sesion.usuarioId, pedido, { entorno: leerEntorno() });
  if (!r.ok) {
    const volver = new URL("/reportes/gastos", base);
    volver.searchParams.set("sucursal", sucursal || "todas");
    if (pedido.desde) volver.searchParams.set("desde", pedido.desde);
    if (pedido.hasta) volver.searchParams.set("hasta", pedido.hasta);
    if (pedido.corte) volver.searchParams.set("corte", pedido.corte);
    volver.searchParams.set("error", r.error);
    return Response.redirect(volver, 303);
  }
  const archivo = r.archivo;
  const contenido = archivo.formato === "xlsx" ? await excelGastos(archivo) : await pdfGastos(archivo);
  return new Response(new Uint8Array(contenido), {
    headers: {
      "Content-Type": archivo.formato === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf",
      "Content-Disposition": `attachment; filename="${nombreArchivoGastos(archivo)}"`,
      "Cache-Control": "no-store",
    },
  });
}

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { abrirDesdeCierre, cerrarDia, cierrePendiente, configurarCustodia, prepararCierre } from "../../src/lib/cierres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { revisarDiferencia } from "../../src/lib/diferencias";
import { cambiarMontoFondo, confirmarEntradaFondo } from "../../src/lib/fondos";
import { recogerBuzon } from "../../src/lib/recolecciones";
import { abrirTurno } from "../../src/lib/turnos";
import { aplicarCambio } from "../../src/lib/usuarios";

/**
 * Reporte de caja por sucursal y periodo (aprobado el 21 nov 2026), con datos ficticios: permisos individuales de
 * consulta y descarga desde «Usuarios, roles y permisos», dónde está el efectivo al corte, conteo a ciegas (subtotal
 * visible), detalle con el mismo corte y descargas en Excel y PDF con su historial.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar el reporte de caja 2026";
const PRUEBAS = { entorno: "pruebas" as const };
const NADIE = { hubo: false as const };
const LLAVE = { estado: "correcta", motivo: "" };
const id = () => randomUUID().slice(0, 8);

async function cuenta(nombre: string, rol: string | null, sucursalId: string | null) {
  const correo = `caja-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  if (rol && sucursalId) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${sucursalId}, 'Prueba del reporte de caja')`;
  return { id: u.id, correo, nombre };
}

/**
 * Sucursal con buzón: la vespertina cerró con $20 menos en la bolsa (diferencia por revisar) y sobres de $400 (bolsa) y
 * $3,050 (cajón) en el buzón; la matutina abrió con los fondos. Dirección registró un aumento del fondo de $200 que nadie
 * ha confirmado. La otra sucursal no tiene turnos: sin datos.
 */
async function escenario() {
  const codigo = `C${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const nombre = `Caja ${codigo}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${nombre}, ${codigo}) returning id`;
  const [otra] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Otra " + codigo}, ${"O" + codigo.slice(1)}) returning id`;
  const general = await cuenta(`Dirección general ${id()}`, null, null);
  await sql`insert into alcance_general (usuario_id, rol, motivo) values (${general.id}, 'direccion', 'Prueba del reporte de caja')`;
  const matutina = await cuenta(`Recepción matutina ${id()}`, "recepcion", s.id);
  const vespertina = await cuenta(`Recepción vespertina ${id()}`, "recepcion", s.id);
  const admin = await cuenta(`Administración ${id()}`, "administracion", s.id);
  const dir = await cuenta(`Dirección ${id()}`, "direccion", s.id);
  const encargado = await cuenta(`Encargado ${id()}`, "encargado", s.id);
  const t = await abrirTurno(sql, vespertina.id, codigo, { bolsa: "420.00", cajon: "3050.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const c = await configurarCustodia(sql, dir.id, codigo, {
    lugar: "Buzón de recepción", acceso: [dir.id], lugarFondos: "Cajón con llave", accesoCajon: [matutina.id, vespertina.id],
    custodias: [matutina.id, vespertina.id], buzon: true,
  }, PRUEBAS);
  if (!c.ok) throw new Error(c.error);
  for (const lugar of ["bolsa_visitas", "cajon_mensualidades"]) {
    const r = await cambiarMontoFondo(sql, dir.id, codigo,
      { lugar, monto: "300", origen: "entrega_persona", destino: "", detalleOrigen: "Efectivo ficticio de Dirección", motivo: "Fondo provisional" }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const x = await confirmarEntradaFondo(sql, vespertina.id, codigo, { entradaId: r.entradaId!, recibido: "300" }, PRUEBAS);
    if (!x.ok) throw new Error(x.error);
  }
  const p = await prepararCierre(sql, vespertina.id, codigo, { turnoId: t.turnoId }, PRUEBAS);
  if (!p.ok) throw new Error(p.error);
  const cierre = await cerrarDia(sql, vespertina.id, codigo, {
    turnoId: t.turnoId, conteo: { bolsa: "700", cajon: "3350" }, fondos: { bolsa: "300", cajon: "300" }, custodio: vespertina.id, nota: "", apoyo: NADIE,
    custodia: { ubicacion: "Llavero de recepción", sobres: [], llave: LLAVE }, depositados: p.sobres.map((x) => x.id),
  }, PRUEBAS);
  if (!cierre.ok) throw new Error(cierre.error);
  const pend = (await cierrePendiente(sql, s.id))!;
  const a = await abrirDesdeCierre(sql, matutina.id, codigo, {
    entregaId: pend.entregaId, version: pend.version, sobres: [], conteo: { bolsa: "300", cajon: "300" }, apoyo: NADIE, llave: LLAVE,
  }, PRUEBAS);
  if (!a.ok) throw new Error(a.error);
  const subir = await cambiarMontoFondo(sql, dir.id, codigo,
    { lugar: "bolsa_visitas", monto: "500", origen: "entrega_persona", destino: "", detalleOrigen: "Efectivo ficticio de Dirección", motivo: "Más cambio para el fin de semana" }, PRUEBAS);
  if (!subir.ok) throw new Error(subir.error);
  return { codigo, nombre, sucursalId: s.id, otraId: otra.id, otraNombre: "Otra " + codigo, general, admin, dir, encargado, sobres: p.sobres };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
const CONSULTAR = "Consultar · Consultar el reporte de caja: dónde está el efectivo, sus detalles e historial";
const DESCARGAR = "Consultar · Descargar el reporte de caja en Excel o PDF (solo donde también puede consultarlo)";

test("permisos de consulta y descarga, dónde está el efectivo al corte, detalle con el mismo corte y descargas con su historial", async ({ page }) => {
  const e = await escenario();

  // Nadie lo tiene por su perfil: Administración no ve el reporte.
  await entrar(page, e.admin.correo);
  await expect(page.getByTestId("ir-reporte-caja")).toHaveCount(0);
  await page.goto("/reportes/caja");
  await expect(page.getByTestId("no-encontrada")).toBeVisible();

  // Dirección general se lo da desde «Usuarios, roles y permisos». Descargar exige consultar esa sucursal.
  await entrar(page, e.general.correo);
  await page.goto(`/usuarios/${e.admin.id}`);
  const dar = async (permiso: string, sucursales: string[], motivo: string) => {
    await page.getByTestId("abrir-dar_permiso").click();
    const f = page.getByTestId("formulario-dar_permiso");
    await f.getByLabel("Permiso").selectOption({ label: permiso });
    await f.getByLabel("Elegir sucursales (una o varias)").check();
    for (const s of sucursales) await f.getByLabel(s, { exact: true }).check();
    await f.getByLabel("Motivo").fill(motivo);
    await f.getByRole("button", { name: "Revisar cómo quedará" }).click();
    return f;
  };
  let f = await dar(DESCARGAR, [e.nombre], "Entrega el reporte mensual");
  await expect(f).toContainText("primero dale «Consultar el reporte de caja» en esas mismas sucursales");
  await page.reload();
  f = await dar(CONSULTAR, [e.nombre, e.otraNombre], "Revisa el efectivo de sus sucursales");
  await expect(f.getByTestId("gana")).toContainText("Consultar el reporte de caja");
  await f.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(page.getByRole("status")).toContainText("Cambio guardado");
  f = await dar(DESCARGAR, [e.nombre], "Entrega el reporte mensual");
  await expect(f.getByTestId("gana")).toContainText("Descargar el reporte de caja");
  await capturar(page, "caja-permiso-descargar");
  await f.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(page.getByRole("status")).toContainText("Cambio guardado");

  // Administración (no recoge): ve lo anotado de los sobres, con la leyenda, y el total marcado como incompleto.
  await entrar(page, e.admin.correo);
  await page.getByTestId("ir-reporte-caja").click();
  await expect(page.getByRole("heading", { name: "Reporte de caja", exact: true })).toBeVisible();
  await expect(page.getByTestId("resumen-sucursales")).toBeVisible();
  await page.getByTestId("filtros").getByLabel("Sucursal").selectOption({ label: e.nombre });
  await page.getByRole("button", { name: "Ver" }).click();
  await expect(page.getByTestId("lugar-bolsa_visitas")).toContainText("$300.00");
  await expect(page.getByTestId("lugar-cajon_mensualidades")).toContainText("Información incompleta");
  await expect(page.getByTestId(`sobre-${e.sobres[0].folio}`)).toContainText("$400.00");
  await expect(page.getByTestId("leyenda-anotados")).toContainText("Contiene importes anotados de sobres sin contar");
  await expect(page.getByTestId("total-etiqueta")).toHaveText("Total registrado al corte");
  await expect(page.getByTestId("total-caja")).toContainText("Incompleto");
  await expect(page.getByTestId("total-importe")).toHaveText("$4,050.00");
  // El aumento del fondo sin confirmar va aparte, con su estado y las personas; la bolsa sigue en $300.
  await expect(page.getByTestId("entradas-fondo")).toContainText("Pendiente de confirmar");
  await expect(page.getByTestId("entradas-fondo")).toContainText(`entrega ${e.dir.nombre}`);
  await expect(page.getByTestId("entradas-fondo")).toContainText("$200.00");
  await expect(page.getByTestId("lugar-bolsa_visitas")).not.toContainText("$500.00");
  // La diferencia del cierre, por revisar al corte.
  await expect(page.getByTestId("aparte").getByTestId("diferencia")).toContainText("Por revisar");
  const enlaceDiferencia = await page.getByTestId("aparte").getByTestId("diferencia").getByRole("link").getAttribute("href");
  const corteIso = new URL(enlaceDiferencia!, "http://x").searchParams.get("corte")!;
  await capturar(page, "caja-administracion");

  // El detalle conserva el corte.
  const corte = await page.getByTestId("corte").locator("b").innerText();
  await page.getByTestId(`sobre-${e.sobres[1].folio}`).getByRole("link").click();
  await expect(page.getByRole("heading", { name: `Sobre ${e.sobres[1].folio}` })).toBeVisible();
  await expect(page.getByTestId("al-corte")).toContainText("En el buzón, por recoger");
  await expect(page.getByTestId("corte-detalle")).toContainText(`Corte: ${corte}`);
  await expect(page.getByTestId("historial-detalle")).toContainText("Registró que lo depositó en el buzón");
  await page.getByRole("link", { name: /← Reporte de caja/ }).click();

  // Después del corte, el Encargado revisa la diferencia: el detalle abierto con ese corte la sigue mostrando por revisar.
  const [dif] = await sql<{ id: string }[]>`select d.id from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id where l.sucursal_id = ${e.sucursalId}`;
  expect(await revisarDiferencia(sql, e.encargado.id, e.codigo, { diferenciaId: dif.id, resultado: "faltante_confirmado", motivo: "Prueba: faltan 20 pesos" }, PRUEBAS))
    .toMatchObject({ ok: true });
  await page.goto(enlaceDiferencia!);
  await expect(page.getByTestId("al-corte")).toContainText("Estado al corte: Por revisar");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cierre del");
  await expect(page.getByTestId("evento-despues")).toContainText("Después del corte");
  await expect(page.getByTestId("evento-despues")).toContainText("Revisó: Faltante confirmado");
  await capturar(page, "caja-diferencia-al-corte");
  await page.getByRole("link", { name: /← Reporte de caja/ }).click();
  await expect(page.getByTestId("aparte").getByTestId("diferencia")).toContainText("Por revisar");

  // Descargas: Excel y PDF, con el mismo corte; quedan en el historial.
  const descargar = async (formato: string) => {
    const f2 = page.getByTestId("descargar");
    await f2.getByLabel(formato, { exact: false }).check();
    const [d] = await Promise.all([page.waitForEvent("download"), f2.getByTestId("boton-descargar").click()]);
    return d;
  };
  const xlsx = await descargar("Excel (.xlsx)");
  expect(xlsx.suggestedFilename()).toMatch(new RegExp(`^reporte-caja-${e.codigo}-.*\\.xlsx$`));
  expect((await readFile((await xlsx.path())!)).subarray(0, 2).toString()).toBe("PK");
  const pdf = await descargar("PDF");
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  expect((await readFile((await pdf.path())!)).subarray(0, 5).toString()).toBe("%PDF-");
  await page.reload();
  await expect(page.getByTestId("historial-descargas")).toContainText(e.admin.nombre);
  await expect(page.getByTestId("historial-descargas").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("historial-descargas")).toContainText("«Contiene importes anotados de sobres sin contar»");

  // Con «Todas mis sucursales» solo se incluye la que puede descargar, y lo avisa.
  await page.getByTestId("filtros").getByLabel("Sucursal").selectOption({ label: "Todas mis sucursales" });
  await page.getByRole("button", { name: "Ver" }).click();
  await expect(page.getByTestId("descarga-incluidas")).toContainText(`Se incluyen: ${e.nombre}`);
  await expect(page.getByTestId("descarga-incluidas")).toContainText(`No se incluyen (sin permiso de descarga): ${e.otraNombre}`);
  await expect(page.getByTestId(`resumen-${"O" + e.codigo.slice(1)}`)).toContainText("Sin datos");
  await capturar(page, "caja-todas");

  // La otra sucursal no tiene turnos: «Sin datos», nunca $0.00, y el recuadro es un subtotal.
  await page.getByTestId("filtros").getByLabel("Sucursal").selectOption({ label: e.otraNombre });
  await page.getByRole("button", { name: "Ver" }).click();
  await expect(page.getByTestId("etapa-1").getByTestId("sin-datos")).toHaveCount(2);
  await expect(page.getByTestId("etapa-1")).not.toContainText("$0.00");
  await expect(page.getByTestId("total-etiqueta")).toHaveText("Subtotal visible al corte");
  await expect(page.getByTestId("total-caja")).toContainText("faltan 2 lugares sin datos");
  await page.getByTestId("lugar-bolsa_visitas").getByRole("link").click();
  await expect(page.getByTestId("filas-detalle").getByTestId("sin-datos")).toBeVisible();
  await capturar(page, "caja-sin-datos");

  // Dirección con la consulta (sin descarga): conteo a ciegas, subtotal visible, sin botón de descargar.
  const r = await aplicarCambio(sql, e.general.id, e.dir.id, {
    tipo: "dar_permiso", permiso: "reporte.caja", alcance: { todas: false, sucursales: [e.sucursalId] }, limite: "", hasta: "", motivo: "Revisa el efectivo de Tenango",
  }, PRUEBAS);
  expect(r).toEqual({ ok: true });
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("reporte-caja").click();
  await expect(page.getByTestId(`sobre-${e.sobres[0].folio}`)).toContainText("importe oculto hasta contarlo");
  await expect(page.getByTestId("aviso-ciegas")).toBeVisible();
  await expect(page.getByTestId("total-etiqueta")).toHaveText("Subtotal visible al corte");
  await expect(page.getByTestId("total-caja")).toContainText("No es el total");
  await expect(page.getByTestId("total-importe")).toContainText("$600.00");
  await expect(page.getByTestId("descargar")).toHaveCount(0);
  await expect(page.getByTestId("leyenda-anotados")).toHaveCount(0);
  await capturar(page, "caja-direccion-ciegas");
  await page.getByTestId(`sobre-${e.sobres[0].folio}`).getByRole("link").click();
  await expect(page.getByTestId("filas-detalle")).toContainText("Oculto: sin contar");
  await expect(page.getByTestId("historial-detalle")).toContainText("importe oculto hasta contarlo");
  await expect(page.getByTestId("historial-detalle")).not.toContainText("$400");

  // Al recoger, lo contado pasa a «Confirmado, por depositar» y la diferencia va aparte.
  const recogida = await recogerBuzon(sql, e.dir.id, e.codigo, { sobres: [
    { sobreId: e.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "400" },
    { sobreId: e.sobres[1].id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
  ], llave: LLAVE }, PRUEBAS);
  expect(recogida).toMatchObject({ ok: true });
  await page.goto(`/reportes/caja?sucursal=${e.codigo}`);
  await expect(page.getByTestId("etapa-4")).toContainText("$3,400.00");
  await expect(page.getByTestId("total-etiqueta")).toHaveText("Total registrado al corte");
  await expect(page.getByTestId("aparte").getByTestId("diferencia").filter({ hasText: "−$50.00" })).toBeVisible();
  await capturar(page, "caja-direccion-recogido");

  // Con el corte anterior a la recolección, su tabla no muestra conteos: aparecen solo como información posterior.
  const [rec] = await sql<{ id: string }[]>`select id from recoleccion where sucursal_id = ${e.sucursalId}`;
  await page.goto(`/reportes/caja/detalle?${new URLSearchParams({ sucursal: e.codigo, corte: corteIso, tipo: "recoleccion", id: rec.id })}`);
  await expect(page.getByTestId("al-corte")).toContainText("Aún no se registraba al corte: sus sobres seguían por recoger");
  await expect(page.getByTestId("importe-al-corte")).toHaveCount(0);
  await expect(page.getByTestId("al-corte").getByRole("table")).toContainText("Contado al corte");
  await expect(page.getByTestId("al-corte").getByRole("table")).not.toContainText("$3,000.00");
  await expect(page.getByTestId("al-corte").getByRole("table").getByText("Sin contar al corte")).toHaveCount(2);
  await expect(page.getByTestId("evento-despues").filter({ hasText: "contó $3,000.00" })).toBeVisible();
  await expect(page.getByTestId("evento")).toHaveCount(0);
  await capturar(page, "caja-recoleccion-al-corte");
});

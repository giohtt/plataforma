import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { abrirDesdeCierre, cerrarDia, cierrePendiente, configurarCustodia, prepararCierre } from "../../src/lib/cierres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { revisarDiferencia } from "../../src/lib/diferencias";
import { cambiarMontoFondo, confirmarEntradaFondo } from "../../src/lib/fondos";
import { recogerBuzon, registrarDepositoRecoleccion, revisarDiferenciaSobre } from "../../src/lib/recolecciones";
import { confirmarRetiro, generarFolio, recontarRetiro, registrarDeposito, registrarRetiro, revisarRetiro } from "../../src/lib/retiros";
import { abrirTurno } from "../../src/lib/turnos";
import { aplicarCambio } from "../../src/lib/usuarios";

/** Abre un grupo del menú de la sucursal (vienen cerrados salvo «Efectivo y depósitos»). */
async function abrirGrupo(page: import("@playwright/test").Page, grupo: string) {
  const g = page.getByTestId(`grupo-${grupo}`);
  if ((await g.getAttribute("open")) === null) await page.getByTestId(`abrir-grupo-${grupo}`).click();
}

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
/** Elige sucursal (y periodo) desde «Cambiar sucursal o periodo». */
async function elegir(page: Page, sucursal: string) {
  if (await page.getByTestId("descargar").isVisible()) await page.getByTestId("cerrar-descarga").click();
  const d = page.getByTestId("cambiar");
  if ((await d.getAttribute("open")) === null) await d.locator("summary").click();
  await page.getByTestId("filtros").getByLabel("Sucursal").selectOption({ label: sucursal });
  await page.getByRole("button", { name: "Ver" }).click();
}
/** Abre el panel de descarga si está cerrado. */
async function abrirDescarga(page: Page) {
  if (!(await page.getByTestId("descargar").isVisible())) await page.getByTestId("abrir-descarga").click();
  await expect(page.getByTestId("descargar")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Caja y depósitos", exact: true })).toBeVisible();
  await expect(page.getByTestId("resumen-sucursales")).toBeVisible();
  await elegir(page, e.nombre);
  // Efectivo al corte: solo los renglones con algo; lo que está en cero, agrupado en una línea.
  await expect(page.getByTestId("renglon-1-importe")).toHaveText("$600.00");
  await expect(page.getByTestId("renglon-1")).toContainText("Bolsa $300.00 · Cajón $300.00");
  await expect(page.getByTestId("renglon-2-importe")).toHaveText("$3,450.00");
  await expect(page.getByTestId("renglon-2")).toContainText("2 sobres");
  await expect(page.getByTestId("efectivo-ceros")).toHaveText("Sin pendientes: 0 entregas por confirmar · nada por depositar.");
  await expect(page.getByTestId("total-nota")).toContainText("el cajón cuenta con su último conteo");
  await expect(page.getByTestId("leyenda-anotados")).toContainText("Contiene importes anotados de sobres sin contar");
  await expect(page.getByTestId("total-etiqueta")).toHaveText("Total registrado al corte");
  await expect(page.getByTestId("total-caja")).toContainText("Incompleto");
  await expect(page.getByTestId("total-importe")).toHaveText("$4,050.00");
  await expect(page.getByTestId("depositado-importe")).toHaveText("$0.00");
  // El aumento del fondo sin confirmar y la diferencia del cierre van aparte, en «Requiere atención».
  await expect(page.getByTestId("atencion-entradas")).toContainText("$200.00");
  await expect(page.getByTestId("atencion-por_revisar")).toContainText("−$20.00");
  await expect(page.getByTestId("renglon-1")).not.toContainText("$500.00");
  await capturar(page, "caja-administracion");

  // Segundo nivel, con el mismo corte: por folio (con quién lo tiene y antigüedad) y diferencias con su clave.
  const corte = await page.getByTestId("corte").locator("b").last().innerText();
  await page.getByTestId("ir-folio").click();
  await expect(page.getByRole("heading", { name: "Más detalle" })).toBeVisible();
  await expect(page.getByTestId("corte")).toContainText(corte);
  await expect(page.getByTestId(`folio-${e.sobres[0].folio}`)).toContainText("$400.00");
  await expect(page.getByTestId(`folio-${e.sobres[0].folio}`)).toContainText("En el buzón");
  await expect(page.getByTestId("folio-Aumento del fondo · Bolsa de visitas")).toContainText(`${e.dir.nombre} (la entrega)`);
  await capturar(page, "caja-por-folio");
  await page.getByTestId("filtros-folio").getByLabel("Etapa").selectOption({ label: "2. Sobres por recoger" });
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page.getByTestId("tabla-folios").locator("tbody tr")).toHaveCount(2);
  await page.getByRole("link", { name: "Diferencias", exact: true }).click();
  await expect(page.getByTestId("diferencia")).toContainText("D-1");
  await expect(page.getByTestId("diferencia")).toContainText("Por revisar");
  const enlaceDiferencia = await page.getByTestId("diferencia").getByRole("link").getAttribute("href");
  const corteIso = new URL(enlaceDiferencia!, "http://x").searchParams.get("corte")!;

  // El detalle conserva el corte.
  await page.getByRole("link", { name: "Por folio", exact: true }).click();
  await page.getByTestId(`folio-${e.sobres[1].folio}`).getByRole("link").click();
  await expect(page.getByRole("heading", { name: `Sobre ${e.sobres[1].folio}` })).toBeVisible();
  await expect(page.getByTestId("al-corte")).toContainText("En el buzón, por recoger");
  await expect(page.getByTestId("corte-detalle")).toContainText(`Corte: ${corte}`);
  await expect(page.getByTestId("historial-detalle")).toContainText("Registró que lo depositó en el buzón");
  await page.getByRole("link", { name: /← Caja y depósitos/ }).click();

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
  await page.getByRole("link", { name: /← Caja y depósitos/ }).click();
  await expect(page.getByTestId("atencion-por_revisar")).toContainText("−$20.00");

  // Descargas: Excel y PDF, con el mismo corte; quedan en el historial.
  // El panel de descarga se abre al tocar «Descargar» y se cierra con «Cerrar».
  await abrirDescarga(page);
  await capturar(page, "caja-descargar-abierto");
  await page.getByTestId("cerrar-descarga").click();
  await expect(page.getByTestId("descargar")).toHaveCount(0);
  const descargar = async (formato: string) => {
    await abrirDescarga(page);
    const f2 = page.getByTestId("descargar");
    await f2.getByLabel(formato, { exact: false }).check();
    const [d] = await Promise.all([page.waitForEvent("download"), f2.getByTestId("boton-descargar").click()]);
    return d;
  };
  const xlsx = await descargar("Excel (.xlsx)");
  expect(xlsx.suggestedFilename()).toMatch(new RegExp(`^caja-y-depositos-${e.codigo}-.*\\.xlsx$`));
  expect((await readFile((await xlsx.path())!)).subarray(0, 2).toString()).toBe("PK");
  const pdf = await descargar("PDF");
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  expect((await readFile((await pdf.path())!)).subarray(0, 5).toString()).toBe("%PDF-");
  await page.getByTestId("ir-descargas").click();
  await expect(page.getByTestId("historial-descargas")).toContainText(e.admin.nombre);
  await expect(page.getByTestId("historial-descargas").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("historial-descargas")).toContainText("«Contiene importes anotados de sobres sin contar»");
  await page.getByRole("link", { name: /← Caja y depósitos/ }).click();

  // Con «Todas mis sucursales» solo se incluye la que puede descargar, y lo avisa.
  await elegir(page, "Todas mis sucursales");
  await abrirDescarga(page);
  await expect(page.getByTestId("descarga-incluidas")).toContainText(`Se incluyen: ${e.nombre}`);
  await expect(page.getByTestId("descarga-incluidas")).toContainText(`No se incluyen (sin permiso de descarga): ${e.otraNombre}`);
  await expect(page.getByTestId(`resumen-${"O" + e.codigo.slice(1)}`)).toContainText("Sin datos");
  await capturar(page, "caja-todas");

  // La otra sucursal no tiene turnos ni ningún importe: «Sin datos», nunca $0.00; sin registros de sobres, $0.00.
  await elegir(page, e.otraNombre);
  await expect(page.getByTestId("renglon-1-importe")).toHaveText("Sin datos");
  await expect(page.getByTestId("efectivo-ceros")).toHaveText("Sin pendientes: 0 sobres registrados por recoger · 0 entregas por confirmar · nada por depositar.");
  await expect(page.getByTestId("total-etiqueta")).toHaveText("Total al corte");
  await expect(page.getByTestId("total-importe")).toHaveText("Sin datos");
  await expect(page.getByTestId("total-nota")).toContainText("no hay ningún importe conocido");
  await capturar(page, "caja-sin-datos");
  await page.getByTestId("ir-folio").click();
  await page.getByTestId("folio-Bolsa de visitas").getByRole("link").click();
  await expect(page.getByTestId("filas-detalle").getByTestId("sin-datos")).toBeVisible();

  // Dirección con la consulta (sin descarga): conteo a ciegas, subtotal visible, sin botón de descargar.
  const r = await aplicarCambio(sql, e.general.id, e.dir.id, {
    tipo: "dar_permiso", permiso: "reporte.caja", alcance: { todas: false, sucursales: [e.sucursalId] }, limite: "", hasta: "", motivo: "Revisa el efectivo de Tenango",
  }, PRUEBAS);
  expect(r).toEqual({ ok: true });
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  // Menú de Dirección: solo «Efectivo y depósitos» abierto; «Lo que puedes hacer en esta sucursal», cerrado.
  await expect(page.getByTestId("abrir-grupo-autorizaciones")).toContainText("Autorizaciones y accesos");
  await expect(page.getByTestId("permisos-sucursal")).toBeHidden();
  await capturar(page, "menu-direccion-cerrado");
  await abrirGrupo(page, "autorizaciones");
  await abrirGrupo(page, "configuracion");
  await capturar(page, "menu-direccion-abierto");
  await abrirGrupo(page, "reportes");
  await page.getByTestId("reporte-caja").click();
  await expect(page.getByTestId("renglon-2-importe")).toHaveText("Oculto: sin contar");
  await expect(page.getByTestId("renglon-2")).toContainText("importe oculto hasta contarlos");
  await expect(page.getByTestId("aviso-ciegas")).toBeVisible();
  await expect(page.getByTestId("total-etiqueta")).toHaveText("Subtotal visible al corte");
  await expect(page.getByTestId("total-caja")).toContainText("No es el total: faltan 2 importes ocultos");
  await expect(page.getByTestId("total-importe")).toContainText("$600.00");
  await expect(page.getByTestId("abrir-descarga")).toHaveCount(0);
  await expect(page.getByTestId("leyenda-anotados")).toHaveCount(0);
  await capturar(page, "caja-direccion-ciegas");
  await page.getByTestId("ir-folio").click();
  await expect(page.getByTestId(`folio-${e.sobres[0].folio}`)).toContainText("Oculto: sin contar");
  await expect(page.getByTestId("tabla-folios")).not.toContainText("$400");
  await page.getByTestId(`folio-${e.sobres[0].folio}`).getByRole("link").click();
  await expect(page.getByTestId("filas-detalle")).toContainText("Oculto: sin contar");
  await expect(page.getByTestId("historial-detalle")).toContainText("importe oculto hasta contarlo");
  await expect(page.getByTestId("historial-detalle")).not.toContainText("$400");

  // Al recoger, lo contado pasa a «Confirmado, por depositar» y la diferencia va aparte, ligada a su origen por la clave.
  const recogida = await recogerBuzon(sql, e.dir.id, e.codigo, { sobres: [
    { sobreId: e.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "400" },
    { sobreId: e.sobres[1].id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
  ], llave: LLAVE }, PRUEBAS);
  expect(recogida).toMatchObject({ ok: true });
  await page.goto(`/reportes/caja?sucursal=${e.codigo}`);
  await expect(page.getByTestId("renglon-4-importe")).toHaveText("$3,400.00");
  await expect(page.getByTestId("total-etiqueta")).toHaveText("Total registrado al corte");
  await expect(page.getByTestId("por-persona").getByTestId("persona")).toContainText(e.dir.nombre);
  await expect(page.getByTestId("por-persona").getByTestId("persona")).toContainText("$3,400.00");
  await capturar(page, "caja-direccion-recogido");
  await page.getByTestId("ir-origen").click();
  await expect(page.getByTestId("origen-cuerpo")).toBeHidden();
  await page.getByTestId("origen").locator("summary").click();
  await expect(page.getByTestId("origen-cuerpo")).toContainText("Anotado $3,450.00");
  await expect(page.getByTestId("origen-cuerpo")).toContainText("diferencia −$50.00 (D-2)");
  await expect(page.getByTestId("origen-saldo")).toHaveText("$3,400.00");
  await page.getByRole("link", { name: "Diferencias", exact: true }).click();
  await expect(page.getByTestId("diferencia").filter({ hasText: "−$50.00" })).toBeVisible();

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

test("casos de la maqueta 7: depósitos parciales antes y durante el periodo, y sin conteos con dinero por depositar", async ({ page }) => {
  const e = await escenario();
  const encargada = await cuenta(`Encargada de retiros ${id()}`, "encargada_retiros", e.sucursalId);
  for (const permiso of ["reporte.caja", "reporte.caja_descargar"]) {
    expect(await aplicarCambio(sql, e.general.id, e.admin.id, { tipo: "dar_permiso", permiso, alcance: { todas: false, sucursales: [e.sucursalId] }, limite: "", hasta: "", motivo: "Prueba de los casos" }, PRUEBAS))
      .toEqual({ ok: true });
  }
  const fecha = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(d);
  const hoy = fecha(new Date());
  // Caso A: la recolección (contado $3,400, −$50) y un retiro de $280 se confirmaron hace tres días y se depositaron en partes.
  const rec = await recogerBuzon(sql, e.dir.id, e.codigo, { sobres: [
    { sobreId: e.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "400" },
    { sobreId: e.sobres[1].id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
  ], llave: LLAVE }, PRUEBAS);
  expect(rec).toMatchObject({ ok: true });
  const [{ id: rid }] = await sql<{ id: string }[]>`select id from recoleccion where sucursal_id = ${e.sucursalId}`;
  const depRec = (importe: string, referencia: string) => registrarDepositoRecoleccion(sql, e.dir.id, e.codigo, { recoleccionId: rid, importe, fecha: hoy, referencia }, PRUEBAS);
  expect(await depRec("400", "DEP-ANTES-01")).toMatchObject({ ok: true });
  const [turno] = await sql<{ id: string; abrio: string }[]>`select id, abierto_por as abrio from turno where sucursal_id = ${e.sucursalId} and cerrado_en is null`;
  const folio = await generarFolio(sql, turno.abrio, e.codigo, { turnoId: turno.id, lugar: "cajon_mensualidades" }, PRUEBAS);
  if (!folio.ok) throw new Error(folio.error);
  const ret = await registrarRetiro(sql, turno.abrio, e.codigo, { turnoId: turno.id, folioId: folio.folioId, contado: "280", cambio: "0", encargada: encargada.id }, PRUEBAS);
  if (!ret.ok) throw new Error(ret.error);
  expect(await confirmarRetiro(sql, encargada.id, { retiroId: ret.retiroId, version: 1, importe: "280", folioCoincide: true, folioEnSobre: "", motivo: "" }, PRUEBAS))
    .toMatchObject({ ok: true });
  const ahoraLocal = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Mexico_City", dateStyle: "short", timeStyle: "short" }).format(new Date()).replace(" ", "T");
  const depRet = (importe: string, referencia: string) =>
    registrarDeposito(sql, encargada.id, { retiroId: ret.retiroId, importe, depositadoEn: ahoraLocal(), referencia, corrige: null, motivo: "" }, PRUEBAS);
  expect(await depRet("100", "DEP-ANTES-02")).toMatchObject({ ok: true });
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recoleccion set creada_en = creada_en - interval '3 days', resuelta_en = resuelta_en - interval '3 days' where id = ${rid}`;
    await tx`update diferencia_sobre set creada_en = creada_en - interval '3 days' where recoleccion_id = ${rid}`;
    await tx`update deposito_recoleccion set en = en - interval '3 days', fecha = fecha - 3 where recoleccion_id = ${rid}`;
    await tx`update retiro set entregado_en = entregado_en - interval '3 days', habilitado_en = habilitado_en - interval '3 days' where id = ${ret.retiroId}`;
    await tx`update retiro_conteo set en = en - interval '3 days' where retiro_id = ${ret.retiroId}`;
    await tx`update deposito_retiro set en = en - interval '3 days', depositado_en = depositado_en - interval '3 days' where retiro_id = ${ret.retiroId}`;
  });
  expect(await depRec("1000", "DEP-DURANTE-01")).toMatchObject({ ok: true });
  expect(await depRec("1000", "DEP-DURANTE-02")).toMatchObject({ ok: true });
  expect(await depRet("120", "DEP-DURANTE-03")).toMatchObject({ ok: true });
  expect(await depRet("40", "DEP-DURANTE-04")).toMatchObject({ ok: true });

  await entrar(page, e.admin.correo);
  await page.goto(`/reportes/caja?${new URLSearchParams({ sucursal: e.codigo, desde: hoy, hasta: hoy })}`);
  await expect(page.getByTestId("depositado-importe")).toHaveText("$2,160.00");
  await expect(page.getByTestId("renglon-4-importe")).toHaveText("$1,020.00");
  await expect(page.getByTestId("atencion-atrasados")).toContainText("Ver folios");
  await expect(page.getByTestId("por-persona")).toContainText("$1,000.00 de 3 a 7 días");
  await capturar(page, "caso-a-resumen");
  await page.getByTestId("ir-origen").click();
  const filas = page.getByTestId("origen");
  await expect(filas).toHaveCount(2);
  await expect(filas.nth(0)).toContainText("Anterior al periodo");
  await expect(filas.nth(0).locator("summary")).toContainText("$2,000.00");
  await expect(filas.nth(0).locator("summary")).not.toContainText("$400.00");
  await filas.nth(0).locator("summary").click();
  await expect(filas.nth(0).getByTestId("origen-cuerpo")).toContainText("antes del periodo");
  await expect(filas.nth(0).getByTestId("origen-cuerpo")).toContainText("$400.00");
  await expect(filas.nth(0).getByTestId("origen-cuerpo").locator("tbody tr")).toHaveCount(3);
  await expect(page.getByTestId("origen-durante")).toHaveText("$2,160.00");
  await expect(page.getByTestId("origen-saldo")).toHaveText("$1,020.00");
  await capturar(page, "caso-a-origen-destino");

  // Caso B (otra sucursal): sin conteos al corte (el periodo termina ayer; sus turnos son de hoy) y un retiro de $300
  // confirmado hace dos días, por depositar.
  const b = await escenario();
  for (const permiso of ["reporte.caja", "reporte.caja_descargar"]) {
    expect(await aplicarCambio(sql, b.general.id, b.admin.id, { tipo: "dar_permiso", permiso, alcance: { todas: false, sucursales: [b.sucursalId] }, limite: "", hasta: "", motivo: "Prueba de los casos" }, PRUEBAS))
      .toEqual({ ok: true });
  }
  const encargadaB = await cuenta(`Encargada de retiros ${id()}`, "encargada_retiros", b.sucursalId);
  const [turnoB] = await sql<{ id: string; abrio: string }[]>`select id, abierto_por as abrio from turno where sucursal_id = ${b.sucursalId} and cerrado_en is null`;
  const folioB = await generarFolio(sql, turnoB.abrio, b.codigo, { turnoId: turnoB.id, lugar: "bolsa_visitas" }, PRUEBAS);
  if (!folioB.ok) throw new Error(folioB.error);
  const retB = await registrarRetiro(sql, turnoB.abrio, b.codigo, { turnoId: turnoB.id, folioId: folioB.folioId, contado: "300", cambio: "0", encargada: encargadaB.id }, PRUEBAS);
  if (!retB.ok) throw new Error(retB.error);
  expect(await confirmarRetiro(sql, encargadaB.id, { retiroId: retB.retiroId, version: 1, importe: "300", folioCoincide: true, folioEnSobre: "", motivo: "" }, PRUEBAS))
    .toMatchObject({ ok: true });
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update retiro set entregado_en = entregado_en - interval '2 days', habilitado_en = habilitado_en - interval '2 days' where id = ${retB.retiroId}`;
    await tx`update retiro_conteo set en = en - interval '2 days' where retiro_id = ${retB.retiroId}`;
  });
  await entrar(page, b.admin.correo);
  const ayer = fecha(new Date(Date.now() - 86_400_000));
  const hace3 = fecha(new Date(Date.now() - 3 * 86_400_000));
  await page.goto(`/reportes/caja?${new URLSearchParams({ sucursal: b.codigo, desde: hace3, hasta: ayer })}`);
  await expect(page.getByTestId("renglon-1-importe")).toHaveText("Sin datos");
  await expect(page.getByTestId("efectivo-ceros")).toHaveText("Sin pendientes: 0 sobres registrados por recoger · 0 entregas por confirmar.");
  await expect(page.getByTestId("renglon-4-importe")).toHaveText("$300.00");
  await expect(page.getByTestId("total-etiqueta")).toHaveText("Subtotal visible al corte");
  await expect(page.getByTestId("total-importe")).toHaveText("$300.00");
  await expect(page.getByTestId("total-nota")).toContainText("No es el total: faltan los datos de bolsa y cajón (sin conteos registrados)");
  await capturar(page, "caso-b-sin-conteos");
});

test("pendientes por etapa: Dirección resuelve el faltante de un retiro; el del sobre en que participó lo resuelve otra cuenta", async ({ page }) => {
  const e = await escenario();
  expect(await aplicarCambio(sql, e.general.id, e.dir.id, { tipo: "dar_permiso", permiso: "reporte.caja", alcance: { todas: false, sucursales: [e.sucursalId] }, limite: "", hasta: "", motivo: "Revisa el efectivo" }, PRUEBAS))
    .toEqual({ ok: true });
  // Sobre: Dirección recoge el buzón (participa) y cuenta $50 menos; Administración confirma el faltante.
  expect(await recogerBuzon(sql, e.dir.id, e.codigo, { sobres: [
    { sobreId: e.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "400" },
    { sobreId: e.sobres[1].id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
  ], llave: LLAVE }, PRUEBAS)).toMatchObject({ ok: true });
  const [difSobre] = await sql<{ id: string }[]>`select d.id from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id where s.sucursal_id = ${e.sucursalId}`;
  expect(await revisarDiferenciaSobre(sql, e.admin.id, e.codigo, { diferenciaId: difSobre.id, resultado: "faltante_confirmado", motivo: "Prueba: faltan 50 pesos" }, PRUEBAS))
    .toEqual({ ok: true });
  // Retiro: se registran $280, Encargada de retiros cuenta $250 y el Encargado confirma el faltante.
  const encargada = await cuenta(`Encargada de retiros ${id()}`, "encargada_retiros", e.sucursalId);
  const [turno] = await sql<{ id: string; abrio: string }[]>`select id, abierto_por as abrio from turno where sucursal_id = ${e.sucursalId} and cerrado_en is null`;
  const folio = await generarFolio(sql, turno.abrio, e.codigo, { turnoId: turno.id, lugar: "cajon_mensualidades" }, PRUEBAS);
  if (!folio.ok) throw new Error(folio.error);
  const ret = await registrarRetiro(sql, turno.abrio, e.codigo, { turnoId: turno.id, folioId: folio.folioId, contado: "280", cambio: "0", encargada: encargada.id }, PRUEBAS);
  if (!ret.ok) throw new Error(ret.error);
  const version = async () => (await sql<{ version: number }[]>`select version from retiro where id = ${ret.retiroId}`)[0].version;
  await confirmarRetiro(sql, encargada.id, { retiroId: ret.retiroId, version: await version(), importe: "250", folioCoincide: true, folioEnSobre: "", motivo: "" }, PRUEBAS);
  await recontarRetiro(sql, encargada.id, { retiroId: ret.retiroId, version: await version(), recontaron: false, importe: null, con: null, motivo: "Prueba: Recepción ya se fue" }, PRUEBAS);
  expect(await revisarRetiro(sql, e.encargado.id, e.codigo, { retiroId: ret.retiroId, version: await version(), resultado: "faltante_confirmado", motivo: "Prueba: el sobre trae 250", montoVerificado: "250" }, PRUEBAS))
    .toEqual({ ok: true });

  // En el reporte: «Por revisar» (el cierre con $20 menos) y «Pendiente de resolución» (dos casos, cada uno con su importe).
  await entrar(page, e.dir.correo);
  await page.goto(`/reportes/caja?sucursal=${e.codigo}`);
  await expect(page.getByTestId("atencion-por_revisar")).toContainText("Por revisar");
  await expect(page.getByTestId("atencion-pendiente_resolucion")).toContainText("2Pendiente de resolución");
  await expect(page.getByTestId("atencion-pendiente_resolucion")).toContainText(`Faltante del retiro ${folio.folio} −$30.00`);
  await expect(page.getByTestId("atencion-pendiente_resolucion")).toContainText(`Faltante del sobre ${e.sobres[1].folio} −$50.00`);
  await capturar(page, "pendientes-por-etapa");
  await page.getByTestId("atencion-pendiente_resolucion").getByRole("link", { name: "Ver casos" }).click();
  await expect(page.getByTestId("etapa-pendiente_resolucion").getByTestId("diferencia")).toHaveCount(2);
  await capturar(page, "diferencias-por-etapa");

  // Dirección no participó en el retiro: lo resuelve desde el retiro, con motivo.
  await page.getByTestId("etapa-pendiente_resolucion").getByTestId("diferencia").filter({ hasText: "Retiro" }).getByRole("link", { name: "Ir a resolver" }).click();
  await expect(page.getByTestId("faltante-direccion")).toContainText("Faltante de $30.00: pendiente para Dirección");
  const f = page.getByTestId("resolver-faltante");
  await f.getByRole("button", { name: "Registrar resolución" }).click();
  await expect(f.getByRole("alert")).toBeVisible();
  await f.getByLabel("Motivo (obligatorio)").fill("Prueba: lo absorbe la sucursal");
  await capturar(page, "resolver-retiro");
  await f.getByRole("button", { name: "Registrar resolución" }).click();
  await expect(page.getByRole("status")).toContainText("Resolución registrada");
  await expect(page.getByTestId("faltante-resuelto")).toContainText("Lo absorbe la sucursal");
  await expect(page.getByTestId("estado-retiro")).toHaveText("Revisado · faltante resuelto por Dirección");
  await expect(page.getByTestId("historial-retiro")).toContainText("Dirección resolvió el faltante: Lo absorbe la sucursal");
  await expect(page.getByTestId("sin-destino")).toHaveText("$250.00");

  // En el sobre participó: no ve el formulario, aunque tenga autorización para revisar lo propio.
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  const tarjeta = page.getByTestId(`diferencia-${e.sobres[1].folio}`);
  await expect(tarjeta.getByTestId("faltante-direccion")).toBeVisible();
  await expect(tarjeta.getByTestId("resuelve-otra-cuenta")).toContainText("lo resuelve otra cuenta de Dirección que no participó");
  await expect(tarjeta.getByTestId("resolver-faltante")).toHaveCount(0);
  await capturar(page, "sobre-participo");

  // De vuelta en el reporte: queda un caso pendiente de resolución; el efectivo no cambió.
  await page.goto(`/reportes/caja?sucursal=${e.codigo}`);
  await expect(page.getByTestId("atencion-pendiente_resolucion")).toContainText("1Pendiente de resolución");
  await expect(page.getByTestId("atencion-pendiente_resolucion")).not.toContainText("retiro");
});

test("autorización para resolver lo propio: se otorga expresamente con vista previa; quien participó resuelve el sobre y queda marcado", async ({ page }) => {
  const e = await escenario();
  expect(await aplicarCambio(sql, e.general.id, e.dir.id, { tipo: "dar_permiso", permiso: "reporte.caja", alcance: { todas: false, sucursales: [e.sucursalId] }, limite: "", hasta: "", motivo: "Revisa el efectivo" }, PRUEBAS))
    .toEqual({ ok: true });
  expect(await recogerBuzon(sql, e.dir.id, e.codigo, { sobres: [
    { sobreId: e.sobres[0].id, estado: "correcto", folioVisto: "", motivo: "", contado: "400" },
    { sobreId: e.sobres[1].id, estado: "correcto", folioVisto: "", motivo: "", contado: "3000" },
  ], llave: LLAVE }, PRUEBAS)).toMatchObject({ ok: true });
  const [difSobre] = await sql<{ id: string }[]>`select d.id from diferencia_sobre d join sobre_cierre s on s.id = d.sobre_id where s.sucursal_id = ${e.sucursalId}`;
  expect(await revisarDiferenciaSobre(sql, e.admin.id, e.codigo, { diferenciaId: difSobre.id, resultado: "faltante_confirmado", motivo: "Prueba: faltan 50 pesos" }, PRUEBAS))
    .toEqual({ ok: true });

  // Quien administra accesos la otorga: una sucursal, hasta (máximo 90 días), motivo y vista previa.
  await entrar(page, e.general.correo);
  await page.goto(`/usuarios/${e.dir.id}`);
  const seccion = page.getByTestId("autorresolucion");
  await expect(seccion.getByTestId("autorresolucion-sin")).toContainText("quien participó no resuelve sus faltantes");
  await seccion.getByTestId("abrir-autorresolucion").click();
  const a = seccion.getByTestId("formulario-autorresolucion");
  const max = await a.getByLabel("Hasta").getAttribute("max");
  expect(await a.getByLabel("Hasta").inputValue()).toBe(max);
  await a.getByLabel("Una sucursal").check();
  await a.getByLabel(`Caja ${e.codigo}`, { exact: true }).check();
  await a.getByLabel("Motivo").fill("Prueba: no hay otra Dirección que resuelva");
  await a.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await expect(a.getByTestId("vista-previa")).toContainText("Puede resolver con «Lo absorbe la sucursal» faltantes ya confirmados de retiros y sobres en los que participó");
  await capturar(page, "autorresolucion-vista-previa");
  expect((await sql`select 1 from autorresolucion where usuario_id = ${e.dir.id}`).length).toBe(0);
  await a.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(seccion.getByTestId("autorresolucion-vigente")).toContainText(`Autorizada en Caja ${e.codigo}`);
  // La de revisar lo propio no se otorgó.
  await expect(page.getByTestId("autorrevision")).toContainText("Sin autorización");
  await capturar(page, "autorresolucion-otorgada");

  // Dirección, que participó en la cadena del sobre, ahora lo resuelve con la marca.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  const tarjeta = page.getByTestId(`diferencia-${e.sobres[1].folio}`);
  await expect(tarjeta.getByTestId("resolver-propio")).toContainText("quedará marcado «Resuelta por quien participó»");
  const f = tarjeta.getByTestId("resolver-faltante");
  await f.getByLabel("Motivo (obligatorio)").fill("Prueba: lo absorbe la sucursal");
  await capturar(page, "resolver-propio");
  await f.getByRole("button", { name: "Registrar resolución" }).click();
  await expect(page.getByRole("status")).toContainText("Resolución registrada");
  await expect(page.getByTestId(`diferencia-${e.sobres[1].folio}`).getByTestId("marca-resuelta-propia")).toHaveText("Resuelta por quien participó");
  await capturar(page, "resuelta-propia");

  // En el reporte: cerrada, con la marca; el efectivo no cambió.
  await page.goto(`/reportes/caja/mas?sucursal=${e.codigo}&vista=diferencias`);
  const cerrada = page.getByTestId("etapa-cerrada").getByTestId("diferencia").filter({ hasText: e.sobres[1].folio });
  await expect(cerrada.getByTestId("chip-resuelta-propia")).toHaveText("Resuelta por quien participó");
  // En pantalla la marca va una sola vez (la etiqueta); el texto del estado no la repite.
  await expect(cerrada).toContainText("Resuelta por Dirección · Lo absorbe la sucursal");
  expect(((await cerrada.textContent()) ?? "").split("Resuelta por quien participó")).toHaveLength(2);
  await expect(cerrada.getByTestId("importe-diferencia")).toHaveText("−$50.00");
  await capturar(page, "reporte-resuelta-propia");

  // Terminada: se bloquean nuevas resoluciones propias; la marca y el historial se conservan.
  const [vig] = await sql<{ id: string }[]>`select id from autorresolucion where usuario_id = ${e.dir.id} and revocada_en is null`;
  expect(await aplicarCambio(sql, e.general.id, e.dir.id, { tipo: "terminar_autorresolucion", id: vig.id, motivo: "Prueba: se termina" }, PRUEBAS)).toEqual({ ok: true });
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  await expect(page.getByTestId(`diferencia-${e.sobres[1].folio}`).getByTestId("marca-resuelta-propia")).toBeVisible();
  await entrar(page, e.general.correo);
  await page.goto("/usuarios?vista=historial");
  await expect(page.getByTestId("historial-accesos")).toContainText("Autorizó resolver faltantes en los que participó");
  await expect(page.getByTestId("historial-accesos")).toContainText("Terminó la autorización para resolver faltantes en los que participó");
});

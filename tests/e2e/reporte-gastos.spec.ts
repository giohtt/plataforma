import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { decidirGasto, registrarGastoPagado, registrarPago, solicitarGasto, entregarAnticipo } from "../../src/lib/gastos";
import { abrirTurno } from "../../src/lib/turnos";

/**
 * Bloque 6, PR 9 (28 nov 2026; solo datos ficticios; límites ficticios solo para la prueba): Dirección consulta el
 * reporte de gastos (cada gasto una vez, vistas, aparte, detalle por clave) y lo descarga; la caja muestra la sección
 * de gastos con fuera de caja y pendientes, cada gasto una vez en el total.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));
const PRUEBAS = { entorno: "pruebas" as const };
const CLAVE = "frase para probar el reporte de gastos 2026";
const id = () => randomUUID().slice(0, 8);
const hoy = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
async function cuenta(nombre: string, rol: string, sucursal: string | null) {
  const correo = `rgastos-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  if (sucursal) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${sucursal}, 'Prueba del reporte de gastos')`;
  else await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${rol}, 'Prueba del reporte de gastos')`;
  return { id: u.id, correo, nombre };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("reporte de gastos: total una vez, vistas, aparte, detalle y descarga; la caja con fuera de caja y pendientes", async ({ page }) => {
  test.setTimeout(150_000);
  const codigo = `R${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Reporte gastos " + codigo}, ${codigo}) returning id`;
  const rec = await cuenta(`Recepción ${id()}`, "recepcion", s.id);
  const enc = await cuenta(`Encargado ${id()}`, "encargado", s.id);
  const adm = await cuenta(`Administración ${id()}`, "administracion", s.id);
  const dir = await cuenta(`Dirección ${id()}`, "direccion", null);
  await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo) values (${enc.id}, 'autorizacion.gasto', ${s.id}, 1000, 9000, 'Prueba')`;
  await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, motivo) values (${dir.id}, 'reporte.caja', ${s.id}, 'Prueba')`;
  const t = await abrirTurno(sql, rec.id, codigo, { bolsa: "1000.00", cajon: "0.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const solicitar = async (concepto: string, importe: string) => {
    const r = await solicitarGasto(sql, adm.id, codigo, { concepto, categoria: "prueba_limpieza", importe, proveedor: "", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const d = await decidirGasto(sql, enc.id, codigo, { clave: r.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS);
    if (!d.ok) throw new Error(d.error);
    return r.clave;
  };
  // G1: bolsa, comprobado. G2: tarjeta el mismo día sin hora y por comprobar (dos pendientes). G3: anticipo sin comprobar.
  const g1 = await solicitar("Garrafones ficticios", "200");
  const p1 = await registrarPago(sql, rec.id, codigo, { clave: g1, version: 1, origen: "bolsa_visitas", importe: "200", aQuien: "", pagadoEl: "", cuenta: "", referencia: "",
    tipo: "ticket", folio: "", motivoSin: "" }, PRUEBAS);
  if (!p1.ok) throw new Error(p1.error);
  const g2 = await solicitar("Focos ficticios", "300");
  const p2 = await registrarPago(sql, adm.id, codigo, { clave: g2, version: 1, origen: "tarjeta", importe: "300", aQuien: "", pagadoEl: hoy(), cuenta: "Tarjeta ficticia",
    referencia: "", tipo: "", folio: "", motivoSin: "" }, PRUEBAS);
  if (!p2.ok) throw new Error(p2.error);
  const g3 = await solicitar("Material por comprar", "100");
  const a3 = await entregarAnticipo(sql, rec.id, codigo, { clave: g3, version: 1, lugar: "bolsa_visitas", recibe: adm.id }, PRUEBAS);
  if (!a3.ok) throw new Error(a3.error);
  // G4: ya pagado con dinero personal (reembolso pendiente).
  const g4 = await registrarGastoPagado(sql, enc.id, codigo, { concepto: "Cloro ficticio", categoria: "prueba_limpieza", importe: "50", proveedor: "", nota: "", pagaId: "",
    origen: "dinero_personal", pagadoPor: enc.id, pagadoEl: hoy(), turno: "", aQuien: "", cuenta: "", referencia: "", motivoPagado: "Prueba ficticia: urgente",
    tipo: "ticket", folio: "", motivoSin: "", envio: randomUUID() }, PRUEBAS);
  if (!g4.ok) throw new Error(g4.error);

  await entrar(page, dir.correo);
  await page.getByTestId("ir-reporte-gastos").click();
  await page.goto(`/reportes/gastos?sucursal=${codigo}`);
  await expect(page.getByTestId("total-gastado")).toHaveText("$550.00");
  await expect(page.getByTestId("renglones-estado").getByTestId("renglon-vista")).toHaveCount(2);
  await expect(page.getByTestId("renglones-estado")).toContainText("Pagado sin autorización previa o no comprobada");
  await expect(page.getByTestId("aparte-anticipos")).toContainText("$100.00");
  await expect(page.getByTestId("fila-gasto")).toHaveCount(3);
  await expect(page.getByTestId("detalle-gastos")).toContainText("Autorización previa no comprobada · Por comprobar");
  await capturar(page, "reporte-gastos");
  await page.getByTestId("vista-origen").click();
  await expect(page.getByTestId("renglones-origen")).toContainText("Tarjeta");
  await expect(page.getByTestId("total-gastado")).toHaveText("$550.00");
  await page.getByTestId("detalle-gastos").getByRole("link", { name: g1 }).click();
  await expect(page.getByTestId("clave-gasto")).toHaveText(g1);
  await page.goBack();

  // Descarga (Excel con las hojas; PDF).
  const descargar = async (formato: string, detalle = false) => {
    if (!(await page.getByTestId("descargar").isVisible())) await page.getByTestId("abrir-descarga").click();
    const f = page.getByTestId("descargar");
    await f.getByLabel(formato, { exact: false }).check();
    await f.getByLabel(detalle ? /Con detalle/ : "Resumen").check();
    const [d] = await Promise.all([page.waitForEvent("download"), f.getByTestId("boton-descargar").click()]);
    return d;
  };
  const xlsx = await descargar("Excel (.xlsx)", true);
  expect(xlsx.suggestedFilename()).toMatch(new RegExp(`^gastos-${codigo}-.*\\.xlsx$`));
  expect((await readFile((await xlsx.path())!)).subarray(0, 2).toString()).toBe("PK");
  const pdf = await descargar("PDF");
  expect((await readFile((await pdf.path())!)).subarray(0, 5).toString()).toBe("%PDF-");

  // Caja: sección de gastos con fuera de caja y pendientes; cada gasto una vez en el total.
  await page.goto(`/reportes/caja?sucursal=${codigo}`);
  await expect(page.getByTestId("fuera-de-caja-importe")).toHaveText("$100.00");
  await expect(page.getByTestId("gasto-pendiente-sin_autorizacion")).toContainText("$350.00");
  await expect(page.getByTestId("gastos-pendientes-total")).toContainText("Gastos con algún pendiente: 3 · $450.00");
  await capturar(page, "caja-gastos");
  await page.getByTestId("gasto-pendiente-reembolsos").locator("summary").click();
  await expect(page.getByTestId("gasto-pendiente-reembolsos").getByRole("link", { name: g4.clave })).toBeVisible();
  await page.goto(`/reportes/caja/mas?sucursal=${codigo}&vista=movimientos`);
  await expect(page.getByTestId("mov-gastos")).toContainText("−$200.00");
  await expect(page.getByTestId("mov-anticipos")).toContainText("−$100.00");

  // Recepción no consulta el reporte de gastos.
  await entrar(page, rec.correo);
  await expect(page.getByTestId("ir-reporte-gastos")).toHaveCount(0);
  const r = await page.goto("/reportes/gastos");
  expect(r?.status()).toBe(404);
});

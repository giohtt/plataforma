import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 6, PR 3 (27 nov 2026; solo datos ficticios): Recepción solicita un gasto (clave fija, sin mover dinero), lo
 * corrige como versión nueva con motivo; Encargado ve las solicitudes de la sucursal; sucursal que paga aparte;
 * «parte de una compra ya solicitada».
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar las solicitudes 2026";
const id = () => randomUUID().slice(0, 8);
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
async function cuenta(nombre: string, asignaciones: [string, string][]) {
  const correo = `solicitud-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, sucursal] of asignaciones) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${sucursal}, 'Prueba de gastos')`;
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
const codigo = () => `S${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;

test("solicitar un gasto, corregirlo como versión nueva y consultarlo como Encargado", async ({ page }) => {
  test.setTimeout(90_000);
  const c1 = codigo();
  const c2 = codigo();
  const [s1] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Solicitudes " + c1}, ${c1}) returning id`;
  const [s2] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Otra " + c2}, ${c2}) returning id`;
  const recepcion = await cuenta(`Recepción ${id()}`, [["recepcion", s1.id]]);
  const encargado = await cuenta(`Encargado ${id()}`, [["encargado", s1.id], ["encargado", s2.id]]);

  await entrar(page, recepcion.correo);
  await page.goto(`/sucursales/${c1}`);
  await page.getByTestId("abrir-grupo-gastos").click();
  await expect(page.getByTestId("gastos")).toHaveText("Solicitar gasto");
  await page.getByTestId("gastos").click();
  await expect(page.getByTestId("sin-gastos")).toBeVisible();
  await page.getByTestId("abrir-solicitud").click();
  const f = page.getByTestId("formulario-solicitud");
  await f.getByRole("button", { name: "Enviar solicitud" }).click();
  await expect(f.getByText("Escribe qué se va a comprar o pagar (de 3 a 120 caracteres).")).toBeVisible();
  const f2 = page.getByTestId("formulario-solicitud");
  await f2.getByLabel("Qué se va a comprar o pagar").fill("Garrafones de agua");
  await f2.getByLabel("Categoría").selectOption({ label: "Agua (de prueba)" });
  await f2.getByLabel("Importe").fill("480");
  await f2.getByLabel(/Proveedor/).fill("Proveedor ficticio A");
  await expect(f2.getByText("Categorías de prueba: la lista real está pendiente.")).toBeVisible();
  await capturar(page, "solicitud-formulario");
  await f2.getByRole("button", { name: "Enviar solicitud" }).click();
  await expect(page.getByRole("status")).toHaveText("Solicitud registrada. No mueve dinero ni autoriza el gasto.");
  await expect(page.getByTestId("clave-gasto")).toHaveText(`${c1}-G1`);
  await expect(page.getByTestId("importe-gasto")).toHaveText("$480.00");
  await expect(page.getByTestId("estado-gasto")).toHaveText("Solicitado");

  // Corrección: versión 2 con motivo; la versión 1 se conserva.
  await page.getByTestId("abrir-correccion").click();
  const c = page.getByTestId("formulario-correccion");
  await c.getByLabel("Importe").fill("600");
  await c.getByRole("button", { name: "Guardar corrección" }).click();
  await expect(page.getByText("Escribe el motivo de la corrección (de 5 a 300 caracteres).")).toBeVisible();
  const cc = page.getByTestId("formulario-correccion");
  await cc.getByLabel("Importe").fill("600");
  await cc.getByLabel(/Motivo de la corrección/).fill("Faltaba un garrafón");
  await cc.getByRole("button", { name: "Guardar corrección" }).click();
  await expect(page.getByRole("status")).toHaveText("Corrección guardada como versión nueva. La anterior se conserva.");
  await expect(page.getByTestId("estado-gasto")).toHaveText("Solicitado · versión 2");
  await expect(page.getByTestId("version-gasto")).toHaveCount(2);
  await expect(page.getByTestId("version-gasto").nth(0)).toContainText("Solicitud: Garrafones de agua · Agua (de prueba) · $480.00");
  await expect(page.getByTestId("version-gasto").nth(1)).toContainText("Corrección · versión 2: Garrafones de agua · Agua (de prueba) · $600.00");
  await expect(page.getByTestId("version-gasto").nth(1)).toContainText("Motivo: «Faltaba un garrafón»");
  await capturar(page, "solicitud-detalle");

  // Encargado: ve las solicitudes de la sucursal, no corrige la ajena; solicita una parte de la misma compra pagada por otra sucursal.
  await entrar(page, encargado.correo);
  await page.goto(`/sucursales/${c1}`);
  await page.getByTestId("abrir-grupo-gastos").click();
  await expect(page.getByTestId("gastos")).toHaveText("Gastos de la sucursal");
  await page.getByTestId("gastos").click();
  await expect(page.getByTestId("gasto")).toHaveCount(1);
  await expect(page.getByTestId("gasto").first()).toContainText(recepcion.nombre);
  await page.getByTestId("abrir-solicitud").click();
  const fe = page.getByTestId("formulario-solicitud");
  await fe.getByLabel("Qué se va a comprar o pagar").fill("Más garrafones");
  await fe.getByLabel("Categoría").selectOption({ label: "Agua (de prueba)" });
  await fe.getByLabel("Importe").fill("120");
  await fe.getByLabel("Sucursal que paga").selectOption({ label: `Otra ${c2}` });
  await fe.getByRole("checkbox", { name: "Es parte de una compra ya solicitada" }).check();
  await fe.getByLabel("Compra original").selectOption({ label: `${c1}-G1 · Garrafones de agua` });
  await fe.getByRole("button", { name: "Enviar solicitud" }).click();
  await expect(page.getByTestId("clave-gasto")).toHaveText(`${c1}-G2`);
  await expect(page.getByTestId("paga-gasto")).toHaveText(`Otra ${c2} (otra sucursal)`);
  await expect(page.getByTestId("compra-de")).toHaveText(`${c1}-G1`);
  await page.getByTestId("compra-de").getByRole("link").click();
  await expect(page.getByTestId("partes")).toHaveText(`${c1}-G2 ($120.00)`);
  await expect(page.getByTestId("abrir-correccion")).toHaveCount(0);
  await page.goto(`/sucursales/${c1}/gastos`);
  await capturar(page, "solicitud-lista");

  // También aparece en la sucursal que paga.
  await page.goto(`/sucursales/${c2}/gastos`);
  await expect(page.getByTestId("gasto")).toHaveCount(1);
  await expect(page.getByTestId("gasto").first()).toContainText(`Para Solicitudes ${c1}`);

  // Recepción ve solo lo suyo y no entra a la otra sucursal.
  await entrar(page, recepcion.correo);
  await page.goto(`/sucursales/${c1}/gastos`);
  await expect(page.getByTestId("gasto")).toHaveCount(1);
  expect((await page.goto(`/sucursales/${c1}/gastos/${c1}-G2`))?.status()).toBe(404);
  expect((await page.goto(`/sucursales/${c2}/gastos`))?.status()).toBe(404);
});

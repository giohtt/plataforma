import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/** Bloque 3, primer paso: apertura de turno de Recepción. Cada prueba usa su propia sucursal ficticia. */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar turnos 2026";

async function sucursal(estado = "activa") {
  const codigo = `X${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
  await sql`insert into sucursal (nombre, codigo, estado_operativo, desactivada_en)
            values (${"Turnos " + codigo}, ${codigo}, ${estado}, ${estado === "inactiva" ? sql`now()` : null})`;
  return codigo;
}
async function crearCuenta(asignaciones: [string, string][]) {
  const correo = `turno-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const nombre = "Recepcionista " + correo.slice(6, 14);
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de turno' from sucursal where codigo = ${codigo}`;
  }
  return { correo, nombre };
}
async function iniciar(page: Page, correo: string) {
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await iniciar(page, correo);
}
async function usarSesionDe(browser: Browser, page: Page, correo: string) {
  const otra = await browser.newContext();
  await iniciar(await otra.newPage(), correo);
  const cookies = await otra.cookies();
  await otra.close();
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
}
const abiertos = async (codigo: string) =>
  (await sql`select count(*)::int as n from turno t join sucursal s on s.id = t.sucursal_id where s.codigo = ${codigo} and t.cerrado_en is null`)[0].n as number;
const lista = (page: Page) => page.waitForLoadState("networkidle");

test("Recepción abre turno: totales por separado, $0 válido, vacío no; el cajón queda «No conciliado»", async ({ page }) => {
  const codigo = await sucursal();
  const recep = await crearCuenta([["recepcion", codigo]]);
  await entrar(page, recep.correo);
  await page.goto(`/sucursales/${codigo}`);
  await page.getByTestId("turno").click();
  await lista(page);
  await expect(page.getByTestId("apertura-bolsa")).toContainText(`Responsable desde la apertura: ${recep.nombre}`);
  await expect(page.getByTestId("apertura-cajon")).toContainText("No conciliado: faltan datos de Open Desk");

  // Vacío no es 0: se piden los dos.
  await page.getByRole("button", { name: "Abrir turno" }).click();
  await expect(page.locator("#bolsa-error")).toHaveText("Escribe el total contado. Si no hay dinero, escribe 0.");
  await expect(page.locator("#cajon-error")).toHaveText("Escribe el total contado. Si no hay dinero, escribe 0.");
  // $0 en la bolsa es válido; el cajón sigue vacío.
  await page.getByLabel("Total contado").first().fill("0");
  await page.getByRole("button", { name: "Abrir turno" }).click();
  await expect(page.locator("#bolsa-error")).toHaveCount(0);
  await expect(page.locator("#cajon-error")).toBeVisible();
  await expect(page.locator("#bolsa")).toHaveValue("0");
  expect(await abiertos(codigo)).toBe(0);

  await page.locator("#cajon").fill("1,200");
  await page.getByRole("button", { name: "Abrir turno" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Turno abierto.");
  await expect(page.getByTestId("lugar-bolsa_visitas")).toContainText("$0.00 contado al abrir");
  await expect(page.getByTestId("lugar-bolsa_visitas")).toContainText(`Responsable: ${recep.nombre}`);
  await expect(page.getByTestId("lugar-cajon_mensualidades")).toContainText("$1,200.00 contado al abrir");
  await expect(page.getByTestId("lugar-cajon_mensualidades")).toContainText(`Responsable: ${recep.nombre}`);
  await expect(page.getByTestId("no-conciliado")).toHaveText("No conciliado: faltan datos de Open Desk");
  // Los totales nunca se suman en uno solo.
  await expect(page.locator("main")).not.toContainText("$1,200.00 contado al abrir en total");
  expect(await abiertos(codigo)).toBe(1);
});

test("dos recepcionistas con el formulario abierto al mismo tiempo: solo una abre el turno", async ({ browser }) => {
  const codigo = await sucursal();
  const a = await crearCuenta([["recepcion", codigo]]);
  const b = await crearCuenta([["recepcion", codigo]]);
  const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()];
  const [pa, pb] = [await ctxA.newPage(), await ctxB.newPage()];
  await iniciar(pa, a.correo);
  await iniciar(pb, b.correo);
  for (const p of [pa, pb]) {
    await p.goto(`/sucursales/${codigo}/turno`);
    await lista(p);
    await p.locator("#bolsa").fill("350");
    await p.locator("#cajon").fill("0");
  }
  await Promise.all([pa.getByRole("button", { name: "Abrir turno" }).click(), pb.getByRole("button", { name: "Abrir turno" }).click()]);
  const resultado = async (p: Page) => {
    if (await p.locator("p.aviso[role=status]").count()) return "abierto";
    if (await p.locator("p.aviso[role=alert]").count()) return (await p.locator("p.aviso[role=alert]").innerText()).trim();
    return null;
  };
  await expect.poll(async () => [await resultado(pa), await resultado(pb)].filter(Boolean).length).toBe(2);
  const r = [await resultado(pa), await resultado(pb)].sort();
  expect(r).toEqual(["Ya hay un turno de Recepción abierto en esta sucursal. Solo puede haber uno a la vez.", "abierto"]);
  expect(await abiertos(codigo)).toBe(1);
  await ctxA.close();
  await ctxB.close();
});

test("con un turno abierto, otra recepcionista ve el turno y no el formulario", async ({ page }) => {
  const codigo = await sucursal();
  const a = await crearCuenta([["recepcion", codigo]]);
  await entrar(page, a.correo);
  await page.goto(`/sucursales/${codigo}/turno`);
  await lista(page);
  await page.locator("#bolsa").fill("100");
  await page.locator("#cajon").fill("200");
  await page.getByRole("button", { name: "Abrir turno" }).click();
  await expect(page.getByTestId("turno-abierto")).toBeVisible();

  await entrar(page, (await crearCuenta([["recepcion", codigo]])).correo);
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("turno-abierto")).toContainText(`Abierto por ${a.nombre} ·`);
  await expect(page.getByRole("button", { name: "Abrir turno" })).toHaveCount(0);
});

test("Encargado consulta pero no abre, ni enviando el formulario directamente; otra sucursal: «No encontrada»", async ({ page, browser }) => {
  const codigo = await sucursal();
  const encargado = await crearCuenta([["encargado", codigo]]);
  await entrar(page, encargado.correo);
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("sin-turno")).toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir turno" })).toHaveCount(0);

  // Formulario abierto por Recepción y enviado con la sesión del Encargado.
  await usarSesionDe(browser, page, (await crearCuenta([["recepcion", codigo]])).correo);
  await page.goto(`/sucursales/${codigo}/turno`);
  await lista(page);
  await usarSesionDe(browser, page, encargado.correo);
  await page.locator("#bolsa").fill("50");
  await page.locator("#cajon").fill("0");
  await page.getByRole("button", { name: "Abrir turno" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toHaveText("Tu cuenta no tiene permiso para abrir turno en esta sucursal.");
  expect(await abiertos(codigo)).toBe(0);

  await entrar(page, (await crearCuenta([["recepcion", "STG"]])).correo);
  expect((await page.goto(`/sucursales/${codigo}/turno`))?.status()).toBe(404);
});

test("en una sucursal inactiva no se puede abrir turno", async ({ page }) => {
  const codigo = await sucursal("inactiva");
  await entrar(page, (await crearCuenta([["recepcion", codigo]])).correo);
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.locator("main")).toContainText("Esta sucursal está desactivada: no se pueden abrir turnos.");
  await expect(page.getByRole("button", { name: "Abrir turno" })).toHaveCount(0);
});

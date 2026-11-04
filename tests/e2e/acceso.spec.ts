import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Tarea 6: acceso permitido y denegado con envíos directos al servidor que la pantalla no ofrece.
 * Cada prueba deja las sucursales ficticias como estaban; si algo se colara, la prueba lo detecta.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar accesos 2026";

async function crearCuenta(asignaciones: [string, string][], { general }: { general?: string } = {}) {
  const correo = `acceso-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${"Cuenta " + correo.slice(7, 15)}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de acceso' from sucursal where codigo = ${codigo}`;
  }
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${general}, 'Prueba de acceso')`;
  return { correo, id: u.id };
}

async function entrar(page: Page, correo: string) {
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function usarSesionDe(browser: Browser, page: Page, correo: string) {
  const otra = await browser.newContext();
  await entrar(await otra.newPage(), correo);
  const cookies = await otra.cookies();
  await otra.close();
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
}

const sucursal = async (codigo: string) =>
  (await sql<{ id: string; nombre: string; color: string | null; estado_operativo: string; version: number }[]>`
    select id, nombre, color, estado_operativo, version from sucursal where codigo = ${codigo}`)[0];
const aviso = (page: Page) => page.locator("p.aviso[role=alert]");

test("sin sesión: enviar los formularios de crear, editar o desactivar no cambia nada", async ({ page, browser }) => {
  const general = await crearCuenta([], { general: "direccion" });
  const antes = await sucursal("TEN");
  const codigo = `Z${randomUUID().replace(/[^0-9]/g, "").slice(0, 3)}`;

  // Alta: el formulario queda abierto y la sesión desaparece antes de enviarlo.
  await entrar(page, general.correo);
  await page.goto("/sucursales/nueva");
  await page.context().clearCookies();
  await page.getByLabel("Nombre", { exact: true }).fill(`Sin sesión ${codigo}`);
  await page.getByLabel("Código").fill(codigo);
  await page.getByRole("button", { name: "Crear sucursal" }).click();
  await expect(page).toHaveURL(/\/iniciar-sesion/);
  expect(await sucursal(codigo)).toBeUndefined();

  // Edición y desactivación de Tenango, igual.
  for (const accion of ["editar", "desactivar"] as const) {
    await usarSesionDe(browser, page, general.correo);
    await page.goto("/sucursales/TEN/editar");
    await page.context().clearCookies();
    if (accion === "editar") {
      await page.getByLabel("Nombre", { exact: true }).fill("Tenango sin sesión");
      await page.locator("#motivo").fill("Intento sin sesión");
      await page.getByRole("button", { name: "Guardar cambios" }).click();
    } else {
      await page.getByLabel(/Confirmo que quiero desactivar/).check();
      await page.locator("#actividad-motivo").fill("Intento sin sesión");
      await page.getByRole("button", { name: "Desactivar sucursal" }).click();
    }
    await expect(page, accion).toHaveURL(/\/iniciar-sesion/);
    expect(await sucursal("TEN"), accion).toEqual(antes);
  }
});

test("Recepción: desactivar Tenango con un envío directo se rechaza", async ({ page, browser }) => {
  const recepcion = await crearCuenta([["recepcion", "TEN"]]);
  await entrar(page, (await crearCuenta([], { general: "direccion" })).correo);
  await page.goto("/sucursales/TEN/editar");
  const antes = await sucursal("TEN");
  await usarSesionDe(browser, page, recepcion.correo);
  await page.getByLabel(/Confirmo que quiero desactivar/).check();
  await page.locator("#actividad-motivo").fill("Intento de Recepción");
  await page.getByRole("button", { name: "Desactivar sucursal" }).click();
  await expect(aviso(page)).toHaveText("Tu cuenta no tiene permiso para hacer este cambio.");
  expect(await sucursal("TEN")).toEqual(antes);
});

test("Dirección de Tenango no cambia Santiago aunque altere el identificador oculto del formulario", async ({ page }) => {
  await entrar(page, (await crearCuenta([["direccion", "TEN"]])).correo);
  const stg = await sucursal("STG");
  const ten = await sucursal("TEN");

  // Edición: el formulario es de Tenango, pero se envía con el identificador y la versión de Santiago.
  await page.goto("/sucursales/TEN/editar");
  await page.evaluate(({ id, version }) => {
    // Solo los formularios del catálogo; el de «Cerrar sesión» no lleva identificador.
    for (const campo of document.querySelectorAll<HTMLInputElement>("form input[name=id]")) campo.value = id;
    for (const campo of document.querySelectorAll<HTMLInputElement>("form input[name=version]")) campo.value = String(version);
  }, stg);
  await page.getByLabel("Nombre", { exact: true }).fill("Santiago alterado");
  await page.locator("#motivo").fill("Intento con identificador ajeno");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(aviso(page)).toHaveText("No encontrada.");

  // Desactivación, igual.
  await page.goto("/sucursales/TEN/editar");
  await page.evaluate(({ id, version }) => {
    // Solo los formularios del catálogo; el de «Cerrar sesión» no lleva identificador.
    for (const campo of document.querySelectorAll<HTMLInputElement>("form input[name=id]")) campo.value = id;
    for (const campo of document.querySelectorAll<HTMLInputElement>("form input[name=version]")) campo.value = String(version);
  }, stg);
  await page.getByLabel(/Confirmo que quiero desactivar/).check();
  await page.locator("#actividad-motivo").fill("Intento con identificador ajeno");
  await page.getByRole("button", { name: "Desactivar sucursal" }).click();
  await expect(aviso(page)).toHaveText("No encontrada.");

  expect(await sucursal("STG")).toEqual(stg);
  expect(await sucursal("TEN")).toEqual(ten);
});

test("un acceso revocado deja de valer en la siguiente solicitud, sin cerrar sesión", async ({ page }) => {
  const recepcion = await crearCuenta([["recepcion", "TEN"]]);
  await entrar(page, recepcion.correo);
  expect((await page.goto("/sucursales/TEN"))?.status()).toBe(200);

  await sql`update asignacion set revocada_en = now() where usuario_id = ${recepcion.id}`;

  expect((await page.goto("/sucursales/TEN"))?.status()).toBe(404);
  const lista = await page.evaluate(async () => (await fetch("/api/sucursales")).json());
  expect(lista).toEqual({ sucursales: [] });
  await page.goto("/");
  await expect(page.getByTestId("sin-sucursales")).toBeVisible();
});

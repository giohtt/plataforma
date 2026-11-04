import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/** Bloque 2, primer flujo: buscar, elegir entre coincidencias y crear un expediente. Solo datos ficticios. */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar visitantes 2026";

async function crearCuenta(asignaciones: [string, string][]) {
  const correo = `visit-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${"Cuenta " + correo.slice(6, 14)}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de visitantes' from sucursal where codigo = ${codigo}`;
  }
  return correo;
}

async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
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

const visitantes = (page: Page) => page.getByTestId("resultados").getByTestId("visitante");
const aviso = (page: Page) => page.locator("p.aviso[role=alert]");
/** Nombre sin palabras en común con ningún otro: la búsqueda aproximada no lo confunde. */
const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxyz"[Math.floor(Math.random() * 21)]).join("");
const nombreUnico = () => `${letras(9)} ${letras(9)} ${letras(9)}`;
/** Espera a que la página termine de cargar antes de escribir en un formulario. */
const lista = (page: Page) => page.waitForLoadState("networkidle");
const cuantos = async (nombre: string) => (await sql`select count(*)::int as n from visitante where nombre = ${nombre}`)[0].n as number;

test("Recepción busca por nombre: varias coincidencias, teléfono enmascarado, y elige a la persona", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN");
  await page.getByTestId("visitantes").click();
  await page.getByLabel("Nombre completo o teléfono").fill("maria hernandez");
  await page.getByRole("button", { name: "Buscar" }).click();

  await expect(visitantes(page)).toHaveCount(2);
  await expect(page.getByTestId("resultados")).toContainText("Hay varias personas posibles");
  await expect(page.getByTestId("resultados")).toContainText("•• •••• 0101");
  await expect(page.getByTestId("resultados")).toContainText("Registrado en Santiago");
  expect(await page.content()).not.toMatch(/0000000101|0000000102/);

  await visitantes(page).filter({ hasText: "Santiago" }).getByRole("link", { name: "Es esta persona" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Expediente elegido.");
  await expect(page.getByTestId("expediente")).toContainText("•• •••• 0102");
  await expect(page.getByTestId("expediente")).toContainText("En Santiago");
});

test("por teléfono completo encuentra a quienes lo comparten; un pedazo de teléfono no se acepta", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN/visitantes?q=000%20000%200201");
  await expect(visitantes(page)).toHaveCount(2);
  await expect(page.getByTestId("resultados")).toContainText("Ana Martínez Ruiz");
  await expect(page.getByTestId("resultados")).toContainText("Luis Martínez Ruiz");
  await expect(page.getByTestId("resultados")).toContainText("00 0000 0201");

  await page.goto("/sucursales/TEN/visitantes?q=0201");
  await expect(aviso(page)).toHaveText("Para buscar por teléfono escribe los 10 dígitos.");
  await expect(page.getByTestId("resultados")).toHaveCount(0);
});

test("alta con homónimo: no se crea hasta confirmar que es otra persona", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  const nombre = "Fernanda López Torres";
  const antes = await cuantos(nombre);

  await page.goto("/sucursales/TEN/visitantes?q=fernanda%20lopez%20torres");
  await expect(visitantes(page)).not.toHaveCount(0);
  await page.getByTestId("crear-visitante").click();
  await lista(page);
  await expect(page.getByLabel("Nombre completo")).toHaveValue("fernanda lopez torres");
  await page.getByLabel("Nombre completo").fill(nombre);
  await page.getByLabel("Estado de procedencia (opcional)").selectOption("Puebla");
  await page.getByRole("button", { name: "Crear expediente" }).click();

  const coincidencias = page.getByTestId("coincidencias");
  await expect(coincidencias).toBeVisible();
  await expect(coincidencias).toContainText("Mismo nombre");
  // Sin marcar la casilla no se crea nada, y lo escrito se conserva.
  await page.getByRole("button", { name: "Crear expediente nuevo" }).click();
  await expect(coincidencias).toBeVisible();
  await expect(page.getByLabel("Estado de procedencia (opcional)")).toHaveValue("Puebla");
  expect(await cuantos(nombre)).toBe(antes);

  await page.getByLabel(/Confirmo que la persona no es ninguna/).check();
  await page.getByRole("button", { name: "Crear expediente nuevo" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Expediente creado.");
  await expect(page.getByTestId("nombre-visitante")).toHaveText(nombre);
  expect(await cuantos(nombre)).toBe(antes + 1);
  const [{ n }] = await sql`
    select count(*)::int as n from visitante_distinto d join visitante v on v.id = d.visitante_id
    where v.nombre = ${nombre} and v.estado_procedencia = 'Puebla' and v.creado_en > now() - interval '1 minute'`;
  expect(n).toBeGreaterThanOrEqual(antes);
});

test("alta sin coincidencias: se crea directo y el teléfono se muestra enmascarado", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  const unico = nombreUnico();
  await page.goto(`/sucursales/TEN/visitantes?q=${encodeURIComponent(unico)}`);
  await expect(page.getByTestId("resultados")).toContainText("Sin coincidencias");
  await page.getByTestId("crear-visitante").click();
  await lista(page);
  const telefono = `000${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  await page.getByLabel("Teléfono (opcional)").fill(telefono);
  await page.getByRole("button", { name: "Crear expediente" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Expediente creado.");
  await expect(page.getByTestId("expediente")).toContainText(`•• •••• ${telefono.slice(-4)}`);
  expect(await page.content()).not.toContain(telefono);
});

test("sin permiso: otra sucursal, sin asignaciones o Administración reciben «No encontrada»", async ({ page }) => {
  const [{ id }] = await sql<{ id: string }[]>`select id from visitante where telefono = '0000000101'`;
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  for (const ruta of ["/sucursales/STG/visitantes?q=maria", "/sucursales/STG/visitantes/nuevo", `/sucursales/STG/visitantes/${id}`]) {
    expect((await page.goto(ruta))?.status(), ruta).toBe(404);
  }

  await entrar(page, await crearCuenta([]));
  expect((await page.goto("/sucursales/TEN/visitantes?q=maria"))?.status()).toBe(404);

  await entrar(page, await crearCuenta([["administracion", "TEN"]]));
  await page.goto("/sucursales/TEN/visitantes?q=maria%20hernandez");
  await expect(visitantes(page)).toHaveCount(2);
  await expect(page.getByTestId("crear-visitante")).toHaveCount(0);
  expect((await page.goto("/sucursales/TEN/visitantes/nuevo"))?.status()).toBe(404);
});

test("envío directo: sin permiso o cambiando la sucursal oculta, el alta se rechaza", async ({ page, browser }) => {
  const nombre = nombreUnico();

  // Formulario abierto por Recepción de Tenango y enviado con la sesión de una cuenta sin asignaciones.
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN/visitantes/nuevo");
  await lista(page);
  await usarSesionDe(browser, page, await crearCuenta([]));
  await page.getByLabel("Nombre completo").fill(nombre);
  await page.getByRole("button", { name: "Crear expediente" }).click();
  await expect(aviso(page)).toHaveText("No encontrada.");

  // Recepción de Tenango cambia la sucursal oculta a Santiago.
  await usarSesionDe(browser, page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN/visitantes/nuevo");
  await lista(page);
  await page.evaluate(() => {
    for (const c of document.querySelectorAll<HTMLInputElement>("form input[name=codigo]")) c.value = "STG";
  });
  await page.getByLabel("Nombre completo").fill(nombre);
  await page.getByRole("button", { name: "Crear expediente" }).click();
  await expect(aviso(page)).toHaveText("No encontrada.");

  expect(await cuantos(nombre)).toBe(0);
});

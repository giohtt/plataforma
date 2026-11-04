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
/** Busca desde la pantalla, como lo hace Recepción (envío por POST, sin datos en la dirección). */
async function buscar(page: Page, texto: string, codigo = "TEN") {
  await page.goto(`/sucursales/${codigo}/visitantes`);
  await lista(page);
  await page.getByLabel("Nombre completo o teléfono").fill(texto);
  await page.getByRole("button", { name: "Buscar" }).click();
}
const cuantos = async (nombre: string) => (await sql`select count(*)::int as n from visitante where nombre = ${nombre}`)[0].n as number;

test("Recepción busca por nombre: varias coincidencias, teléfono enmascarado, y elige a la persona", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN");
  await page.getByTestId("visitantes").click();
  await expect(page).toHaveURL(/\/sucursales\/TEN\/visitantes$/);
  await buscar(page, "maria hernandez");

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
  await buscar(page, "000 000 0201");
  await expect(visitantes(page)).toHaveCount(2);
  await expect(page.getByTestId("resultados")).toContainText("Ana Martínez Ruiz");
  await expect(page.getByTestId("resultados")).toContainText("Luis Martínez Ruiz");
  await expect(page.getByTestId("resultados")).toContainText("00 0000 0201");

  await buscar(page, "0201");
  await expect(aviso(page)).toHaveText("Para buscar por teléfono escribe los 10 dígitos.");
  await expect(page.getByTestId("resultados")).toHaveCount(0);
});

test("el nombre y el teléfono no aparecen en la dirección, ni al buscar ni al pasar al alta", async ({ page }) => {
  const direcciones: string[] = [];
  page.on("request", (r) => direcciones.push(r.url()));
  page.on("framenavigated", (f) => direcciones.push(f.url()));
  const revisar = (paso: string) => {
    direcciones.push(page.url());
    for (const url of direcciones) {
      const legible = decodeURIComponent(url).toLowerCase().replace(/\+/g, " ");
      for (const dato of ["maria", "maría", "hernandez", "hernández", "luis", "martinez", "martínez", "0000000201", "000 000 0201", "q="]) {
        expect(legible, `${paso}: «${dato}» en ${url}`).not.toContain(dato);
      }
    }
  };

  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  direcciones.length = 0;

  // Paso 1: búsquedas por nombre y por teléfono.
  await buscar(page, "María Hernández");
  await expect(visitantes(page)).toHaveCount(2);
  await page.getByLabel("Nombre completo o teléfono").fill("000 000 0201");
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(visitantes(page)).toHaveCount(2);
  revisar("búsqueda");

  // Paso 2: de la búsqueda al alta, con coincidencias y confirmación, hasta crear el expediente.
  await page.getByTestId("crear-visitante").click();
  await expect(page.getByTestId("alta-visitante")).toBeVisible();
  await expect(page.getByLabel("Teléfono (opcional)")).toHaveValue("0000000201");
  await expect(page).toHaveURL(/\/sucursales\/TEN\/visitantes$/);
  await page.getByLabel("Nombre completo").fill("Luis Martínez Ruiz");
  await page.getByRole("button", { name: "Crear expediente" }).click();
  await expect(page.getByTestId("coincidencias")).toBeVisible();
  revisar("alta con coincidencias");
  // Se guarda con datos únicos para no alterar los expedientes que usan las demás pruebas.
  await page.getByLabel("Nombre completo").fill(nombreUnico());
  await page.getByLabel("Teléfono (opcional)").fill(`000${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`);
  await page.getByLabel(/Confirmo que la persona no es ninguna/).check();
  await page.getByRole("button", { name: "Crear expediente nuevo" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Expediente creado.");
  revisar("expediente creado");
  expect(direcciones.length).toBeGreaterThan(3);
});

test("la búsqueda no se puede hacer desde la dirección", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN/visitantes?q=maria%20hernandez");
  await lista(page);
  await expect(page.getByTestId("resultados")).toHaveCount(0);
  await expect(page.getByLabel("Nombre completo o teléfono")).toHaveValue("");
});

test("alta con homónimo: no se crea hasta confirmar que es otra persona", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  const nombre = "Fernanda López Torres";
  const antes = await cuantos(nombre);

  await buscar(page, "fernanda lopez torres");
  await expect(visitantes(page)).not.toHaveCount(0);
  await page.getByTestId("crear-visitante").click();
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
});

test("alta sin coincidencias: se crea directo y el teléfono se muestra enmascarado", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  const unico = nombreUnico();
  await buscar(page, unico);
  await expect(page.getByTestId("resultados")).toContainText("Sin coincidencias");
  await page.getByTestId("crear-visitante").click();
  const telefono = `000${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  await page.getByLabel("Teléfono (opcional)").fill(telefono);
  await page.getByRole("button", { name: "Crear expediente" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Expediente creado.");
  await expect(page.getByTestId("expediente")).toContainText(`•• •••• ${telefono.slice(-4)}`);
  expect(await page.content()).not.toContain(telefono);
});

test("sin permiso: otra sucursal, sin asignaciones o Administración", async ({ page }) => {
  const [{ id }] = await sql<{ id: string }[]>`select id from visitante where telefono = '0000000101'`;
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  for (const ruta of ["/sucursales/STG/visitantes", `/sucursales/STG/visitantes/${id}`]) {
    expect((await page.goto(ruta))?.status(), ruta).toBe(404);
  }

  await entrar(page, await crearCuenta([]));
  expect((await page.goto("/sucursales/TEN/visitantes"))?.status()).toBe(404);

  await entrar(page, await crearCuenta([["administracion", "TEN"]]));
  await buscar(page, "maria hernandez");
  await expect(visitantes(page)).toHaveCount(2);
  await expect(page.getByTestId("crear-visitante")).toHaveCount(0);
});

test("envío directo: sin permiso, buscar y crear se rechazan; cambiar la sucursal oculta tampoco sirve", async ({ page, browser }) => {
  const nombre = nombreUnico();

  // Búsqueda abierta por Recepción de Tenango y enviada con la sesión de una cuenta sin asignaciones.
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN/visitantes");
  await lista(page);
  await usarSesionDe(browser, page, await crearCuenta([]));
  await page.getByLabel("Nombre completo o teléfono").fill("maria hernandez");
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(aviso(page)).toHaveText("No encontrada.");
  await expect(page.getByTestId("resultados")).toHaveCount(0);

  // Alta abierta por Recepción de Tenango y enviada sin permiso.
  await usarSesionDe(browser, page, await crearCuenta([["recepcion", "TEN"]]));
  await buscar(page, nombre);
  await page.getByTestId("crear-visitante").click();
  await usarSesionDe(browser, page, await crearCuenta([]));
  await page.getByRole("button", { name: "Crear expediente" }).click();
  await expect(aviso(page)).toHaveText("No encontrada.");

  // Recepción de Tenango cambia la sucursal oculta a Santiago, en la búsqueda y en el alta.
  await usarSesionDe(browser, page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN/visitantes");
  await lista(page);
  await page.evaluate(() => {
    for (const c of document.querySelectorAll<HTMLInputElement>("form input[name=codigo]")) c.value = "STG";
  });
  await page.getByLabel("Nombre completo o teléfono").fill(nombre);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(aviso(page)).toHaveText("No encontrada.");

  await buscar(page, nombre);
  await page.getByTestId("crear-visitante").click();
  await page.evaluate(() => {
    for (const c of document.querySelectorAll<HTMLInputElement>("form input[name=codigo]")) c.value = "STG";
  });
  await page.getByRole("button", { name: "Crear expediente" }).click();
  await expect(aviso(page)).toHaveText("No encontrada.");

  expect(await cuantos(nombre)).toBe(0);
});

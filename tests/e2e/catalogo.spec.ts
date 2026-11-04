import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Catálogo de sucursales desde el navegador: alta, edición, desactivación y reactivación,
 * quién ve cada opción, y envíos directos al servidor con la sesión de alguien sin permiso.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar el catalogo 2026";

async function crearCuenta(asignaciones: [string, string][], { general }: { general?: string } = {}) {
  const correo = `catalogo-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${"Cuenta " + correo.slice(9, 17)}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de navegador' from sucursal where codigo = ${codigo}`;
  }
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${general}, 'Prueba de navegador')`;
  return correo;
}

async function entrar(page: Page, correo: string) {
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Cambia la sesión de una pestaña por la de otra cuenta, sin recargar el formulario abierto. */
async function usarSesionDe(browser: Browser, page: Page, correo: string) {
  const otra = await browser.newContext();
  await entrar(await otra.newPage(), correo);
  const cookies = await otra.cookies();
  await otra.close();
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
}

const codigoNuevo = () => `Q${randomUUID().replace(/[^0-9]/g, "").slice(0, 3)}`;
const fila = async (codigo: string) =>
  (await sql<{ nombre: string; color: string | null; estado_operativo: string }[]>`
    select nombre, color, estado_operativo from sucursal where codigo = ${codigo}`)[0];

test("Dirección general: crea, edita, desactiva y reactiva una sucursal, y todo queda en el historial", async ({ page }) => {
  await entrar(page, await crearCuenta([], { general: "direccion" }));
  await page.getByTestId("nueva-sucursal").click();
  await expect(page).toHaveURL(/\/sucursales\/nueva$/);

  // Un nombre que ya existe, escrito sin acento: se rechaza y no se pierde lo escrito.
  const codigo = codigoNuevo();
  const nombre = `Sucursal ${codigo}`;
  await page.getByLabel("Nombre", { exact: true }).fill("rayon");
  await page.getByLabel("Código").fill(codigo.toLowerCase());
  await page.getByRole("button", { name: "Crear sucursal" }).click();
  await expect(page.locator("#nombre-error")).toContainText("Ya existe una sucursal con ese nombre");
  await expect(page.getByLabel("Código")).toHaveValue(codigo.toLowerCase());

  await page.getByLabel("Nombre", { exact: true }).fill(nombre);
  await page.getByLabel("Motivo (opcional)").fill("Alta de prueba");
  await page.getByRole("button", { name: "Crear sucursal" }).click();
  await expect(page).toHaveURL(new RegExp(`/sucursales/${codigo}\\?aviso=creada$`));
  await expect(page.locator("p.aviso[role=status]")).toContainText("No se asignó a nadie");
  await expect(page.getByTestId("nombre-sucursal")).toHaveText(nombre);
  expect(await fila(codigo)).toEqual({ nombre, color: null, estado_operativo: "proxima" });
  expect(await sql`select 1 from asignacion a join sucursal s on s.id = a.sucursal_id where s.codigo = ${codigo}`).toHaveLength(0);

  // Editar: el motivo es obligatorio.
  await page.getByTestId("editar-sucursal").click();
  await page.getByLabel("Sin color definido todavía").uncheck();
  await page.getByLabel("Color", { exact: true }).fill("#1b7a3e");
  await page.getByLabel("Estado", { exact: true }).selectOption("activa");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.locator("#motivo-error")).toBeVisible();
  await page.locator("#motivo").fill("Color y apertura de prueba");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Cambios guardados.");
  expect(await fila(codigo)).toEqual({ nombre, color: "#1b7a3e", estado_operativo: "activa" });
  const historial = page.getByTestId("historial-sucursal");
  await expect(historial).toContainText("Editada");
  await expect(historial).toContainText("Color: (vacío) → #1b7a3e");
  await expect(historial).toContainText("Estado: Próxima apertura → Activa");
  await expect(historial).toContainText("Motivo: Color y apertura de prueba");

  // Desactivar pide confirmar con la casilla.
  await page.getByTestId("editar-sucursal").click();
  const actividad = page.getByTestId("actividad");
  await actividad.getByLabel("Motivo").fill("Cierre de prueba");
  await actividad.getByRole("button", { name: "Desactivar sucursal" }).click();
  await expect(actividad.getByText("Marca la casilla para confirmar.")).toBeVisible();
  await actividad.getByLabel(/Confirmo que quiero desactivar/).check();
  await actividad.getByRole("button", { name: "Desactivar sucursal" }).click();
  await expect(page.getByTestId("sucursal-inactiva")).toBeVisible();
  expect((await fila(codigo)).estado_operativo).toBe("inactiva");

  // Reactivar.
  await page.getByTestId("editar-sucursal").click();
  await page.getByTestId("actividad").getByLabel("Motivo").fill("Reapertura de prueba");
  await page.getByRole("button", { name: "Reactivar sucursal" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Sucursal reactivada.");
  expect((await fila(codigo)).estado_operativo).toBe("activa");
  await expect(historial.locator("ol.historial > li > strong")).toHaveText(["Reactivada", "Desactivada", "Editada", "Creada"]);
});

test("Recepción de Tenango no ve opciones del catálogo y las páginas responden «No encontrada»", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await expect(page.getByTestId("nueva-sucursal")).toHaveCount(0);
  await page.goto("/sucursales/TEN");
  await expect(page.getByTestId("editar-sucursal")).toHaveCount(0);
  await expect(page.getByTestId("historial-sucursal")).toHaveCount(0);
  for (const ruta of ["/sucursales/nueva", "/sucursales/TEN/editar", "/sucursales/STG/editar"]) {
    expect((await page.goto(ruta))?.status(), ruta).toBe(404);
    await expect(page.getByTestId("no-encontrada")).toBeVisible();
  }
});

test("Dirección solo de Tenango: edita Tenango, pero no crea ni edita Santiago", async ({ page }) => {
  await entrar(page, await crearCuenta([["direccion", "TEN"]]));
  await expect(page.getByTestId("nueva-sucursal")).toHaveCount(0);
  expect((await page.goto("/sucursales/nueva"))?.status()).toBe(404);
  expect((await page.goto("/sucursales/STG/editar"))?.status()).toBe(404);
  expect((await page.goto("/sucursales/TEN/editar"))?.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Guardar cambios" })).toBeVisible();
});

test("envío directo al servidor: con la sesión de Recepción, crear y editar se rechazan", async ({ page, browser }) => {
  const recepcion = await crearCuenta([["recepcion", "TEN"]]);

  // Alta: el formulario se abre con Dirección general y se envía con la sesión de Recepción.
  await entrar(page, await crearCuenta([], { general: "direccion" }));
  await page.goto("/sucursales/nueva");
  await usarSesionDe(browser, page, recepcion);
  const codigo = codigoNuevo();
  await page.getByLabel("Nombre", { exact: true }).fill(`Intrusa ${codigo}`);
  await page.getByLabel("Código").fill(codigo);
  await page.getByRole("button", { name: "Crear sucursal" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toHaveText("Tu cuenta no tiene permiso para hacer este cambio.");
  expect(await fila(codigo)).toBeUndefined();

  // Edición de Tenango, igual.
  await usarSesionDe(browser, page, await crearCuenta([], { general: "direccion" }));
  await page.goto("/sucursales/TEN/editar");
  const antes = await fila("TEN");
  await usarSesionDe(browser, page, recepcion);
  await page.getByLabel("Nombre", { exact: true }).fill("Tenango cambiado");
  await page.locator("#motivo").fill("Intento sin permiso");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toHaveText("Tu cuenta no tiene permiso para hacer este cambio.");
  expect(await fila("TEN")).toEqual(antes);
});

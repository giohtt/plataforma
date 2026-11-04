import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Permisos vistos desde el navegador y con solicitudes directas al servidor.
 * Usa las sucursales ficticias cargadas al arrancar; cada prueba crea su propia cuenta.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar permisos 2026";

async function idSucursal(codigo: string) {
  const [s] = await sql<{ id: string }[]>`select id from sucursal where codigo = ${codigo}`;
  return s.id;
}

async function crearCuenta(asignaciones: [string, string][], { general }: { general?: string } = {}) {
  const correo = `permisos-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${"Cuenta " + correo.slice(9, 17)}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              values (${u.id}, ${rol}, ${await idSucursal(codigo)}, 'Prueba de navegador')`;
  }
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${general}, 'Prueba de navegador')`;
  return correo;
}

/**
 * Solicitud directa al servidor desde el navegador de la persona, con su cookie de sesión.
 * Es lo que haría alguien que intenta saltarse la pantalla escribiendo la dirección de la API.
 */
async function pedir(page: Page, ruta: string): Promise<{ status: number; cuerpo: unknown }> {
  return page.evaluate(async (r) => {
    const res = await fetch(r, { credentials: "same-origin" });
    return { status: res.status, cuerpo: await res.json() };
  }, ruta);
}

async function entrar(page: Page, correo: string) {
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("sin sesión, la API de sucursales responde 401 y no entrega datos", async ({ request }) => {
  const lista = await request.get("/api/sucursales");
  expect(lista.status()).toBe(401);
  expect(await lista.json()).toEqual({ error: "Sin sesión" });
  const detalle = await request.get(`/api/sucursales/${await idSucursal("TEN")}`);
  expect(detalle.status()).toBe(401);
});

test("cuenta sin asignaciones: entra, ve el aviso y no accede a ninguna sucursal", async ({ page }) => {
  await entrar(page, await crearCuenta([]));
  await expect(page.getByTestId("sin-sucursales")).toContainText("no tiene acceso a ninguna sucursal");
  await expect(page.getByTestId("alcance-general")).toContainText("No otorgado");
  await expect(page.getByTestId("facultades")).toContainText("Ninguna");

  expect(await pedir(page, "/api/sucursales")).toEqual({ status: 200, cuerpo: { sucursales: [] } });
  expect((await pedir(page, `/api/sucursales/${await idSucursal("TEN")}`)).status).toBe(404);
  expect((await page.goto("/sucursales/TEN"))?.status()).toBe(404);
});

test("Recepción de Tenango: ve solo Tenango y su vista de Recepción", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  const enlaces = page.getByTestId("lista-sucursales").getByRole("link");
  await expect(enlaces).toHaveCount(1);
  await expect(enlaces.first()).toHaveAttribute("data-codigo", "TEN");

  await enlaces.first().click();
  await expect(page.getByTestId("nombre-sucursal")).toHaveText("Tenango");
  await expect(page.locator("[data-perfil]")).toHaveCount(1);
  await expect(page.locator('[data-perfil="recepcion"]')).toContainText("Vista de Recepción");
  await expect(page.getByTestId("permisos-sucursal")).toContainText("sucursal.consultar");
  await expect(page.getByTestId("permisos-sucursal")).not.toContainText("sucursal.editar");

  // Escribir otra sucursal en la dirección no sirve: «No encontrada», sin datos de esa sucursal.
  expect((await page.goto("/sucursales/STG"))?.status()).toBe(404);
  await expect(page.getByTestId("no-encontrada")).toContainText("No encontrada");
  await expect(page.locator("body")).not.toContainText("Santiago");
  // Una sucursal que no existe muestra exactamente lo mismo.
  expect((await page.goto("/sucursales/ZZZ"))?.status()).toBe(404);
  await expect(page.getByTestId("no-encontrada")).toContainText("No encontrada");
});

test("Recepción de Tenango: el servidor rechaza solicitudes directas a otra sucursal", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  const lista = (await pedir(page, "/api/sucursales")) as { status: number; cuerpo: { sucursales: { codigo: string }[] } };
  expect(lista.status).toBe(200);
  expect(lista.cuerpo.sucursales.map((s) => s.codigo)).toEqual(["TEN"]);

  expect((await pedir(page, `/api/sucursales/${await idSucursal("TEN")}`)).status).toBe(200);
  for (const codigo of ["STG", "ATL", "RAY", "SAD", "SCR"]) {
    const ajena = await pedir(page, `/api/sucursales/${await idSucursal(codigo)}`);
    expect(ajena, codigo).toEqual({ status: 404, cuerpo: { error: "No encontrada" } });
  }
  // Un identificador inventado responde igual que uno ajeno.
  expect((await pedir(page, `/api/sucursales/${randomUUID()}`)).status).toBe(404);
});

test("API: un identificador de sucursal mal formado responde 404, nunca un error del servidor", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]], { general: "direccion" }));
  const ten = await idSucursal("TEN");
  // Incluso con acceso a todas las sucursales, un formato inválido no llega a la base.
  for (const malo of [
    "abc",
    "TEN",
    "-".repeat(36),
    "g".repeat(36),
    `${ten}0`,
    ten.replaceAll("-", ""),
    "%27%20or%20%271%27%3D%271",
    "..%2F..%2Fapi%2Festado",
  ]) {
    expect(await pedir(page, `/api/sucursales/${malo}`), malo).toEqual({ status: 404, cuerpo: { error: "No encontrada" } });
  }
  // El mismo identificador, bien formado, sí responde.
  expect((await pedir(page, `/api/sucursales/${ten}`)).status).toBe(200);
});

test("Dirección con alcance general: ve todas las sucursales", async ({ page }) => {
  await entrar(page, await crearCuenta([["direccion", "TEN"]], { general: "direccion" }));
  const [{ total }] = await sql<{ total: number }[]>`select count(*)::int as total from sucursal`;
  await expect(page.getByTestId("lista-sucursales").getByRole("link")).toHaveCount(total);
  await expect(page.getByTestId("alcance-general")).toContainText("Dirección en todas las sucursales");
});

test("Dirección solo de Tenango: no ve otras sucursales ni tiene alcance general", async ({ page }) => {
  await entrar(page, await crearCuenta([["direccion", "TEN"]]));
  await expect(page.getByTestId("lista-sucursales").getByRole("link")).toHaveCount(1);
  await expect(page.getByTestId("alcance-general")).toContainText("No otorgado");
  expect((await page.goto("/sucursales/STG"))?.status()).toBe(404);
});

import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/** Bloque 2: reporte de expedientes creados y posibles duplicados (solo consulta, datos ficticios). */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar el reporte de expedientes";

async function crearCuenta(asignaciones: [string, string][]) {
  const correo = `repexp-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${"Cuenta " + correo.slice(7, 15)}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de reporte' from sucursal where codigo = ${codigo}`;
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
const pares = (page: Page) => page.getByTestId("par");
const par = (page: Page, nombre: RegExp) => pares(page).filter({ hasText: nombre });

test("Recepción no tiene el reporte: sin botón y «No encontrada», también con una solicitud directa", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN");
  await expect(page.getByTestId("reporte-expedientes")).toHaveCount(0);
  for (const ruta of ["/reportes/expedientes", "/reportes/expedientes?sucursal=TEN"]) {
    expect((await page.goto(ruta))?.status(), ruta).toBe(404);
    const directa = await page.evaluate(async (r) => {
      const res = await fetch(r, { credentials: "same-origin" });
      return { status: res.status, cuerpo: await res.text() };
    }, ruta);
    expect(directa.status).toBe(404);
    expect(directa.cuerpo).not.toContain("Valeria");
  }
});

test("Encargado de Tenango: expedientes creados de Tenango y el par de Valeria; no ve Santiago", async ({ page }) => {
  await entrar(page, await crearCuenta([["encargado", "TEN"]]));
  await page.goto("/sucursales/TEN");
  await page.getByTestId("reporte-expedientes").click();
  await expect(page).toHaveURL(/\/reportes\/expedientes\?sucursal=TEN$/);
  await expect(page.locator("#sucursal option")).toHaveText(["Tenango"]);

  // El número coincide con la base para el periodo mostrado (fechas de la zona horaria de Tenango).
  const desde = await page.getByLabel("Desde").inputValue();
  const hasta = await page.getByLabel("Hasta").inputValue();
  const [{ n }] = await sql`
    select count(*)::int as n from visitante v join sucursal s on s.id = v.sucursal_alta_id
    where s.codigo = 'TEN' and v.creado_en >= (${desde}::date)::timestamp at time zone s.zona_horaria
      and v.creado_en < (${hasta}::date + 1)::timestamp at time zone s.zona_horaria`;
  await expect(page.getByTestId("expedientes-creados")).toContainText("Expedientes creados");
  await expect(page.getByTestId("creados-TEN")).toHaveText(String(n));

  await expect(par(page, /Valeria Gómez Pineda/)).toHaveCount(1);
  await expect(par(page, /Valeria Gómez Pineda/)).toContainText("Mismo teléfono");
  await expect(par(page, /Valeria Gómez Pineda/)).toContainText("•• •••• 0401");
  // María tiene una ficha en Santiago: este reporte no la muestra. Ana y Luis están confirmados como distintos.
  await expect(par(page, /María Hernández/)).toHaveCount(0);
  await expect(par(page, /Ana Martínez Ruiz/)).toHaveCount(0);
  await expect(page.getByTestId("total-duplicados")).toHaveText(String(await pares(page).count()));
  expect(await page.locator("body").innerText()).not.toMatch(/0000000\d{3}/);

  expect((await page.goto("/reportes/expedientes?sucursal=STG"))?.status()).toBe(404);
});

test("con el reporte en Tenango y Santiago aparece el par de María, contado una vez", async ({ page }) => {
  await entrar(page, await crearCuenta([["administracion", "TEN"], ["administracion", "STG"]]));
  await page.goto("/reportes/expedientes");
  await expect(page.locator("#sucursal option")).toHaveText(["Todas mis sucursales", "Santiago", "Tenango"]);
  const maria = par(page, /María Hernández García/);
  await expect(maria).toHaveCount(1);
  await expect(maria).toContainText("Mismo nombre");
  await expect(maria).toContainText("Creada en Tenango");
  await expect(maria).toContainText("Creada en Santiago");
  await expect(page.getByTestId("creados-total")).toBeVisible();

  await page.getByLabel("Sucursal").selectOption("STG");
  await page.getByRole("button", { name: "Ver" }).click();
  await expect(page).toHaveURL(/sucursal=STG/);
  await expect(par(page, /María Hernández García/)).toHaveCount(1);
  await expect(par(page, /Valeria/)).toHaveCount(0);
});

test("Encargado de Santiago no ve el par de María porque no tiene el reporte en Tenango", async ({ page }) => {
  await entrar(page, await crearCuenta([["encargado", "STG"]]));
  await page.goto("/reportes/expedientes");
  await expect(par(page, /María Hernández García/)).toHaveCount(0);
});

test("el reporte es solo consulta: el único formulario es el filtro", async ({ page }) => {
  await entrar(page, await crearCuenta([["direccion", "TEN"]]));
  await page.goto("/reportes/expedientes");
  await expect(page.locator("main form")).toHaveCount(1);
  await expect(page.locator("main form")).toHaveAttribute("method", "get");
  await expect(page.locator("main button")).toHaveText(["Ver"]);
});

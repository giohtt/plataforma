import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/** Tarea 7: reporte de usuarios y accesos por sucursal, de solo consulta. */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar el reporte 2026";

async function crearCuenta(asignaciones: [string, string][]) {
  const correo = `reporte-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${"Cuenta " + correo.slice(8, 16)}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de reporte' from sucursal where codigo = ${codigo}`;
  }
  return correo;
}

async function entrar(page: Page, correo: string) {
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Solicitud directa a la página del reporte, con la sesión del navegador. */
async function pedirHtml(page: Page, ruta: string) {
  return page.evaluate(async (r) => {
    const res = await fetch(r, { credentials: "same-origin" });
    return { status: res.status, cuerpo: await res.text() };
  }, ruta);
}

test("Recepción no puede abrir el reporte, ni de su sucursal ni con una solicitud directa", async ({ page }) => {
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto("/sucursales/TEN");
  await expect(page.getByTestId("reporte-usuarios")).toHaveCount(0);
  for (const ruta of ["/reportes/usuarios", "/reportes/usuarios?sucursal=TEN", "/reportes/usuarios?sucursal=TEN&anteriores=1"]) {
    expect((await page.goto(ruta))?.status(), ruta).toBe(404);
    await expect(page.getByTestId("no-encontrada")).toBeVisible();
    const directa = await pedirHtml(page, ruta);
    expect(directa.status, ruta).toBe(404);
    expect(directa.cuerpo).not.toContain("Encargado Tenango (prueba)");
  }
});

test("Encargado de Tenango consulta Tenango, pero no Santiago, ni con una solicitud directa", async ({ page }) => {
  await entrar(page, await crearCuenta([["encargado", "TEN"]]));
  await page.goto("/sucursales/TEN");
  await page.getByTestId("reporte-usuarios").click();
  await expect(page).toHaveURL(/\/reportes\/usuarios\?sucursal=TEN$/);
  await expect(page.locator("#sucursal option")).toHaveText(["Tenango"]);
  await expect(page.getByTestId("locales")).toContainText("Recepción Tenango (prueba)");
  await expect(page.getByTestId("locales")).not.toContainText("Recepción Santiago (prueba)");

  for (const ruta of ["/reportes/usuarios?sucursal=STG", "/reportes/usuarios?sucursal=STG&anteriores=1", "/reportes/usuarios?sucursal=ZZZ"]) {
    expect((await page.goto(ruta))?.status(), ruta).toBe(404);
    await expect(page.getByTestId("no-encontrada")).toBeVisible();
    const directa = await pedirHtml(page, ruta);
    expect(directa.status, ruta).toBe(404);
    expect(directa.cuerpo).not.toContain("Recepción Santiago (prueba)");
  }
});

test("vigentes por defecto; «Incluir anteriores» agrega la vencida; quien tiene dos vías cuenta una vez", async ({ page }) => {
  await entrar(page, await crearCuenta([["encargado", "TEN"]]));
  await page.goto("/reportes/usuarios?sucursal=TEN");
  const locales = page.getByTestId("locales");
  await expect(locales).not.toContainText("Recepción con asignación vencida (prueba)");

  // Dirección general: asignación en Tenango y acceso general. Aparece en ambas listas, cuenta una vez.
  await expect(locales).toContainText("Dirección general (prueba)");
  await expect(page.getByTestId("generales")).toContainText("Dirección general (prueba)");
  await expect(page.getByTestId("facultades-sucursal")).toContainText("Todas las sucursales");
  await expect(page.getByTestId("facultades-sucursal")).toContainText("$1,000.00");

  const [{ total }] = await sql<{ total: number }[]>`
    select count(*)::int as total from usuario u, sucursal s
    where s.codigo = 'TEN' and u.activo and (
      exists (select 1 from perfiles_en_sucursal(u.id, s.id))
      or exists (select 1 from facultad_otorgada f where f.usuario_id = u.id and (f.sucursal_id = s.id or f.todas_las_sucursales)
                 and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en)))`;
  await expect(page.getByTestId("total-personas")).toHaveText(String(total));

  await page.getByLabel(/Incluir anteriores/).check();
  await page.getByRole("button", { name: "Ver" }).click();
  await expect(page).toHaveURL(/sucursal=TEN&anteriores=1/);
  const vencida = locales.getByRole("row", { name: /Recepción con asignación vencida/ });
  await expect(vencida).toContainText("Vencida");
  await expect(page.getByTestId("total-personas")).toHaveText(String(total));
});

test("el reporte es de solo consulta: no ofrece formularios que cambien datos", async ({ page }) => {
  await entrar(page, await crearCuenta([["encargado", "TEN"]]));
  await page.goto("/reportes/usuarios?sucursal=TEN");
  // Solo el filtro (GET) y «Cerrar sesión».
  await expect(page.locator("main form")).toHaveCount(1);
  await expect(page.locator("main form")).toHaveAttribute("method", "get");
  await expect(page.locator("main button")).toHaveText(["Ver"]);
});

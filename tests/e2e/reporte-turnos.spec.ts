import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/** Bloque 3: reporte de turnos abiertos y responsables (solo consulta). Cada prueba usa sus sucursales ficticias. */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar el reporte de turnos";

async function sucursal() {
  const codigo = `R${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
  await sql`insert into sucursal (nombre, codigo, estado_operativo) values (${"Reporte " + codigo}, ${codigo}, 'activa')`;
  return codigo;
}
async function crearCuenta(asignaciones: [string, string][]) {
  const correo = `rept-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const nombre = "Persona " + correo.slice(5, 13);
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de reporte' from sucursal where codigo = ${codigo}`;
  }
  return { correo, nombre };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
/** Abre el turno desde la pantalla, como Recepción. */
async function abrirTurno(page: Page, codigo: string) {
  await page.goto(`/sucursales/${codigo}/turno`);
  await page.waitForLoadState("networkidle");
  await page.locator("#bolsa").fill("0");
  await page.locator("#cajon").fill("1,200");
  await page.getByRole("button", { name: "Abrir turno" }).click();
  await expect(page.getByTestId("turno-abierto")).toBeVisible();
}

test("los campos de la apertura empiezan vacíos, sin «0.00» de ejemplo, y siguen pidiendo escribir 0", async ({ page }) => {
  const codigo = await sucursal();
  await entrar(page, (await crearCuenta([["recepcion", codigo]])).correo);
  await page.goto(`/sucursales/${codigo}/turno`);
  await page.waitForLoadState("networkidle");
  for (const campo of ["#bolsa", "#cajon"]) {
    await expect(page.locator(campo)).toHaveValue("");
    await expect(page.locator(campo)).not.toHaveAttribute("placeholder");
  }
  await page.getByRole("button", { name: "Abrir turno" }).click();
  await expect(page.locator("#bolsa-error")).toHaveText("Escribe el total contado. Si no hay dinero, escribe 0.");
});

test("Recepción ve su turno, pero no el reporte: sin botón y «No encontrada», también con enlace directo", async ({ page }) => {
  const codigo = await sucursal();
  const recep = await crearCuenta([["recepcion", codigo]]);
  await entrar(page, recep.correo);
  await abrirTurno(page, codigo);
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("turno-abierto")).toContainText(`Abierto por ${recep.nombre}`);
  await page.goto(`/sucursales/${codigo}`);
  await expect(page.getByTestId("reporte-turnos")).toHaveCount(0);
  for (const ruta of ["/reportes/turnos", `/reportes/turnos?sucursal=${codigo}`]) {
    expect((await page.goto(ruta))?.status(), ruta).toBe(404);
    await expect(page.getByTestId("no-encontrada")).toBeVisible();
    const directa = await page.evaluate(async (r) => {
      const res = await fetch(r, { credentials: "same-origin" });
      return { status: res.status, cuerpo: await res.text() };
    }, ruta);
    expect(directa.status, ruta).toBe(404);
    expect(directa.cuerpo).not.toContain("Responsable de la bolsa");
  }
});

test("Encargado ve el turno abierto: apertura, quién abrió y responsables de la bolsa y del cajón por separado", async ({ page }) => {
  const codigo = await sucursal();
  const recep = await crearCuenta([["recepcion", codigo]]);
  await entrar(page, recep.correo);
  await abrirTurno(page, codigo);

  await entrar(page, (await crearCuenta([["encargado", codigo]])).correo);
  await page.goto(`/sucursales/${codigo}`);
  await page.getByTestId("reporte-turnos").click();
  await expect(page).toHaveURL(new RegExp(`/reportes/turnos\\?sucursal=${codigo}$`));
  await expect(page.getByTestId("turnos-abiertos")).toHaveText("1");
  const fila = page.getByTestId(`turno-${codigo}`);
  await expect(fila).toContainText(recep.nombre);
  await expect(page.getByTestId(`bolsa-${codigo}`)).toContainText(recep.nombre);
  await expect(page.getByTestId(`cajon-${codigo}`)).toContainText(recep.nombre);
  await expect(fila).toContainText(/\d{1,2}:\d{2}/);
  // Solo consulta: sin importes ni formularios que cambien datos.
  await expect(page.locator("main")).not.toContainText("$");
  await expect(page.locator("main form")).toHaveCount(0);
});

test("Administración de dos sucursales ve ambas; Encargado de otra sucursal no ve esta", async ({ page }) => {
  const conTurno = await sucursal();
  const sinTurno = await sucursal();
  await entrar(page, (await crearCuenta([["recepcion", conTurno]])).correo);
  await abrirTurno(page, conTurno);

  await entrar(page, (await crearCuenta([["administracion", conTurno], ["administracion", sinTurno]])).correo);
  await page.goto("/reportes/turnos");
  await expect(page.getByTestId("turnos-abiertos")).toHaveText("1");
  await expect(page.getByTestId(`turno-${sinTurno}`)).toContainText("Sin turno abierto");
  await expect(page.getByTestId(`bolsa-${conTurno}`)).toBeVisible();
  await page.getByLabel("Sucursal").selectOption(sinTurno);
  await page.getByRole("button", { name: "Ver" }).click();
  await expect(page.getByTestId(`turno-${conTurno}`)).toHaveCount(0);
  await expect(page.getByTestId("turnos-abiertos")).toHaveText("0");

  await entrar(page, (await crearCuenta([["encargado", sinTurno]])).correo);
  expect((await page.goto(`/reportes/turnos?sucursal=${conTurno}`))?.status()).toBe(404);
});

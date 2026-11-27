import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 6, PR 2 (27 nov 2026; solo datos ficticios): «Autorizar gastos» en la ficha de la persona, con límite por gasto
 * y acumulado diario, vista previa antes de guardar; «sin límite» solo para Dirección; cargo «Gestión administrativa».
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar los gastos 2026";
const id = () => randomUUID().slice(0, 8);
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
async function cuenta(nombre: string) {
  const correo = `gastos-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
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

test("autorizar gastos: límite por gasto y acumulado diario con vista previa; sin límite solo para Dirección", async ({ page }) => {
  test.setTimeout(90_000);
  const codigo = `G${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const sucursal = `Gastos ${codigo}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${sucursal}, ${codigo}) returning id`;
  const dir = await cuenta(`Dirección ${id()}`);
  await sql`insert into alcance_general (usuario_id, rol, motivo) values (${dir.id}, 'direccion', 'Prueba de gastos')`;
  const encargado = await cuenta(`Encargado ${id()}`);
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${encargado.id}, 'encargado', ${s.id}, 'Prueba de gastos')`;

  await entrar(page, dir.correo);
  await page.goto(`/usuarios/${encargado.id}`);
  const sec = page.getByTestId("facultad-gasto");
  await expect(sec.getByTestId("facultad-gasto-sin")).toHaveText("Sin facultad: no autoriza gastos.");
  await sec.getByTestId("abrir-facultad_gasto").click();
  const f = sec.getByTestId("formulario-facultad_gasto");
  // «Sin límite» no es para un Encargado.
  await f.getByRole("checkbox", { name: /Sin límite/ }).check();
  await f.getByRole("radio", { name: "Elegir sucursales (una o varias)" }).check();
  await f.getByRole("checkbox", { name: sucursal }).check();
  await f.getByLabel("Motivo").fill("Prueba ficticia de límites para gastos");
  await f.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await expect(sec.getByText("Esta autorización es solo para una cuenta con Dirección en esas sucursales.")).toBeVisible();

  const f2 = sec.getByTestId("formulario-facultad_gasto");
  await f2.getByRole("checkbox", { name: /Sin límite/ }).uncheck();
  await f2.getByLabel("Límite por gasto").fill("300");
  await f2.getByLabel("Acumulado diario").fill("200");
  await f2.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await expect(sec.getByText("Escribe el acumulado diario: un importe mayor que 0 y no menor que el límite por gasto.")).toBeVisible();
  const f3 = sec.getByTestId("formulario-facultad_gasto");
  await f3.getByLabel("Acumulado diario").fill("500");
  await f3.getByRole("button", { name: "Revisar cómo quedará" }).click();
  const vista = f3.getByTestId("vista-previa");
  await expect(vista).toContainText(`Autorizar gastos en ${sucursal} · hasta $300.00 por gasto y $500.00 en total por día.`);
  await expect(vista.getByTestId("gana")).toContainText(`límite $300.00 por gasto y $500.00 al día en ${sucursal}`);
  await capturar(page, "facultad-gasto-vista-previa");
  await f3.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(page.getByRole("status")).toHaveText("Cambio guardado. Quedó en el historial.");
  await expect(page.getByTestId("facultad-gasto-vigente")).toContainText(`${sucursal} · límite $300.00 por gasto y $500.00 al día`);
  await expect(page.getByTestId("puede-autorizacion.gasto")).toContainText(`límite $300.00 por gasto y $500.00 al día en ${sucursal}`);
  await expect(page.getByTestId("historial-persona")).toContainText("Dio la facultad para autorizar gastos");
  await capturar(page, "facultad-gasto-guardada");

  // «Dar un permiso» ya no ofrece autorizar gastos.
  await page.getByTestId("abrir-dar_permiso").click();
  await expect(page.getByTestId("formulario-dar_permiso").locator('option[value="autorizacion.gasto"]')).toHaveCount(0);

  // Dirección en todas: sin límite, marcado a propósito.
  await page.goto(`/usuarios/${dir.id}`);
  const sd = page.getByTestId("facultad-gasto");
  await sd.getByTestId("abrir-facultad_gasto").click();
  const fd = sd.getByTestId("formulario-facultad_gasto");
  await fd.getByRole("checkbox", { name: /Sin límite/ }).check();
  await expect(fd.getByLabel("Límite por gasto")).toHaveCount(0);
  await fd.getByRole("radio", { name: /Todas las sucursales/ }).check();
  await fd.getByLabel("Motivo").fill("Prueba ficticia: Dirección sin límite");
  await fd.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await expect(fd.getByTestId("vista-previa")).toContainText("sin límite");
  await fd.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(page.getByTestId("facultad-gasto-vigente")).toContainText("Todas las sucursales · sin límite");
  await capturar(page, "facultad-gasto-direccion");

  // El perfil «Gestión administrativa» existe y se ofrece al dar un perfil.
  await page.getByTestId("abrir-dar_perfil").click();
  await expect(page.getByTestId("formulario-dar_perfil").getByLabel("Perfil")).toContainText("Gestión administrativa");
});

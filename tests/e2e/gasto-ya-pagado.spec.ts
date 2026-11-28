import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { abrirTurno } from "../../src/lib/turnos";

/**
 * Bloque 6, PR 8 (27 nov 2026; solo datos ficticios): el Encargado registra un gasto que ya se pagó de la bolsa en un
 * turno cerrado. Queda «Pagado sin autorización previa · por revisar · Dirección», ligado a ese turno, sin descontarse
 * del turno abierto. Dirección lo ve en su bandeja, sin botón para autorizarlo.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));
const PRUEBAS = { entorno: "pruebas" as const };
const CLAVE = "frase para probar los ya pagados 2026";
const id = () => randomUUID().slice(0, 8);
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
async function cuenta(nombre: string, rol: string, sucursal: string | null) {
  const correo = `yapagado-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  if (sucursal) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${sucursal}, 'Prueba de ya pagados')`;
  else await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${rol}, 'Prueba de ya pagados')`;
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

test("gasto ya pagado de la bolsa de un turno cerrado: sin autorización previa, ligado a ese turno, sin tocar el turno abierto", async ({ page }) => {
  test.setTimeout(120_000);
  const codigo = `Y${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Ya pagados " + codigo}, ${codigo}) returning id`;
  const rec = await cuenta(`Recepción ${id()}`, "recepcion", s.id);
  const rec2 = await cuenta(`Recepción ${id()}`, "recepcion", s.id);
  const enc = await cuenta(`Encargado ${id()}`, "encargado", s.id);
  const dir = await cuenta(`Dirección ${id()}`, "direccion", null);
  const t1 = await abrirTurno(sql, rec.id, codigo, { bolsa: "1000.00", cajon: "0.00" }, PRUEBAS);
  if (!t1.ok) throw new Error(t1.error);
  await sql`update turno set cerrado_en = now() where sucursal_id = ${s.id}`;
  await sql`update responsable_lugar set hasta = now() where turno_id in (select id from turno where sucursal_id = ${s.id})`;
  const t2 = await abrirTurno(sql, rec2.id, codigo, { bolsa: "500.00", cajon: "0.00" }, PRUEBAS);
  if (!t2.ok) throw new Error(t2.error);

  // Recepción no lo registra (avisa a su Encargado).
  await entrar(page, rec2.correo);
  await page.goto(`/sucursales/${codigo}/gastos`);
  await expect(page.getByTestId("registrar-ya-pagado")).toHaveCount(0);

  await entrar(page, enc.correo);
  await page.goto(`/sucursales/${codigo}/gastos`);
  await page.getByTestId("abrir-ya-pagado").click();
  const f = page.getByTestId("formulario-gasto-pagado");
  await f.getByLabel("Qué se va a comprar o pagar").fill("Garrafones ficticios");
  await f.getByLabel("Categoría").selectOption({ label: "Agua (de prueba)" });
  await f.getByLabel("Importe").fill("120");
  await f.getByLabel(/Proveedor/).fill("Agua ficticia");
  await f.getByRole("radio", { name: "Bolsa de visitas" }).check();
  await f.getByLabel("Turno cerrado del que salió").selectOption({ index: 1 });
  await f.getByLabel("Quién pagó").selectOption({ label: rec.nombre });
  await f.getByLabel("Fecha del pago").fill(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date()));
  await f.getByLabel(/Por qué se pagó sin pedir autorización/).fill("Prueba ficticia: se acabó el agua en la tarde");
  await f.getByLabel("Tipo de comprobante").selectOption("ticket");
  await capturar(page, "ya-pagado-formulario");
  await f.getByRole("button", { name: "Registrar gasto ya pagado" }).click();
  await expect(page.getByRole("status")).toContainText("Gasto ya pagado registrado. No es aprobarlo");
  await expect(page.getByTestId("estado-gasto")).toContainText("Pagado sin autorización previa · por revisar · Dirección");
  await expect(page.getByTestId("ya-pagado")).toContainText("Prueba ficticia: se acabó el agua en la tarde");
  await expect(page.getByTestId("turno-cerrado")).toContainText("Pago de un turno cerrado");
  await expect(page.getByTestId("importe-pagado")).toHaveText("$120.00");
  await expect(page.getByTestId("formulario-decision")).toHaveCount(0);
  await capturar(page, "ya-pagado-detalle");
  const clave = (await page.getByTestId("clave-gasto").textContent())!;

  // El turno abierto no cambia.
  await entrar(page, rec2.correo);
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("esperado").first()).toHaveText("$500.00");
  await expect(page.getByTestId("gastos-pagados")).toHaveCount(0);

  // Dirección lo ve en su bandeja, sin botón para autorizarlo.
  await entrar(page, dir.correo);
  await page.goto("/gastos?vista=sin_autorizacion");
  await expect(page.getByRole("link", { name: clave })).toBeVisible();
  await capturar(page, "ya-pagado-bandeja");
  await page.goto(`/sucursales/${codigo}/gastos/${clave}`);
  await expect(page.getByTestId("estado-gasto")).toContainText("Pagado sin autorización previa");
  await expect(page.getByTestId("formulario-decision")).toHaveCount(0);
});

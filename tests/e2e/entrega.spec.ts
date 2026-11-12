import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 5: cambio de turno con confirmación de quien recibe, con datos ficticios. Sucursal nueva con un turno
 * abierto: bolsa con $650 al abrir, sin cobros (esperado $650), y cajón con $1,200.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar la entrega 2026";
const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxz"[Math.floor(Math.random() * 20)]).join("");

async function crearCuenta(rol: string, codigo: string, nombre: string) {
  const correo = `entrega-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba de entrega' from sucursal where codigo = ${codigo}`;
  return { id: u.id, correo, nombre };
}
async function escenario() {
  const codigo = `Y${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  await sql`insert into sucursal (nombre, codigo) values (${"Entrega " + codigo}, ${codigo})`;
  const laura = await crearCuenta("recepcion", codigo, "Laura " + letras(5));
  const sofia = await crearCuenta("recepcion", codigo, "Sofía " + letras(5));
  const [t] = await sql<{ id: string }[]>`
    insert into turno (sucursal_id, abierto_por) select id, ${laura.id} from sucursal where codigo = ${codigo} returning id`;
  await sql`insert into responsable_lugar (lugar_id, turno_id, usuario_id)
            select l.id, ${t.id}, ${laura.id} from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  await sql`insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por)
            select ${t.id}, l.id, 'apertura', case l.tipo when 'bolsa_visitas' then 650 else 1200 end, ${laura.id}
            from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  return { codigo, laura, sofia, turnoId: t.id };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
async function entregar(page: Page, codigo: string, bolsa: string, cajon: string, a: string) {
  await page.goto(`/sucursales/${codigo}/turno`);
  await page.getByTestId("ir-entregar").click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("entrega-esperado")).toHaveText("$650.00");
  await page.locator("#bolsa").fill(bolsa);
  await page.locator("#cajon").fill(cajon);
  await page.getByLabel("Quién recibe").selectOption({ label: a });
  await page.getByTestId("apoyo").getByRole("radio", { name: "No, nadie más participó" }).check();
  await page.getByRole("button", { name: "Entregar el turno" }).click();
  await expect(page.getByTestId("estado-entrega")).toContainText(`Entrega pendiente de confirmar por ${a}`);
  await expect(page.getByTestId("estado-entrega")).not.toContainText("m..");
}
async function recibir(page: Page, codigo: string, bolsa: string, cajon: string, aclaracion?: string) {
  if (!aclaracion) {
    await page.goto(`/sucursales/${codigo}/turno`);
    await page.getByTestId("ir-recibir").click();
  }
  await page.waitForLoadState("networkidle");
  await page.locator("#bolsa").fill(bolsa);
  await page.locator("#cajon").fill(cajon);
  if (aclaracion) await page.locator("#aclaracion").fill(aclaracion);
  await page.getByTestId("apoyo").getByRole("radio", { name: "No, nadie más participó" }).check();
  await page.getByRole("button", { name: aclaracion ? "Confirmar tras recontar" : "Confirmar lo que recibo" }).click();
}

test("faltan $50 contra el esperado: la entrante confirma desde su cuenta y empieza su turno con lo que recibió", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.laura.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/entrega`);
  await page.waitForLoadState("networkidle");
  await page.locator("#bolsa").fill("600");
  await expect(page.getByTestId("entrega-diferencia")).toContainText("Diferencia contra el esperado: −$50.00");
  await entregar(page, e.codigo, "600", "1850", e.sofia.nombre);
  // Mientras está pendiente, no se cobra.
  await expect(page.getByRole("link", { name: "Registrar visita" })).toHaveCount(0);

  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/recibir`);
  // No ve lo que contó la saliente.
  await expect(page.locator("main")).not.toContainText("600");
  await expect(page.locator("main")).not.toContainText("1,850");
  await recibir(page, e.codigo, "600", "1850");
  await expect(page.locator("p.aviso[role=status]")).toContainText("Turno recibido");
  const bolsa = page.getByTestId("recibida-bolsa_visitas");
  await expect(bolsa.getByTestId("dif-esperado")).toHaveText("−$50.00 · Por revisar");
  await expect(bolsa.getByTestId("dif-personas")).toHaveText("$0.00");
  await expect(page.getByTestId("recibida-cajon_mensualidades").getByTestId("dif-esperado")).toHaveText("No se puede calcular");
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("contado-al-abrir")).toHaveText("$600.00");
  await expect(page.getByTestId("lugar-bolsa_visitas")).toContainText(e.sofia.nombre);
  await expect(page.getByRole("link", { name: "Registrar visita" })).toBeVisible();
  // La tabla se ve desde la primera columna (el lugar, fija) y el resto se consulta desplazándola; no hay «p.m..».
  const tabla = page.getByTestId("entrega-recibida").locator(".tabla-desplazable");
  await tabla.scrollIntoViewIfNeeded();
  expect(await tabla.evaluate((x) => x.scrollLeft)).toBe(0);
  await expect(page.getByTestId("entrega-recibida").getByRole("columnheader", { name: "Lugar" })).toBeInViewport();
  await tabla.evaluate((x) => x.scrollTo({ left: x.scrollWidth }));
  await expect(bolsa.getByRole("cell", { name: "Bolsa de visitas" })).toBeInViewport();
  await expect(bolsa.getByTestId("dif-personas")).toBeInViewport();
  expect(await page.locator("main").innerText()).not.toMatch(/[ap]\.m\.\./);
  // En computadora la tabla «Entrega recibida» se lee completa, sin deslizar.
  if (test.info().project.name === "escritorio") {
    expect(await tabla.evaluate((x) => x.scrollWidth <= x.clientWidth + 1)).toBe(true);
  }
});

test("si no coinciden, recuentan juntas y el desacuerdo que persiste queda por revisar aparte", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.laura.correo);
  await entregar(page, e.codigo, "650", "1200", e.sofia.nombre);

  await entrar(page, e.sofia.correo);
  await recibir(page, e.codigo, "600", "1200");
  await expect(page.getByTestId("aviso-recuento")).toBeVisible();
  await expect(page.getByTestId("tabla-recuento")).toContainText("$650.00");
  await expect(page.getByTestId("tabla-recuento")).toContainText("−$50.00");
  await recibir(page, e.codigo, "600", "1200", "Recontamos juntas y siguen faltando $50");
  const bolsa = page.getByTestId("recibida-bolsa_visitas");
  await expect(bolsa.getByTestId("dif-esperado")).toHaveText("$0.00");
  await expect(bolsa.getByTestId("dif-personas")).toHaveText("−$50.00 · Por revisar");
  await expect(page.getByTestId("aclaracion")).toContainText("Recontamos juntas y siguen faltando $50");
});

test("la saliente puede cancelar la entrega pendiente con motivo y vuelve a cobrar", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.laura.correo);
  await entregar(page, e.codigo, "650", "1200", e.sofia.nombre);
  await page.getByLabel("Motivo para cancelar la entrega").fill("Elegí a la persona equivocada");
  await page.getByRole("button", { name: "Cancelar la entrega" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Entrega cancelada. El turno sigue a tu cargo.");
  await expect(page.getByRole("link", { name: "Registrar visita" })).toBeVisible();
  await expect(page.getByTestId("ir-entregar")).toBeVisible();
});

import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 5: diferencias de efectivo (lista y desglose), con datos ficticios. Sucursal nueva con un turno
 * abierto: bolsa con $650 al abrir, sin cobros (esperado $650), y cajón con $1,200.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar las diferencias 2026";
const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxz"[Math.floor(Math.random() * 20)]).join("");

async function crearCuenta(rol: string, codigo: string, nombre: string) {
  const correo = `diferencias-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba de diferencias' from sucursal where codigo = ${codigo}`;
  return { id: u.id, correo, nombre };
}
async function escenario() {
  const codigo = `Y${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  await sql`insert into sucursal (nombre, codigo) values (${"Entrega " + codigo}, ${codigo})`;
  const laura = await crearCuenta("recepcion", codigo, "Laura " + letras(5));
  const sofia = await crearCuenta("recepcion", codigo, "Sofía " + letras(5));
  const encargado = await crearCuenta("encargado", codigo, "Encargado " + letras(5));
  const [t] = await sql<{ id: string }[]>`
    insert into turno (sucursal_id, abierto_por) select id, ${laura.id} from sucursal where codigo = ${codigo} returning id`;
  await sql`insert into responsable_lugar (lugar_id, turno_id, usuario_id)
            select l.id, ${t.id}, ${laura.id} from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  await sql`insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por)
            select ${t.id}, l.id, 'apertura', case l.tipo when 'bolsa_visitas' then 650 else 1200 end, ${laura.id}
            from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  return { codigo, laura, sofia, encargado, turnoId: t.id };
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
  await page.getByRole("button", { name: "Entregar el turno" }).click();
  await expect(page.getByTestId("estado-entrega")).toContainText(`Entrega pendiente de confirmar por ${a}`);
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
  await page.getByRole("button", { name: aclaracion ? "Confirmar tras recontar" : "Confirmar lo que recibo" }).click();
}

test("Encargado consulta el caso: esperado, entregado y recibido por separado, y el desglose del esperado", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.laura.correo);
  await entregar(page, e.codigo, "600", "1200", e.sofia.nombre);
  await entrar(page, e.sofia.correo);
  await recibir(page, e.codigo, "600", "1200");
  await expect(page.locator("p.aviso[role=status]")).toContainText("Turno recibido");
  // Recepción no ve las diferencias.
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("diferencias")).toHaveCount(0);

  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("diferencias")).toHaveText("Diferencias de efectivo (1)");
  await page.getByTestId("diferencias").click();
  const caso = page.getByTestId("caso-diferencia").first();
  await expect(caso).toContainText("−$50.00 · Faltante contra el esperado");
  await expect(caso.getByTestId("estado-caso")).toHaveText("1 por revisar");
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/lista-${test.info().project.name}.png`, fullPage: true });
  await caso.getByTestId("ver-caso").click();
  const bolsa = page.getByTestId("caso-bolsa_visitas");
  await expect(bolsa.getByTestId("cifra-esperado")).toHaveText("$650.00");
  await expect(bolsa.getByTestId("cifra-entregado")).toHaveText("$600.00");
  await expect(bolsa.getByTestId("cifra-recibido")).toHaveText("$600.00");
  await expect(bolsa.getByTestId("cifra-entre-personas")).toHaveText("$0.00");
  await expect(bolsa.getByTestId("cifra-contra-esperado")).toContainText("−$50.00");
  await expect(bolsa.getByTestId("cifra-contra-esperado")).toContainText("Faltante contra el esperado · Por revisar");
  await expect(page.getByTestId("caso-cajon_mensualidades").getByTestId("cifra-contra-esperado")).toContainText("No se puede calcular");
  await expect(page.getByTestId("desglose-total")).toHaveText("$650.00");
  await expect(page.getByTestId("desglose-no-coincide")).toHaveCount(0);
  await expect(page.getByTestId("participaste")).toHaveCount(0);
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/detalle-${test.info().project.name}.png`, fullPage: true });
});

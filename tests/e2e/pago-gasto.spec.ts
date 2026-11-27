import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { decidirGasto, solicitarGasto } from "../../src/lib/gastos";
import { abrirTurno } from "../../src/lib/turnos";

/**
 * Bloque 6, PR 5 (27 nov 2026; solo datos ficticios; límites ficticios solo para la prueba): Recepción paga de la bolsa
 * un gasto autorizado, por lo pagado y con su comprobante; la salida baja el esperado del turno una vez. Pedir
 * autorización por el excedente. Dinero personal: pendiente de reembolso.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));
const PRUEBAS = { entorno: "pruebas" as const };
const CLAVE = "frase para probar los pagos 2026";
const id = () => randomUUID().slice(0, 8);
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
async function cuenta(nombre: string, rol: string, sucursal: string) {
  const correo = `pago-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${sucursal}, 'Prueba de pagos')`;
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

test("Recepción paga de la bolsa lo autorizado con su comprobante; excedente aparte; dinero personal pendiente de reembolso", async ({ page }) => {
  test.setTimeout(120_000);
  const codigo = `Q${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Pagos " + codigo}, ${codigo}) returning id`;
  const rec = await cuenta(`Recepción ${id()}`, "recepcion", s.id);
  const enc = await cuenta(`Encargado ${id()}`, "encargado", s.id);
  await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo)
            values (${enc.id}, 'autorizacion.gasto', ${s.id}, 500, 2000, 'Prueba')`;
  const t = await abrirTurno(sql, rec.id, codigo, { bolsa: "1000.00", cajon: "0.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  for (const importe of ["200", "300", "80"]) {
    const r = await solicitarGasto(sql, rec.id, codigo, { concepto: `Material ficticio ${importe}`, categoria: "prueba_limpieza", importe,
      proveedor: "Proveedor ficticio A", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const d = await decidirGasto(sql, enc.id, codigo, { clave: r.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS);
    if (!d.ok) throw new Error(d.error);
  }

  await entrar(page, rec.correo);
  await page.goto(`/sucursales/${codigo}`);
  await expect(page.getByTestId("accion-gastos-pagar")).toHaveText("Gastos autorizados por pagar (3)");
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G1`);
  const f = page.getByTestId("formulario-pago");
  await f.getByRole("radio", { name: "Bolsa de visitas" }).check();
  await f.getByLabel("Importe pagado").fill("250");
  await f.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.getByText("No puedes registrar más de lo autorizado. Si costó más, pide autorización por el excedente.")).toBeVisible();
  const f2 = page.getByTestId("formulario-pago");
  await f2.getByRole("radio", { name: "Bolsa de visitas" }).check();
  await f2.getByLabel("Importe pagado").fill("180");
  await f2.getByLabel("Tipo de comprobante").selectOption("ticket");
  await f2.getByLabel(/Folio/).fill("T-001");
  await capturar(page, "pago-formulario");
  await f2.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.getByRole("status")).toHaveText("Pago registrado. Si fue en efectivo, la salida quedó registrada una sola vez en el turno.");
  await expect(page.getByTestId("pagado")).toHaveText("Pagado");
  await expect(page.getByTestId("origen-pago")).toHaveText("Bolsa de visitas");
  await expect(page.getByTestId("importe-pagado")).toHaveText("$180.00");
  await expect(page.getByTestId("comprobacion")).toHaveText("Comprobado");
  await expect(page.getByTestId("comprobantes")).toContainText("Ticket · folio T-001");
  await capturar(page, "pago-registrado");
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("gastos-pagados").first()).toHaveText("− $180.00");
  await expect(page.getByTestId("esperado").first()).toHaveText("$820.00");

  // Costó más: autorización por el excedente, ligada a la misma compra.
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G2`);
  await page.getByTestId("abrir-excedente").click();
  await page.getByTestId("formulario-excedente").getByLabel("Cuánto cuesta en realidad").fill("350");
  await page.getByTestId("formulario-excedente").getByRole("button", { name: "Pedir autorización por el excedente" }).click();
  await expect(page.getByTestId("clave-gasto")).toHaveText(`${codigo}-G4`);
  await expect(page.getByTestId("importe-gasto")).toHaveText("$50.00");
  await expect(page.getByTestId("compra-de")).toHaveText(`${codigo}-G2`);
  await expect(page.getByTestId("estado-gasto")).toContainText("Por autorizar");

  // Dinero personal: no sale de caja; pendiente de reembolso; sin comprobante con motivo.
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G3`);
  const f3 = page.getByTestId("formulario-pago");
  await f3.getByRole("radio", { name: /Dinero personal/ }).check();
  await f3.getByLabel("Tipo de comprobante").selectOption("sin");
  await f3.getByLabel(/Por qué no hay comprobante/).fill("Prueba ficticia: el proveedor no entrega nota");
  await f3.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.getByTestId("reembolso-pendiente")).toContainText("pendiente de reembolso");
  await expect(page.getByTestId("comprobacion")).toHaveText("Sin comprobante · por revisar · Dirección");
  await capturar(page, "pago-personal");
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("esperado").first()).toHaveText("$820.00");
});

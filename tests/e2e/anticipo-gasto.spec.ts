import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { confirmarAnticipo, decidirGasto, entregarAnticipo, solicitarGasto } from "../../src/lib/gastos";
import { abrirTurno } from "../../src/lib/turnos";

/**
 * Bloque 6, PR 6 (27 nov 2026; solo datos ficticios; límites ficticios solo para la prueba): Recepción entrega un
 * anticipo de la bolsa; Administración lo confirma y lo comprueba desde su cuenta; el cambio vuelve en dos partes. Si
 * se necesitó más, el excedente queda como otra solicitud de la misma compra y, ya autorizado, se paga de la bolsa.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));
const PRUEBAS = { entorno: "pruebas" as const };
const CLAVE = "frase para probar los anticipos 2026";
const id = () => randomUUID().slice(0, 8);
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
async function cuenta(nombre: string, rol: string, sucursal: string) {
  const correo = `anticipo-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${sucursal}, 'Prueba de anticipos')`;
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

test("anticipo de la bolsa: entrega, confirmación, comprobación, cambio en partes y excedente pagado de caja", async ({ page }) => {
  test.setTimeout(150_000);
  const codigo = `N${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Anticipos " + codigo}, ${codigo}) returning id`;
  const rec = await cuenta(`Recepción ${id()}`, "recepcion", s.id);
  const enc = await cuenta(`Encargado ${id()}`, "encargado", s.id);
  const adm = await cuenta(`Administración ${id()}`, "administracion", s.id);
  await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo)
            values (${enc.id}, 'autorizacion.gasto', ${s.id}, 1000, 5000, 'Prueba')`;
  const t = await abrirTurno(sql, rec.id, codigo, { bolsa: "1000.00", cajon: "0.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  for (const importe of ["300", "400"]) {
    const r = await solicitarGasto(sql, rec.id, codigo, { concepto: `Material ficticio ${importe}`, categoria: "prueba_limpieza", importe,
      proveedor: "Ferretería ficticia", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
    const d = await decidirGasto(sql, enc.id, codigo, { clave: r.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS);
    if (!d.ok) throw new Error(d.error);
  }

  // Recepción (responsable vigente de la bolsa) entrega el anticipo a Administración.
  await entrar(page, rec.correo);
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G1`);
  await page.getByTestId("abrir-anticipo").click();
  const f = page.getByTestId("formulario-anticipo");
  await f.getByRole("radio", { name: "Bolsa de visitas" }).check();
  await f.getByLabel("Quién lo recibe para comprar").selectOption({ label: adm.nombre });
  await capturar(page, "anticipo-entregar");
  await f.getByRole("button", { name: "Entregar anticipo" }).click();
  await expect(page.getByRole("status")).toContainText("Anticipo entregado. Salió de caja una sola vez");
  await expect(page.getByTestId("anticipo-por-comprobar")).toHaveText("Fuera de caja: anticipo por comprobar");
  await expect(page.getByTestId("anticipo-entregado")).toHaveText("$300.00 · Bolsa de visitas");
  await expect(page.getByTestId("anticipo-recibe")).toContainText("falta que confirme que lo recibió");
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("anticipos-entregados").first()).toHaveText("− $300.00");
  await expect(page.getByTestId("esperado").first()).toHaveText("$700.00");

  // Administración lo confirma y lo comprueba desde su cuenta: gastó menos.
  await entrar(page, adm.correo);
  await page.goto(`/sucursales/${codigo}`);
  await expect(page.getByTestId("accion-anticipos")).toHaveText("Anticipos a tu cargo por comprobar (1)");
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G1`);
  await page.getByRole("button", { name: "Confirmo que recibí $300.00" }).click();
  await expect(page.getByRole("status")).toHaveText("Recibiste el anticipo: queda a tu cargo hasta comprobar la compra.");
  const c = page.getByTestId("formulario-comprobar-anticipo");
  await c.getByLabel("Cuánto se pagó al proveedor").fill("260");
  await expect(c.getByTestId("diferencia-anticipo")).toContainText("Sobran $40.00");
  await c.getByLabel("Tipo de comprobante").selectOption("ticket");
  await c.getByLabel(/Folio/).fill("T-901");
  await capturar(page, "anticipo-comprobar");
  await c.getByRole("button", { name: "Comprobar anticipo" }).click();
  await expect(page.getByRole("status")).toContainText("Devuelve el cambio a la responsable de caja");
  await expect(page.getByTestId("origen-pago")).toHaveText("Anticipo comprobado");
  await expect(page.getByTestId("importe-pagado")).toHaveText("$260.00");
  await expect(page.getByTestId("anticipo-cambio")).toContainText("$40.00 · por devolver a caja");

  // Recepción cuenta y recibe el cambio: primero una parte (el anticipo sigue abierto por lo que falta), luego el resto.
  await entrar(page, rec.correo);
  await page.goto(`/sucursales/${codigo}`);
  await expect(page.getByTestId("accion-cambio-anticipo")).toHaveText("Cambio de anticipos por recibir (1)");
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G1`);
  const recibir = async (importe: string) => {
    const k = page.getByTestId("formulario-cambio-anticipo");
    await k.getByLabel("Cuánto contaste").fill(importe);
    await k.getByRole("button", { name: "Recibir cambio" }).click();
  };
  await recibir("30");
  await expect(page.getByRole("status")).toHaveText("Devolución parcial recibida: entró a caja una sola vez. El anticipo sigue abierto por lo que falta.");
  await expect(page.getByTestId("cambio-pendiente")).toHaveText("Fuera de caja: cambio por devolver $10.00");
  await expect(page.getByTestId("anticipo-cambio")).toContainText("devuelto $30.00 · falta $10.00");
  await capturar(page, "anticipo-cambio-parcial");
  await recibir("20");
  await expect(page.getByText("Es más de lo que falta por devolver.")).toBeVisible();
  await recibir("10");
  await expect(page.getByRole("status")).toHaveText("Cambio recibido completo: entró a caja una sola vez y el anticipo quedó cerrado.");
  await expect(page.getByTestId("anticipo-cambio")).toContainText("devuelto completo");
  await expect(page.getByTestId("devoluciones-cambio").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("cambio-pendiente")).toHaveCount(0);
  await capturar(page, "anticipo-cambio");
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("cambios-anticipo").first()).toHaveText("+ $40.00");
  await expect(page.getByTestId("esperado").first()).toHaveText("$740.00");

  // Necesitó más: el excedente es otra solicitud de la misma compra (G2), por la diferencia.
  const e = await entregarAnticipo(sql, rec.id, codigo, { clave: `${codigo}-G2`, version: 1, lugar: "bolsa_visitas", recibe: adm.id }, PRUEBAS);
  if (!e.ok) throw new Error(e.error);
  const ok = await confirmarAnticipo(sql, adm.id, codigo, { clave: `${codigo}-G2` }, PRUEBAS);
  if (!ok.ok) throw new Error(ok.error);
  await entrar(page, adm.correo);
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G2`);
  const c2 = page.getByTestId("formulario-comprobar-anticipo");
  await c2.getByLabel("Cuánto se pagó al proveedor").fill("470");
  await expect(c2.getByTestId("diferencia-anticipo")).toContainText("Faltan $70.00");
  await c2.getByLabel("Tipo de comprobante").selectOption("nota");
  await c2.getByRole("button", { name: "Comprobar anticipo" }).click();
  await expect(page.getByRole("status")).toContainText("Se pidió autorización por el excedente");
  await expect(page.getByTestId("anticipo-excedente")).toContainText(`$70.00 · ${codigo}-G3`);
  await expect(page.getByTestId("importe-pagado")).toHaveText("$400.00");
  await capturar(page, "anticipo-excedente");
  await page.getByTestId("anticipo-excedente").getByRole("link", { name: `${codigo}-G3` }).click();
  await expect(page.getByTestId("clave-gasto")).toHaveText(`${codigo}-G3`);
  await expect(page.getByTestId("importe-gasto")).toHaveText("$70.00");
  await expect(page.getByTestId("compra-de")).toHaveText(`${codigo}-G2`);
  await expect(page.getByTestId("estado-gasto")).toContainText("Por autorizar");
  await expect(page.getByTestId("pagado-compra")).toContainText("$400.00");

  // Los $70 que faltaron los cubrió Administración al comprar. Ya autorizado el excedente, Recepción se los paga de la bolsa.
  const dx = await decidirGasto(sql, enc.id, codigo, { clave: `${codigo}-G3`, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS);
  if (!dx.ok) throw new Error(dx.error);
  await entrar(page, rec.correo);
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G3`);
  const p = page.getByTestId("formulario-pago");
  await p.getByRole("radio", { name: "Bolsa de visitas" }).check();
  await p.getByLabel(/A quién se pagó/).fill(`${adm.nombre} (lo cubrió al comprar)`);
  await p.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.getByTestId("importe-pagado")).toHaveText("$70.00");
  await expect(page.getByTestId("pagado-compra")).toContainText("$470.00");
  await expect(page.getByTestId("pagado-compra")).toContainText(`${codigo}-G2: $400.00 (Anticipo comprobado) + ${codigo}-G3: $70.00 (Bolsa de visitas)`);
  await capturar(page, "anticipo-excedente-caja");
  // Bolsa: 740 − 400 (anticipo) − 70 (excedente) = 270. Lo gastado en la compra ($470) baja una sola vez.
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("anticipos-entregados").first()).toHaveText("− $700.00");
  await expect(page.getByTestId("gastos-pagados").first()).toHaveText("− $70.00");
  await expect(page.getByTestId("esperado").first()).toHaveText("$270.00");
});

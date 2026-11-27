import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { decidirGasto, registrarPago, solicitarGasto } from "../../src/lib/gastos";
import { abrirTurno } from "../../src/lib/turnos";

/**
 * Bloque 6, PR 7 (27 nov 2026; solo datos ficticios; facultades ficticias solo para la prueba): Administración pagó
 * con su dinero; Dirección autoriza el reembolso desde su bandeja; Recepción lo paga de la bolsa una sola vez y
 * Administración confirma que lo recibió.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));
const PRUEBAS = { entorno: "pruebas" as const };
const CLAVE = "frase para probar los reembolsos 2026";
const id = () => randomUUID().slice(0, 8);
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
async function cuenta(nombre: string, rol: string, sucursal: string | null) {
  const correo = `reembolso-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  if (sucursal) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${sucursal}, 'Prueba de reembolsos')`;
  else await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, ${rol}, 'Prueba de reembolsos')`;
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

test("reembolso: Dirección lo autoriza, Recepción lo paga de la bolsa una vez y quien pagó con su dinero lo confirma", async ({ page }) => {
  test.setTimeout(150_000);
  const codigo = `E${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Reembolsos " + codigo}, ${codigo}) returning id`;
  const rec = await cuenta(`Recepción ${id()}`, "recepcion", s.id);
  const enc = await cuenta(`Encargado ${id()}`, "encargado", s.id);
  const adm = await cuenta(`Administración ${id()}`, "administracion", s.id);
  const dir = await cuenta(`Dirección ${id()}`, "direccion", null);
  await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo)
            values (${enc.id}, 'autorizacion.gasto', ${s.id}, 1000, 5000, 'Prueba')`;
  await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, sin_limite, motivo) values (${dir.id}, 'autorizacion.gasto', ${s.id}, true, 'Prueba')`;
  const t = await abrirTurno(sql, rec.id, codigo, { bolsa: "1000.00", cajon: "0.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const r = await solicitarGasto(sql, rec.id, codigo, { concepto: "Focos ficticios", categoria: "prueba_mantenimiento", importe: "120",
    proveedor: "Tlapalería ficticia", nota: "", pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  const d = await decidirGasto(sql, enc.id, codigo, { clave: r.clave, version: 1, decision: "autorizado", motivo: "" }, PRUEBAS);
  if (!d.ok) throw new Error(d.error);
  const p = await registrarPago(sql, adm.id, codigo, { clave: r.clave, version: 1, origen: "dinero_personal", importe: "120", aQuien: "", pagadoEl: hoyMx(),
    cuenta: "", referencia: "", tipo: "ticket", folio: "", motivoSin: "" }, PRUEBAS);
  if (!p.ok) throw new Error(p.error);

  // Dirección lo ve en su bandeja y lo autoriza desde su cuenta.
  await entrar(page, dir.correo);
  await page.goto("/gastos?vista=reembolsos");
  const fila = page.getByTestId("fila-bandeja").filter({ hasText: r.clave });
  await expect(fila.getByTestId("reembolso-bandeja")).toHaveText("Reembolso por decidir · Dirección");
  await fila.getByRole("link", { name: r.clave }).click();
  await expect(page.getByTestId("estado-reembolso")).toHaveText("Reembolso por decidir · Dirección");
  const f = page.getByTestId("formulario-decision-reembolso");
  await expect(f).toContainText(`Decidir el reembolso de $120.00 a ${adm.nombre}`);
  await capturar(page, "reembolso-decidir");
  await f.getByRole("button", { name: "Autorizar reembolso" }).click();
  await expect(page.getByRole("status")).toHaveText("Reembolso autorizado desde tu cuenta. Autorizar no mueve dinero: el pago se registra aparte.");
  await expect(page.getByTestId("decision-reembolso")).toContainText(`Autorizado por ${dir.nombre}`);

  // Recepción (responsable vigente) lo paga de la bolsa.
  await entrar(page, rec.correo);
  await page.goto(`/sucursales/${codigo}`);
  await expect(page.getByTestId("accion-reembolsos-pagar")).toHaveText("Reembolsos autorizados por pagar (1)");
  await page.goto(`/sucursales/${codigo}/gastos/${r.clave}`);
  const pr = page.getByTestId("formulario-pago-reembolso");
  await pr.getByRole("radio", { name: "Bolsa de visitas" }).check();
  await capturar(page, "reembolso-pagar");
  await pr.getByRole("button", { name: "Pagar reembolso" }).click();
  await expect(page.getByRole("status")).toHaveText("Reembolso pagado una sola vez. Falta que lo confirme quien lo recibe, desde su cuenta.");
  await expect(page.getByTestId("pago-reembolso")).toContainText("$120.00 · Bolsa de visitas");
  await expect(page.getByTestId("formulario-pago-reembolso")).toHaveCount(0);
  await page.goto(`/sucursales/${codigo}/turno`);
  await expect(page.getByTestId("reembolsos-pagados").first()).toHaveText("− $120.00");
  await expect(page.getByTestId("esperado").first()).toHaveText("$880.00");

  // Administración confirma que lo recibió: queda liquidado.
  await entrar(page, adm.correo);
  await page.goto(`/sucursales/${codigo}`);
  await expect(page.getByTestId("accion-reembolsos-confirmar")).toHaveText("Reembolsos por confirmar que recibiste (1)");
  await page.goto(`/sucursales/${codigo}/gastos/${r.clave}`);
  await page.getByRole("button", { name: "Confirmo que recibí el reembolso de $120.00" }).click();
  await expect(page.getByRole("status")).toHaveText("Confirmaste que recibiste el reembolso: queda liquidado.");
  await expect(page.getByTestId("estado-reembolso")).toHaveText("Reembolso recibido");
  await expect(page.getByTestId("importe-pagado")).toHaveText("$120.00");
  await capturar(page, "reembolso-recibido");
});

import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 5: retiros a Encargada de retiros, con datos ficticios. Sucursal nueva con un turno abierto: bolsa con $900
 * (esperado $900) y cajón con $2,300.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar los retiros 2026";
const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxz"[Math.floor(Math.random() * 20)]).join("");

async function crearCuenta(rol: string, codigo: string, nombre: string) {
  const correo = `retiros-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba de retiros' from sucursal where codigo = ${codigo}`;
  return { id: u.id, correo, nombre };
}
async function escenario() {
  const codigo = `W${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  await sql`insert into sucursal (nombre, codigo) values (${"Retiros " + codigo}, ${codigo})`;
  const laura = await crearCuenta("recepcion", codigo, "Laura " + letras(5));
  const encargada = await crearCuenta("encargada_retiros", codigo, "Encargada de retiros " + letras(4));
  const encargado = await crearCuenta("encargado", codigo, "Encargado " + letras(5));
  const admin = await crearCuenta("administracion", codigo, "Administración " + letras(5));
  const [t] = await sql<{ id: string }[]>`
    insert into turno (sucursal_id, abierto_por) select id, ${laura.id} from sucursal where codigo = ${codigo} returning id`;
  await sql`insert into responsable_lugar (lugar_id, turno_id, usuario_id)
            select l.id, ${t.id}, ${laura.id} from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  await sql`insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por)
            select ${t.id}, l.id, 'apertura', case l.tipo when 'bolsa_visitas' then 900 else 2300 end, ${laura.id}
            from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  return { codigo, laura, encargada, encargado, admin };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
async function retirar(page: Page, codigo: string, lugar: "bolsa_visitas" | "cajon_mensualidades", contado: string, cambio: string, folio: string) {
  await page.goto(`/sucursales/${codigo}/turno`);
  await page.getByTestId("ir-retiro").click();
  await page.waitForLoadState("networkidle");
  const f = page.getByTestId(`retiro-${lugar}`);
  await f.getByLabel("Total contado antes del retiro").fill(contado);
  await f.getByLabel("Deja para cambio (lo indica Encargada de retiros)").fill(cambio);
  await f.getByLabel("Folio del sobre").fill(folio);
  await capturar(page, "formulario-retiro");
  await f.getByRole("button", { name: /Entregar a Encargada de retiros/ }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("Retiro registrado");
}
const fechaLocal = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(Date.now() - 60_000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
/** En computadora, las tablas se leen completas sin deslizar. */
async function tablasSinDeslizar(page: Page) {
  if (test.info().project.name !== "escritorio") return;
  for (const t of await page.locator(".tabla-desplazable").all()) {
    expect(await t.evaluate((x) => x.scrollWidth <= x.clientWidth + 1)).toBe(true);
  }
}

test("$2,300 registrados y $2,250 contados: solo ese folio en pausa, los $50 fuera de su saldo y depósitos hasta el monto verificado", async ({ page }) => {
  const e = await escenario();
  // Recepción entrega la bolsa ($800, deja $100) y el cajón ($2,300), cada uno con su folio.
  await entrar(page, e.laura.correo);
  await retirar(page, e.codigo, "bolsa_visitas", "900", "100", "T-01");
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("esperado")).toHaveText("$100.00");
  await retirar(page, e.codigo, "cajon_mensualidades", "2300", "0", "T-02");
  await expect(page.getByTestId("retiro-turno")).toHaveCount(2);
  for (const r of await page.getByTestId("estado-retiro").all()) await expect(r).toHaveText("Pendiente de confirmar por Encargada de retiros");
  await expect(page.getByRole("link", { name: "Registrar visita" })).toBeVisible();
  await capturar(page, "turno");

  // Encargada de retiros confirma a ciegas: la bolsa coincide; el cajón no.
  await entrar(page, e.encargada.correo);
  await page.goto("/retiros");
  await expect(page.getByTestId("por-confirmar")).not.toContainText("2,300");
  const b = page.locator('[data-testid=retiro-por-confirmar][data-folio="T-01"]');
  await b.getByLabel("¿Cuánto contaste en el sobre?").fill("800");
  await b.getByRole("radio", { name: "Sí, coincide" }).check();
  await b.getByRole("button", { name: "Confirmar lo que recibí" }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("Retiro confirmado");
  const c = page.locator('[data-testid=retiro-por-confirmar][data-folio="T-02"]');
  await c.getByLabel("¿Cuánto contaste en el sobre?").fill("2250");
  await c.getByRole("radio", { name: "Sí, coincide" }).check();
  await c.getByRole("button", { name: "Confirmar lo que recibí" }).click();
  const rc = page.locator('[data-testid=retiro-por-recontar][data-folio="T-02"]');
  await expect(rc.getByTestId("no-coincide")).toContainText("Registró Recepción: $2,300.00 · Contaste: $2,250.00 · Diferencia: −$50.00");
  await capturar(page, "recuento");
  await rc.getByRole("radio", { name: "No pudimos recontar en este momento" }).check();
  await rc.getByRole("button", { name: "No coincide · registrar mi conteo" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toHaveText("Revisa los campos marcados.");
  await page.locator('[data-testid=retiro-por-recontar][data-folio="T-02"]').getByRole("radio", { name: "No pudimos recontar en este momento" }).check();
  await page.locator('[data-testid=retiro-por-recontar][data-folio="T-02"]').getByLabel("Motivo (obligatorio si no coincide)").fill("Prueba ficticia: Recepción ya no estaba");
  await page.locator('[data-testid=retiro-por-recontar][data-folio="T-02"]').getByRole("button", { name: "No coincide · registrar mi conteo" }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("solo los depósitos de ese folio quedan en pausa");
  // Su saldo: $800 de la bolsa; el cajón en pausa con lo que contó y los $50 aparte.
  await expect(page.getByTestId("saldo-sin-destino")).toHaveText("$800.00");
  await expect(page.getByTestId("saldo-en-pausa")).toContainText("$2,250.00");
  await expect(page.getByTestId("saldo-por-aclarar")).toContainText("−$50.00");
  await expect(page.locator('[data-testid=mi-retiro][data-folio="T-02"]').getByTestId("estado")).toContainText("No coincide · Por revisar");
  await expect(page.locator('[data-testid=mi-retiro][data-folio="T-02"]').getByTestId("estado")).toContainText("Por revisar desde hace menos de 1 h");
  await tablasSinDeslizar(page);

  await capturar(page, "bandeja");

  // El folio en pausa no ofrece depósito; el de la bolsa sí (parcial).
  await page.locator('[data-testid=mi-retiro][data-folio="T-02"]').getByTestId("ver-retiro").click();
  await expect(page.getByTestId("pausa")).toContainText("en pausa");
  await expect(page.getByTestId("registrar-deposito")).toHaveCount(0);
  await page.goto("/retiros");
  await page.locator('[data-testid=mi-retiro][data-folio="T-01"]').getByTestId("ver-retiro").click();
  const dep = page.getByTestId("registrar-deposito");
  await dep.getByLabel("Importe depositado").fill("500");
  await expect(dep).toContainText("Depósito parcial: quedarán $300.00");
  await dep.getByLabel("Fecha y hora del depósito").fill(fechaLocal());
  await dep.getByLabel("Referencia del comprobante (obligatoria)").fill("DEP-FICTICIO-0001");
  await dep.getByRole("button", { name: /Registrar depósito/ }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Depósito registrado.");
  await expect(page.getByTestId("sin-destino")).toHaveText("$300.00");

  // Recepción ve el estado, no el detalle.
  await entrar(page, e.laura.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.locator('[data-testid=retiro-turno][data-folio="T-02"]').getByTestId("estado-retiro")).toHaveText("No coincide · Por revisar");
  await expect(page.locator('[data-testid=retiro-turno][data-folio="T-01"]').getByTestId("estado-retiro")).toHaveText("Confirmado por Encargada de retiros");

  // Encargado (no participó) revisa: faltante confirmado con $2,250 verificados.
  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("retiros")).toHaveText("Retiros de efectivo (1)");
  await page.getByTestId("retiros").click();
  await expect(page.getByTestId("retiro")).toHaveCount(1);
  await page.getByTestId("ver-retiro").click();
  await expect(page.getByTestId("cifra-registrado")).toContainText("$2,300.00");
  await expect(page.getByTestId("cifra-inicial")).toContainText("$2,250.00");
  await expect(page.getByTestId("cifra-diferencia")).toContainText("−$50.00");
  await expect(page.getByTestId("quien-revisa")).toContainText("Revisa: Encargado");
  await capturar(page, "revision");
  const rv = page.getByTestId("revisar-retiro");
  await rv.getByRole("radio", { name: /Faltante confirmado/ }).check();
  await rv.getByLabel("Monto verificado en el sobre").fill("2250");
  await rv.getByLabel("Motivo (obligatorio)").fill("Prueba ficticia: el sobre correcto tiene $2,250");
  await rv.getByRole("button", { name: "Registrar revisión" }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("Revisión registrada");
  await expect(page.getByTestId("estado-retiro")).toHaveText("Revisado · faltante confirmado, pendiente para Dirección");
  await expect(page.getByTestId("faltante-direccion")).toContainText("Faltante de $50.00: pendiente para Dirección");
  await expect(page.getByTestId("historial-retiro")).toContainText("se lleva $2,300.00");
  await expect(page.getByTestId("historial-retiro")).toContainText("Conteo de Encargada de retiros: $2,250.00");
  await capturar(page, "revisado");
  await tablasSinDeslizar(page);

  // Encargada de retiros deposita: no más del monto verificado.
  await entrar(page, e.encargada.correo);
  await page.goto("/retiros");
  await page.locator('[data-testid=mi-retiro][data-folio="T-02"]').getByTestId("ver-retiro").click();
  await expect(page.getByTestId("habilitado")).toHaveText("$2,250.00");
  let d = page.getByTestId("registrar-deposito");
  await d.getByLabel("Importe depositado").fill("2300");
  await d.getByLabel("Fecha y hora del depósito").fill(fechaLocal());
  await d.getByLabel("Referencia del comprobante (obligatoria)").fill("DEP-FICTICIO-0002");
  await d.getByRole("button", { name: /Registrar depósito/ }).click();
  await expect(page.locator("p.aviso[role=alert]")).toHaveText("Revisa los campos marcados.");
  await expect(page.getByTestId("registrar-deposito")).toContainText("supera lo que queda por depositar");
  d = page.getByTestId("registrar-deposito");
  await d.getByLabel("Importe depositado").fill("2250");
  await d.getByLabel("Fecha y hora del depósito").fill(fechaLocal());
  await d.getByLabel("Referencia del comprobante (obligatoria)").fill("DEP-FICTICIO-0002");
  await d.getByRole("button", { name: /Registrar depósito/ }).click();
  await expect(page.getByTestId("sin-destino")).toHaveText("$0.00");

  // Administración ve el saldo bajo responsabilidad de Encargada de retiros.
  await entrar(page, e.admin.correo);
  await page.goto(`/sucursales/${e.codigo}/retiros`);
  const s = page.getByTestId("saldo-encargada");
  await expect(s.getByTestId("sin-destino")).toHaveText("$300.00");
  await expect(s.getByTestId("en-pausa")).toHaveText("$0.00");
  await expect(s.getByTestId("faltante-direccion")).toHaveText("−$50.00");
  await capturar(page, "administracion");
  await tablasSinDeslizar(page);
});

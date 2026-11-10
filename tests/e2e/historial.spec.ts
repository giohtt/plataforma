import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 4: historial del visitante entre sucursales, con datos ficticios. Dos sucursales nuevas con su turno.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar el historial 2026";
const CONSONANTES = "bcdfghjklmnpqrstvwxz";
const letras = (n: number) => Array.from({ length: n }, () => CONSONANTES[Math.floor(Math.random() * CONSONANTES.length)]).join("");
const nombrePropio = () => { const l = letras(7); return l[0].toUpperCase() + l.slice(1); };

async function crearCuenta(rol: string, codigo: string, nombre: string) {
  const correo = `historial-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba del historial' from sucursal where codigo = ${codigo}`;
  return { id: u.id, correo, nombre };
}
async function escenario() {
  const codigo = `X${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  await sql`insert into sucursal (nombre, codigo) values (${"Accesos " + codigo}, ${codigo})`;
  const recep = await crearCuenta("recepcion", codigo, "Recepción responsable " + letras(4));
  const recep2 = await crearCuenta("recepcion", codigo, "Recepción apoyo " + letras(4));
  const encargado = await crearCuenta("encargado", codigo, "Encargado " + letras(4));
  const admin = await crearCuenta("administracion", codigo, "Administración " + letras(4));
  const [t] = await sql<{ id: string }[]>`
    insert into turno (sucursal_id, abierto_por) select id, ${recep.id} from sucursal where codigo = ${codigo} returning id`;
  await sql`insert into responsable_lugar (lugar_id, turno_id, usuario_id)
            select l.id, ${t.id}, ${recep.id} from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  await sql`insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por)
            select ${t.id}, l.id, 'apertura', case l.tipo when 'bolsa_visitas' then 150 else 0 end, ${recep.id}
            from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  const ficha = async () => {
    const nombre = `${nombrePropio()} ${nombrePropio()} ${nombrePropio()}`;
    await sql`insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id)
              select ${nombre}, ${"000" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}, 'Querétaro', id from sucursal where codigo = 'ATL'`;
    return nombre;
  };
  return { codigo, recep, recep2, encargado, admin, ficha };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
/** Cobra a una o varias fichas desde la pantalla de visita y deja la pantalla de «Cobro registrado». */
async function cobrar(page: Page, codigo: string, nombres: string[], transferencia?: string) {
  await page.goto(`/sucursales/${codigo}/turno/visita`);
  await page.waitForLoadState("networkidle");
  for (const nombre of nombres) {
    await page.getByLabel(/nombre completo o teléfono/).fill(nombre);
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByTestId("visitante").filter({ hasText: nombre }).getByRole("button", { name: "Agregar" }).click();
  }
  await expect(page.getByTestId("en-grupo")).toHaveCount(nombres.length);
  if (transferencia) {
    await page.getByRole("radio", { name: "Transferencia" }).check();
    await page.getByRole("radio", { name: "Clave de rastreo" }).check();
    await page.locator("#referencia").fill(transferencia);
    await page.getByRole("button", { name: /Registrar transferencia/ }).click();
  } else {
    await page.getByRole("button", { name: `Confirmar cobro · $${nombres.length * 50}.00` }).click();
  }
  await expect(page.getByTestId("cobro-registrado")).toContainText("Cobro registrado");
}


test("Recepción ve el detalle de su sucursal y de la otra solo conteo y última; Administración con una sola sucursal ve solo esa", async ({ page }) => {
  const a = await escenario();
  const b = await escenario();
  const persona = `${nombrePropio()} ${nombrePropio()} ${nombrePropio()}`;
  await sql`insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id)
            select ${persona}, '0000000457', 'Querétaro', id from sucursal where codigo = 'ATL'`;
  const nombreB = `Accesos ${b.codigo}`;
  // Sucursal A: transferencia pendiente. Sucursal B (después): efectivo.
  await entrar(page, a.recep.correo);
  await cobrar(page, a.codigo, [persona], "PRUEBAHIST" + letras(5).toUpperCase());
  await entrar(page, b.recep.correo);
  await cobrar(page, b.codigo, [persona]);

  // Recepción de A, desde la búsqueda al cobrar.
  await entrar(page, a.recep.correo);
  await page.goto(`/sucursales/${a.codigo}/turno/visita`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/nombre completo o teléfono/).fill(persona);
  await page.getByRole("button", { name: "Buscar" }).click();
  const tarjeta = page.getByTestId("visitante").filter({ hasText: persona });
  await expect(tarjeta.getByTestId("historial-resumen")).toContainText(`2 visitas registradas · Última el`);
  await expect(tarjeta.getByTestId("historial-resumen")).toContainText(`en ${nombreB}`);
  await expect(tarjeta.getByTestId("historial-incompleto")).toHaveText("Historial incompleto");
  const enlace = tarjeta.getByTestId("ver-historial");
  await expect(enlace).toHaveAttribute("target", "_blank");
  const urlHistorial = (await enlace.getAttribute("href"))!;
  await page.goto(urlHistorial);
  const h = page.getByTestId("historial");
  await expect(h.getByTestId("historial-total")).toContainText("2 visitas registradas");
  await expect(h.getByTestId("historial-sucursal")).toHaveCount(1);
  await expect(h.getByTestId("historial-otra")).toHaveCount(1);
  await expect(h.getByTestId("historial-otra")).toContainText(nombreB);
  await expect(h.getByTestId("historial-otra")).toContainText("(solo en su sucursal)");
  await expect(h.getByTestId("detalle-sucursal")).toHaveCount(1);
  await expect(h.getByTestId("estado-pago")).toHaveText("Pendiente de verificar abono");
  await expect(h.getByTestId("detalle-sucursal")).not.toContainText(nombreB);

  // Administración solo de A: vista y totales solo de A.
  const admin = await crearCuenta("administracion", a.codigo, "Administración " + letras(4));
  await entrar(page, admin.correo);
  await page.goto(`/sucursales/${a.codigo}/visitantes`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Nombre completo o teléfono").fill(persona);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByTestId("visitante").filter({ hasText: persona }).getByTestId("historial-resumen"))
    .toContainText(`1 visita registrada · Última el`);
  await page.getByTestId("visitante").filter({ hasText: persona }).getByTestId("ver-historial").click();
  const ha = page.getByTestId("historial");
  await expect(ha.getByTestId("historial-total")).toContainText("1 visita registrada");
  await expect(ha.getByTestId("historial-otra")).toHaveCount(0);
  await expect(ha).not.toContainText(nombreB);

  // Dirección registra la cobertura de A.
  const dir = await crearCuenta("direccion", a.codigo, "Dirección " + letras(4));
  await entrar(page, dir.correo);
  await page.goto(`/sucursales/${a.codigo}`);
  await page.getByTestId("cobertura").click();
  await page.getByLabel("Hay datos confiables de visitas desde").fill("2026-11-04");
  await page.getByRole("button", { name: "Registrar cobertura" }).click();
  await expect(page.getByRole("status")).toHaveText("Cobertura registrada.");
  await expect(page.getByTestId("cobertura-actual")).toContainText("puede haber visitas anteriores sin registrar");
  await entrar(page, admin.correo);
  await page.goto(urlHistorial);
  await expect(page.getByTestId("cobertura")).toContainText("datos confiables desde el 4 nov 2026");
  await expect(page.getByTestId("historial-incompleto")).toBeVisible();
});

test("ficha creada en otra sucursal: Administración con una sola sucursal no ve esa sucursal ni en la tarjeta ni en el expediente", async ({ page }) => {
  const a = await escenario();
  const b = await escenario();
  const nombreB = `Accesos ${b.codigo}`;
  // La ficha se crea en B (como «Santiago»); tiene una visita en A y después otra en B.
  const persona = `${nombrePropio()} ${nombrePropio()} ${nombrePropio()}`;
  await sql`insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id)
            select ${persona}, '0000000458', 'Querétaro', id from sucursal where codigo = ${b.codigo}`;
  await entrar(page, a.recep.correo);
  await cobrar(page, a.codigo, [persona]);
  await entrar(page, b.recep.correo);
  await cobrar(page, b.codigo, [persona]);

  // Administración solo de A: la tarjeta completa y el expediente completo sin B, tampoco en el HTML recibido.
  await entrar(page, a.admin.correo);
  await page.goto(`/sucursales/${a.codigo}/visitantes`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Nombre completo o teléfono").fill(persona);
  await page.getByRole("button", { name: "Buscar" }).click();
  const tarjeta = page.getByTestId("visitante").filter({ hasText: persona });
  await expect(tarjeta.getByTestId("historial-resumen")).toContainText("1 visita registrada · Última el");
  await expect(tarjeta.getByTestId("historial-resumen")).toContainText(`en Accesos ${a.codigo}`);
  await expect(tarjeta.getByTestId("registrado-en")).toHaveCount(0);
  await expect(tarjeta).not.toContainText(nombreB);
  await expect(tarjeta).not.toContainText("Registrado en");
  await expect(page.locator("body")).not.toContainText(nombreB);
  expect(await page.content()).not.toContain(b.codigo);

  await tarjeta.getByTestId("ver-historial").click();
  await expect(page.getByTestId("nombre-visitante")).toHaveText(persona);
  await expect(page.getByTestId("expediente-creado")).toHaveCount(0);
  await expect(page.getByTestId("expediente")).not.toContainText("Expediente creado");
  await expect(page.getByTestId("historial-total")).toContainText("1 visita registrada");
  await expect(page.locator("body")).not.toContainText(nombreB);
  expect(await page.content()).not.toContain(b.codigo);

  // Recepción de A: tampoco ve el alta en B, pero conserva el conteo y la última visita registrada en B.
  await entrar(page, a.recep.correo);
  await page.goto(`/sucursales/${a.codigo}/visitantes`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Nombre completo o teléfono").fill(persona);
  await page.getByRole("button", { name: "Buscar" }).click();
  const tr = page.getByTestId("visitante").filter({ hasText: persona });
  await expect(tr.getByTestId("historial-resumen")).toContainText(`2 visitas registradas · Última el`);
  await expect(tr.getByTestId("historial-resumen")).toContainText(`en ${nombreB}`);
  await expect(tr.getByTestId("registrado-en")).toHaveCount(0);
  await tr.getByTestId("ver-historial").click();
  await expect(page.getByTestId("expediente-creado")).toHaveCount(0);

  // Administración de B sí ve dónde y cuándo se creó.
  await entrar(page, b.admin.correo);
  await page.goto(`/sucursales/${b.codigo}/visitantes`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Nombre completo o teléfono").fill(persona);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByTestId("visitante").filter({ hasText: persona }).getByTestId("registrado-en")).toContainText(`Registrado en ${nombreB} el`);
  await page.getByTestId("visitante").filter({ hasText: persona }).getByTestId("ver-historial").click();
  await expect(page.getByTestId("expediente-creado")).toContainText(`En ${nombreB}, el`);
});

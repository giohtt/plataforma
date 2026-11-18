import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 5, regla 7 (18 nov 2026), con datos ficticios: las recepcionistas custodian la caja con llave y Dirección recoge
 * una vez por semana. Sucursal nueva como Tenango: turno abierto con $900 en la bolsa y $3,400 en el cajón, sin fondo fijo.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar la recolección 2026";
const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxz"[Math.floor(Math.random() * 20)]).join("");

async function crearCuenta(rol: string, codigo: string, nombre: string) {
  const correo = `recoleccion-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba de recolección' from sucursal where codigo = ${codigo}`;
  return { id: u.id, correo, nombre };
}
async function escenario() {
  const codigo = `Q${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  await sql`insert into sucursal (nombre, codigo) values (${"Recolección " + codigo}, ${codigo})`;
  const laura = await crearCuenta("recepcion", codigo, "Laura " + letras(5));
  const sofia = await crearCuenta("recepcion", codigo, "Sofía " + letras(5));
  const encargado = await crearCuenta("encargado", codigo, "Encargado " + letras(5));
  const admin = await crearCuenta("administracion", codigo, "Administración " + letras(5));
  const dir = await crearCuenta("direccion", codigo, "Dirección " + letras(5));
  const [t] = await sql<{ id: string }[]>`
    insert into turno (sucursal_id, abierto_por) select id, ${laura.id} from sucursal where codigo = ${codigo} returning id`;
  await sql`insert into responsable_lugar (lugar_id, turno_id, usuario_id)
            select l.id, ${t.id}, ${laura.id} from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  await sql`insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por)
            select ${t.id}, l.id, 'apertura', case l.tipo when 'bolsa_visitas' then 900 else 3400 end, ${laura.id}
            from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  return { codigo, laura, sofia, encargado, admin, dir };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};

test("custodia por las recepcionistas, sobres guardados en la caja y recolección por Dirección con depósito parcial", async ({ page }) => {
  const e = await escenario();

  // Dirección nombra a las custodias. Nadie viene marcada.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/custodia/configurar`);
  await expect(page.getByTestId("custodias").getByLabel(e.laura.nombre)).not.toBeChecked();
  await page.getByLabel("Dónde se guardan los sobres").fill("Caja con llave de recepción");
  await page.getByRole("group", { name: "Quién tiene acceso", exact: true }).getByLabel(e.laura.nombre).check();
  await page.getByRole("group", { name: "Quién tiene acceso", exact: true }).getByLabel(e.sofia.nombre).check();
  await page.getByLabel("Dónde quedan los fondos fijos").fill("Cajón con llave de recepción");
  for (const p of [e.laura, e.sofia]) await page.getByTestId("acceso-cajon").getByLabel(p.nombre).check();
  // Sin custodias no se guarda.
  await page.getByRole("button", { name: "Guardar la custodia" }).click();
  await expect(page.getByText("Elige de 1 a 10 custodias con asignación en la sucursal.")).toBeVisible();
  for (const p of [e.laura, e.sofia]) await page.getByTestId("custodias").getByLabel(p.nombre).check();
  await capturar(page, "recoleccion-configurar");
  await page.getByRole("button", { name: "Guardar la custodia" }).click();
  await expect(page.getByTestId("historial-custodia")).toContainText("custodias:");
  for (const p of [e.laura, e.sofia]) await expect(page.getByTestId("historial-custodia")).toContainText(p.nombre);

  // Laura cierra y se queda con la llave: el excedente va a los sobres, que se quedan en la caja.
  await entrar(page, e.laura.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/cierre`);
  await page.getByTestId("generar-folios").click();
  const bolsa = (await page.getByTestId("folio-bolsa").textContent())!;
  const cajon = (await page.getByTestId("folio-cajon").textContent())!;
  await page.getByTestId("cierre-bolsa").getByLabel("Total contado al cerrar").fill("900");
  await page.getByTestId("cierre-cajon").getByLabel("Total contado al cerrar").fill("3400");
  await expect(page.getByTestId("aviso-sobres-guardados")).toBeVisible();
  await page.getByLabel("Custodia que se queda con la llave").selectOption({ label: `Yo · ${e.laura.nombre} — cierro y me quedo con la llave` });
  for (const l of ["bolsa_visitas", "cajon_mensualidades"]) await page.getByTestId(`verificar-${l}`).getByLabel(/^Sí: cerrado/).check();
  await page.getByLabel(/^Sí: la caja de sobres y el cajón/).check();
  await page.getByLabel("No, nadie más participó").check();
  await capturar(page, "recoleccion-cierre");
  await page.getByRole("button", { name: "Cerrar el turno y guardar sobres y llave" }).click();
  await expect(page.getByRole("heading", { name: "Turno cerrado · sobres en la caja" })).toBeVisible();

  // Sofía abre: no abre los sobres; verifica la caja, recibe la llave y cuenta solo el fondo (aquí no hay fondo: $0).
  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/apertura`);
  await expect(page.getByTestId("aviso-caja-apertura")).toBeVisible();
  await expect(page.getByTestId("formulario-apertura-cierre")).not.toContainText("3,400");
  for (const f of [bolsa, cajon]) await page.getByTestId(`verificar-${f}`).getByLabel(/^Sí: cerrado/).check();
  await page.getByLabel(/^Sí: la caja de sobres y el cajón/).check();
  await page.getByTestId("apertura-bolsa").getByLabel(/^Efectivo que cuentas/).fill("0");
  await page.getByTestId("apertura-cajon").getByLabel(/^Efectivo que cuentas/).fill("0");
  await page.getByLabel("No, nadie más participó").check();
  await capturar(page, "recoleccion-apertura");
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Turno abierto desde el cierre. Desde ahora eres la responsable de la bolsa y del cajón.");
  await expect(page.getByTestId("resumen-caja")).toContainText("2 sobres guardados");

  // Una semana después: el sobre de la bolsa lleva 9 días (aviso desde los 8). Sofía entrega solo ese a Dirección.
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sobre_cierre set resuelto_en = resuelto_en - interval '9 days' where folio = ${bolsa}`;
  });
  await page.getByTestId("ir-recoleccion").click();
  await expect(page.getByTestId(`aviso-${bolsa}`)).toBeVisible();
  await expect(page.getByTestId(`aviso-${cajon}`)).toHaveCount(0);
  await expect(page.getByTestId("llave-caja")).toContainText(e.sofia.nombre);
  await page.getByTestId(`elegir-${bolsa}`).getByRole("checkbox").check();
  await page.getByLabel("Recoge (Dirección)").selectOption({ label: e.dir.nombre });
  await capturar(page, "recoleccion-entregar");
  await page.getByRole("button", { name: "Entregar los sobres elegidos" }).click();
  await expect(page.getByTestId("entrega-pendiente")).toContainText(bolsa);
  await expect(page.getByTestId(`caja-${cajon}`)).toContainText("En la caja");

  // Dirección cuenta a ciegas: no ve lo anotado. Faltan $50.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("sobres-por-recoger").click();
  await expect(page.getByTestId("tabla-caja")).not.toContainText("900");
  await page.getByTestId(`verificar-${bolsa}`).getByLabel(/^Sí: cerrado/).check();
  await page.getByLabel(`Sobre ${bolsa} · bolsa · contado`).fill("850");
  await capturar(page, "recoleccion-confirmar");
  await page.getByRole("button", { name: "Confirmar lo que recojo" }).click();
  await expect(page.getByTestId("aviso-recogida")).toContainText("1 sobre queda por revisar");
  await expect(page.getByTestId("saldo")).toContainText("$850.00");
  // Depósito parcial.
  await page.getByLabel(/^Importe depositado/).fill("500");
  await page.getByLabel("Referencia del depósito (ficticia)").fill("DEP-FICTICIO-001");
  await page.getByRole("button", { name: "Registrar el depósito" }).click();
  await expect(page.getByTestId("depositado")).toHaveText("$500.00");
  await expect(page.getByTestId("saldo")).toContainText("$350.00");
  await expect(page.getByTestId(`caja-${cajon}`)).toBeVisible();

  // Administración (no participó) revisa la diferencia con la cadena completa.
  await entrar(page, e.admin.correo);
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  const dif = page.getByTestId(`diferencia-${bolsa}`);
  await expect(dif).toContainText("−$50.00");
  await dif.getByText("Cadena de custodia").click();
  await expect(dif.getByTestId("cadena")).toContainText(e.laura.nombre);
  await expect(dif.getByTestId("cadena")).toContainText(e.sofia.nombre);
  await expect(dif.getByTestId("cadena")).toContainText(e.dir.nombre);
  await dif.getByLabel("Faltante confirmado").check();
  await dif.getByLabel("Motivo").fill("Faltan $50 en el sobre de la bolsa");
  await capturar(page, "recoleccion-revision");
  await dif.getByRole("button", { name: "Guardar la revisión" }).click();
  await expect(page.getByTestId(`diferencia-${bolsa}`).getByTestId("estado-diferencia")).toContainText("Faltante confirmado");
});

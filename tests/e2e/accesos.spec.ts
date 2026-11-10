import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 4: registro de accesos del piloto de Tenango, con datos ficticios. Cada prueba crea su sucursal, su
 * turno ($150 en la bolsa), dos cuentas de Recepción (una responsable de la bolsa), Encargado y Administración.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar los accesos 2026";
const CONSONANTES = "bcdfghjklmnpqrstvwxz";
const letras = (n: number) => Array.from({ length: n }, () => CONSONANTES[Math.floor(Math.random() * CONSONANTES.length)]).join("");
const nombrePropio = () => { const l = letras(7); return l[0].toUpperCase() + l.slice(1); };

async function crearCuenta(rol: string, codigo: string, nombre: string) {
  const correo = `accesos-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba de accesos' from sucursal where codigo = ${codigo}`;
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
const persona = (page: Page, nombre: string) => page.getByTestId("pase-acceso").filter({ hasText: nombre });
const operacionDe = async (codigo: string) =>
  (await sql<{ id: string }[]>`select o.id from operacion_visita o join sucursal s on s.id = o.sucursal_id where s.codigo = ${codigo} order by o.registrada_en desc limit 1`)[0].id;

test("cobro grupal: un botón por persona, cualquier cuenta de Recepción registra; reingreso con el mismo pase sin cobrar", async ({ page }) => {
  const e = await escenario();
  const [ana, luis, paola] = [await e.ficha(), await e.ficha(), await e.ficha()];
  await entrar(page, e.recep.correo);
  await cobrar(page, e.codigo, [ana, luis, paola]);
  await page.getByTestId("registrar-entradas").click();
  await expect(page.getByTestId("pase-acceso")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Registrar entrada" })).toHaveCount(3);

  // La otra cuenta de Recepción (no responsable de la bolsa) registra las entradas.
  const url = page.url();
  await entrar(page, e.recep2.correo);
  await page.goto(url);
  await persona(page, ana).getByRole("button", { name: "Registrar entrada" }).click();
  await expect(page.getByRole("status")).toHaveText("Entrada registrada.");
  await expect(persona(page, ana).getByTestId("entrada")).toContainText(`registró ${e.recep2.nombre}`);
  await persona(page, luis).getByRole("button", { name: "Registrar entrada" }).click();
  await expect(persona(page, luis).getByTestId("entrada")).toBeVisible();
  await expect(persona(page, paola).getByTestId("sin-entrada")).toHaveText("Todavía no entra");
  await expect(persona(page, ana).getByRole("button", { name: "Registrar reingreso" })).toBeVisible();

  // Ana sale y vuelve: desde la búsqueda de la responsable de la bolsa se ofrece el reingreso, no otro cobro.
  await entrar(page, e.recep.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/visita`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/nombre completo o teléfono/).fill(ana);
  await page.getByRole("button", { name: "Buscar" }).click();
  await page.getByTestId("visitante").filter({ hasText: ana }).getByRole("button", { name: "Agregar" }).click();
  await expect(page.getByTestId("pase-aqui")).toContainText("y ya entró: no se cobra otra visita");
  await expect(page.getByRole("button", { name: /Confirmar cobro/ })).toBeDisabled();
  await page.getByTestId("ir-pase").click();
  await persona(page, ana).getByRole("button", { name: "Registrar reingreso" }).click();
  await expect(page.getByRole("status")).toHaveText("Reingreso registrado con el mismo pase, sin cobrar.");
  await expect(persona(page, ana).getByTestId("reingreso")).toHaveCount(1);

  // En el turno: accesos aparte; la bolsa y las ventas no cambian (un cobro de $150).
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("accesos-entradas")).toHaveText("2");
  await expect(page.getByTestId("accesos-reingresos")).toHaveText("1");
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("esperado")).toHaveText("$300.00");
  await expect(page.getByTestId("ventas-total")).toHaveText("$150.00");
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from operacion_visita o join sucursal s on s.id = o.sucursal_id where s.codigo = ${e.codigo}`;
  expect(n).toBe(1);
});

test("transferencia pendiente: Recepción pide autorización, Encargado responde desde su sesión y Recepción ve aprobada o rechazada", async ({ page }) => {
  const e = await escenario();
  const [mariana, rocio] = [await e.ficha(), await e.ficha()];
  await entrar(page, e.recep.correo);
  await cobrar(page, e.codigo, [mariana], "MBAN01PRUEBA" + letras(4).toUpperCase());
  await page.getByTestId("registrar-entradas").click();
  await expect(page.getByTestId("aviso-transferencia")).toContainText("necesita la autorización de Encargado");
  await expect(persona(page, mariana).getByRole("button", { name: "Registrar entrada" })).toHaveCount(0);
  await persona(page, mariana).getByLabel("Qué muestra el visitante").fill("Muestra el comprobante con la misma clave e importe");
  await persona(page, mariana).getByRole("button", { name: "Pedir autorización" }).click();
  await expect(page.getByRole("status")).toContainText("Autorización pedida");
  await expect(persona(page, mariana).getByTestId("autorizacion-estado")).toContainText("Autorización pendiente");
  const urlMariana = page.url();

  await cobrar(page, e.codigo, [rocio], "MBAN01PRUEBA" + letras(4).toUpperCase());
  await page.getByTestId("registrar-entradas").click();
  await persona(page, rocio).getByLabel("Qué muestra el visitante").fill("Solo dice que ya transfirió");
  await persona(page, rocio).getByRole("button", { name: "Pedir autorización" }).click();
  const urlRocio = page.url();

  // Recepción no ve la bandeja.
  await page.goto(`/sucursales/${e.codigo}/accesos`);
  await expect(page.getByRole("heading", { name: "No encontrada" })).toBeVisible();

  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("accesos").click();
  await expect(page.getByRole("heading", { name: "Accesos por autorizar" })).toBeVisible();
  await expect(page.getByTestId("por-autorizar")).toHaveCount(2);
  const m = page.getByTestId("por-autorizar").filter({ hasText: mariana });
  await expect(m).toContainText("$50.00 por transferencia");
  await m.getByLabel(/Por qué lo autorizas/).fill("Revisé el comprobante: misma clave e importe");
  await m.getByRole("button", { name: "Autorizar acceso" }).click();
  await expect(page.getByRole("status")).toContainText("Acceso autorizado");
  const r = page.getByTestId("por-autorizar").filter({ hasText: rocio });
  // Sin motivo no se envía (el campo es obligatorio): sigue pendiente.
  await r.getByRole("button", { name: "No autorizar" }).click();
  await expect(page.getByTestId("por-autorizar")).toHaveCount(1);
  await r.getByLabel(/Por qué lo autorizas/).fill("Sin comprobante: que espere la verificación");
  await r.getByRole("button", { name: "No autorizar" }).click();
  await expect(page.getByRole("status")).toContainText("Acceso no autorizado");
  await expect(page.getByTestId("por-autorizar")).toHaveCount(0);

  await entrar(page, e.recep.correo);
  await page.goto(urlMariana);
  await expect(persona(page, mariana).getByTestId("autorizacion-estado")).toContainText(`Autorizado por ${e.encargado.nombre}`);
  await persona(page, mariana).getByRole("button", { name: "Registrar entrada" }).click();
  await expect(persona(page, mariana).getByTestId("entrada")).toContainText(`autorizó ${e.encargado.nombre}`);
  await expect(page.getByTestId("detalle-estado")).toHaveText("Pendiente de verificar abono");

  await page.goto(urlRocio);
  await expect(persona(page, rocio).getByTestId("autorizacion-estado")).toContainText(`No autorizado por ${e.encargado.nombre}`);
  await expect(persona(page, rocio).getByTestId("autorizacion-estado")).toContainText("Sin comprobante: que espere la verificación");
  await expect(persona(page, rocio).getByRole("button", { name: "Pedir autorización" })).toBeVisible();
  await expect(persona(page, rocio).getByRole("button", { name: "Registrar entrada" })).toHaveCount(0);

  // Administración revisa pero no autoriza.
  await entrar(page, e.admin.correo);
  await page.goto(`/sucursales/${e.codigo}/accesos`);
  await expect(page.getByRole("heading", { name: "Registro de accesos" })).toBeVisible();
  await expect(page.getByTestId("bandeja-accesos")).toHaveCount(0);
  await expect(page.getByTestId("resuelta")).toHaveCount(2);
  await expect(page.getByTestId("acceso")).toHaveCount(1);
  expect(await operacionDe(e.codigo)).toBeTruthy();
});

test("aperturas sin pase: motivo, visita que se cobra con autorización y emergencia con motivo después", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await page.getByTestId("ir-accesos").click();
  await expect(page.getByRole("heading", { name: "Accesos del turno" })).toBeVisible();

  await page.getByTestId("form-sin-pase").getByLabel("Motivo").selectOption("socio_open_desk");
  await page.getByTestId("form-sin-pase").getByLabel(/Detalle/).fill("Credencial que Open Desk no reconoce");
  await page.getByRole("button", { name: "Registrar apertura sin pase" }).click();
  await expect(page.getByRole("status")).toContainText("Apertura sin pase registrada");

  await page.getByRole("button", { name: "Registrar apertura de emergencia" }).click();
  await expect(page.getByRole("status")).toContainText("Apertura de emergencia registrada");
  await expect(page.getByTestId("emergencia-pendiente")).toHaveCount(1);

  await page.getByTestId("form-visita-sin-cobro").getByLabel("Quién es y por qué no se cobra").fill("Invitado de la gerencia, prueba ficticia");
  await page.getByTestId("form-visita-sin-cobro").getByRole("button", { name: "Pedir autorización" }).click();
  await expect(page.getByTestId("visita-sin-cobro").getByTestId("autorizacion-estado")).toContainText("Autorización pendiente");

  // El turno avisa de la emergencia sin motivo.
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("accesos-sin-pase")).toHaveText("2");
  await expect(page.getByTestId("accesos-sin-motivo")).toContainText("1 apertura de emergencia sin motivo");

  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}/accesos`);
  await expect(page.getByTestId("incidente")).toHaveCount(1);
  const v = page.getByTestId("por-autorizar");
  await expect(v).toContainText("Visita que normalmente se cobra");
  await v.getByLabel(/Por qué lo autorizas/).fill("Autorizado por la gerencia para la prueba");
  await v.getByRole("button", { name: "Autorizar acceso" }).click();
  await expect(page.getByRole("status")).toContainText("Acceso autorizado");

  await entrar(page, e.recep2.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/accesos`);
  await expect(page.getByTestId("visita-sin-cobro").getByTestId("autorizacion-estado")).toContainText(`Autorizado por ${e.encargado.nombre}`);
  await page.getByRole("button", { name: "Registrar apertura autorizada" }).click();
  await expect(page.getByRole("status")).toContainText("Apertura sin pase registrada");
  await expect(page.getByRole("button", { name: "Registrar apertura autorizada" })).toHaveCount(0);
  await page.getByTestId("form-completar-motivo").getByLabel("Motivo de la emergencia").fill("Visitante con mareo; entró personal de apoyo");
  await page.getByRole("button", { name: "Guardar motivo" }).click();
  await expect(page.getByRole("status")).toHaveText("Motivo guardado.");
  await expect(page.getByTestId("emergencia-pendiente")).toHaveCount(0);
  await expect(page.getByTestId("accesos-del-turno").getByTestId("acceso")).toHaveCount(3);
  await expect(page.getByTestId("accesos-del-turno")).toContainText(`motivo completado por ${e.recep2.nombre}`);
  await expect(page.getByTestId("accesos-del-turno")).toContainText(`autorizó ${e.encargado.nombre}`);
});

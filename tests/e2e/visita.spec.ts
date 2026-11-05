import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 4, primer flujo: visita individual de $50 en efectivo. Cada prueba crea su sucursal ficticia, su
 * turno abierto ($0 en la bolsa, $1,200 en el cajón) y su ficha de visitante creada en otra sucursal.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar visitas 2026";
const CONSONANTES = "bcdfghjklmnpqrstvwxz";
const letras = (n: number) => Array.from({ length: n }, () => CONSONANTES[Math.floor(Math.random() * CONSONANTES.length)]).join("");
const nombrePropio = () => { const l = letras(7); return l[0].toUpperCase() + l.slice(1); };

async function crearCuenta(asignaciones: [string, string][]) {
  const correo = `visita-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const nombre = "Recepcionista " + correo.slice(7, 15);
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de visita' from sucursal where codigo = ${codigo}`;
  }
  return { id: u.id, correo, nombre };
}
/** Abre un turno directamente en la base, como lo haría la apertura del bloque 3. */
async function abrirTurno(codigo: string, usuarioId: string) {
  const [t] = await sql<{ id: string }[]>`
    insert into turno (sucursal_id, abierto_por) select id, ${usuarioId} from sucursal where codigo = ${codigo} returning id`;
  await sql`insert into responsable_lugar (lugar_id, turno_id, usuario_id)
            select l.id, ${t.id}, ${usuarioId} from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  await sql`insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por)
            select ${t.id}, l.id, 'apertura', case l.tipo when 'bolsa_visitas' then 0 else 1200 end, ${usuarioId}
            from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  return t.id;
}
async function escenario() {
  const codigo = `Y${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
  await sql`insert into sucursal (nombre, codigo) values (${"Visitas " + codigo}, ${codigo})`;
  const recep = await crearCuenta([["recepcion", codigo]]);
  const turnoId = await abrirTurno(codigo, recep.id);
  const nombre = `${nombrePropio()} ${nombrePropio()} ${nombrePropio()}`;
  const telefono = "000" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
  await sql`insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id)
            select ${nombre}, ${telefono}, 'Querétaro', id from sucursal where codigo = 'ATL'`;
  return { codigo, recep, turnoId, nombre, telefono };
}
async function iniciar(page: Page, correo: string) {
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await iniciar(page, correo);
}
async function usarSesionDe(browser: Browser, page: Page, correo: string) {
  const otra = await browser.newContext();
  await iniciar(await otra.newPage(), correo);
  const cookies = await otra.cookies();
  await otra.close();
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
}
const lista = (page: Page) => page.waitForLoadState("networkidle");
const conteos = async (codigo: string) => {
  const [r] = await sql<{ operaciones: number; pases: number; movimientos: number; suma: string }[]>`
    select (select count(*)::int from operacion_visita o where o.sucursal_id = s.id) as operaciones,
           (select count(*)::int from pase_visita p where p.sucursal_id = s.id) as pases,
           (select count(*)::int from movimiento_efectivo m join lugar_efectivo l on l.id = m.lugar_id where l.sucursal_id = s.id) as movimientos,
           (select coalesce(sum(m.importe), 0)::text from movimiento_efectivo m join lugar_efectivo l on l.id = m.lugar_id where l.sucursal_id = s.id) as suma
    from sucursal s where s.codigo = ${codigo}`;
  return r;
};

/** Desde el turno: Registrar visita → buscar → Elegir. Deja la pantalla de cobro con la ficha elegida. */
async function elegir(page: Page, codigo: string, nombre: string) {
  await page.goto(`/sucursales/${codigo}/turno`);
  await page.getByRole("link", { name: "Registrar visita" }).click();
  await expect(page).toHaveURL(new RegExp(`/sucursales/${codigo}/turno/visita$`));
  await lista(page);
  await page.getByLabel(/Busca la ficha del visitante/).fill(nombre);
  await page.getByRole("button", { name: "Buscar" }).click();
  await page.getByTestId("visitante").filter({ hasText: nombre }).getByRole("button", { name: "Elegir" }).click();
  await expect(page.getByTestId("datos-cobro")).toContainText(nombre);
}
const confirmar = (page: Page) => page.getByRole("button", { name: "Confirmar cobro · $50.00" });
const aviso = (page: Page) => page.locator("[data-testid=datos-cobro] [role=alert]");
/** Intercepta solo el envío del cobro (lleva la clave), no la búsqueda. */
const esCobro = (route: Route) => route.request().method() === "POST" && (route.request().postData() ?? "").includes("clave");

test("una sola pantalla: Recibido $100 muestra $50 de cambio ahí mismo; se registra el cobro y a la bolsa entran $50", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  const pantalla = page.getByTestId("datos-cobro");
  await expect(pantalla).toContainText(`•• •••• ${e.telefono.slice(6)}`);
  await expect(pantalla).toContainText(`Visitas ${e.codigo}`);
  await expect(page.getByTestId("total")).toHaveText("$50.00 en efectivo");
  await expect(pantalla.getByRole("button")).toHaveText([/Confirmar cobro · \$50\.00/, "Cambiar visitante"]);

  // Menos que el total: el error aparece junto al campo y no deja confirmar.
  await page.getByLabel("Recibido (opcional)").fill("20");
  await expect(page.locator("#recibido-error")).toHaveText("Lo recibido es menor que el total de la visita ($50.00). No se puede confirmar así.");
  await expect(page.getByLabel("Recibido (opcional)")).toHaveAttribute("aria-invalid", "true");
  await expect(confirmar(page)).toBeDisabled();

  await page.getByLabel("Recibido (opcional)").fill("100");
  await expect(page.locator("#recibido-error")).toHaveCount(0);
  await expect(page.getByTestId("cambio")).toHaveText("Cambio: $50.00");
  expect(await conteos(e.codigo)).toMatchObject({ operaciones: 0, movimientos: 0 });

  await confirmar(page).click();
  const listo = page.getByTestId("cobro-registrado");
  await expect(listo.getByRole("heading")).toHaveText("Cobro registrado");
  await expect(listo).toContainText(e.nombre);
  await expect(page.getByTestId("cambio-registrado")).toHaveText("$50.00");
  await expect(listo.getByRole("button", { name: "Nueva visita" })).toBeVisible();
  // El nombre y el teléfono no van en la dirección.
  expect(page.url()).toMatch(new RegExp(`/sucursales/${e.codigo}/turno/visita$`));
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 1, movimientos: 1, suma: "50.00" });
  const [c] = await sql`select c.recibido::text, c.cambio::text from cobro_visita c join operacion_visita o on o.id = c.operacion_id
                        join sucursal s on s.id = o.sucursal_id where s.codigo = ${e.codigo}`;
  expect(c).toEqual({ recibido: "100.00", cambio: "50.00" });

  // «Nueva visita» deja la búsqueda vacía para el siguiente visitante.
  await listo.getByRole("button", { name: "Nueva visita" }).click();
  await expect(page.getByLabel(/Busca la ficha del visitante/)).toHaveValue("");
  await expect(page.getByTestId("resultados")).toHaveCount(0);

  // En el turno: la bolsa suma los $50; el cajón queda igual y sin efectivo esperado calculado.
  await page.getByRole("link", { name: "← Turno" }).click();
  const bolsa = page.getByTestId("lugar-bolsa_visitas");
  await expect(bolsa.getByTestId("contado-al-abrir")).toHaveText("$0.00");
  await expect(bolsa.getByTestId("entradas")).toHaveText("+ $50.00");
  await expect(bolsa.getByTestId("esperado")).toHaveText("$50.00");
  const cajon = page.getByTestId("lugar-cajon_mensualidades");
  await expect(cajon.getByTestId("contado-al-abrir")).toHaveText("$1,200.00");
  await expect(cajon.getByTestId("esperado")).toHaveText("No calculado: faltan datos de Open Desk");
  await expect(page.getByTestId("visita-turno")).toHaveCount(1);
  await expect(page.getByTestId("visita-turno")).toContainText(`${e.nombre} ·`);
});

test("sin escribir lo recibido también se registra el cobro de $50", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await expect(page.getByTestId("cambio")).toHaveCount(0);
  await confirmar(page).click();
  await expect(page.getByTestId("cobro-registrado")).toContainText("Cobro registrado");
  await expect(page.getByTestId("cambio-registrado")).toHaveCount(0);
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 1, movimientos: 1, suma: "50.00" });
});

test("si lo recibido llega al servidor menor que el total, se rechaza y el error aparece junto al campo", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await page.getByLabel("Recibido (opcional)").fill("100");
  // Se cambia lo enviado en el camino: el navegador validó $100, al servidor llegan $20.
  await page.route("**/*", async (route) => {
    if (!esCobro(route)) return route.continue();
    const cuerpo = (route.request().postData() ?? "").replace(/(name="[^"]*recibido"\r\n\r\n)100/, "$120");
    await route.continue({ postData: cuerpo });
  });
  await confirmar(page).click();
  await expect(page.locator("#recibido-error")).toHaveText("Lo recibido es menor que el total de la visita ($50.00). No se puede confirmar así.");
  expect(await conteos(e.codigo)).toMatchObject({ operaciones: 0, movimientos: 0 });
});

test("doble clic en «Confirmar cobro»: una sola visita y una sola entrada de efectivo", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await confirmar(page).dblclick();
  await expect(page.getByTestId("cobro-registrado")).toBeVisible();
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 1, movimientos: 1, suma: "50.00" });
});

test("se pierde la conexión después de guardar: al reintentar muestra «Cobro registrado» sin cobrar dos veces", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  let cortes = 0;
  await page.route("**/*", async (route) => {
    if (!esCobro(route) || cortes > 0) return route.continue();
    cortes++;
    await route.fetch(); // el servidor sí lo recibe y lo guarda…
    await route.abort("internetdisconnected"); // …pero la respuesta no llega
  });
  await confirmar(page).click();
  await expect(aviso(page)).toHaveText(
    "Se perdió la conexión y no sabemos si el cobro se guardó. Vuelve a tocar «Confirmar cobro»: si ya se había guardado, no se cobrará dos veces.");
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 1, movimientos: 1, suma: "50.00" });

  await confirmar(page).click();
  await expect(page.getByTestId("cobro-registrado")).toContainText("Cobro registrado");
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 1, movimientos: 1, suma: "50.00" });
});

test("se pierde la conexión antes de llegar: al reintentar se registra una sola vez", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  let cortes = 0;
  await page.route("**/*", async (route) => {
    if (!esCobro(route) || cortes > 0) return route.continue();
    cortes++;
    await route.abort("internetdisconnected");
  });
  await confirmar(page).click();
  await expect(aviso(page)).toContainText("Se perdió la conexión");
  expect(await conteos(e.codigo)).toMatchObject({ operaciones: 0 });
  await confirmar(page).click();
  await expect(page.getByTestId("cobro-registrado")).toBeVisible();
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 1, movimientos: 1, suma: "50.00" });
});

test("solo cobra la responsable de la bolsa: otra recepcionista y Encargado no pueden, ni enviando el cobro directamente", async ({ page, browser }) => {
  const e = await escenario();
  const otra = await crearCuenta([["recepcion", e.codigo]]);
  const encargado = await crearCuenta([["encargado", e.codigo]]);

  await entrar(page, otra.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("turno-abierto")).toBeVisible();
  await expect(page.getByRole("link", { name: "Registrar visita" })).toHaveCount(0);
  await page.goto(`/sucursales/${e.codigo}/turno/visita`);
  await expect(page.getByTestId("no-puede-cobrar")).toHaveText("Solo la responsable de la bolsa de visitas puede cobrar en este turno.");

  await entrar(page, encargado.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByRole("link", { name: "Registrar visita" })).toHaveCount(0);
  await page.goto(`/sucursales/${e.codigo}/turno/visita`);
  await expect(page.getByRole("heading", { name: "No encontrada" })).toBeVisible();

  // La responsable llega a la pantalla de cobro; el cobro se envía con la sesión de otra cuenta.
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await usarSesionDe(browser, page, otra.correo);
  await confirmar(page).click();
  await expect(aviso(page)).toHaveText("Solo la responsable de la bolsa de visitas puede cobrar en este turno. No se guardó nada.");
  await usarSesionDe(browser, page, encargado.correo);
  await confirmar(page).click();
  await expect(aviso(page)).toHaveText("Tu cuenta no tiene permiso para registrar visitas en esta sucursal. No se guardó nada.");
  expect(await conteos(e.codigo)).toMatchObject({ operaciones: 0, movimientos: 0 });
});

test("si el turno cambia mientras se cobra, no se guarda nada", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  // Simula cierre y nueva apertura (el cierre real llega en el bloque 5).
  await sql`update turno set cerrado_en = now() where id = ${e.turnoId}`;
  await sql`update responsable_lugar set hasta = now() where turno_id = ${e.turnoId}`;
  await abrirTurno(e.codigo, e.recep.id);
  await confirmar(page).click();
  await expect(aviso(page)).toHaveText(
    "El turno cambió mientras cobrabas. No se guardó nada: vuelve a abrir «Registrar visita» desde el turno.");
  expect(await conteos(e.codigo)).toMatchObject({ operaciones: 0, movimientos: 0 });
});

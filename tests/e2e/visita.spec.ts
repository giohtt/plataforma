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
  // Código al azar de letras y números: con muchas sucursales por corrida, cuatro dígitos llegaban a repetirse.
  const codigo = `Y${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
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

/** Desde el turno: Registrar visita → buscar → Agregar. Deja la pantalla de cobro con la ficha en el grupo. */
async function elegir(page: Page, codigo: string, nombre: string) {
  await page.goto(`/sucursales/${codigo}/turno`);
  await page.getByRole("link", { name: "Registrar visita" }).click();
  await expect(page).toHaveURL(new RegExp(`/sucursales/${codigo}/turno/visita$`));
  await lista(page);
  await page.getByLabel(/nombre completo o teléfono/).fill(nombre);
  await page.getByRole("button", { name: "Buscar" }).click();
  await page.getByTestId("visitante").filter({ hasText: nombre }).getByRole("button", { name: "Agregar" }).click();
  await expect(page.getByTestId("datos-cobro")).toContainText(nombre);
}
const confirmar = (page: Page, total = "$50.00") => page.getByRole("button", { name: `Confirmar cobro · ${total}` });
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
  await expect(pantalla.getByRole("button")).toHaveText(["Quitar", /Confirmar cobro · \$50\.00/, "Empezar de nuevo"]);

  // Menos que el total: el error aparece junto al campo y no deja confirmar.
  await page.getByLabel("Recibido (opcional)").fill("20");
  await expect(page.locator("#recibido-error")).toHaveText("Lo recibido es menor que el total ($50.00). No se puede confirmar así.");
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
  await expect(page.getByTestId("datos-cobro")).toHaveCount(0);
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
  await expect(bolsa).toContainText("Cobros de visitas en efectivo (1 cobro · 1 visita)");
  await expect(page.getByTestId("cobro-turno")).toHaveCount(1);
  await expect(page.getByTestId("cobro-turno")).toContainText("1 persona · $50.00 en efectivo");
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
  await expect(page.locator("#recibido-error")).toHaveText("Lo recibido es menor que el total ($50.00). No se puede confirmar así.");
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
    "Se perdió la conexión y no sabemos si el cobro se guardó. Vuelve a tocar «Confirmar cobro»: si ya se había guardado, no se cobrará dos veces. Mientras tanto no se puede cambiar el grupo ni lo recibido.");
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

// ---------------------------------------------------------------------------
// Cobro grupal
// ---------------------------------------------------------------------------

/** Tres fichas ficticias que comparten teléfono (como Ana, Luis y Diego), sin visitas registradas hoy. */
async function tresQueCompartenTelefono() {
  const telefono = "000" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
  const apellidos = `${nombrePropio()} ${nombrePropio()}`;
  const nombres = [`${nombrePropio()} ${apellidos}`, `${nombrePropio()} ${apellidos}`, `${nombrePropio()} ${apellidos}`];
  for (const n of nombres) {
    await sql`insert into visitante (nombre, telefono, sucursal_alta_id) select ${n}, ${telefono}, id from sucursal where codigo = 'TEN'`;
  }
  return { telefono, nombres };
}
async function buscar(page: Page, texto: string) {
  await page.getByLabel(/nombre completo o teléfono/).fill(texto);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByTestId("resultados")).toBeVisible();
}
const tarjeta = (page: Page, nombre: string) => page.getByTestId("resultados").getByTestId("visitante").filter({ hasText: nombre });
async function abrirCobro(page: Page, codigo: string) {
  await page.goto(`/sucursales/${codigo}/turno/visita`);
  await lista(page);
}

test("grupo de tres: sin repetir, quitar y volver a agregar; total $150, cambio de $50 y una sola entrada de $150", async ({ page }) => {
  const e = await escenario();
  const g = await tresQueCompartenTelefono();
  await entrar(page, e.recep.correo);
  await abrirCobro(page, e.codigo);
  await buscar(page, g.telefono);
  for (const n of g.nombres) await tarjeta(page, n).getByRole("button", { name: "Agregar" }).click();
  await expect(page.getByTestId("en-grupo")).toHaveCount(3);
  // La misma persona no se agrega dos veces.
  for (const n of g.nombres) await expect(tarjeta(page, n).getByRole("button", { name: "Ya está en el grupo" })).toBeDisabled();
  await expect(page.getByTestId("total")).toHaveText("$150.00 en efectivo (3 × $50.00)");

  // Quitar antes de confirmar recalcula el total; se puede volver a agregar.
  await page.getByRole("button", { name: `Quitar a ${g.nombres[1]}` }).click();
  await expect(page.getByTestId("en-grupo")).toHaveCount(2);
  await expect(page.getByTestId("total")).toHaveText("$100.00 en efectivo (2 × $50.00)");
  await expect(confirmar(page, "$100.00")).toBeVisible();
  await tarjeta(page, g.nombres[1]).getByRole("button", { name: "Agregar" }).click();
  await expect(page.getByTestId("total")).toHaveText("$150.00 en efectivo (3 × $50.00)");

  await page.getByLabel("Recibido (opcional)").fill("100");
  await expect(page.locator("#recibido-error")).toHaveText("Lo recibido es menor que el total ($150.00). No se puede confirmar así.");
  await expect(confirmar(page, "$150.00")).toBeDisabled();
  await page.getByLabel("Recibido (opcional)").fill("200");
  await expect(page.getByTestId("cambio")).toHaveText("Cambio: $50.00");
  await expect(page.getByTestId("aviso-visita-hoy")).toHaveCount(0);
  expect(page.url()).not.toContain(g.telefono);

  await confirmar(page, "$150.00").click();
  const listo = page.getByTestId("cobro-registrado");
  await expect(listo.getByRole("heading")).toHaveText("Cobro registrado");
  await expect(listo).toContainText("3 personas");
  await expect(page.getByTestId("registrados").locator("li")).toHaveText([g.nombres[0], g.nombres[2], g.nombres[1]]);
  await expect(page.getByTestId("cambio-registrado")).toHaveText("$50.00");
  await expect(page.getByTestId("bolsa-registrado")).toHaveText("$150.00");
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 3, movimientos: 1, suma: "150.00" });

  // En el turno: una línea por cobro, con acceso al detalle de visitantes y pases.
  await listo.getByRole("link", { name: "Ver el turno" }).click();
  await expect(page.getByTestId("lugar-bolsa_visitas")).toContainText("Cobros de visitas en efectivo (1 cobro · 3 visitas)");
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("esperado")).toHaveText("$150.00");
  await expect(page.getByTestId("cobro-turno")).toHaveCount(1);
  await expect(page.getByTestId("cobro-turno")).toContainText("3 personas · $150.00 en efectivo");
  await page.getByTestId("cobro-turno").getByRole("link", { name: "Ver detalle" }).click();
  await expect(page.getByTestId("detalle-total")).toHaveText("$150.00");
  await expect(page.getByTestId("detalle-bolsa")).toContainText("$150.00");
  await expect(page.getByTestId("pase")).toHaveCount(3);
  await expect(page.getByTestId("pase").first()).toContainText(`1. ${g.nombres[0]}`);
  await expect(page.getByTestId("detalle-pases")).toContainText(`•• •••• ${g.telefono.slice(6)}`);
  await expect(page.getByTestId("detalle-pases")).not.toContainText(g.telefono);
});

test("crear una ficha desde la misma pantalla conserva el grupo; una coincidencia se puede agregar sin crear otra", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await expect(page.getByTestId("en-grupo")).toHaveCount(1);

  // Ficha nueva sin coincidencias: se crea y entra al grupo.
  const nuevo = `${nombrePropio()} ${nombrePropio()} ${nombrePropio()}`;
  await buscar(page, nuevo);
  await page.getByTestId("crear-visitante").click();
  await expect(page.getByTestId("alta-visitante")).toContainText("El grupo que ya armaste se conserva.");
  await expect(page.getByLabel("Nombre completo")).toHaveValue(nuevo);
  await page.getByRole("button", { name: "Crear expediente" }).click();
  await expect(page.getByTestId("en-grupo")).toHaveCount(2);
  await expect(page.getByTestId("en-grupo").nth(1)).toContainText(nuevo);
  await expect(page.getByTestId("alta-visitante")).toHaveCount(0);
  expect((await sql`select count(*)::int as n from visitante where nombre = ${nuevo}`)[0].n).toBe(1);

  // Intentar crear de nuevo a la primera persona: aparece la coincidencia y se agrega esa ficha, sin crear otra.
  const otra = await tresQueCompartenTelefono();
  await buscar(page, `${nombrePropio()} ${nombrePropio()}`);
  await page.getByTestId("crear-visitante").click();
  await lista(page);
  await page.getByLabel("Nombre completo").fill(otra.nombres[0]);
  await page.getByRole("button", { name: "Crear expediente" }).click();
  const coincidencia = page.getByTestId("coincidencias").getByTestId("visitante").filter({ hasText: otra.nombres[0] });
  await coincidencia.getByRole("button", { name: "Agregar" }).click();
  await expect(page.getByTestId("en-grupo")).toHaveCount(3);
  expect((await sql`select count(*)::int as n from visitante where nombre = ${otra.nombres[0]}`)[0].n).toBe(1);

  await confirmar(page, "$150.00").click();
  await expect(page.getByTestId("cobro-registrado")).toContainText("3 personas");
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 3, movimientos: 1, suma: "150.00" });
});

test("si alguien ya tiene pase de hoy en esta sucursal, no se cobra otra visita: se ofrece registrar su entrada o reingreso", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await expect(page.getByTestId("visita-hoy")).toHaveCount(0);
  await expect(page.getByTestId("pase-aqui")).toHaveCount(0);
  await confirmar(page).click();
  await expect(page.getByTestId("cobro-registrado")).toBeVisible();

  await page.getByRole("button", { name: "Nueva visita" }).click();
  await buscar(page, e.nombre);
  await tarjeta(page, e.nombre).getByRole("button", { name: "Agregar" }).click();
  await expect(page.getByTestId("pase-aqui")).toContainText(`Ya tiene pase de hoy en Visitas ${e.codigo}: no se cobra otra visita.`);
  await expect(page.getByTestId("aviso-pase-aqui")).toContainText("no se cobra otra visita");
  await expect(confirmar(page)).toBeDisabled();
  await page.getByTestId("ir-pase").click();
  await expect(page.getByTestId("entradas")).toBeVisible();
  await page.getByRole("button", { name: "Registrar entrada" }).click();
  await expect(page.getByRole("status")).toHaveText("Entrada registrada.");

  // Ya entró: ahora se ofrece el reingreso, también desde la búsqueda.
  await abrirCobro(page, e.codigo);
  await buscar(page, e.nombre);
  await tarjeta(page, e.nombre).getByRole("button", { name: "Agregar" }).click();
  await expect(page.getByTestId("pase-aqui")).toContainText("y ya entró");
  await expect(page.getByTestId("ir-pase")).toHaveText("Registrar reingreso");
  await expect(page.getByRole("button", { name: /Cobrar otra visita/ })).toHaveCount(0);
  expect(await conteos(e.codigo)).toMatchObject({ operaciones: 1, pases: 1 });
});

test("grupo: se pierde la conexión después de guardar; el grupo y lo recibido quedan fijos y el reintento no cobra dos veces", async ({ page }) => {
  const e = await escenario();
  const g = await tresQueCompartenTelefono();
  await entrar(page, e.recep.correo);
  await abrirCobro(page, e.codigo);
  await buscar(page, g.telefono);
  for (const n of g.nombres) await tarjeta(page, n).getByRole("button", { name: "Agregar" }).click();
  await page.getByLabel("Recibido (opcional)").fill("200");
  let cortes = 0;
  await page.route("**/*", async (route) => {
    if (!esCobro(route) || cortes > 0) return route.continue();
    cortes++;
    await route.fetch();
    await route.abort("internetdisconnected");
  });
  await confirmar(page, "$150.00").click();
  await expect(aviso(page)).toContainText("Mientras tanto no se puede cambiar el grupo ni lo recibido.");
  await expect(page.getByRole("button", { name: /^Quitar a / }).first()).toBeDisabled();
  await expect(page.getByLabel("Recibido (opcional)")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "Buscar" })).toBeDisabled();
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 3, movimientos: 1, suma: "150.00" });

  await confirmar(page, "$150.00").click();
  await expect(page.getByTestId("cobro-registrado")).toContainText("3 personas");
  await expect(page.getByTestId("cambio-registrado")).toHaveText("$50.00");
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 3, movimientos: 1, suma: "150.00" });
});

test("la misma clave enviada con otro grupo se rechaza en el servidor", async ({ page }) => {
  const e = await escenario();
  const g = await tresQueCompartenTelefono();
  await entrar(page, e.recep.correo);
  await abrirCobro(page, e.codigo);
  await buscar(page, g.telefono);
  for (const n of g.nombres) await tarjeta(page, n).getByRole("button", { name: "Agregar" }).click();
  // Primer envío: se guarda pero la respuesta no llega. El reintento se altera en el camino: sin la tercera persona.
  let envios = 0;
  await page.route("**/*", async (route) => {
    if (!esCobro(route)) return route.continue();
    envios++;
    if (envios === 1) { await route.fetch(); return route.abort("internetdisconnected"); }
    const partes = (route.request().postData() ?? "").split(/(?=------)/);
    let vistos = 0;
    const cuerpo = partes.filter((p) => !(p.includes('visitanteId"') && ++vistos === 3)).join("");
    await route.continue({ postData: cuerpo });
  });
  await confirmar(page, "$150.00").click();
  await expect(aviso(page)).toContainText("Se perdió la conexión");
  await confirmar(page, "$150.00").click();
  await expect(aviso(page)).toHaveText("Este cobro ya se había enviado con otras personas o con otro importe recibido. No se guardó nada.");
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 3, movimientos: 1, suma: "150.00" });
});

// ---------------------------------------------------------------------------
// Cobro con tarjeta
// ---------------------------------------------------------------------------
const registrar = (page: Page, total = "$50.00") => page.getByRole("button", { name: `Registrar cobro aprobado · ${total}` });
async function aTarjeta(page: Page) {
  await page.getByRole("radio", { name: "Tarjeta" }).check();
  await expect(page.getByLabel("Recibido (opcional)")).toHaveCount(0);
}
const conTarjetaEnBd = async (codigo: string) =>
  (await sql`select count(*)::int as n from cobro_visita c join operacion_visita o on o.id = c.operacion_id
             join sucursal s on s.id = o.sucursal_id where s.codigo = ${codigo} and c.forma_pago = 'tarjeta'`)[0].n as number;

test("tarjeta, una persona: autorización obligatoria; confirmado operativamente, liquidación pendiente y la bolsa no cambia", async ({ page }) => {
  const e = await escenario();
  const g = await tresQueCompartenTelefono();
  await entrar(page, e.recep.correo);
  // Antes: un cobro de $50 en efectivo, para comprobar que la tarjeta no mueve el esperado de la bolsa.
  await elegir(page, e.codigo, e.nombre);
  await confirmar(page).click();
  await expect(page.getByTestId("cobro-registrado")).toBeVisible();
  await page.getByRole("button", { name: "Nueva visita" }).click();

  await buscar(page, g.nombres[0]);
  await tarjeta(page, g.nombres[0]).getByRole("button", { name: "Agregar" }).click();
  await aTarjeta(page);
  await expect(page.getByTestId("datos-cobro")).toContainText("Cobra $50.00 en la terminal y espera a que diga «Aprobado».");
  await expect(page.getByTestId("datos-cobro")).toContainText("Si la terminal rechaza el pago, no registres nada.");

  // Sin autorización o con un formato que no corresponde: el error aparece junto al campo y no se registra.
  await registrar(page).click();
  await expect(page.locator("#autorizacion-error")).toHaveText("Escribe el número de autorización del comprobante de la terminal.");
  await page.getByLabel("Autorización del comprobante").fill("12");
  await registrar(page).click();
  await expect(page.locator("#autorizacion-error")).toHaveText("La autorización debe tener de 4 a 12 letras o números, como aparece en el comprobante.");
  expect(await conTarjetaEnBd(e.codigo)).toBe(0);

  await page.getByLabel("Autorización del comprobante").fill("a1b2c3");
  await registrar(page).click();
  const listo = page.getByTestId("cobro-registrado");
  await expect(listo).toContainText("$50.00 con tarjeta");
  await expect(page.getByTestId("autorizacion-registrada")).toHaveText("A1B2C3");
  await expect(page.getByTestId("estado-registrado")).toHaveText("Confirmado operativamente");
  await expect(page.getByTestId("conciliacion-registrada")).toHaveText("Pendiente de conciliar");
  await expect(page.getByTestId("bolsa-registrado")).toHaveText("No entra efectivo (tarjeta)");
  expect(await conteos(e.codigo)).toEqual({ operaciones: 2, pases: 2, movimientos: 1, suma: "50.00" });

  await listo.getByRole("link", { name: "Ver el turno" }).click();
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("esperado")).toHaveText("$50.00");
  await expect(page.getByTestId("lugar-bolsa_visitas")).toContainText("(1 cobro · 1 visita)");
  await expect(page.getByTestId("total-tarjeta")).toHaveText("$50.00");
  await expect(page.getByTestId("conciliacion-tarjeta")).toHaveText("Pendiente de conciliar");
  const linea = page.getByTestId("cobro-turno").filter({ hasText: "con tarjeta" });
  await expect(linea).toContainText("1 persona · $50.00 con tarjeta · confirmado operativamente · liquidación pendiente de conciliar");
  await linea.getByRole("link", { name: "Ver detalle" }).click();
  await expect(page.getByTestId("detalle-autorizacion")).toHaveText("A1B2C3");
  await expect(page.getByTestId("detalle-estado")).toHaveText("Confirmado operativamente");
  await expect(page.getByTestId("detalle-conciliacion")).toHaveText("Pendiente de conciliar");
  await expect(page.getByTestId("detalle-bolsa")).toHaveText("No entra efectivo (tarjeta)");
});

test("tarjeta, grupo de tres: «Registrar cobro aprobado · $150.00» y ninguna entrada de efectivo", async ({ page }) => {
  const e = await escenario();
  const g = await tresQueCompartenTelefono();
  await entrar(page, e.recep.correo);
  await abrirCobro(page, e.codigo);
  await buscar(page, g.telefono);
  for (const n of g.nombres) await tarjeta(page, n).getByRole("button", { name: "Agregar" }).click();
  await aTarjeta(page);
  await page.getByLabel("Autorización del comprobante").fill("778899");
  await registrar(page, "$150.00").click();
  await expect(page.getByTestId("cobro-registrado")).toContainText("3 personas");
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 3, movimientos: 0, suma: "0" });
});

test("autorización repetida hoy en la sucursal: muestra el cobro previo y pide confirmar que es otra venta", async ({ page }) => {
  const e = await escenario();
  const g = await tresQueCompartenTelefono();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await aTarjeta(page);
  await page.getByLabel("Autorización del comprobante").fill("555000");
  await registrar(page).click();
  await expect(page.getByTestId("cobro-registrado")).toBeVisible();
  await page.getByRole("button", { name: "Nueva visita" }).click();

  await buscar(page, g.nombres[1]);
  await tarjeta(page, g.nombres[1]).getByRole("button", { name: "Agregar" }).click();
  await aTarjeta(page);
  await page.getByLabel("Autorización del comprobante").fill("555000");
  await registrar(page).click();
  const previa = page.getByTestId("autorizacion-previa");
  await expect(previa).toContainText(`Esta autorización ya se registró hoy en Visitas ${e.codigo}:`);
  await expect(previa).toContainText("1 persona · $50.00 · Confirmado operativamente");
  await expect(previa.getByRole("link", { name: "Ver cobro" })).toHaveAttribute("target", "_blank");
  await expect(registrar(page)).toBeDisabled();
  expect(await conTarjetaEnBd(e.codigo)).toBe(1);

  await previa.getByLabel("Confirmo que es otra venta aprobada en la terminal, distinta de la anterior.").check();
  await registrar(page).click();
  await expect(page.getByTestId("cobro-registrado")).toContainText(g.nombres[1]);
  expect(await conTarjetaEnBd(e.codigo)).toBe(2);
});

test("tarjeta: se pierde la conexión después de registrar; indica no volver a pasar la tarjeta y el reintento no duplica", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await aTarjeta(page);
  await page.getByLabel("Autorización del comprobante").fill("900100");
  let cortes = 0;
  await page.route("**/*", async (route) => {
    if (!esCobro(route) || cortes > 0) return route.continue();
    cortes++;
    await route.fetch();
    await route.abort("internetdisconnected");
  });
  await registrar(page).click();
  await expect(aviso(page)).toHaveText(
    "Se perdió la conexión y no sabemos si el cobro se registró en Fitnessland. El pago ya se cobró en la terminal: no vuelvas a pasar la tarjeta. Toca «Registrar cobro aprobado» otra vez con la misma autorización: si ya se había registrado, no se registrará dos veces.");
  await expect(page.getByLabel("Autorización del comprobante")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("radio", { name: "Efectivo" })).toBeDisabled();
  expect(await conTarjetaEnBd(e.codigo)).toBe(1);

  await registrar(page).click();
  await expect(page.getByTestId("cobro-registrado")).toContainText("$50.00 con tarjeta");
  await expect(page.getByTestId("autorizacion-previa")).toHaveCount(0);
  expect(await conTarjetaEnBd(e.codigo)).toBe(1);
  expect(await conteos(e.codigo)).toMatchObject({ operaciones: 1, movimientos: 0 });
});

test("tarjeta: si el servidor rechaza el registro, recuerda no volver a pasar la tarjeta", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await aTarjeta(page);
  await page.getByLabel("Autorización del comprobante").fill("313131");
  await sql`update turno set cerrado_en = now() where id = ${e.turnoId}`;
  await sql`update responsable_lugar set hasta = now() where turno_id = ${e.turnoId}`;
  await abrirTurno(e.codigo, e.recep.id);
  await registrar(page).click();
  await expect(aviso(page)).toContainText("El turno cambió mientras cobrabas. No se guardó nada");
  await expect(aviso(page)).toContainText("El pago ya se cobró en la terminal: no vuelvas a pasar la tarjeta; registra este cobro con la misma autorización.");
  expect(await conTarjetaEnBd(e.codigo)).toBe(0);
});

// ---------------------------------------------------------------------------
// Cobro por transferencia y verificación del abono
// ---------------------------------------------------------------------------
const registrarTransferencia = (page: Page, total = "$50.00") => page.getByRole("button", { name: `Registrar transferencia · ${total}` });
async function aTransferencia(page: Page, referencia: string, tipo: "Clave de rastreo" | "Folio bancario" = "Clave de rastreo") {
  await page.getByRole("radio", { name: "Transferencia" }).check();
  await expect(page.getByLabel("Recibido (opcional)")).toHaveCount(0);
  if (referencia) {
    await page.getByRole("radio", { name: tipo }).check();
    await page.getByLabel("Clave de rastreo o folio bancario").fill(referencia);
  }
}
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const estadoTransferencia = async (codigo: string) =>
  (await sql`select c.estado, c.version, c.abono_fecha::text as abono from cobro_visita c join operacion_visita o on o.id = c.operacion_id
             join sucursal s on s.id = o.sucursal_id where s.codigo = ${codigo} and c.forma_pago = 'transferencia'`) as unknown as { estado: string; version: number; abono: string | null }[];

test("transferencia: queda pendiente sin tocar la bolsa; Administración verifica el mismo cobro y pasa a verificado", async ({ page }) => {
  const e = await escenario();
  const adm = await crearCuenta([["administracion", e.codigo]]);
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await page.getByRole("radio", { name: "Transferencia" }).check();
  await expect(page.getByTestId("datos-cobro")).toContainText("Pide al visitante que transfiera $50.00 a la cuenta de Fitnessland");
  await expect(page.getByTestId("aviso-acceso")).toContainText("Para entrar antes, necesita la autorización de Encargado.");
  // Sin tipo ni referencia: error junto al campo.
  await registrarTransferencia(page).click();
  await expect(page.locator("#referencia-error")).toHaveText("Indica si es una clave de rastreo o un folio bancario.");
  await page.getByRole("radio", { name: "Clave de rastreo" }).check();
  await registrarTransferencia(page).click();
  await expect(page.locator("#referencia-error")).toHaveText("Escribe la clave de rastreo o el folio bancario del comprobante de la transferencia.");
  const ref = `MBAN${Math.floor(Math.random() * 1e12)}`;
  await page.getByLabel("Clave de rastreo o folio bancario").fill(ref.toLowerCase());
  await registrarTransferencia(page).click();
  const listo = page.getByTestId("cobro-registrado");
  await expect(listo).toContainText("$50.00 por transferencia");
  await expect(page.getByTestId("referencia-registrada")).toHaveText(ref);
  await expect(page.getByTestId("estado-registrado")).toHaveText("Pendiente de verificar abono");
  await expect(page.getByTestId("bolsa-registrado")).toHaveText("No entra efectivo (transferencia)");
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 1, movimientos: 0, suma: "0" });

  await listo.getByRole("link", { name: "Ver el turno" }).click();
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("esperado")).toHaveText("$0.00");
  await expect(page.getByTestId("transf-pendientes")).toHaveText("$50.00");
  await expect(page.getByTestId("cobro-turno")).toContainText("1 persona · $50.00 por transferencia · Pendiente de verificar abono");

  // Recepción no verifica.
  await page.goto(`/sucursales/${e.codigo}/transferencias`);
  await expect(page.getByRole("heading", { name: "No encontrada" })).toBeVisible();

  // Administración: importe incompleto no; importe completo y fecha, sí.
  await entrar(page, adm.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("transferencias").click();
  await lista(page);
  const fila = page.getByTestId("pendientes").getByTestId("transferencia");
  await expect(fila).toHaveCount(1);
  await expect(fila.getByTestId("referencia")).toHaveText(ref);
  await fila.getByLabel("Importe que llegó").fill("40");
  await fila.getByLabel("Fecha del abono").fill(hoyMx());
  await fila.getByLabel(/Comprobé en el estado de cuenta/).check();
  await fila.getByRole("button", { name: "Abono verificado" }).click();
  await expect(fila.getByRole("alert")).toHaveText("El abono debe ser por el importe completo del cobro. Si llegó otro importe, no lo marques como verificado.");
  expect((await estadoTransferencia(e.codigo))[0].estado).toBe("pendiente_abono");
  await fila.getByLabel("Importe que llegó").fill("50");
  await fila.getByLabel("Fecha del abono").fill(hoyMx());
  await fila.getByLabel(/Comprobé en el estado de cuenta/).check();
  await fila.getByRole("button", { name: "Abono verificado" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Abono verificado. El cobro pasó de pendiente a verificado.");
  await expect(page.getByTestId("pendientes").getByTestId("transferencia")).toHaveCount(0);
  await expect(page.getByTestId("verificada")).toContainText(ref);
  expect(await estadoTransferencia(e.codigo)).toEqual([{ estado: "abono_verificado", version: 2, abono: hoyMx() }]);
  expect(await conteos(e.codigo)).toEqual({ operaciones: 1, pases: 1, movimientos: 0, suma: "0" });

  // En el turno: pasó de pendientes a verificadas, el mismo cobro, y la bolsa sigue igual.
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("transf-pendientes")).toHaveText("$0.00");
  await expect(page.getByTestId("transf-verificadas")).toHaveText("$50.00");
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("esperado")).toHaveText("$0.00");
  await expect(page.getByTestId("cobro-turno")).toHaveCount(1);
  await page.getByTestId("cobro-turno").getByRole("link", { name: "Ver detalle" }).click();
  await expect(page.getByTestId("detalle-estado")).toHaveText("Abono verificado");
  await expect(page.getByTestId("cambio-estado")).toContainText("Pendiente de verificar abono → Abono verificado");
});

test("quien registró la transferencia no la puede verificar; «No localizado» pide motivo y después se puede verificar", async ({ page }) => {
  const e = await escenario();
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) select ${e.recep.id}, 'administracion', id, 'Prueba' from sucursal where codigo = ${e.codigo}`;
  const dir = await crearCuenta([["direccion", e.codigo]]);
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await aTransferencia(page, `FOL${Math.floor(Math.random() * 1e8)}`, "Folio bancario");
  await registrarTransferencia(page).click();
  await expect(page.getByTestId("cobro-registrado")).toBeVisible();
  await page.goto(`/sucursales/${e.codigo}/transferencias`);
  await expect(page.getByTestId("propia")).toHaveText("La registraste tú: debe verificarla otra persona con permiso.");
  await expect(page.getByRole("button", { name: "Abono verificado" })).toHaveCount(0);

  await entrar(page, dir.correo);
  await page.goto(`/sucursales/${e.codigo}/transferencias`);
  await lista(page);
  const fila = page.getByTestId("pendientes").getByTestId("transferencia");
  await fila.getByLabel("Motivo si no se localiza").fill("no");
  await fila.getByRole("button", { name: "No localizado" }).click();
  await expect(fila.getByRole("alert")).toHaveText("Explica por qué no se localizó (de 5 a 300 caracteres).");
  await fila.getByLabel("Motivo si no se localiza").fill("No aparece en el estado de cuenta de hoy");
  await fila.getByRole("button", { name: "No localizado" }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("Marcada como no localizada");
  const nl = page.getByTestId("no-localizadas").getByTestId("transferencia");
  await expect(nl).toContainText("Motivo: No aparece en el estado de cuenta de hoy");
  await expect(nl.getByRole("button", { name: "No localizado" })).toHaveCount(0);

  // En el turno: la no localizada se muestra aparte y no suma al total confirmado; la bolsa no cambia.
  await page.goto(`/sucursales/${e.codigo}/turno`);
  const esperadoAntes = await page.getByTestId("lugar-bolsa_visitas").getByTestId("esperado").textContent();
  await expect(page.getByTestId("ventas-transferencia")).toHaveText("$0.00");
  await expect(page.getByTestId("ventas-no-localizadas")).toHaveText("$50.00");
  await expect(page.getByTestId("ventas-pendientes")).toHaveText("$0.00");
  await expect(page.getByTestId("ventas-total")).toHaveText("$0.00");
  await page.goto(`/sucursales/${e.codigo}/transferencias`);
  await nl.getByLabel("Importe que llegó").fill("50");
  await nl.getByLabel("Fecha del abono").fill(hoyMx());
  await nl.getByLabel(/Comprobé en el estado de cuenta/).check();
  await nl.getByRole("button", { name: "Abono verificado" }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("Abono verificado");
  expect((await estadoTransferencia(e.codigo))[0].estado).toBe("abono_verificado");

  // Se localizó: el mismo cobro pasa a verificadas y suma una sola vez.
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("ventas-transferencia")).toHaveText("$50.00");
  await expect(page.getByTestId("ventas-no-localizadas")).toHaveText("$0.00");
  await expect(page.getByTestId("ventas-total")).toHaveText("$50.00");
  await expect(page.getByTestId("cobro-turno")).toHaveCount(1);
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("esperado")).toHaveText(esperadoAntes!);
  await page.getByTestId("cobro-turno").getByRole("link", { name: "Ver detalle" }).click();
  await expect(page.getByTestId("cambio-estado")).toHaveCount(2);
  await expect(page.getByTestId("cambio-estado").nth(0)).toContainText("Pendiente de verificar abono → No localizado");
  await expect(page.getByTestId("cambio-estado").nth(1)).toContainText("No localizado → Abono verificado");
});

test("referencia repetida: muestra el cobro previo y pide confirmar que es otra transferencia", async ({ page }) => {
  const e = await escenario();
  const g = await tresQueCompartenTelefono();
  const ref = `RPT${Math.floor(Math.random() * 1e9)}`;
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await aTransferencia(page, ref);
  await registrarTransferencia(page).click();
  await expect(page.getByTestId("cobro-registrado")).toBeVisible();
  await page.getByRole("button", { name: "Nueva visita" }).click();

  await buscar(page, g.nombres[0]);
  await tarjeta(page, g.nombres[0]).getByRole("button", { name: "Agregar" }).click();
  await aTransferencia(page, ref);
  await registrarTransferencia(page).click();
  const previa = page.getByTestId("referencia-previa");
  await expect(previa).toContainText("Esta referencia ya está registrada en otro cobro:");
  await expect(previa).toContainText("Pendiente de verificar abono");
  await expect(registrarTransferencia(page)).toBeDisabled();
  await previa.getByLabel("Confirmo que es otra transferencia, distinta de la anterior.").check();
  await registrarTransferencia(page).click();
  await expect(page.getByTestId("cobro-registrado")).toContainText(g.nombres[0]);
  expect((await estadoTransferencia(e.codigo)).length).toBe(2);
});

test("transferencia: se pierde la conexión; el reintento con la misma referencia no registra dos veces", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await elegir(page, e.codigo, e.nombre);
  await aTransferencia(page, `CNX${Math.floor(Math.random() * 1e9)}`);
  let cortes = 0;
  await page.route("**/*", async (route) => {
    if (!esCobro(route) || cortes > 0) return route.continue();
    cortes++;
    await route.fetch();
    await route.abort("internetdisconnected");
  });
  await registrarTransferencia(page).click();
  await expect(aviso(page)).toContainText("Vuelve a tocar «Registrar transferencia» con la misma referencia");
  await expect(page.getByLabel("Clave de rastreo o folio bancario")).toHaveAttribute("readonly", "");
  await registrarTransferencia(page).click();
  await expect(page.getByTestId("cobro-registrado")).toContainText("Pendiente de verificar abono");
  await expect(page.getByTestId("referencia-previa")).toHaveCount(0);
  expect((await estadoTransferencia(e.codigo)).length).toBe(1);
});

import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/** Bloque 2: corrección de expedientes. Solo datos ficticios; cada prueba crea sus propios expedientes. */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar correcciones 2026";

async function crearCuenta(asignaciones: [string, string][]) {
  const correo = `corr-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${"Cuenta " + correo.slice(5, 13)}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de corrección' from sucursal where codigo = ${codigo}`;
  }
  return { correo, nombre: "Cuenta " + correo.slice(5, 13) };
}

async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function usarSesionDe(browser: Browser, page: Page, correo: string) {
  const otra = await browser.newContext();
  const p = await otra.newPage();
  await p.goto("/iniciar-sesion");
  await p.getByLabel("Correo").fill(correo);
  await p.getByLabel("Contraseña").fill(CLAVE);
  await p.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(p).toHaveURL(/\/$/);
  const cookies = await otra.cookies();
  await otra.close();
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
}

const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxyz"[Math.floor(Math.random() * 21)]).join("");
const nombreUnico = () => `${letras(8)} ${letras(8)} ${letras(8)}`;
const telefonoUnico = () => `000${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
async function expediente(codigo: string, telefono: string | null = null) {
  const nombre = nombreUnico();
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id)
    select ${nombre}, ${telefono}, 'Puebla', id from sucursal where codigo = ${codigo} returning id`;
  return { id: v.id, nombre };
}
const fila = async (id: string) =>
  (await sql`select nombre, telefono, estado_procedencia, version from visitante where id = ${id}`)[0];
const aviso = (page: Page) => page.locator("p.aviso[role=alert]");
const lista = (page: Page) => page.waitForLoadState("networkidle");

test("Encargado de Tenango corrige un expediente de Tenango: motivo obligatorio e historial con teléfono enmascarado", async ({ page }) => {
  const encargado = await crearCuenta([["encargado", "TEN"]]);
  const anterior = telefonoUnico();
  const nuevo = telefonoUnico();
  const v = await expediente("TEN", anterior);
  const nombreNuevo = nombreUnico();

  await entrar(page, encargado.correo);
  await page.goto(`/sucursales/TEN/visitantes/${v.id}`);
  await page.getByTestId("corregir-visitante").click();
  await lista(page);
  await expect(page.getByText(`Actual: •• •••• ${anterior.slice(-4)}`)).toBeVisible();

  await page.getByLabel("Nombre completo").fill(nombreNuevo);
  await page.getByLabel("Teléfono nuevo").fill(nuevo);
  await page.getByLabel("Estado de procedencia").selectOption("Hidalgo");
  await page.getByRole("button", { name: "Guardar corrección" }).click();
  await expect(page.locator("#motivo-error")).toBeVisible();
  expect((await fila(v.id)).nombre).toBe(v.nombre);

  await page.getByLabel("Motivo de la corrección").fill("El visitante dictó mal su nombre");
  await page.getByRole("button", { name: "Guardar corrección" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Corrección guardada.");
  expect(await fila(v.id)).toMatchObject({ nombre: nombreNuevo, telefono: nuevo, estado_procedencia: "Hidalgo" });

  const historial = page.getByTestId("correcciones");
  await expect(historial).toContainText(`Teléfono: •• •••• ${anterior.slice(-4)} → •• •••• ${nuevo.slice(-4)}`);
  await expect(historial).toContainText(`Nombre: ${v.nombre} → ${nombreNuevo}`);
  await expect(historial).toContainText("Estado de procedencia: Puebla → Hidalgo");
  await expect(historial).toContainText("Motivo: El visitante dictó mal su nombre");
  await expect(historial).toContainText(`${encargado.nombre} · desde Tenango`);
  const html = await page.content();
  expect(html).not.toContain(anterior);
  expect(html).not.toContain(nuevo);
  expect(decodeURIComponent(page.url())).not.toMatch(new RegExp(`${nombreNuevo.split(" ")[0]}|${nuevo}`));
});

test("Encargado de Tenango no corrige un expediente creado en Santiago", async ({ page }) => {
  const v = await expediente("STG");
  await entrar(page, (await crearCuenta([["encargado", "TEN"]])).correo);
  await page.goto(`/sucursales/TEN/visitantes/${v.id}`);
  await expect(page.getByTestId("expediente")).toBeVisible();
  await expect(page.getByTestId("corregir-visitante")).toHaveCount(0);
  expect((await page.goto(`/sucursales/TEN/visitantes/${v.id}/corregir`))?.status()).toBe(404);
});

test("Recepción y Administración no tienen la opción de corregir", async ({ page }) => {
  const v = await expediente("TEN");
  for (const rol of ["recepcion", "administracion"]) {
    await entrar(page, (await crearCuenta([[rol, "TEN"]])).correo);
    await page.goto(`/sucursales/TEN/visitantes/${v.id}`);
    await expect(page.getByTestId("expediente"), rol).toBeVisible();
    await expect(page.getByTestId("corregir-visitante"), rol).toHaveCount(0);
    expect((await page.goto(`/sucursales/TEN/visitantes/${v.id}/corregir`))?.status(), rol).toBe(404);
  }
});

test("envío directo del formulario: Recepción y cuentas sin permiso en la sucursal no guardan cambios", async ({ page, browser }) => {
  const v = await expediente("TEN", telefonoUnico());
  const antes = await fila(v.id);
  const encargado = await crearCuenta([["encargado", "TEN"]]);

  const intentar = async (correo: string, esperado: string) => {
    await usarSesionDe(browser, page, encargado.correo);
    await page.goto(`/sucursales/TEN/visitantes/${v.id}/corregir`);
    await lista(page);
    await usarSesionDe(browser, page, correo);
    await page.getByLabel("Nombre completo").fill(nombreUnico());
    await page.getByLabel("Motivo de la corrección").fill("Intento sin permiso");
    await page.getByRole("button", { name: "Guardar corrección" }).click();
    await expect(aviso(page)).toHaveText(esperado);
  };

  await entrar(page, encargado.correo);
  await intentar((await crearCuenta([["recepcion", "TEN"]])).correo, "Tu cuenta no tiene permiso para corregir este expediente.");
  await intentar((await crearCuenta([["administracion", "TEN"]])).correo, "Tu cuenta no tiene permiso para corregir este expediente.");
  await intentar((await crearCuenta([["encargado", "STG"]])).correo, "No encontrada.");
  await intentar((await crearCuenta([])).correo, "No encontrada.");

  expect(await fila(v.id)).toEqual(antes);
  expect(await sql`select 1 from visitante_cambio where visitante_id = ${v.id}`).toHaveLength(0);
});

test("envío directo: Encargado de Tenango cambia el identificador oculto por uno de Santiago y no se guarda", async ({ page }) => {
  const propio = await expediente("TEN");
  const ajeno = await expediente("STG");
  const antes = await fila(ajeno.id);
  await entrar(page, (await crearCuenta([["encargado", "TEN"]])).correo);
  await page.goto(`/sucursales/TEN/visitantes/${propio.id}/corregir`);
  await lista(page);
  await page.evaluate(({ id, version }) => {
    document.querySelector<HTMLInputElement>("form input[name=id]")!.value = id;
    document.querySelector<HTMLInputElement>("form input[name=version]")!.value = String(version);
  }, { id: ajeno.id, version: antes.version });
  await page.getByLabel("Nombre completo").fill(nombreUnico());
  await page.getByLabel("Motivo de la corrección").fill("Intento con otro expediente");
  await page.getByRole("button", { name: "Guardar corrección" }).click();
  await expect(aviso(page)).toHaveText("Tu cuenta no tiene permiso para corregir este expediente.");
  expect(await fila(ajeno.id)).toEqual(antes);
});

test("si la corrección produce coincidencias, avisa y al confirmar guarda con las fichas separadas", async ({ page }) => {
  const a = await expediente("TEN");
  const b = await expediente("TEN");
  // Solo las fichas de esta prueba (otras pruebas crean fichas en paralelo): siguen siendo dos, separadas.
  const total = async () =>
    (await sql`select count(*)::int as n from visitante where (id in (${a.id}, ${b.id}) or nombre = ${a.nombre}) and fusionado_en_id is null`)[0].n as number;
  const antes = await total();
  expect(antes).toBe(2);

  await entrar(page, (await crearCuenta([["encargado", "TEN"]])).correo);
  await page.goto(`/sucursales/TEN/visitantes/${b.id}/corregir`);
  await lista(page);
  await page.getByLabel("Nombre completo").fill(a.nombre);
  await page.getByLabel("Motivo de la corrección").fill("Corrección que coincide");
  await page.getByRole("button", { name: "Guardar corrección" }).click();

  const coincidencias = page.getByTestId("coincidencias");
  await expect(coincidencias).toContainText(a.nombre);
  await expect(coincidencias).toContainText("Mismo nombre");
  expect((await fila(b.id)).nombre).toBe(b.nombre);

  await page.getByLabel(/Revisé los expedientes parecidos/).check();
  await page.getByRole("button", { name: "Guardar corrección" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Corrección guardada.");
  expect((await fila(b.id)).nombre).toBe(a.nombre);
  expect((await fila(a.id)).nombre).toBe(a.nombre);
  expect(await total()).toBe(2);
});

test("el historial de correcciones solo lo recibe quien puede corregir; Recepción y Administración ven la ficha actual", async ({ page }) => {
  const anterior = nombreUnico();
  const actual = nombreUnico();
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, sucursal_alta_id) select ${actual}, id from sucursal where codigo = 'TEN' returning id`;
  await sql`
    insert into visitante_cambio (visitante_id, campo, valor_anterior, valor_nuevo, motivo, usuario_id, sucursal_id)
    select ${v.id}, 'nombre', ${anterior}, ${actual}, 'Motivo reservado de prueba', u.id, s.id
    from usuario u, sucursal s where u.correo = 'encargado.tenango@prueba.fitnessland.invalid' and s.codigo = 'TEN'`;
  const ruta = `/sucursales/TEN/visitantes/${v.id}`;
  /** Lo que el servidor envía al navegador para esa página, tal cual. */
  const respuesta = () => page.evaluate(async (r) => (await fetch(r, { credentials: "same-origin" })).text(), ruta);

  for (const rol of ["recepcion", "administracion"]) {
    await entrar(page, (await crearCuenta([[rol, "TEN"]])).correo);
    await page.goto(ruta);
    await expect(page.getByTestId("nombre-visitante"), rol).toHaveText(actual);
    await expect(page.getByTestId("correcciones"), rol).toHaveCount(0);
    const html = await respuesta();
    expect(html, rol).toContain(actual);
    expect(html, rol).not.toContain(anterior);
    expect(html, rol).not.toContain("Motivo reservado de prueba");
  }

  // Encargado de Santiago puede consultar desde Santiago, pero el expediente es de Tenango: tampoco lo recibe.
  await entrar(page, (await crearCuenta([["encargado", "STG"]])).correo);
  await page.goto(`/sucursales/STG/visitantes/${v.id}`);
  await expect(page.getByTestId("nombre-visitante")).toHaveText(actual);
  const html = await page.evaluate(async (r) => (await fetch(r, { credentials: "same-origin" })).text(), `/sucursales/STG/visitantes/${v.id}`);
  expect(html).not.toContain(anterior);
  expect(html).not.toContain("Motivo reservado de prueba");

  // Encargado de Tenango sí puede corregirlo: ve el historial.
  await entrar(page, (await crearCuenta([["encargado", "TEN"]])).correo);
  await page.goto(ruta);
  await expect(page.getByTestId("correcciones")).toContainText(`Nombre: ${anterior} → ${actual}`);
  await expect(page.getByTestId("correcciones")).toContainText("Motivo reservado de prueba");
});

test("el formulario indica que el motivo no debe incluir teléfonos completos", async ({ page }) => {
  const v = await expediente("TEN");
  await entrar(page, (await crearCuenta([["encargado", "TEN"]])).correo);
  await page.goto(`/sucursales/TEN/visitantes/${v.id}/corregir`);
  await expect(page.locator("#motivo-ayuda")).toContainText("sin escribir teléfonos completos");
  await expect(page.getByLabel("Motivo de la corrección")).toHaveAttribute("aria-describedby", "motivo-ayuda");
});

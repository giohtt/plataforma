import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/** Bloque 2: fusión manual de fichas duplicadas. Solo datos ficticios; cada prueba crea sus fichas. */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar fusiones 2026";

async function crearCuenta(asignaciones: [string, string][], general = false) {
  const correo = `fus-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${"Cuenta " + correo.slice(4, 12)}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  for (const [rol, codigo] of asignaciones) {
    await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
              select ${u.id}, ${rol}, id, 'Prueba de fusión' from sucursal where codigo = ${codigo}`;
  }
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, 'direccion', 'Prueba de fusión')`;
  return correo;
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

const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxyz"[Math.floor(Math.random() * 21)]).join("");
const nombreUnico = () => `${letras(8)} ${letras(8)} ${letras(8)}`;
const telefonoUnico = () => `000${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
async function ficha(codigo: string, datos: { nombre?: string; telefono?: string | null; estado?: string | null } = {}) {
  const nombre = datos.nombre ?? nombreUnico();
  const [v] = await sql<{ id: string }[]>`
    insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id)
    select ${nombre}, ${datos.telefono ?? null}, ${datos.estado ?? null}, id from sucursal where codigo = ${codigo} returning id`;
  return { id: v.id, nombre };
}
const unidaA = async (id: string) => (await sql`select fusionado_en_id from visitante where id = ${id}`)[0].fusionado_en_id as string | null;
const lista = (page: Page) => page.waitForLoadState("networkidle");

/** Abre la fusión desde la ficha `desde`, busca por `texto` y compara con la ficha `con`. */
async function compararDesde(page: Page, codigo: string, desde: string, texto: string, con: string) {
  await page.goto(`/sucursales/${codigo}/visitantes/${desde}/fusionar`);
  await lista(page);
  await page.getByLabel(/Buscar la ficha duplicada/).fill(texto);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByTestId("candidatas")).toBeVisible();
  await expect(page.getByTestId("candidata")).not.toHaveCount(0);
  await page.locator(`[data-testid=candidata]:has(input[name=b][value="${con}"])`).getByRole("button", { name: "Comparar con esta ficha" }).click();
}

test("caso permitido: Dirección de Tenango une dos fichas de la misma persona con vista previa y motivo", async ({ page }) => {
  const telefono = telefonoUnico();
  const a = await ficha("TEN", { telefono, estado: "Estado de México" });
  const b = await ficha("TEN", { telefono, estado: null });
  await entrar(page, await crearCuenta([["direccion", "TEN"]]));

  await page.goto(`/sucursales/TEN/visitantes/${a.id}`);
  await page.getByTestId("fusionar-visitante").click();
  await lista(page);
  await page.getByLabel(/Buscar la ficha duplicada/).fill(telefono);
  await page.getByRole("button", { name: "Buscar" }).click();
  // La ficha de partida no aparece como candidata.
  await expect(page.getByTestId("candidata")).toHaveCount(1);
  await page.getByRole("button", { name: "Comparar con esta ficha" }).click();

  const comparacion = page.getByTestId("comparacion");
  await expect(comparacion).toContainText(`•• •••• ${telefono.slice(-4)}`);
  await expect(page.getByTestId("aviso-irreversible")).toHaveText("La fusión no se puede deshacer desde la pantalla.");
  // El número completo solo está en el buscador, donde Dirección lo escribió; no en la comparación ni en el texto visible.
  expect(await comparacion.innerHTML()).not.toContain(telefono);
  expect(await page.locator("body").innerText()).not.toContain(telefono);

  // Queda activa la ficha 2, con el nombre y la procedencia de la ficha 1.
  await page.getByTestId("ficha-b").click();
  await page.getByLabel("Nombre: usar el de la Ficha 1").check();
  await page.getByLabel("Estado de procedencia: usar el de la Ficha 1").check();
  const previa = page.getByTestId("vista-previa");
  await expect(previa).toContainText(a.nombre);
  await expect(previa).toContainText("Estado de México");
  await expect(previa).toContainText("Ficha 2, creada en Tenango");

  // Sin motivo ni casilla no se une.
  await page.getByRole("button", { name: "Unir fichas" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toContainText("no se puede deshacer");
  await page.getByLabel("Motivo de la fusión").fill("Se registró dos veces por error");
  await page.getByRole("button", { name: "Unir fichas" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toContainText("no se puede deshacer");
  expect(await unidaA(a.id)).toBeNull();

  await page.getByLabel(/Entiendo que la fusión no se puede deshacer/).check();
  await page.getByRole("button", { name: "Unir fichas" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Fichas unidas. Esta es la ficha activa.");
  await expect(page).toHaveURL(new RegExp(`/visitantes/${b.id}\\?aviso=fusionado$`));
  await expect(page.getByTestId("nombre-visitante")).toHaveText(a.nombre);
  await expect(page.getByTestId("fusiones")).toContainText("Motivo: Se registró dos veces por error");
  expect(await page.content()).not.toContain(telefono);
  expect(await unidaA(a.id)).toBe(b.id);

  // El enlace anterior lleva a la ficha activa.
  await page.goto(`/sucursales/TEN/visitantes/${a.id}`);
  await expect(page).toHaveURL(new RegExp(`/visitantes/${b.id}\\?aviso=unida$`));
  await expect(page.locator("p.aviso[role=status]")).toHaveText("La ficha que abriste se unió a esta. Esta es la ficha activa.");
});

test("caso bloqueado: dos personas que comparten teléfono y ya se confirmaron como distintas", async ({ page }) => {
  const telefono = telefonoUnico();
  const x = await ficha("TEN", { telefono });
  const y = await ficha("TEN", { telefono });
  await sql`insert into visitante_distinto (visitante_id, distinto_de_id, motivo) values (${y.id}, ${x.id}, 'Confirmado por Recepción')`;
  await entrar(page, await crearCuenta([], true));

  await compararDesde(page, "TEN", x.id, telefono, y.id);
  const bloqueo = page.getByTestId("fusion-bloqueada");
  await expect(bloqueo).toContainText("ya se confirmó que son personas distintas");
  await expect(bloqueo).toContainText("Compartir nombre o teléfono por sí solo no demuestra que sean la misma persona");
  await expect(page.getByTestId("comparacion")).toHaveCount(0);
  expect(await unidaA(x.id)).toBeNull();
  expect(await unidaA(y.id)).toBeNull();
});

test("fichas de sucursales distintas: Dirección de una sola sucursal no puede; con permiso en ambas, sí", async ({ page }) => {
  const telefono = telefonoUnico();
  const deTen = await ficha("TEN", { telefono });
  const deStg = await ficha("STG", { telefono });

  await entrar(page, await crearCuenta([["direccion", "TEN"]]));
  await compararDesde(page, "TEN", deTen.id, telefono, deStg.id);
  await expect(page.getByTestId("fusion-bloqueada")).toContainText("permiso de fusión en la sucursal donde se creó cada una");

  await entrar(page, await crearCuenta([["direccion", "TEN"], ["direccion", "STG"]]));
  await compararDesde(page, "TEN", deTen.id, telefono, deStg.id);
  await expect(page.getByTestId("comparacion")).toBeVisible();
});

test("Encargado, Recepción y Administración no tienen la opción; Dirección de Tenango no la tiene en fichas de Santiago", async ({ page }) => {
  const deTen = await ficha("TEN");
  const deStg = await ficha("STG");
  for (const rol of ["encargado", "recepcion", "administracion"]) {
    await entrar(page, await crearCuenta([[rol, "TEN"]]));
    await page.goto(`/sucursales/TEN/visitantes/${deTen.id}`);
    await expect(page.getByTestId("expediente"), rol).toBeVisible();
    await expect(page.getByTestId("fusionar-visitante"), rol).toHaveCount(0);
    expect((await page.goto(`/sucursales/TEN/visitantes/${deTen.id}/fusionar`))?.status(), rol).toBe(404);
  }
  await entrar(page, await crearCuenta([["direccion", "TEN"]]));
  await page.goto(`/sucursales/TEN/visitantes/${deStg.id}`);
  await expect(page.getByTestId("fusionar-visitante")).toHaveCount(0);
  expect((await page.goto(`/sucursales/TEN/visitantes/${deStg.id}/fusionar`))?.status()).toBe(404);
});

test("envío directo: la comparación abierta por Dirección no se puede confirmar con la sesión de Encargado", async ({ page, browser }) => {
  const telefono = telefonoUnico();
  const a = await ficha("TEN", { telefono });
  const b = await ficha("TEN", { telefono });
  await entrar(page, await crearCuenta([["direccion", "TEN"]]));
  await compararDesde(page, "TEN", a.id, telefono, b.id);
  await expect(page.getByTestId("comparacion")).toBeVisible();

  await usarSesionDe(browser, page, await crearCuenta([["encargado", "TEN"]]));
  await page.getByLabel("Motivo de la fusión").fill("Intento sin permiso");
  await page.getByLabel(/Entiendo que la fusión no se puede deshacer/).check();
  await page.getByRole("button", { name: "Unir fichas" }).click();
  await expect(page.getByTestId("fusion-bloqueada")).toContainText("permiso de fusión");
  expect(await unidaA(a.id)).toBeNull();
  expect(await unidaA(b.id)).toBeNull();
});

test("un enlace a una ficha unida solo lleva a la activa si se tiene permiso para consultarla", async ({ page }) => {
  const a = await ficha("TEN");
  const b = await ficha("TEN");
  await sql`update visitante set fusionado_en = now(), fusionado_en_id = ${b.id} where id = ${a.id}`;
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto(`/sucursales/TEN/visitantes/${a.id}`);
  await expect(page).toHaveURL(new RegExp(`/visitantes/${b.id}\\?aviso=unida$`));
  // Una cuenta sin permiso de consulta en la sucursal no llega a ninguna de las dos.
  await entrar(page, await crearCuenta([]));
  expect((await page.goto(`/sucursales/TEN/visitantes/${a.id}`))?.status()).toBe(404);
  await expect(page).toHaveURL(new RegExp(`/visitantes/${a.id}$`));
});

test("dos fusiones seguidas, A con B y B con C: el enlace de A lleva a C y el historial de C muestra las dos", async ({ page }) => {
  const telefono = telefonoUnico();
  const a = await ficha("TEN", { telefono });
  const b = await ficha("TEN", { telefono });
  const c = await ficha("TEN", { telefono });
  await entrar(page, await crearCuenta([["direccion", "TEN"]]));

  const unir = async (desde: string, con: string, motivo: string) => {
    await compararDesde(page, "TEN", desde, telefono, con);
    await page.getByTestId("ficha-b").click(); // queda activa la ficha con la que se compara
    await page.getByLabel("Motivo de la fusión").fill(motivo);
    await page.getByLabel(/Entiendo que la fusión no se puede deshacer/).check();
    await page.getByRole("button", { name: "Unir fichas" }).click();
    await expect(page.locator("p.aviso[role=status]")).toHaveText("Fichas unidas. Esta es la ficha activa.");
    await expect(page).toHaveURL(new RegExp(`/visitantes/${con}\\?aviso=fusionado$`));
  };
  await unir(a.id, b.id, "A y B son la misma persona");
  // Al buscar desde B ya no aparece A: solo C.
  await page.goto(`/sucursales/TEN/visitantes/${b.id}/fusionar`);
  await lista(page);
  await page.getByLabel(/Buscar la ficha duplicada/).fill(telefono);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByTestId("candidata")).toHaveCount(1);
  await unir(b.id, c.id, "B y C son la misma persona");

  // Historial autorizado de C: las dos fusiones, con teléfonos enmascarados.
  const fusiones = page.getByTestId("fusiones");
  await expect(fusiones.locator("ol > li")).toHaveCount(2);
  await expect(fusiones).toContainText("Motivo: B y C son la misma persona");
  await expect(fusiones).toContainText("Motivo: A y B son la misma persona");
  await expect(fusiones).toContainText(`Unida a «${b.nombre}», que después se unió a esta`);
  await expect(fusiones).toContainText(`•• •••• ${telefono.slice(-4)}`);
  expect(await page.content()).not.toContain(telefono);

  // El enlace de A lleva a C con permiso de consulta (Recepción de Tenango), sin mostrarle el historial.
  await entrar(page, await crearCuenta([["recepcion", "TEN"]]));
  await page.goto(`/sucursales/TEN/visitantes/${a.id}`);
  await expect(page).toHaveURL(new RegExp(`/visitantes/${c.id}\\?aviso=unida$`));
  await expect(page.getByTestId("fusiones")).toHaveCount(0);
  // Sin permiso de consulta, ni A ni C.
  await entrar(page, await crearCuenta([]));
  expect((await page.goto(`/sucursales/TEN/visitantes/${a.id}`))?.status()).toBe(404);
});

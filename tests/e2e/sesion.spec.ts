import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { generarToken, huellaToken } from "../../src/lib/tokens";

/**
 * Recorridos reales en el navegador contra la aplicación compilada y una base de pruebas.
 * Cada prueba crea su propio usuario ficticio para no interferir con las demás.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase de prueba para el navegador 2026";

async function crearUsuario(contrasena?: string) {
  const correo = `e2e-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const nombre = `Usuario E2E ${correo.slice(4, 12)}`;
  const hash = contrasena ? await cifrarContrasena(contrasena) : null;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${hash}) returning id`;
  return { id: u.id, correo, nombre };
}

async function iniciarSesion(page: Page, correo: string, contrasena: string) {
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(contrasena);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

test("sin sesión, la plataforma manda a iniciar sesión", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/iniciar-sesion$/);
  await expect(page.getByRole("heading", { name: "Iniciar sesión" })).toBeVisible();
});

test("una cookie de sesión inventada no da acceso", async ({ page, context, baseURL }) => {
  await context.addCookies([
    {
      name: "__Host-fl_sesion",
      value: generarToken(),
      domain: new URL(baseURL!).hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/");
  await expect(page).toHaveURL(/\/iniciar-sesion$/);
});

test("primera vez: pide enlace, fija su contraseña, entra y cierra sesión", async ({ page, context }) => {
  const u = await crearUsuario();

  // 1. Solicita el enlace.
  await page.goto("/iniciar-sesion");
  await page.getByRole("link", { name: "Solicita un enlace" }).click();
  await page.getByLabel("Correo de tu cuenta").fill(u.correo);
  await page.getByRole("button", { name: "Solicitar enlace" }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("se generó un enlace");

  // 2. Lo abre desde el buzón de pruebas.
  await page.goto("/pruebas/buzon");
  const mensaje = page.locator(`li[data-para="${u.correo}"]`).first();
  await expect(mensaje).toContainText("Establece tu contraseña");
  const enlace = await mensaje.getByRole("link", { name: "Abrir enlace" }).getAttribute("href");
  await page.goto(enlace!);

  // 3. Una contraseña corta se rechaza; la buena se guarda.
  await page.getByLabel("Nueva contraseña").fill("corta");
  await page.getByLabel("Escríbela otra vez").fill("corta");
  await page.getByLabel("Nueva contraseña").evaluate((e: HTMLInputElement) => e.removeAttribute("minlength"));
  await page.getByLabel("Escríbela otra vez").evaluate((e: HTMLInputElement) => e.removeAttribute("minlength"));
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toContainText("12 caracteres");

  await page.getByLabel("Nueva contraseña").fill(CLAVE);
  await page.getByLabel("Escríbela otra vez").fill(CLAVE);
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  await expect(page).toHaveURL(/\/iniciar-sesion\?contrasena=lista$/);
  await expect(page.locator("p.aviso[role=status]")).toContainText("Contraseña guardada");

  // 4. El mismo enlace ya no sirve.
  await page.goto(enlace!);
  await expect(page.locator("[data-estado-enlace]")).toHaveAttribute("data-estado-enlace", "usado");

  // 5. Inicia sesión y ve su nombre.
  await iniciarSesion(page, u.correo, CLAVE);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("usuario-sesion")).toHaveText(u.nombre);

  // La cookie no es legible desde JavaScript y solo viaja por conexión segura.
  const cookie = (await context.cookies()).find((c) => c.name === "__Host-fl_sesion");
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });

  // 6. Cierra sesión: ya no entra, ni siquiera reponiendo la cookie anterior.
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/iniciar-sesion\?sesion=cerrada$/);
  await context.addCookies([cookie!]);
  await page.goto("/");
  await expect(page).toHaveURL(/\/iniciar-sesion$/);
});

test("contraseña incorrecta: mensaje genérico y sin sesión", async ({ page }) => {
  const u = await crearUsuario(CLAVE);
  await iniciarSesion(page, u.correo, "esta no es la contraseña 1");
  await expect(page.locator("p.aviso[role=alert]")).toHaveText("Correo o contraseña incorrectos.");
  await page.goto("/");
  await expect(page).toHaveURL(/\/iniciar-sesion$/);
});

test("un enlace vencido no permite fijar contraseña", async ({ page }) => {
  const u = await crearUsuario();
  const token = generarToken();
  await sql`
    insert into enlace_recuperacion (token_hash, usuario_id, creado_en, expira_en)
    values (${huellaToken(token)}, ${u.id}, now() - interval '2 hours', now() - interval '1 hour')`;
  await page.goto(`/recuperar/${token}`);
  await expect(page.locator("[data-estado-enlace]")).toHaveAttribute("data-estado-enlace", "vencido");
  await expect(page.getByLabel("Nueva contraseña")).toHaveCount(0);
});

test("pedir enlace para un correo inexistente da la misma respuesta y no deja mensaje", async ({ page }) => {
  const correo = `nadie-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  await page.goto("/recuperar");
  await page.getByLabel("Correo de tu cuenta").fill(correo);
  await page.getByRole("button", { name: "Solicitar enlace" }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("Si el correo pertenece a una cuenta activa");
  const [{ n }] = await sql`select count(*)::int as n from buzon_prueba where para = ${correo}`;
  expect(n).toBe(0);
});

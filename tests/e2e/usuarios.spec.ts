import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Sección «Usuarios, roles y permisos» (19 nov 2026, 16:22), con datos ficticios: crear e invitar, dar perfil y quitar un
 * permiso con vista previa, autorización para revisar lo propio e historial. Los permisos se comprueban en el servidor.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar los usuarios 2026";
const id = () => randomUUID().slice(0, 8);

async function cuenta(nombre: string) {
  const correo = `usuarios-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  return { id: u.id, correo, nombre };
}
async function escenario() {
  const codigo = `U${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Usuarios " + codigo}, ${codigo}) returning id`;
  const dir = await cuenta(`Dirección ${id()}`);
  await sql`insert into alcance_general (usuario_id, rol, motivo) values (${dir.id}, 'direccion', 'Prueba de usuarios')`;
  const recepcion = await cuenta(`Recepción ${id()}`);
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${recepcion.id}, 'recepcion', ${s.id}, 'Prueba de usuarios')`;
  return { codigo, sucursal: "Usuarios " + codigo, dir, recepcion };
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

test("crear e invitar, dar un perfil y quitar un permiso con vista previa; revisar lo propio por 90 días; historial", async ({ page }) => {
  // Recorrido largo (también otorga la autorización para resolver lo propio): en GitHub, en celular, pasaba de 30 s.
  test.setTimeout(90_000);
  const e = await escenario();

  // Recepción no entra a la sección (el servidor responde «No encontrada»).
  await entrar(page, e.recepcion.correo);
  await expect(page.getByTestId("ir-usuarios")).toHaveCount(0);
  await page.goto("/usuarios");
  await expect(page.getByTestId("no-encontrada")).toBeVisible();

  await entrar(page, e.dir.correo);
  await page.getByTestId("ir-usuarios").click();
  await expect(page.getByRole("heading", { name: "Usuarios, roles y permisos" })).toBeVisible();
  await page.getByTestId("nueva-persona").click();
  const correo = `nueva-${id()}@prueba.fitnessland.invalid`;
  await page.getByLabel("Nombre").fill("Nueva recepcionista (prueba)");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Puesto (opcional)").fill("Recepcionista matutina");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await expect(page.getByRole("status")).toContainText("Cuenta creada sin perfiles ni contraseña");
  await expect(page.getByTestId("puesto")).toHaveText("Recepcionista matutina");

  // Dar Recepción en una sucursal: nada viene marcado y se revisa antes de guardar.
  await page.getByTestId("abrir-dar_perfil").click();
  const f = page.getByTestId("formulario-dar_perfil");
  await f.getByLabel("Perfil").selectOption({ label: "Recepción" });
  await expect(f.getByLabel(/^Todas las sucursales/)).not.toBeChecked();
  await f.getByLabel("Elegir sucursales (una o varias)").check();
  await f.getByLabel(e.sucursal, { exact: true }).check();
  await f.getByLabel("Motivo").fill("Contratación como recepcionista matutina");
  await f.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await expect(f.getByTestId("vista-previa")).toContainText(`Sucursales: Ninguna → ${e.sucursal}`);
  await expect(f.getByTestId("gana")).toContainText("Registrar visitas y cobros");
  await expect(f.getByTestId("vista-previa")).toContainText("«Todas» incluye las sucursales que se abran después.");
  await capturar(page, "usuarios-vista-previa");
  await f.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(page.getByRole("status")).toContainText("Cambio guardado");
  await expect(page.getByTestId(`perfil-recepcion-${e.sucursal}`)).toBeVisible();
  await expect(page.getByTestId("puede-caja.retirar")).toBeVisible();

  // Quitar un permiso que viene en su perfil: la restricción prevalece.
  await page.getByTestId("abrir-restringir").click();
  const r = page.getByTestId("formulario-restringir");
  await r.getByLabel("Permiso").selectOption({ label: "Registrar · Registrar retiros de efectivo" });
  await r.getByLabel("Elegir sucursales (una o varias)").check();
  await r.getByLabel(e.sucursal, { exact: true }).check();
  await r.getByLabel("Motivo").fill("Sin retiros mientras se capacita");
  await r.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await expect(r.getByTestId("pierde")).toContainText("Registrar retiros de efectivo");
  // Si cambia algo después de revisar, hay que volver a revisar.
  await r.getByLabel("Motivo").fill("Sin retiros mientras se capacita (2 semanas)");
  await expect(r.getByRole("button", { name: "Confirmar y guardar" })).toHaveCount(0);
  await r.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await r.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(page.getByTestId("restriccion-caja.retirar")).toContainText("No puede: Registrar retiros de efectivo");
  await expect(page.getByTestId("puede-caja.retirar")).toHaveCount(0);
  await expect(page.getByTestId("puede-visita.registrar")).toBeVisible();

  // Invitación de 48 horas; generar otra invalida la anterior.
  await page.getByRole("button", { name: "Generar invitación" }).click();
  const enlace1 = (await page.getByTestId("enlace-invitacion").textContent())!;
  await page.getByRole("button", { name: "Generar otra invitación" }).click();
  await expect(page.getByTestId("enlace-invitacion")).not.toHaveText(enlace1);
  const enlace2 = (await page.getByTestId("enlace-invitacion").textContent())!;
  await capturar(page, "usuarios-ficha");
  await page.context().clearCookies();
  await page.goto(enlace1.replace(/^https?:\/\/[^/]+/, ""));
  await expect(page.getByText("Este enlace fue reemplazado por uno más reciente.")).toBeVisible();
  await page.goto(enlace2.replace(/^https?:\/\/[^/]+/, ""));
  await expect(page.getByText("Este enlace fue reemplazado")).toHaveCount(0);

  // Su propia cuenta: autorización para revisar lo propio, máximo 90 días.
  await entrar(page, e.dir.correo);
  await page.goto(`/usuarios/${e.dir.id}`);
  await page.getByTestId("abrir-autorrevision").click();
  const a = page.getByTestId("formulario-autorrevision");
  const max = await a.getByLabel("Hasta").getAttribute("max");
  expect(await a.getByLabel("Hasta").inputValue()).toBe(max);
  await a.getByLabel(/^Todas las sucursales/).check();
  await a.getByLabel("Motivo").fill("Aún no hay personal de Administración");
  await a.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await expect(a.getByTestId("vista-previa")).toContainText("cada revisión queda marcada «Revisada por quien participó»");
  await a.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(page.getByTestId("autorrevision-vigente")).toContainText("Autorizada en todas las sucursales");
  const [x] = await sql<{ dias: number }[]>`
    select extract(epoch from vigente_hasta - vigente_desde) / 86400 as dias from autorrevision where usuario_id = ${e.dir.id} and revocada_en is null`;
  expect(Number(x.dias)).toBeLessThanOrEqual(90);
  expect(Number(x.dias)).toBeGreaterThan(89);
  await capturar(page, "usuarios-mi-cuenta");
  // Aparte: autorización para resolver lo propio, también a sí misma, con vista previa.
  const r2 = page.getByTestId("autorresolucion");
  await r2.getByTestId("abrir-autorresolucion").click();
  const b = r2.getByTestId("formulario-autorresolucion");
  await b.getByLabel(/^Todas las sucursales/).check();
  await b.getByLabel("Motivo").fill("Aún no hay otra Dirección que resuelva");
  await b.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await expect(b.getByTestId("vista-previa")).toContainText("cada resolución queda marcada «Resuelta por quien participó»");
  await b.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(r2.getByTestId("autorresolucion-vigente")).toContainText("Autorizada en todas las sucursales");
  await expect(page.getByTestId("autorrevision-vigente")).toBeVisible();

  // Historial: quién, cuándo, a quién, qué y motivo.
  await page.goto("/usuarios?vista=historial");
  const h = page.getByTestId("historial-accesos");
  await expect(h).toContainText(`${e.dir.nombre} · Restringió un permiso · Nueva recepcionista (prueba)`);
  await expect(h).toContainText("Motivo: «Sin retiros mientras se capacita (2 semanas)»");
  await expect(h).toContainText("Autorizó revisar lo propio");
  await expect(h).toContainText("Autorizó resolver faltantes en los que participó");
  await page.goto("/usuarios?vista=perfiles");
  await expect(page.getByTestId("perfiles")).toContainText("Registrar retiros de efectivo");
});

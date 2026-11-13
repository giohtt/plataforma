import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 5: diferencias de efectivo (lista y desglose), con datos ficticios. Sucursal nueva con un turno
 * abierto: bolsa con $650 al abrir, sin cobros (esperado $650), y cajón con $1,200.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar las diferencias 2026";
const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxz"[Math.floor(Math.random() * 20)]).join("");

async function crearCuenta(rol: string, codigo: string, nombre: string) {
  const correo = `diferencias-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba de diferencias' from sucursal where codigo = ${codigo}`;
  return { id: u.id, correo, nombre };
}
async function escenario() {
  const codigo = `Y${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  await sql`insert into sucursal (nombre, codigo) values (${"Entrega " + codigo}, ${codigo})`;
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
            select ${t.id}, l.id, 'apertura', case l.tipo when 'bolsa_visitas' then 650 else 1200 end, ${laura.id}
            from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = ${codigo}`;
  return { codigo, laura, sofia, encargado, admin, dir, turnoId: t.id };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
async function entregar(page: Page, codigo: string, bolsa: string, cajon: string, a: string) {
  await page.goto(`/sucursales/${codigo}/turno`);
  await page.getByTestId("ir-entregar").click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("entrega-esperado")).toHaveText("$650.00");
  await page.locator("#bolsa").fill(bolsa);
  await page.locator("#cajon").fill(cajon);
  await page.getByLabel("Quién recibe").selectOption({ label: a });
  await page.getByTestId("apoyo").getByRole("radio", { name: "No, nadie más participó" }).check();
  await page.getByRole("button", { name: "Entregar el turno" }).click();
  await expect(page.getByTestId("estado-entrega")).toContainText(`Entrega pendiente de confirmar por ${a}`);
}
async function recibir(page: Page, codigo: string, bolsa: string, cajon: string, aclaracion?: string) {
  if (!aclaracion) {
    await page.goto(`/sucursales/${codigo}/turno`);
    await page.getByTestId("ir-recibir").click();
  }
  await page.waitForLoadState("networkidle");
  await page.locator("#bolsa").fill(bolsa);
  await page.locator("#cajon").fill(cajon);
  if (aclaracion) await page.locator("#aclaracion").fill(aclaracion);
  await page.getByTestId("apoyo").getByRole("radio", { name: "No, nadie más participó" }).check();
  await page.getByRole("button", { name: aclaracion ? "Confirmar tras recontar" : "Confirmar lo que recibo" }).click();
}


/** En computadora, las tablas se leen completas sin deslizar; en celular se puede deslizar si hace falta. */
async function tablasSinDeslizar(page: Page) {
  if (test.info().project.name !== "escritorio") return;
  for (const t of await page.locator(".tabla-desplazable").all()) {
    expect(await t.evaluate((x) => x.scrollWidth <= x.clientWidth + 1)).toBe(true);
  }
}

test("Encargado consulta el caso: esperado, entregado y recibido por separado, y el desglose del esperado", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.laura.correo);
  await entregar(page, e.codigo, "600", "1200", e.sofia.nombre);
  await entrar(page, e.sofia.correo);
  await recibir(page, e.codigo, "600", "1200");
  await expect(page.locator("p.aviso[role=status]")).toContainText("Turno recibido");
  // Recepción no ve las diferencias.
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("diferencias")).toHaveCount(0);

  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("diferencias")).toHaveText("Diferencias de efectivo (1)");
  await page.getByTestId("diferencias").click();
  const caso = page.getByTestId("caso-diferencia").first();
  await expect(caso).toContainText("−$50.00 · Faltante contra el esperado");
  await expect(caso.getByTestId("estado-caso")).toHaveText("1 por revisar");
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/lista-${test.info().project.name}.png`, fullPage: true });
  await caso.getByTestId("ver-caso").click();
  const bolsa = page.getByTestId("caso-bolsa_visitas");
  await expect(bolsa.getByTestId("cifra-esperado")).toHaveText("$650.00");
  await expect(bolsa.getByTestId("cifra-entregado")).toHaveText("$600.00");
  await expect(bolsa.getByTestId("cifra-recibido")).toHaveText("$600.00");
  await expect(bolsa.getByTestId("cifra-entre-personas")).toHaveText("$0.00");
  await expect(bolsa.getByTestId("cifra-contra-esperado")).toContainText("−$50.00");
  await expect(bolsa.getByTestId("cifra-contra-esperado")).toContainText("Faltante contra el esperado · Por revisar");
  await expect(page.getByTestId("caso-cajon_mensualidades").getByTestId("cifra-contra-esperado")).toContainText("No se puede calcular");
  await expect(page.getByTestId("desglose-total")).toHaveText("$650.00");
  await expect(page.getByTestId("desglose-no-coincide")).toHaveCount(0);
  await expect(page.getByTestId("participaste")).toHaveCount(0);
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/detalle-${test.info().project.name}.png`, fullPage: true });
});

test("Encargado registra «Aclarada» con motivo: queda en el historial y los importes no cambian", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.laura.correo);
  await entregar(page, e.codigo, "600", "1200", e.sofia.nombre);
  await entrar(page, e.sofia.correo);
  await recibir(page, e.codigo, "600", "1200");

  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  await page.getByTestId("ver-caso").first().click();
  await page.waitForLoadState("networkidle");
  const dif = page.getByTestId("diferencia");
  await expect(dif).toHaveCount(1);
  await expect(dif.getByTestId("estado-diferencia")).toHaveText("Por revisar");
  // Sin motivo no se registra.
  await dif.getByRole("radio", { name: /Aclarada/ }).check();
  await dif.getByRole("button", { name: "Registrar revisión" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toHaveText("Revisa los campos marcados.");
  await page.getByTestId("diferencia").getByRole("radio", { name: /Aclarada/ }).check();
  await page.getByTestId("diferencia").getByLabel("Motivo (obligatorio)").fill("Diferencia simulada a propósito en la prueba del 11 de noviembre");
  await page.getByTestId("diferencia").getByRole("button", { name: "Registrar revisión" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Revisión registrada. Los importes no cambiaron.");
  await expect(page.getByTestId("diferencia").getByTestId("estado-diferencia")).toHaveText("Aclarada");
  await expect(page.getByTestId("revision")).toContainText(`Revisó ${e.encargado.nombre} (Encargado)`);
  await expect(page.getByTestId("revision")).toContainText("Diferencia simulada a propósito en la prueba del 11 de noviembre");
  await expect(page.getByTestId("evento-caso").last()).toContainText("Aclarada");
  await expect(page.getByTestId("evento-caso").last()).toContainText(e.encargado.nombre);
  await expect(page.getByTestId("caso-bolsa_visitas").getByTestId("cifra-esperado")).toHaveText("$650.00");
  await expect(page.getByTestId("caso-bolsa_visitas").getByTestId("cifra-recibido")).toHaveText("$600.00");
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/revisada-${test.info().project.name}.png`, fullPage: true });
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("diferencias")).toHaveText("Diferencias de efectivo");

  // En el turno de quien recibió se ve el resultado y el saldo de apertura sigue igual.
  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("recibida-bolsa_visitas").getByTestId("dif-esperado")).toHaveText("−$50.00 · Aclarada");
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("contado-al-abrir")).toHaveText("$600.00");
});

test("apoyo en el recuento: la Encargada declarada confirma desde su cuenta, no revisa y el caso pasa a Administración", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.laura.correo);
  await entregar(page, e.codigo, "650", "1200", e.sofia.nombre);
  // La entrante cuenta $600: no coincide y recuentan con ayuda de la Encargada.
  await entrar(page, e.sofia.correo);
  await recibir(page, e.codigo, "600", "1200");
  await expect(page.getByTestId("aviso-recuento")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.locator("#bolsa").fill("600");
  await page.locator("#cajon").fill("1200");
  await page.locator("#aclaracion").fill("Recontamos con la Encargada; siguen faltando $50");
  await page.getByTestId("apoyo").getByRole("radio", { name: "Sí, me ayudaron" }).check();
  await page.getByTestId("personas-apoyo").getByRole("checkbox", { name: e.encargado.nombre }).check();
  await page.getByRole("button", { name: "Confirmar tras recontar" }).click();
  // La entrega se completa aunque el apoyo siga pendiente; el turno abre con lo confirmado.
  await expect(page.locator("p.aviso[role=status]")).toContainText("Turno recibido");
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("contado-al-abrir")).toHaveText("$600.00");

  // Antes de confirmar: la Encargada ve el caso como participante y no puede revisarlo.
  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  await page.getByTestId("ver-caso").first().click();
  await expect(page.getByTestId("participaste")).toBeVisible();
  await expect(page.getByTestId("nivel-revision")).toContainText("Administración");
  await expect(page.getByTestId("apoyo-recuento")).toContainText(`${e.encargado.nombre} (pendiente de confirmar) · lo declaró ${e.sofia.nombre}`);
  await expect(page.getByTestId("formulario-revision")).toHaveCount(0);
  // Confirma su participación desde su cuenta.
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("apoyos-pendientes").click();
  await expect(page.getByTestId("apoyo-pendiente")).toContainText(`${e.sofia.nombre} declaró que participaste en el recuento`);
  expect(await page.getByTestId("apoyo-pendiente").innerText()).not.toMatch(/m\.\./);
  await page.getByRole("button", { name: "Confirmo que participé" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Participación confirmada.");
  await expect(page.getByTestId("sin-apoyos")).toBeVisible();
  // Después de confirmar: sigue sin poder revisar.
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  await page.getByTestId("ver-caso").first().click();
  await expect(page.getByTestId("apoyo-recuento")).toContainText("confirmó");
  await expect(page.getByTestId("formulario-revision")).toHaveCount(0);

  // Administración sí revisa.
  await entrar(page, e.admin.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  await page.getByTestId("ver-caso").first().click();
  await page.waitForLoadState("networkidle");
  const dif = page.getByTestId("diferencia");
  await expect(dif).toHaveCount(1);
  const circulo = await dif.getByRole("radio", { name: /Aclarada/ }).boundingBox();
  const texto = await dif.locator(".opcion-revision strong").first().boundingBox();
  expect(circulo!.width).toBeLessThan(30);
  expect(texto!.x - (circulo!.x + circulo!.width)).toBeLessThan(40);
  await dif.getByRole("radio", { name: /Aclarada/ }).check();
  await dif.getByLabel("Motivo (obligatorio)").fill("Se recontó con la Encargada; diferencia simulada en la prueba");
  await dif.getByRole("button", { name: "Registrar revisión" }).click();
  await expect(page.getByTestId("revision")).toContainText(`Revisó ${e.admin.nombre} (Administración)`);
  await expect(page.getByTestId("historial-caso")).toContainText(`Apoyo declarado en el recuento: ${e.encargado.nombre}`);
  await expect(page.getByTestId("historial-caso")).toContainText("Apoyo confirmado en el recuento");
  // Aclarada: color neutro; tablas completas en computadora; el círculo de cada opción junto a su texto.
  await expect(page.getByTestId("caso-bolsa_visitas").getByTestId("tarjeta-entre-personas")).toHaveClass(/cifra-aclarada/);
  await expect(page.getByTestId("desglose-total")).toBeVisible();
  await tablasSinDeslizar(page);
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/apoyo-${test.info().project.name}.png`, fullPage: true });
});

test("Dirección resuelve un faltante confirmado: tiempo pendiente, aviso de más de 48 horas, «Lo absorbe la sucursal» y cierre", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.laura.correo);
  await entregar(page, e.codigo, "600", "1200", e.sofia.nombre);
  await entrar(page, e.sofia.correo);
  await recibir(page, e.codigo, "600", "1200");

  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  await page.getByTestId("ver-caso").first().click();
  await page.waitForLoadState("networkidle");
  const dif = page.getByTestId("diferencia");
  await dif.getByRole("radio", { name: /Faltante confirmado/ }).check();
  await dif.getByLabel("Motivo (obligatorio)").fill("No apareció tras recontar dos veces");
  await dif.getByRole("button", { name: "Registrar revisión" }).click();
  await expect(page.getByTestId("estado-diferencia")).toHaveText("Faltante confirmado · pendiente para Dirección");
  await expect(page.getByTestId("formulario-resolucion")).toHaveCount(0);

  // Simula que el caso lleva 50 horas esperando a Dirección.
  await sql.begin(async (tx) => {
    await tx`alter table revision_diferencia disable trigger revision_diferencia_inmutable`;
    await tx`update revision_diferencia r set en = now() - interval '50 hours' from diferencia_efectivo d
             where d.id = r.diferencia_id and d.turno_id = ${e.turnoId}`;
    await tx`alter table revision_diferencia enable trigger revision_diferencia_inmutable`;
  });

  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("diferencias")).toHaveText("Diferencias de efectivo (1)");
  await page.getByTestId("diferencias").click();
  const caso = page.getByTestId("caso-diferencia").first();
  await expect(caso.getByTestId("para-direccion")).toHaveText("1 pendiente para Dirección");
  await expect(caso.getByTestId("tiempo-pendiente")).toHaveText("hace 2 días 2 h");
  await expect(caso.getByTestId("aviso-48")).toHaveText("Más de 48 horas pendiente");
  await caso.getByTestId("ver-caso").click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("aviso-48")).toBeVisible();
  const r = page.getByTestId("formulario-resolucion");
  await expect(r.getByRole("radio")).toHaveCount(1);
  await r.getByRole("button", { name: "Registrar decisión" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toHaveText("Revisa los campos marcados.");
  await page.getByTestId("formulario-resolucion").getByLabel("Motivo (obligatorio)").fill("Monto menor; se absorbe como pérdida de la sucursal");
  await page.getByTestId("formulario-resolucion").getByRole("button", { name: "Registrar decisión" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Decisión de Dirección registrada. Los importes no cambiaron.");
  await expect(page.getByTestId("estado-diferencia")).toHaveText("Resuelta por Dirección · cerrada");
  await expect(page.getByTestId("resolucion")).toContainText(`Decidió ${e.dir.nombre} (Dirección)`);
  await expect(page.getByTestId("resolucion")).toContainText("Lo absorbe la sucursal");
  await expect(page.getByTestId("aviso-48")).toHaveCount(0);
  await expect(page.getByTestId("historial-caso")).toContainText("Seguimiento cerrado");
  await expect(page.getByTestId("caso-bolsa_visitas").getByTestId("cifra-esperado")).toHaveText("$650.00");
  await expect(page.getByTestId("caso-bolsa_visitas").getByTestId("cifra-recibido")).toHaveText("$600.00");
  await tablasSinDeslizar(page);
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("diferencias")).toHaveText("Diferencias de efectivo");

  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("recibida-bolsa_visitas").getByTestId("dif-esperado")).toHaveText("−$50.00 · Resuelta por Dirección · cerrada");
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("contado-al-abrir")).toHaveText("$600.00");
});

test("sobrante con corrección pendiente: «Caso abierto desde hace…», aviso de 48 horas y una nota sola no cierra", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.laura.correo);
  await entregar(page, e.codigo, "700", "1200", e.sofia.nombre);
  await entrar(page, e.sofia.correo);
  await recibir(page, e.codigo, "700", "1200");

  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  await page.getByTestId("ver-caso").first().click();
  await page.waitForLoadState("networkidle");
  const dif = page.getByTestId("diferencia");
  await dif.getByRole("radio", { name: /Sobrante confirmado/ }).check();
  await dif.getByLabel("Motivo (obligatorio)").fill("Prueba ficticia: no se encontró el origen");
  await dif.getByRole("button", { name: "Registrar revisión" }).click();
  await expect(page.getByTestId("estado-diferencia")).toHaveText("Sobrante confirmado · pendiente para Dirección");

  // Simula que el sobrante se confirmó hace 50 horas.
  await sql.begin(async (tx) => {
    await tx`alter table revision_diferencia disable trigger revision_diferencia_inmutable`;
    await tx`update revision_diferencia r set en = now() - interval '50 hours' from diferencia_efectivo d
             where d.id = r.diferencia_id and d.turno_id = ${e.turnoId}`;
    await tx`alter table revision_diferencia enable trigger revision_diferencia_inmutable`;
  });

  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  await page.getByTestId("ver-caso").first().click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("tiempo-pendiente")).toHaveText(/^Pendiente para Dirección desde hace 2 días 2 h/);
  const r = page.getByTestId("formulario-resolucion");
  await r.getByRole("radio", { name: /Origen identificado/ }).check();
  await r.locator("textarea[name=origen]").fill("Prueba ficticia: visita cobrada sin registrar");
  await r.getByRole("radio", { name: /Sí: el caso sigue abierto/ }).check();
  await r.getByLabel("Motivo (obligatorio)").fill("Prueba ficticia: falta regularizar el cobro");
  await r.getByRole("button", { name: "Registrar decisión" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Decisión de Dirección registrada. Los importes no cambiaron.");
  await expect(page.getByTestId("estado-diferencia")).toHaveText("Resuelta por Dirección · corrección pendiente");
  // El tiempo sigue contando desde que se confirmó el sobrante, con el aviso de más de 48 horas.
  await expect(page.getByTestId("tiempo-pendiente")).toHaveText(/^Corrección pendiente · Caso abierto desde hace 2 días 2 h/);
  await expect(page.getByTestId("tiempo-pendiente")).not.toContainText("Pendiente para Dirección");
  await expect(page.getByTestId("aviso-48")).toHaveText("Más de 48 horas pendiente");

  // Una nota sola no cierra; tras recargar, el caso sigue igual y el historial no tiene cierre.
  const c = page.getByTestId("formulario-correccion");
  await c.getByLabel("Descripción de la corrección realizada").fill("Prueba ficticia: se regularizó el cobro");
  await c.getByRole("button", { name: "Registrar corrección y cerrar" }).click();
  await expect(page.locator("p.aviso[role=alert]")).toHaveText("Revisa los campos marcados.");
  await expect(page.getByTestId("formulario-correccion")).toContainText("Una nota sola no cierra el caso.");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("estado-diferencia")).toHaveText("Resuelta por Dirección · corrección pendiente");
  await expect(page.getByTestId("tiempo-pendiente")).toHaveText(/^Corrección pendiente · Caso abierto desde hace 2 días 2 h/);
  await expect(page.getByTestId("historial-caso")).not.toContainText("Seguimiento cerrado");
  await expect(page.getByTestId("historial-caso")).not.toContainText("se regularizó el cobro");
  await expect(page.getByTestId("caso-bolsa_visitas").getByTestId("cifra-esperado")).toHaveText("$650.00");
  await expect(page.getByTestId("caso-bolsa_visitas").getByTestId("cifra-recibido")).toHaveText("$700.00");
  await tablasSinDeslizar(page);

  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("lugar-bolsa_visitas").getByTestId("contado-al-abrir")).toHaveText("$700.00");
});

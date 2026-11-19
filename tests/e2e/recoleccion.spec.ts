import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 5, regla 7 (18 nov 2026), con datos ficticios: buzón de depósito con llave solo de Dirección (desde las 19:10) y,
 * para configuraciones anteriores, la caja con llave que custodian las recepcionistas. Sucursal nueva como Tenango: turno abierto con $900 en la bolsa y $3,400 en el cajón, sin fondo fijo.
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

test("buzón: sobres depositados al cerrar, apertura con solo los fondos, cambio de turno y Dirección recoge; un sobre que no está queda por investigar", async ({ page }) => {
  const e = await escenario();

  // Dirección configura el buzón: su llave solo puede ser de Dirección. Nadie viene marcada.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/custodia/configurar`);
  await expect(page.getByTestId("custodias").getByLabel(e.laura.nombre)).not.toBeChecked();
  await expect(page.getByTestId("llave-buzon").getByLabel(e.laura.nombre)).toHaveCount(0);
  await expect(page.getByTestId("llave-buzon").getByLabel(e.dir.nombre)).not.toBeChecked();
  await page.getByLabel("Dónde está el buzón de sobres").fill("Buzón de recepción, junto al mostrador");
  await page.getByTestId("llave-buzon").getByLabel(e.dir.nombre).check();
  await page.getByLabel("Dónde quedan los fondos fijos").fill("Cajón con llave de recepción");
  for (const p of [e.laura, e.sofia]) await page.getByTestId("acceso-cajon").getByLabel(p.nombre).check();
  // Sin custodias no se guarda.
  await page.getByRole("button", { name: "Guardar la custodia" }).click();
  await expect(page.getByText("Elige de 1 a 10 custodias con asignación en la sucursal.")).toBeVisible();
  for (const p of [e.laura, e.sofia]) await page.getByTestId("custodias").getByLabel(p.nombre).check();
  await capturar(page, "buzon-configurar");
  await page.getByRole("button", { name: "Guardar la custodia" }).click();
  await expect(page.getByTestId("historial-custodia")).toContainText(`llave del buzón: ${e.dir.nombre}`);
  await expect(page.getByTestId("historial-custodia")).toContainText("custodias de la llave del cajón");

  // Laura cierra: deposita cada sobre en el buzón y se queda con la llave del cajón. No verifica sobres ni caja.
  await entrar(page, e.laura.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/cierre`);
  await page.getByTestId("generar-folios").click();
  const bolsa = (await page.getByTestId("folio-bolsa").textContent())!;
  const cajon = (await page.getByTestId("folio-cajon").textContent())!;
  await page.getByTestId("cierre-bolsa").getByLabel("Total contado al cerrar").fill("900");
  await page.getByTestId("cierre-cajon").getByLabel("Total contado al cerrar").fill("3400");
  await page.getByLabel("Custodia que se queda con la llave del cajón").selectOption({ label: `Yo · ${e.laura.nombre} — cierro y me quedo con la llave del cajón` });
  await expect(page.getByTestId("custodia-misma-persona").getByTestId(/^verificar-/)).toHaveCount(0);
  await expect(page.getByTestId("llave-caja-sobres")).toHaveCount(0);
  await page.getByLabel(/^Sí: el cajón quedó cerrado/).check();
  await page.getByLabel("Dónde guardas la llave del cajón").fill("Llavero de recepción");
  await page.getByLabel("No, nadie más participó").check();
  // Sin confirmar el depósito de cada sobre no cierra.
  await page.getByTestId("depositar-bolsa_visitas").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Cerrar el turno: sobres en el buzón y me quedo la llave del cajón" }).click();
  await expect(page.getByText("Confirma que depositaste cada sobre en el buzón.")).toBeVisible();
  for (const l of ["bolsa_visitas", "cajon_mensualidades"]) await page.getByTestId(`depositar-${l}`).getByRole("checkbox").check();
  await page.getByLabel(/^Sí: el cajón quedó cerrado/).check();
  await page.getByLabel("No, nadie más participó").check();
  await capturar(page, "buzon-cierre");
  await page.getByRole("button", { name: "Cerrar el turno: sobres en el buzón y me quedo la llave del cajón" }).click();
  await expect(page.getByRole("heading", { name: "Turno cerrado · sobres en el buzón" })).toBeVisible();
  await expect(page.getByTestId("sobre-bolsa_visitas")).toContainText("registrado como depositado en el buzón");

  // Sofía abre: cuenta solo los fondos (aquí no hay fondo: $0) y recibe solo la llave del cajón.
  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/apertura`);
  await expect(page.getByTestId("buzon-info")).toContainText("2 sobres registrados como depositados");
  await expect(page.getByTestId("formulario-apertura-cierre").getByTestId(/^verificar-/)).toHaveCount(0);
  await expect(page.getByTestId("llave-caja-sobres")).toHaveCount(0);
  await page.getByLabel(/^Sí: el cajón quedó cerrado/).check();
  await page.getByTestId("apertura-bolsa").getByLabel(/^Efectivo que cuentas/).fill("0");
  await page.getByTestId("apertura-cajon").getByLabel(/^Efectivo que cuentas/).fill("0");
  await page.getByLabel("No, nadie más participó").check();
  await capturar(page, "buzon-apertura");
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Turno abierto desde el cierre. Desde ahora eres la responsable de la bolsa y del cajón.");
  await expect(page.getByTestId("resumen-caja")).toContainText("Buzón de sobres: 2 sobres registrados como depositados");

  // Cambio de turno: se cuenta todo el efectivo de cada lugar y pasa solo la llave del cajón.
  await page.getByTestId("ir-entregar").click();
  await page.waitForLoadState("networkidle");
  await page.locator("#bolsa").fill("0");
  await page.locator("#cajon").fill("0");
  await page.getByLabel("Quién recibe").selectOption({ label: e.laura.nombre });
  await page.getByTestId("apoyo").getByRole("radio", { name: "No, nadie más participó" }).check();
  await page.getByRole("button", { name: "Entregar el turno" }).click();
  await expect(page.getByTestId("estado-entrega")).toContainText(`Entrega pendiente de confirmar por ${e.laura.nombre}`);
  await entrar(page, e.laura.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/recibir`);
  await expect(page.getByTestId("caja-recepcion")).toContainText("Cuenta todo el efectivo de cada lugar");
  await expect(page.getByTestId("caja-recepcion").getByTestId("buzon-info")).toBeVisible();
  await expect(page.getByTestId(/^verificar-/)).toHaveCount(0);
  await page.getByLabel(/^Sí: el cajón quedó cerrado/).check();
  await page.locator("#bolsa").fill("0");
  await page.locator("#cajon").fill("0");
  await page.getByTestId("apoyo").getByRole("radio", { name: "No, nadie más participó" }).check();
  await capturar(page, "buzon-cambio-turno");
  await page.getByRole("button", { name: "Confirmar lo que recibo" }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("Turno recibido");
  // La recepcionista no abre el buzón.
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  await expect(page.getByTestId("solo-direccion")).toBeVisible();
  await expect(page.getByTestId("formulario-recoger-buzon")).toHaveCount(0);

  // Una semana después: el sobre de la bolsa lleva 9 días (aviso desde los 8).
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sobre_cierre set resuelto_en = resuelto_en - interval '9 days' where folio = ${bolsa}`;
  });

  // Dirección abre el buzón y cuenta a ciegas: faltan $50 en la bolsa y el sobre del cajón no está.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("sobres-por-recoger").click();
  await expect(page.getByTestId(`aviso-${bolsa}`)).toBeVisible();
  await expect(page.getByTestId("tabla-caja")).not.toContainText("900");
  await expect(page.getByTestId(`caja-${bolsa}`)).toContainText("Registrado como depositado");
  await page.getByLabel(/^El buzón estaba cerrado con llave/).check();
  await page.getByTestId(`verificar-${bolsa}`).getByLabel(/^Sí: cerrado/).check();
  await page.getByTestId(`verificar-${cajon}`).getByLabel("No está el sobre").check();
  await page.getByTestId(`verificar-${cajon}`).getByRole("textbox").fill("No estaba en el buzón al abrirlo");
  await page.getByLabel(`Sobre ${bolsa} · bolsa · contado`).fill("850");
  await capturar(page, "buzon-recoger");
  await page.getByRole("button", { name: "Confirmar lo que recojo del buzón" }).click();
  await expect(page.getByTestId("aviso-recogida")).toContainText("1 sobre queda por revisar");
  await expect(page.getByTestId("aviso-recogida")).toContainText("Un sobre no estaba en el buzón: queda por investigar, sin responsable asignado");
  await expect(page.getByTestId("saldo")).toContainText("$850.00");
  await expect(page.getByTestId(`investigar-${cajon}`).getByTestId("estado-investigacion")).toContainText("Por investigar · sin responsable asignado");
  await expect(page.getByTestId("recoleccion")).toContainText("No estaba: por investigar");
  // Depósito parcial.
  await page.getByLabel(/^Importe depositado/).fill("500");
  await page.getByLabel("Referencia del depósito (ficticia)").fill("DEP-FICTICIO-001");
  await page.getByRole("button", { name: "Registrar el depósito" }).click();
  await expect(page.getByTestId("depositado")).toHaveText("$500.00");
  await expect(page.getByTestId("saldo")).toContainText("$350.00");
  await capturar(page, "buzon-investigar");

  // Administración (no participó) revisa la diferencia con la cadena completa.
  await entrar(page, e.admin.correo);
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  const dif = page.getByTestId(`diferencia-${bolsa}`);
  await expect(dif).toContainText("−$50.00");
  await dif.getByText("Cadena de custodia").click();
  await expect(dif.getByTestId("cadena")).toContainText("Registró que lo depositó en el buzón");
  await expect(dif.getByTestId("cadena")).toContainText(e.dir.nombre);
  await dif.getByLabel("Faltante confirmado").check();
  await dif.getByLabel("Motivo").fill("Faltan $50 en el sobre de la bolsa");
  await dif.getByRole("button", { name: "Guardar la revisión" }).click();
  await expect(page.getByTestId(`diferencia-${bolsa}`).getByTestId("estado-diferencia")).toContainText("Faltante confirmado");
});

/** Configuración anterior al buzón (caja con llave): Dirección nombra custodias; Laura cierra y se queda con las llaves; Sofía abre. Devuelve los folios. */
async function cierreYApertura(page: Page, e: Awaited<ReturnType<typeof escenario>>) {
  const [s] = await sql<{ id: string }[]>`select id from sucursal where codigo = ${e.codigo}`;
  await sql`insert into custodia_configuracion (sucursal_id, lugar, acceso, configurada_por, lugar_fondos, acceso_cajon, custodias)
            values (${s.id}, 'Caja con llave de recepción', ${[e.laura.id, e.sofia.id]}::uuid[], ${e.dir.id}, 'Cajón con llave de recepción',
                    ${[e.laura.id, e.sofia.id]}::uuid[], ${[e.laura.id, e.sofia.id]}::uuid[])`;
  await entrar(page, e.laura.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/cierre`);
  await page.getByTestId("generar-folios").click();
  const bolsa = (await page.getByTestId("folio-bolsa").textContent())!;
  const cajon = (await page.getByTestId("folio-cajon").textContent())!;
  await page.getByTestId("cierre-bolsa").getByLabel("Total contado al cerrar").fill("900");
  await page.getByTestId("cierre-cajon").getByLabel("Total contado al cerrar").fill("3400");
  await page.getByLabel("Custodia que se queda con la llave").selectOption({ label: `Yo · ${e.laura.nombre} — cierro y me quedo con la llave` });
  for (const l of ["bolsa_visitas", "cajon_mensualidades"]) await page.getByTestId(`verificar-${l}`).getByLabel(/^Sí: cerrado/).check();
  await page.getByLabel("Sí: la caja de sobres está cerrada y tengo su llave").check();
  await page.getByLabel(/^Sí: el cajón quedó cerrado/).check();
  await page.getByLabel("No, nadie más participó").check();
  await page.getByRole("button", { name: "Cerrar el turno y guardar sobres y llave" }).click();
  await expect(page.getByRole("heading", { name: "Turno cerrado · sobres en la caja" })).toBeVisible();
  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/apertura`);
  for (const f of [bolsa, cajon]) await page.getByTestId(`verificar-${f}`).getByLabel(/^Sí: cerrado/).check();
  await page.getByLabel("Sí: la caja de sobres está cerrada y tengo su llave").check();
  await page.getByLabel(/^Sí: el cajón quedó cerrado/).check();
  await page.getByTestId("apertura-bolsa").getByLabel(/^Efectivo que cuentas/).fill("0");
  await page.getByTestId("apertura-cajon").getByLabel(/^Efectivo que cuentas/).fill("0");
  await page.getByLabel("No, nadie más participó").check();
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.locator("p.aviso[role=status]")).toContainText("Turno abierto desde el cierre");
  return { bolsa, cajon };
}

test("entrega cancelada: devolución por sobre; el que no regresa sigue pendiente con su incidencia, y la llave queda por revisar", async ({ page }) => {
  const e = await escenario();
  const { bolsa, cajon } = await cierreYApertura(page, e);
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  for (const f of [bolsa, cajon]) await page.getByTestId(`elegir-${f}`).getByRole("checkbox").check();
  await page.getByLabel("Recoge (Dirección)").selectOption({ label: e.dir.nombre });
  await page.getByRole("button", { name: "Entregar los sobres elegidos" }).click();
  await expect(page.getByTestId("entrega-pendiente")).toBeVisible();

  // Dirección cancela: los dos quedan por devolver, fuera de la caja.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  await page.getByLabel("Motivo para cancelar la entrega").fill("Hoy no alcanzo a contarlos");
  await page.getByRole("button", { name: "Cancelar la entrega" }).click();
  for (const f of [bolsa, cajon]) await expect(page.getByTestId(`fuera-${f}`)).toContainText("Entrega cancelada, por devolver");
  await expect(page.getByTestId(`caja-${bolsa}`)).toHaveCount(0);
  await expect(page.getByTestId("formulario-devolucion")).toHaveCount(0);

  // Sofía recibe de vuelta solo la bolsa; el cajón no regresa. La caja de sobres estaba sin llave.
  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  const dev = page.getByTestId("formulario-devolucion");
  await expect(dev).toContainText(`Recibes de ${e.dir.nombre}`);
  await dev.getByTestId(`verificar-${bolsa}`).getByLabel(/^Sí: cerrado/).check();
  await dev.getByTestId(`verificar-${cajon}`).getByLabel("No está el sobre").check();
  await dev.getByTestId(`verificar-${cajon}`).getByRole("textbox").fill("Dirección no lo trajo de vuelta");
  await dev.getByLabel("Hay un problema con la caja de sobres o su llave").check();
  await dev.getByTestId("llave-caja-sobres").getByLabel("Motivo de la incidencia").fill("La caja de sobres estaba sin llave");
  await capturar(page, "recoleccion-devolucion");
  await dev.getByRole("button", { name: "Registrar la devolución a la caja" }).click();
  await expect(page.getByTestId("aviso-devolucion-parcial")).toContainText("Un sobre sigue pendiente de devolución");
  await expect(page.getByTestId(`caja-${bolsa}`)).toBeVisible();
  await expect(page.getByTestId(`caja-${cajon}`)).toHaveCount(0);
  await expect(page.getByTestId(`fuera-${cajon}`)).toContainText("Entrega cancelada, por devolver");
  const pendiente = page.getByTestId(`devolucion-${cajon}`);
  await expect(pendiente.getByTestId("pendiente-devolucion")).toContainText(`lo tiene ${e.dir.nombre}`);
  await expect(pendiente.getByTestId("estado-diferencia")).toContainText("Por revisar");
  await expect(page.getByTestId(`devolucion-${bolsa}`)).toContainText(`recibió ${e.sofia.nombre}`);
  await capturar(page, "recoleccion-devolucion-parcial");

  // Administración (no participó) revisa el problema con la llave y ve la cadena del sobre que falta.
  await entrar(page, e.admin.correo);
  await page.goto(`/sucursales/${e.codigo}/recoleccion`);
  await page.getByTestId(`devolucion-${cajon}`).getByText("Cadena de custodia").click();
  await expect(page.getByTestId(`devolucion-${cajon}`).getByTestId("cadena")).toContainText("Revisó la devolución");
  const llave = page.getByTestId("incidencia-llave");
  await expect(llave).toContainText("La caja de sobres estaba sin llave");
  await llave.getByLabel("Incidencia confirmada").check();
  await llave.getByLabel("Motivo").fill("La caja quedó sin llave al devolver");
  await llave.getByRole("button", { name: "Guardar la revisión" }).click();
  await expect(page.getByTestId("estado-incidencia-llave")).toContainText("Incidencia confirmada");
});

import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 4: cancelación de un cobro duplicado en efectivo, con datos ficticios. Cada prueba crea su sucursal,
 * su turno ($150 en la bolsa), una recepcionista y una persona de Dirección con la facultad (límite $150).
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar cancelaciones 2026";
const CONSONANTES = "bcdfghjklmnpqrstvwxz";
const letras = (n: number) => Array.from({ length: n }, () => CONSONANTES[Math.floor(Math.random() * CONSONANTES.length)]).join("");
const nombrePropio = () => { const l = letras(7); return l[0].toUpperCase() + l.slice(1); };

async function crearCuenta(rol: string, codigo: string, nombre: string, limite?: number) {
  const correo = `cancela-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba de cancelación' from sucursal where codigo = ${codigo}`;
  if (limite !== undefined) {
    await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, todas_las_sucursales, limite_monto, motivo)
              select ${u.id}, 'autorizacion.devolucion', id, false, ${limite}, 'Prueba de cancelación (ficticia)' from sucursal where codigo = ${codigo}`;
  }
  return { id: u.id, correo, nombre };
}
async function escenario() {
  const codigo = `X${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  await sql`insert into sucursal (nombre, codigo) values (${"Cancelaciones " + codigo}, ${codigo})`;
  const recep = await crearCuenta("recepcion", codigo, "Recepcionista " + letras(5));
  const dir = await crearCuenta("direccion", codigo, "Dirección " + letras(5), 150);
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
  return { codigo, recep, dir, luis: await ficha(), ana: await ficha() };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}
/** Cobra $50 en efectivo a una ficha desde la pantalla de visita. */
async function cobrar(page: Page, codigo: string, nombre: string) {
  await page.goto(`/sucursales/${codigo}/turno/visita`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/nombre completo o teléfono/).fill(nombre);
  await page.getByRole("button", { name: "Buscar" }).click();
  await page.getByTestId("visitante").filter({ hasText: nombre }).getByRole("button", { name: "Agregar" }).click();
  await page.getByRole("button", { name: "Confirmar cobro · $50.00" }).click();
  await expect(page.getByTestId("cobro-registrado")).toContainText("Cobro registrado");
}
/**
 * Cobra una vez desde la pantalla y prepara el duplicado directamente en los datos de prueba (misma operación con
 * otra clave, mismas personas, mismo importe y su entrada a la bolsa): el servidor ya no deja cobrar dos veces a
 * quien tiene pase de hoy en la sucursal.
 */
async function cobrarDuplicado(page: Page, codigo: string, nombre: string) {
  await cobrar(page, codigo, nombre);
  await sql.begin(async (tx) => {
    const [orig] = await tx<{ id: string; cobro: string }[]>`
      select o.id, c.id as cobro from operacion_visita o join sucursal s on s.id = o.sucursal_id join cobro_visita c on c.operacion_id = o.id
      where s.codigo = ${codigo} order by o.registrada_en desc limit 1`;
    const [o] = await tx<{ id: string }[]>`
      insert into operacion_visita (clave, sucursal_id, turno_id, registrada_por, total)
      select gen_random_uuid(), sucursal_id, turno_id, registrada_por, total from operacion_visita where id = ${orig.id} returning id`;
    const [c] = await tx<{ id: string }[]>`
      insert into cobro_visita (operacion_id, forma_pago, estado, importe, recibido, cambio)
      select ${o.id}, forma_pago, estado, importe, recibido, cambio from cobro_visita where id = ${orig.cobro} returning id`;
    await tx`insert into pase_visita (operacion_id, visitante_id, sucursal_id, tarifa, descuento, total, orden)
             select ${o.id}, visitante_id, sucursal_id, tarifa, descuento, total, orden from pase_visita where operacion_id = ${orig.id}`;
    await tx`insert into movimiento_efectivo (lugar_id, turno_id, tipo, importe, cobro_id, responsable_id, registrado_por)
             select lugar_id, turno_id, tipo, importe, ${c.id}, responsable_id, registrado_por from movimiento_efectivo
             where cobro_id = ${orig.cobro} and tipo = 'entrada_cobro_visita'`;
  });
}
const bolsa = (page: Page) => page.getByTestId("lugar-bolsa_visitas");

test("Recepción pide cancelar el duplicado de Ana y Dirección lo aprueba: la bolsa vuelve de $300 a $250 y las ventas no lo cuentan", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await cobrar(page, e.codigo, e.luis);
  await cobrarDuplicado(page, e.codigo, e.ana);

  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(bolsa(page).getByTestId("esperado")).toHaveText("$300.00");
  await expect(page.getByTestId("ventas-efectivo")).toHaveText("$150.00");
  await expect(page.getByTestId("ajustes")).toHaveCount(0);

  // El más reciente es el duplicado: su detalle ofrece la solicitud con el cobro correcto de Ana, no el de Luis.
  await page.getByTestId("cobro-turno").first().getByRole("link", { name: "Ver detalle" }).click();
  const formulario = page.getByTestId("solicitar-cancelacion");
  await expect(formulario.getByTestId("candidato")).toHaveCount(1);
  await expect(formulario.getByTestId("candidato")).toContainText(e.ana);
  await expect(formulario.getByTestId("candidato").getByRole("radio")).toBeChecked();
  await formulario.getByLabel("Qué pasó").fill("Se capturó dos veces el mismo pago");
  await formulario.getByLabel(/El dinero de este cobro no entró/).check();
  await formulario.getByRole("button", { name: "Solicitar cancelación" }).click();
  await expect(page.getByRole("status")).toContainText("Cancelación solicitada");
  await expect(page.getByTestId("cancelacion")).toContainText("Pendiente de autorizar");
  await expect(page.getByTestId("solicitar-cancelacion")).toHaveCount(0);

  // Pedirla no cambia nada todavía; Recepción no ve la bandeja de autorización.
  await page.getByRole("link", { name: "← Turno" }).click();
  await expect(bolsa(page).getByTestId("esperado")).toHaveText("$300.00");
  await expect(page.getByTestId("marca-solicitada")).toHaveCount(1);
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("cancelaciones")).toHaveCount(0);
  await page.goto(`/sucursales/${e.codigo}/cancelaciones`);
  await expect(page.getByRole("heading", { name: "No encontrada" })).toBeVisible();

  // Dirección la aprueba desde la sucursal.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("cancelaciones").click();
  await expect(page.getByText("Puedes autorizar hasta $150.00 por cobro.")).toBeVisible();
  const solicitud = page.getByTestId("solicitud");
  await expect(solicitud).toHaveCount(1);
  await expect(solicitud).toContainText(`pidió ${e.recep.nombre}`);
  await expect(solicitud).toContainText("ajuste de -$50.00");
  await solicitud.getByRole("button", { name: "Aprobar cancelación" }).click();
  await expect(page.getByRole("status")).toContainText("Cancelación aprobada");
  await expect(page.getByTestId("solicitud")).toHaveCount(0);

  // Recepción ve el resultado en su turno.
  await entrar(page, e.recep.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(bolsa(page).getByTestId("entradas")).toHaveText("+ $150.00");
  await expect(bolsa(page).getByTestId("ajustes")).toHaveText("− $50.00");
  await expect(bolsa(page)).toContainText("Cancelaciones aprobadas (1 cobro duplicado)");
  await expect(bolsa(page).getByTestId("esperado")).toHaveText("$250.00");
  await expect(page.getByTestId("ventas-efectivo")).toHaveText("$100.00");
  await expect(page.getByTestId("ventas-total")).toHaveText("$100.00");
  await expect(page.getByTestId("ventas-excluidas")).toContainText("1 cobro cancelado por duplicado ($50.00)");
  await expect(page.getByTestId("cobro-turno")).toHaveCount(3);
  await expect(page.getByTestId("marca-cancelado")).toHaveCount(1);
  await expect(page.getByTestId("marca-solicitada")).toHaveCount(0);

  // El detalle conserva el historial.
  await page.getByTestId("cobro-turno").first().getByRole("link", { name: "Ver detalle" }).click();
  await expect(page.getByTestId("detalle-estado")).toHaveText("Cancelado");
  await expect(page.getByTestId("cambio-estado")).toContainText(`Confirmado → Cancelado · ${e.dir.nombre}`);
  await expect(page.getByTestId("cancelacion")).toContainText("Aprobada");
  await expect(page.getByTestId("cancelacion")).toContainText("ajuste en la bolsa: -$50.00");

  const [r] = await sql<{ ajustes: number; suma: string }[]>`
    select count(*) filter (where m.tipo = 'ajuste_cancelacion_cobro')::int as ajustes, sum(m.importe)::text as suma
    from movimiento_efectivo m join lugar_efectivo l on l.id = m.lugar_id join sucursal s on s.id = l.sucursal_id
    where s.codigo = ${e.codigo}`;
  expect(r).toEqual({ ajustes: 1, suma: "100.00" });
});

test("el rechazo pide motivo y deja el cobro vigente", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.recep.correo);
  await cobrarDuplicado(page, e.codigo, e.ana);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await page.getByTestId("cobro-turno").first().getByRole("link", { name: "Ver detalle" }).click();
  const formulario = page.getByTestId("solicitar-cancelacion");
  await formulario.getByLabel("Qué pasó").fill("Creo que se registró dos veces");
  await formulario.getByLabel(/El dinero de este cobro no entró/).check();
  await formulario.getByRole("button", { name: "Solicitar cancelación" }).click();
  await expect(page.getByTestId("cancelacion")).toContainText("Pendiente de autorizar");

  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/cancelaciones`);
  const solicitud = page.getByTestId("solicitud");
  await solicitud.getByRole("button", { name: "Rechazar" }).click();
  await expect(solicitud.getByRole("alert")).toBeVisible();
  await solicitud.getByLabel("Motivo si se rechaza").fill("Eran dos visitas distintas");
  await solicitud.getByRole("button", { name: "Rechazar" }).click();
  await expect(page.getByRole("status")).toContainText("Cancelación rechazada");

  await entrar(page, e.recep.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(bolsa(page).getByTestId("esperado")).toHaveText("$250.00");
  await expect(page.getByTestId("ajustes")).toHaveCount(0);
  await expect(page.getByTestId("ventas-efectivo")).toHaveText("$100.00");
});

test("Tenango, dos cuentas de Recepción: solo la responsable de la bolsa puede pedir la cancelación, ni la otra por envío directo", async ({ page }, info) => {
  // Un solo turno abierto por sucursal: esta prueba usa Tenango y corre solo en escritorio.
  test.skip(info.project.name !== "escritorio", "Tenango admite un solo turno abierto");
  const responsable = await crearCuenta("recepcion", "TEN", "Recepción responsable " + letras(4));
  const otra = await crearCuenta("recepcion", "TEN", "Recepción sin bolsa " + letras(4));
  const dir = await crearCuenta("direccion", "TEN", "Dirección Tenango " + letras(4), 150);
  const [t] = await sql<{ id: string }[]>`
    insert into turno (sucursal_id, abierto_por) select id, ${responsable.id} from sucursal where codigo = 'TEN' returning id`;
  await sql`insert into responsable_lugar (lugar_id, turno_id, usuario_id)
            select l.id, ${t.id}, ${responsable.id} from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = 'TEN'`;
  await sql`insert into conteo_efectivo (turno_id, lugar_id, momento, importe, contado_por)
            select ${t.id}, l.id, 'apertura', case l.tipo when 'bolsa_visitas' then 150 else 0 end, ${responsable.id}
            from lugar_efectivo l join sucursal s on s.id = l.sucursal_id where s.codigo = 'TEN'`;
  const ana = `${nombrePropio()} ${nombrePropio()} ${nombrePropio()}`;
  await sql`insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id)
            select ${ana}, ${"000" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}, 'Querétaro', id from sucursal where codigo = 'ATL'`;

  await entrar(page, responsable.correo);
  await cobrarDuplicado(page, "TEN", ana);
  const [{ id: duplicado }, { id: correcto }] = await sql<{ id: string }[]>`
    select id from operacion_visita where turno_id = ${t.id} order by registrada_en desc, id`;

  // La otra cuenta de Recepción ve el detalle, pero no el formulario.
  await entrar(page, otra.correo);
  await page.goto(`/sucursales/TEN/turno/cobros/${duplicado}`);
  await expect(page.getByTestId("detalle-cobro")).toBeVisible();
  await expect(page.getByTestId("solicitar-cancelacion")).toHaveCount(0);
  await expect(page.getByTestId("cancelacion-no-responsable")).toBeVisible();

  // Envío directo: se toma el formulario de la responsable y se envía con la sesión de la otra cuenta.
  await entrar(page, responsable.correo);
  await page.goto(`/sucursales/TEN/turno/cobros/${duplicado}`);
  const formulario = page.getByTestId("solicitar-cancelacion");
  await formulario.getByLabel("Qué pasó").fill("Se capturó dos veces el mismo pago");
  await formulario.getByLabel(/El dinero de este cobro no entró/).check();
  const cookiesResponsable = await page.context().cookies();
  const otraContexto = await page.context().browser()!.newContext();
  const otraPagina = await otraContexto.newPage();
  await entrar(otraPagina, otra.correo);
  await page.context().clearCookies();
  await page.context().addCookies(await otraContexto.cookies());
  await otraContexto.close();
  await formulario.getByRole("button", { name: "Solicitar cancelación" }).click();
  await expect(formulario.getByRole("alert")).toHaveText("Solo la responsable de la bolsa de este turno puede solicitar la cancelación.");
  const contar = async () => (await sql<{ n: number }[]>`
    select count(*)::int as n from cancelacion_cobro x join cobro_visita c on c.id = x.cobro_id where c.operacion_id = ${duplicado}`)[0].n;
  expect(await contar()).toBe(0);

  // La responsable sí puede.
  await page.context().clearCookies();
  await page.context().addCookies(cookiesResponsable);
  await page.goto(`/sucursales/TEN/turno/cobros/${duplicado}`);
  await expect(formulario.getByTestId("candidato").getByRole("radio")).toHaveValue(correcto);
  await formulario.getByLabel("Qué pasó").fill("Se capturó dos veces el mismo pago");
  await formulario.getByLabel(/El dinero de este cobro no entró/).check();
  await formulario.getByRole("button", { name: "Solicitar cancelación" }).click();
  await expect(page.getByTestId("cancelacion")).toContainText("Pendiente de autorizar");
  expect(await contar()).toBe(1);

  // La autorización sigue aparte, con Dirección Tenango; ninguna cuenta de Recepción la ve.
  for (const correo of [responsable.correo, otra.correo]) {
    await entrar(page, correo);
    await page.goto("/sucursales/TEN/cancelaciones");
    await expect(page.getByRole("heading", { name: "No encontrada" })).toBeVisible();
  }
  await entrar(page, dir.correo);
  await page.goto("/sucursales/TEN/cancelaciones");
  const solicitud = page.getByTestId("solicitud").filter({ hasText: responsable.nombre });
  await solicitud.getByRole("button", { name: "Aprobar cancelación" }).click();
  await expect(page.getByRole("status")).toContainText("Cancelación aprobada");
  await entrar(page, responsable.correo);
  await page.goto("/sucursales/TEN/turno");
  await expect(bolsa(page).getByTestId("entradas")).toHaveText("+ $100.00");
  await expect(bolsa(page).getByTestId("ajustes")).toHaveText("− $50.00");
  await expect(bolsa(page).getByTestId("esperado")).toHaveText("$200.00");
});

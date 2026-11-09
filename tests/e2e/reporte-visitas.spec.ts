import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 4: reporte «Visitas y cobros», con datos ficticios. Cada prueba crea su sucursal y su turno ($150 en la bolsa).
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar el reporte de visitas 2026";
const CONSONANTES = "bcdfghjklmnpqrstvwxz";
const letras = (n: number) => Array.from({ length: n }, () => CONSONANTES[Math.floor(Math.random() * CONSONANTES.length)]).join("");
const nombrePropio = () => { const l = letras(7); return l[0].toUpperCase() + l.slice(1); };

async function crearCuenta(rol: string, codigo: string, nombre: string, limite?: number) {
  const correo = `reporte-v-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba del reporte de visitas' from sucursal where codigo = ${codigo}`;
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


test("Encargado ve su sucursal con periodo, confirmados, registrados y el saldo por turno; otra sucursal y Recepción: «No encontrada»", async ({ page }) => {
  const e = await escenario();
  const encargado = await crearCuenta("encargado", e.codigo, "Encargado " + letras(5));
  await entrar(page, e.recep.correo);
  await cobrar(page, e.codigo, e.luis);
  await cobrar(page, e.codigo, e.ana);

  // Recepción no tiene el reporte: ni el botón ni por enlace directo.
  await page.goto(`/sucursales/${e.codigo}`);
  await expect(page.getByTestId("reporte-visitas")).toHaveCount(0);
  await page.goto(`/reportes/visitas?sucursal=${e.codigo}`);
  await expect(page.getByRole("heading", { name: "No encontrada" })).toBeVisible();

  await entrar(page, encargado.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("reporte-visitas").click();
  await expect(page.getByRole("heading", { name: "Visitas y cobros" })).toBeVisible();
  await expect(page.getByTestId("filtros").getByLabel("Desde")).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  await expect(page.getByTestId("conf-efectivo")).toContainText("$100.00");
  await expect(page.getByTestId("conf-total")).toContainText("$100.00");
  await expect(page.getByTestId("sv-no-localizadas")).toContainText("$0.00");
  await expect(page.getByTestId("cancelados-duplicado")).toContainText("$0.00");
  await expect(page.getByTestId("registrados-total")).toHaveText(/Total registrado\s*2\s*2/);
  await expect(page.getByTestId("saldo-turno")).toHaveCount(1);
  await expect(page.getByTestId("saldo-esperado")).toContainText("$250.00");
  await expect(page.getByTestId("saldo-esperado")).toContainText("ahora");

  // Un periodo de un día del año pasado: sin cobros y sin turnos.
  await page.goto(`/reportes/visitas?sucursal=${e.codigo}&desde=2025-01-01&hasta=2025-01-01`);
  await expect(page.getByTestId("registrados-total")).toHaveText(/Total registrado\s*0\s*0/);
  await expect(page.getByTestId("saldo-sin-turno")).toHaveCount(1);
  // Un periodo no válido avisa y usa los últimos 7 días.
  await page.goto(`/reportes/visitas?sucursal=${e.codigo}&desde=2026-11-10&hasta=2026-11-01`);
  await expect(page.getByTestId("periodo-invalido")).toBeVisible();
  await expect(page.getByTestId("registrados-total")).toHaveText(/Total registrado\s*2\s*2/);

  // Otra sucursal, por enlace directo: «No encontrada».
  for (const codigo of ["STG", "TEN", "ZZZZ"]) {
    await page.goto(`/reportes/visitas?sucursal=${codigo}`);
    await expect(page.getByRole("heading", { name: "No encontrada" }), codigo).toBeVisible();
  }
});

test("con varias sucursales: resumen por sucursal con transferencias sin verificar (pendientes y no localizadas) y saldos por turno sin total", async ({ page }) => {
  const a = await escenario();
  const b = await escenario();
  const admin = await crearCuenta("administracion", a.codigo, "Administración " + letras(5));
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${admin.id}, 'administracion', id, 'Prueba del reporte de visitas' from sucursal where codigo = ${b.codigo}`;
  await entrar(page, a.recep.correo);
  await cobrar(page, a.codigo, a.ana);

  await entrar(page, admin.correo);
  await page.goto(`/reportes/visitas?sucursal=${a.codigo}`);
  await page.getByLabel("Sucursal").selectOption({ label: "Todas mis sucursales" });
  await page.getByRole("button", { name: "Ver" }).click();
  const resumen = page.getByTestId("resumen-sucursales");
  await expect(resumen).toContainText("Transferencias sin verificar: pendientes");
  await expect(resumen).toContainText("Transferencias sin verificar: no localizadas");
  await expect(resumen).not.toContainText("No suman");
  await expect(page.getByTestId(`resumen-${a.codigo}`)).toContainText("$50.00");
  await expect(page.getByTestId(`resumen-${b.codigo}`)).toContainText("$0.00");
  await expect(page.getByTestId("resumen-total")).toContainText("Todas mis sucursales");
  await expect(page.getByTestId("forma-total")).toContainText("$50.00");
  // Un renglón por turno, sin total de saldos.
  await expect(page.getByTestId("saldo-turno")).toHaveCount(2);
  await expect(page.getByTestId("saldos-turno")).not.toContainText("Total");
  await expect(page.getByTestId("saldo-esperado").first()).toContainText("$");
  // Solo sus sucursales: Tenango no está en su lista.
  await expect(page.getByLabel("Sucursal").locator("option")).toHaveCount(3);
});

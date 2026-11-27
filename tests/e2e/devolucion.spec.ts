import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { entregaEnCurso, recibirTurno, registrarEntrega } from "../../src/lib/entregas";
import { abrirTurno } from "../../src/lib/turnos";
import { aplicarCambio } from "../../src/lib/usuarios";
import { confirmarVisita, pantallaCobro } from "../../src/lib/visitas";

/**
 * Cambio mal entregado (26 nov 2026; solo datos ficticios): visita de $50 pagada con $100, cambio registrado $50,
 * entregado $30. Encargado registra el origen al revisar, Dirección que no participó autoriza la devolución y Recepción,
 * con la bolsa del turno abierto, la entrega desde la ficha de la persona visitante.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));
const PRUEBAS = { entorno: "pruebas" as const };
const NADIE = { hubo: false as const };
const CLAVE = "frase para probar las devoluciones 2026";
const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxz"[Math.floor(Math.random() * 20)]).join("");
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};

async function crearCuenta(rol: string, codigo: string, nombre: string) {
  const correo = `devolucion-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) select ${u.id}, ${rol}, id, 'Prueba de devolución' from sucursal where codigo = ${codigo}`;
  return { id: u.id, correo, nombre };
}
async function entrar(page: Page, correo: string) {
  await page.context().clearCookies();
  await page.goto("/iniciar-sesion");
  await page.getByLabel("Correo").fill(correo);
  await page.getByLabel("Contraseña").fill(CLAVE);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function escenario() {
  const codigo = `W${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${"Devolución " + codigo}, ${codigo}) returning id`;
  const laura = await crearCuenta("recepcion", codigo, "Laura " + letras(5));
  const sofia = await crearCuenta("recepcion", codigo, "Sofía " + letras(5));
  const encargado = await crearCuenta("encargado", codigo, "Encargado " + letras(5));
  const dir = await crearCuenta("direccion", codigo, "Dirección " + letras(5));
  const [general] = await sql<{ id: string }[]>`select id from usuario where correo = 'direccion.general@prueba.fitnessland.invalid'`;
  await aplicarCambio(sql, general.id, dir.id, { tipo: "dar_permiso", permiso: "reporte.caja", alcance: { todas: false, sucursales: [s.id] }, limite: "", hasta: "", motivo: "Prueba" }, PRUEBAS);
  const t = await abrirTurno(sql, laura.id, codigo, { bolsa: "400.00", cajon: "1000.00" }, PRUEBAS);
  if (!t.ok) throw new Error(t.error);
  const nombre = `Visitante ficticio A ${letras(4)}`;
  const [v] = await sql<{ id: string }[]>`insert into visitante (nombre, sucursal_alta_id) values (${nombre}, ${s.id}) returning id`;
  const p = await pantallaCobro(sql, laura.id, codigo, "pruebas");
  if (!p.ok) throw new Error(p.error);
  const c = await confirmarVisita(sql, laura.id, codigo, {
    clave: randomUUID(), turnoId: p.turnoId, visitanteIds: [v.id], formaPago: "efectivo", recibido: "100.00", cambio: "50.00",
    autorizacion: null, referencia: null, tipoReferencia: null, otraVenta: false,
  }, PRUEBAS);
  if (!c.ok) throw new Error(c.error);
  // Cambio de turno: Laura entrega $470 (esperado $450); Sofía cuenta lo mismo. Queda +$20 contra el esperado.
  const r = await registrarEntrega(sql, laura.id, codigo, { turnoId: t.turnoId, conteo: { bolsa: "470", cajon: "1000" }, recibe: sofia.id, nota: "", apoyo: NADIE }, PRUEBAS);
  if (!r.ok) throw new Error(r.error);
  const x = (await entregaEnCurso(sql, t.turnoId))!;
  const ok = await recibirTurno(sql, sofia.id, codigo, { entregaId: x.id, version: x.version, conteo: { bolsa: "470", cajon: "1000" }, aclaracion: "", apoyo: NADIE }, PRUEBAS);
  if (!ok.ok || ok.resultado !== "confirmada") throw new Error(JSON.stringify(ok));
  return { codigo, laura, sofia, encargado, dir, entregaId: r.entregaId, visitante: { id: v.id, nombre } };
}

test("cambio mal entregado: origen al revisar, Dirección autoriza y Recepción devuelve $20 una sola vez", async ({ page }) => {
  test.setTimeout(90_000);
  const e = await escenario();

  // 1. Encargado revisa: Sobrante confirmado con origen «cambio mal entregado».
  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias/${e.entregaId}`);
  const f = page.getByTestId("formulario-revision");
  await f.getByRole("radio", { name: /Sobrante confirmado/ }).check();
  await f.getByRole("checkbox", { name: /Cambio mal entregado/ }).check();
  await f.getByLabel("Cobro donde se entregó mal el cambio").selectOption({ index: 1 });
  await f.getByLabel("Cambio que realmente se entregó").fill("35");
  await expect(f.getByTestId("por-devolver-calculado")).toContainText("no coincide con el sobrante");
  await f.getByLabel("Cambio que realmente se entregó").fill("30");
  await expect(f.getByTestId("por-devolver-calculado")).toHaveText("Por devolver: $20.00 · coincide con el sobrante");
  await f.getByLabel("Motivo (obligatorio)").fill("Prueba ficticia: pagó con $100 y se le dieron $30 de cambio");
  await capturar(page, "devolucion-revision");
  await f.getByRole("button", { name: "Registrar revisión" }).click();
  await expect(page.getByTestId("origen-cambio")).toContainText("por devolver $20.00");

  // 2. Dirección (no participó) autoriza la devolución.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias/${e.entregaId}`);
  const r = page.getByTestId("formulario-resolucion");
  await r.getByRole("radio", { name: /Por devolver a la persona visitante: \$20\.00/ }).check();
  await r.getByLabel("Motivo (obligatorio)").fill("Prueba ficticia: se le devuelve el cambio");
  await r.getByRole("button", { name: "Registrar decisión" }).click();
  await expect(page.getByTestId("estado-diferencia").first()).toHaveText("Autorizada por Dirección · devolución pendiente");
  await expect(page.getByTestId("devolucion")).toContainText(`Por devolver a ${e.visitante.nombre}: $20.00 · autorizada el`);
  await capturar(page, "devolucion-autorizada");

  // En el reporte de caja: los $20 desglosados dentro del efectivo, y el pendiente «Por devolver a visitantes».
  await page.goto(`/reportes/caja?sucursal=${e.codigo}`);
  await expect(page.getByTestId("renglon-devolver")).toContainText("De este efectivo, por devolver a visitantes");
  await expect(page.getByTestId("renglon-devolver-importe")).toHaveText("$20.00");
  await expect(page.getByTestId("atencion-por_devolver")).toContainText("Por devolver a visitantes");
  await capturar(page, "devolucion-reporte-pendiente");

  // 3. Sofía (tiene la bolsa del turno abierto) entrega el dinero desde la ficha.
  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/visitantes/${e.visitante.id}`);
  const p = page.getByTestId("devolucion-pendiente");
  await expect(p).toContainText("Tiene $20.00 por devolver");
  const d = p.getByTestId("formulario-devolucion");
  await d.getByRole("button", { name: "Registrar devolución" }).click();
  await expect(d.getByRole("alert")).toHaveText("Confirma que la persona visitante recibió el dinero.");
  await d.getByRole("checkbox", { name: new RegExp(`Lo recibió ${e.visitante.nombre}`) }).check();
  await d.getByLabel("Nota (opcional)").fill("Se entregó en recepción");
  await capturar(page, "devolucion-ficha");
  await d.getByRole("button", { name: "Registrar devolución" }).click();
  await expect(page.getByRole("status")).toContainText("Devolución registrada");
  await expect(page.getByTestId("devolucion-pendiente")).toHaveCount(0);
  // El turno muestra la salida y el esperado baja una sola vez.
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("devoluciones").first()).toHaveText("− $20.00");
  await expect(page.getByTestId("esperado").first()).toHaveText("$450.00");

  // 4. Dirección: caso cerrado, sin desglose pendiente, y la devolución en movimientos.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias/${e.entregaId}`);
  await expect(page.getByTestId("estado-diferencia").first()).toHaveText("Resuelta por Dirección · cerrada");
  await expect(page.getByTestId("devolucion")).toContainText(`Devuelta a ${e.visitante.nombre}: $20.00`);
  await page.goto(`/reportes/caja/mas?sucursal=${e.codigo}&vista=movimientos`);
  await expect(page.getByTestId("mov-devoluciones")).toContainText("Devoluciones de cambio a visitantes (1)");
  await capturar(page, "devolucion-movimientos");
});

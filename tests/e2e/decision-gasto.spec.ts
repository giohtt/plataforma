import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";
import { solicitarGasto } from "../../src/lib/gastos";

/**
 * Bloque 6, PR 4 (27 nov 2026; solo datos ficticios; límites ficticios solo para la prueba): Encargado autoriza dentro
 * de su límite; lo que lo pasa lo decide Gestión administrativa (rechazo con motivo); Dirección ve todo en su bandeja
 * sin decidir; delegación temporal con inicio y fin.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));
const PRUEBAS = { entorno: "pruebas" as const };
const CLAVE = "frase para probar las decisiones 2026";
const id = () => randomUUID().slice(0, 8);
const capturar = async (page: Page, nombre: string) => {
  if (process.env.CAPTURAR) await page.screenshot({ path: `${process.env.CAPTURAR}/${nombre}-${test.info().project.name}.png`, fullPage: true });
};
const masDias = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() + n * 86_400_000));
async function cuenta(nombre: string, rol: string | null, sucursal: string | null, general = false) {
  const correo = `decision-${id()}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena) values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  if (rol && sucursal) await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) values (${u.id}, ${rol}, ${sucursal}, 'Prueba de gastos')`;
  if (general) await sql`insert into alcance_general (usuario_id, rol, motivo) values (${u.id}, 'direccion', 'Prueba de gastos')`;
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

test("Encargado autoriza dentro de su límite; Gestión administrativa rechaza lo que lo pasa; Dirección lo ve todo; delegación temporal", async ({ page }) => {
  test.setTimeout(120_000);
  const codigo = `D${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  const nombre = `Decisiones ${codigo}`;
  const [s] = await sql<{ id: string }[]>`insert into sucursal (nombre, codigo) values (${nombre}, ${codigo}) returning id`;
  const rec = await cuenta(`Recepción ${id()}`, "recepcion", s.id);
  const enc = await cuenta(`Encargado ${id()}`, "encargado", s.id);
  const ges = await cuenta(`Gestión ${id()}`, "gestion_administrativa", s.id);
  const dir = await cuenta(`Dirección ${id()}`, null, null, true);
  const sup = await cuenta(`Suplente ${id()}`, "encargado", s.id);
  // Límites ficticios, solo para esta prueba.
  await sql`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, limite_monto, limite_diario, motivo)
            values (${enc.id}, 'autorizacion.gasto', ${s.id}, 300, 500, 'Prueba'), (${ges.id}, 'autorizacion.gasto', ${s.id}, 1000, 3000, 'Prueba')`;
  await sql`insert into facultad_otorgada (usuario_id, permiso, todas_las_sucursales, sin_limite, motivo)
            values (${dir.id}, 'autorizacion.gasto', true, true, 'Prueba')`;
  for (const importe of ["200", "350"]) {
    const r = await solicitarGasto(sql, rec.id, codigo, { concepto: `Material ficticio ${importe}`, categoria: "prueba_limpieza", importe, proveedor: "", nota: "",
      pagaId: "", compraDe: "", envio: randomUUID() }, PRUEBAS);
    if (!r.ok) throw new Error(r.error);
  }

  // Encargado: «Requiere tu acción» con el que puede decidir; autoriza G1; G2 pasa su límite.
  await entrar(page, enc.correo);
  await page.goto(`/sucursales/${codigo}`);
  await expect(page.getByTestId("accion-gastos")).toHaveText("Gastos por autorizar (1)");
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G1`);
  await expect(page.getByTestId("quien-decide")).toContainText(enc.nombre);
  await capturar(page, "decision-por-autorizar");
  await page.getByTestId("formulario-decision").getByRole("button", { name: "Autorizar" }).click();
  await expect(page.getByRole("status")).toHaveText("Gasto autorizado desde tu cuenta. Autorizar no mueve dinero.");
  await expect(page.getByTestId("estado-gasto")).toContainText(`Autorizado por ${enc.nombre}`);
  await expect(page.getByTestId("decision-gasto")).toContainText("Con su facultad: $300.00 por gasto y $500.00 al día");
  await page.goto(`/sucursales/${codigo}/gastos/${codigo}-G2`);
  await expect(page.getByTestId("formulario-decision")).toHaveCount(0);
  await expect(page.getByTestId("impedimento")).toContainText("La compra pasa tu límite por gasto");
  await expect(page.getByTestId("quien-decide")).toContainText(ges.nombre);
  await expect(page.getByTestId("quien-decide")).toContainText(dir.nombre);

  // Gestión administrativa: bandeja «Puedes decidir»; rechazar exige motivo.
  await entrar(page, ges.correo);
  await page.getByTestId("ir-bandeja-gastos").click();
  await expect(page.getByTestId("vista-tuyos")).toHaveText("Puedes decidir (1)");
  await page.getByTestId("fila-bandeja").getByRole("link", { name: `${codigo}-G2` }).click();
  const f = page.getByTestId("formulario-decision");
  await f.getByRole("button", { name: "Rechazar" }).click();
  await expect(page.getByText("Para rechazar escribe el motivo (de 5 a 300 caracteres).")).toBeVisible();
  await page.getByTestId("formulario-decision").getByLabel(/Motivo/).fill("Prueba ficticia: conseguir otra cotización");
  await page.getByTestId("formulario-decision").getByRole("button", { name: "Rechazar" }).click();
  await expect(page.getByRole("status")).toContainText("Gasto rechazado con tu motivo");
  await expect(page.getByTestId("estado-gasto")).toContainText(`Rechazado por ${ges.nombre}`);
  await expect(page.getByTestId("motivo-decision")).toHaveText("Motivo: «Prueba ficticia: conseguir otra cotización»");
  await capturar(page, "decision-rechazada");

  // Dirección: ve todo en su bandeja, aunque no lo haya decidido.
  await entrar(page, dir.correo);
  await page.goto("/gastos?vista=todos");
  const filas = page.getByTestId("fila-bandeja").filter({ hasText: codigo });
  await expect(filas).toHaveCount(2);
  await expect(filas.filter({ hasText: `${codigo}-G1` })).toContainText(`Autorizado por ${enc.nombre}`);
  await expect(filas.filter({ hasText: `${codigo}-G2` })).toContainText(`Rechazado por ${ges.nombre}`);
  await capturar(page, "bandeja-direccion");

  // Delegación temporal: límites y sucursal fijados por Dirección, con inicio y fin.
  await page.goto(`/usuarios/${sup.id}`);
  const sec = page.getByTestId("facultad-gasto");
  await sec.getByTestId("abrir-delegacion_gasto").click();
  const fd = sec.getByTestId("formulario-delegacion_gasto");
  await fd.getByLabel("Límite por gasto").fill("200");
  await fd.getByLabel("Acumulado diario").fill("500");
  await fd.getByRole("radio", { name: "Elegir sucursales (una o varias)" }).check();
  await fd.getByRole("checkbox", { name: nombre }).check();
  await fd.getByLabel("Desde").fill(masDias(1));
  await fd.getByLabel("Hasta (obligatorio)").fill(masDias(7));
  await fd.getByLabel("Motivo").fill("Prueba ficticia: vacaciones del Encargado");
  await fd.getByRole("button", { name: "Revisar cómo quedará" }).click();
  await expect(fd.getByTestId("vista-previa")).toContainText(`Delegación temporal para autorizar gastos en ${nombre}`);
  await capturar(page, "delegacion-vista-previa");
  await fd.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(page.getByTestId("delegacion")).toHaveText("Delegación temporal");
  await expect(page.getByTestId("facultad-gasto-vigente")).toContainText("límite $200.00 por gasto y $500.00 al día");
  await expect(page.getByTestId("facultad-gasto-vigente")).toContainText("Empieza");
});

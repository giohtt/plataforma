import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { cifrarContrasena } from "../../src/lib/contrasena";

/**
 * Bloque 5: cierre del día y custodia nocturna, con datos ficticios. Sucursal nueva como Tenango: turno abierto con
 * $900 en la bolsa y $3,400 en el cajón; quien abre al día siguiente cuenta $3,350 en el cajón.
 */
const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end({ timeout: 5 }));

const CLAVE = "frase para probar el cierre 2026";
const letras = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxz"[Math.floor(Math.random() * 20)]).join("");

async function crearCuenta(rol: string, codigo: string, nombre: string) {
  const correo = `cierre-${randomUUID().slice(0, 8)}@prueba.fitnessland.invalid`;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${nombre}, ${correo}, true, ${await cifrarContrasena(CLAVE)}) returning id`;
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo)
            select ${u.id}, ${rol}, id, 'Prueba de cierre' from sucursal where codigo = ${codigo}`;
  return { id: u.id, correo, nombre };
}
async function escenario() {
  const codigo = `K${Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("")}`;
  await sql`insert into sucursal (nombre, codigo) values (${"Cierre " + codigo}, ${codigo})`;
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
async function configurarCustodia(page: Page, e: { encargado: { nombre: string }; laura: { nombre: string }; sofia: { nombre: string } }) {
  await page.getByLabel("Dónde se guardan los sobres").fill("Caja con llave · oficina");
  await page.getByRole("group", { name: "Quién tiene acceso", exact: true }).getByLabel(e.encargado.nombre).check();
  await page.getByLabel("Dónde quedan los fondos fijos").fill("Cajón con llave de recepción");
  for (const p of [e.laura, e.sofia, e.encargado]) await page.getByTestId("acceso-cajon").getByLabel(p.nombre).check();
}
async function sobresCorrectos(page: Page) {
  for (const l of ["bolsa_visitas", "cajon_mensualidades"]) {
    await page.getByTestId(`verificar-${l}`).getByLabel(/^Sí: cerrado/).check();
  }
}

test("Tenango: cierre con $3,400 en el cajón, custodia del Encargado y apertura con $3,350 sin recuento", async ({ page }) => {
  const e = await escenario();

  // Dirección define dónde se guardan los sobres y quién tiene acceso. Nada viene marcado.
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("configurar-custodia").click();
  await expect(page.getByRole("group", { name: "Quién tiene acceso", exact: true }).getByLabel(e.encargado.nombre)).not.toBeChecked();
  await configurarCustodia(page, e);
  await capturar(page, "cierre-configurar");
  await page.getByRole("button", { name: "Guardar la custodia" }).click();
  await expect(page.getByTestId("historial-custodia")).toContainText("Caja con llave · oficina");

  // Laura genera los folios, cuenta y cierra.
  await entrar(page, e.laura.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await page.getByTestId("ir-cierre").click();
  await page.getByTestId("generar-folios").click();
  await expect(page.getByTestId("folio-bolsa")).toHaveText(new RegExp(`^${e.codigo}-\\d{8}-C1$`));
  await expect(page.getByTestId("folio-cajon")).toHaveText(new RegExp(`^${e.codigo}-\\d{8}-C2$`));
  await page.getByTestId("cierre-bolsa").getByLabel("Total contado al cerrar").fill("900");
  await expect(page.getByTestId("cierre-diferencia")).toHaveText("Coincide con el esperado.");
  await page.getByTestId("cierre-cajon").getByLabel("Total contado al cerrar").fill("3400");
  await expect(page.getByLabel("Custodio nocturno")).toHaveValue(e.encargado.id);
  await page.getByLabel("No, nadie más participó").check();
  await capturar(page, "cierre-formulario");
  await page.getByRole("button", { name: "Cerrar el turno y entregar sobres y llave al custodio" }).click();
  await expect(page.getByTestId("turno-cerrado")).toBeVisible();
  await expect(page.getByTestId("estado-custodia")).toHaveText("Pendiente de confirmar por el custodio");
  // Sin turno abierto no hay retiros ni apertura desde cero.
  await expect(page.getByTestId("ir-retiro")).toHaveCount(0);

  // El Encargado confirma la custodia desde su cuenta, sin ver importes.
  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("custodia-por-confirmar").click();
  await expect(page.getByTestId("formulario-custodia")).not.toContainText("3,400");
  await sobresCorrectos(page);
  await capturar(page, "cierre-custodia");
  await page.getByLabel(/^Sí: el cajón quedó cerrado/).check();
  await page.getByRole("button", { name: "Confirmo que sobres y llave quedan bajo mi custodia" }).click();
  await expect(page.getByTestId("custodia-confirmada")).toHaveText("Custodia confirmada.");

  // Sofía abre: verifica sobres y cuenta a ciegas $3,350 en el cajón.
  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno`);
  await expect(page.getByTestId("estado-custodia")).toContainText("Confirmada · Caja con llave · oficina");
  await page.getByTestId("ir-apertura").click();
  await expect(page.getByTestId("formulario-apertura-cierre")).not.toContainText("3,400");
  await sobresCorrectos(page);
  await page.getByTestId("apertura-bolsa").getByLabel(/^Sobre .* · total que cuentas$/).fill("900");
  await page.getByTestId("apertura-cajon").getByLabel(/^Sobre .* · total que cuentas$/).fill("3350");
  await page.getByLabel("No, nadie más participó").check();
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.getByTestId("aviso-recuento")).toContainText(`Pide un recuento con ${e.encargado.nombre}`);
  await expect(page.getByTestId("tabla-recuento-apertura")).toContainText("−$50.00");
  await capturar(page, "cierre-recuento");
  // No pudieron recontar juntos: motivo obligatorio.
  await page.getByLabel("No pudimos recontar juntos: abro con lo que conté").check();
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.getByText("Escribe el motivo (de 5 a 300 caracteres).").first()).toBeVisible();
  await page.getByLabel("No pudimos recontar juntos: abro con lo que conté").check();
  await page.getByLabel("Motivo (obligatorio)").fill("El Encargado no estaba para recontar");
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Turno abierto desde el cierre. Desde ahora eres la responsable de la bolsa y del cajón.");
  await expect(page.getByTestId("lugar-cajon_mensualidades").getByTestId("contado-al-abrir")).toHaveText("$3,350.00");
  await expect(page.getByTestId("recibida-cajon_mensualidades").getByTestId("dif-personas")).toHaveText("−$50.00 · Por revisar");
  await capturar(page, "cierre-turno-abierto");

  // Revisa Administración: el Encargado fue custodio.
  await entrar(page, e.admin.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  await expect(page.getByTestId("caso-diferencia").first()).toContainText(`Cerró ${e.laura.nombre} → abrió ${e.sofia.nombre}`);
  await page.getByTestId("caso-diferencia").first().getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cierre del día y apertura");
  await expect(page.getByTestId("nivel-revision")).toContainText("Administración");
  await expect(page.getByTestId("custodia-caso")).toContainText("Caja con llave · oficina");
  await expect(page.getByTestId("aclaracion-caso")).toContainText("El Encargado no estaba para recontar");
  await capturar(page, "cierre-caso");
});

test("custodia sin confirmar y sello roto: se abre con motivo y ambas incidencias quedan por revisar aunque el efectivo cuadre", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/custodia/configurar`);
  await configurarCustodia(page, e);
  await page.getByRole("button", { name: "Guardar la custodia" }).click();
  await expect(page.getByTestId("historial-custodia")).toBeVisible();

  await entrar(page, e.laura.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/cierre`);
  await page.getByTestId("generar-folios").click();
  await page.getByTestId("cierre-bolsa").getByLabel("Total contado al cerrar").fill("900");
  await page.getByTestId("cierre-cajon").getByLabel("Total contado al cerrar").fill("3400");
  await page.getByLabel("No, nadie más participó").check();
  await page.getByRole("button", { name: "Cerrar el turno y entregar sobres y llave al custodio" }).click();
  await expect(page.getByTestId("turno-cerrado")).toBeVisible();

  // El Encargado no confirma. Sofía abre: primero se le pide que confirme el custodio.
  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/apertura`);
  await expect(page.getByTestId("custodia-sin-confirmar")).toContainText(`${e.encargado.nombre} todavía no confirma`);
  await sobresCorrectos(page);
  await page.getByTestId("verificar-bolsa_visitas").getByLabel("Llegó abierto o con el sello roto").check();
  await page.getByTestId("verificar-bolsa_visitas").getByLabel("Motivo de la incidencia").fill("La cinta del sello está despegada");
  await page.getByTestId("apertura-bolsa").getByLabel(/^Sobre .* · total que cuentas$/).fill("900");
  await page.getByTestId("apertura-cajon").getByLabel(/^Sobre .* · total que cuentas$/).fill("3400");
  await page.getByLabel("No, nadie más participó").check();
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.getByTestId("custodia-sin-confirmar")).toContainText("Si está disponible, que confirme primero");
  await page.getByLabel(`${e.encargado.nombre} no está disponible: abro sin su confirmación`).check();
  await page.getByLabel("Motivo (obligatorio)").fill("El Encargado no llegó; no contesta el teléfono");
  await capturar(page, "cierre-sin-custodia");
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Turno abierto desde el cierre. Desde ahora eres la responsable de la bolsa y del cajón.");

  // Administración ve dos incidencias por revisar, sin diferencias de efectivo, y las revisa.
  await entrar(page, e.admin.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  const caso = page.getByTestId("caso-diferencia").filter({ hasText: e.sofia.nombre });
  await expect(caso.getByTestId("estado-caso")).toContainText("2 por revisar");
  await expect(caso).toContainText("Sin diferencias");
  await caso.getByTestId("ver-caso").click();
  await expect(page.getByTestId("incidencia")).toHaveCount(2);
  await expect(page.getByTestId("incidencias")).toContainText("Se abrió sin la confirmación del custodio. Motivo: «El Encargado no llegó; no contesta el teléfono»");
  await expect(page.getByTestId("incidencias")).toContainText("abierto o con el sello roto. Motivo: «La cinta del sello está despegada»");
  await capturar(page, "cierre-incidencias");
  for (let i = 0; i < 2; i++) {
    const f = page.getByTestId("formulario-revision-incidencia").first();
    await f.getByLabel("Qué se revisó (obligatorio)").fill("Se habló con el Encargado y se revisó el sobre");
    await f.getByRole("button", { name: "Registrar revisión de la incidencia" }).click();
    await expect(page.locator("p.aviso[role=status]")).toHaveText("Revisión de la incidencia registrada.");
  }
  await expect(page.getByTestId("estado-incidencia")).toHaveText(["Revisada", "Revisada"]);
});

test("fondo fijo de $300 y $300: se recibe, se aparta al cerrar, se cuenta aparte al abrir y la diferencia queda en el sobre", async ({ page }) => {
  const e = await escenario();
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/custodia/configurar`);
  await configurarCustodia(page, e);
  await page.getByRole("button", { name: "Guardar la custodia" }).click();
  await expect(page.getByTestId("historial-custodia")).toContainText("Cajón con llave de recepción");
  // Dirección autoriza los fondos y entrega el efectivo; queda pendiente de recibir.
  await page.goto(`/sucursales/${e.codigo}/fondos`);
  for (const lugar of ["Fondo de visitas (bolsa)", "Fondo de mensualidades (cajón)"]) {
    const f = page.getByTestId("formulario-cambio-fondo");
    await f.getByLabel(lugar).check();
    await f.getByLabel(/^Monto nuevo/).fill("300");
    await f.getByLabel("Lo entrego yo en efectivo: la responsable confirma cuánto recibe").check();
    await f.getByLabel("Origen del dinero que entregas").fill("Efectivo ficticio de Dirección");
    await f.getByLabel("Motivo").fill("Fondo provisional aprobado el 17 nov");
    await f.getByRole("button", { name: "Autorizar el cambio de monto" }).click();
    await expect(page.locator("p.aviso[role=status]")).toContainText("pendiente hasta que la responsable confirme");
  }
  await expect(page.getByTestId("entrada-pendiente")).toHaveCount(2);
  await capturar(page, "fondo-direccion");

  // Laura confirma lo que recibe: entra al esperado de la bolsa.
  await entrar(page, e.laura.correo);
  await page.goto(`/sucursales/${e.codigo}`);
  await page.getByTestId("fondo-por-recibir").click();
  for (let i = 0; i < 2; i++) {
    const f = page.getByTestId("formulario-recibir-fondo").first();
    await f.getByLabel("Cuánto recibiste").fill("300");
    await f.getByRole("button", { name: "Confirmo lo que recibí" }).click();
    await expect(page.locator("p.aviso[role=status]")).toContainText("Confirmaste lo que recibiste");
  }
  await page.goto(`/sucursales/${e.codigo}/turno/cierre`);
  await page.getByTestId("generar-folios").click();
  await expect(page.getByTestId("cierre-esperado")).toHaveText("$1,200.00");
  await page.getByTestId("cierre-bolsa").getByLabel("Total contado al cerrar").fill("1200");
  await page.getByTestId("cierre-bolsa").getByLabel(/^Fondo apartado/).fill("300");
  await page.getByTestId("cierre-cajon").getByLabel("Total contado al cerrar").fill("3700");
  await page.getByTestId("cierre-cajon").getByLabel(/^Fondo apartado/).fill("300");
  await expect(page.getByTestId("cuadre-bolsa")).toContainText("$900.00 = $1,200.00");
  await expect(page.getByTestId("cuadre-cajon")).toContainText("$3,400.00 = $3,700.00");
  await page.getByLabel("No, nadie más participó").check();
  await capturar(page, "fondo-cierre");
  await page.getByRole("button", { name: "Cerrar el turno y entregar sobres y llave al custodio" }).click();
  await expect(page.getByTestId("fondos-cerrado")).toContainText("Cajón con llave de recepción, separados e identificados · llave con");

  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}/custodia`);
  await sobresCorrectos(page);
  await page.getByLabel(/^Sí: el cajón quedó cerrado/).check();
  await page.getByRole("button", { name: "Confirmo que sobres y llave quedan bajo mi custodia" }).click();
  await expect(page.getByTestId("custodia-confirmada")).toHaveText("Custodia confirmada.");

  // Sofía cuenta aparte fondo y sobre: el sobre del cajón trae $50 menos.
  await entrar(page, e.sofia.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/apertura`);
  await sobresCorrectos(page);
  await page.getByTestId("apertura-bolsa").getByLabel(/^Fondo que cuentas/).fill("300");
  await page.getByTestId("apertura-bolsa").getByLabel(/^Sobre .* · total que cuentas$/).fill("900");
  await page.getByTestId("apertura-cajon").getByLabel(/^Fondo que cuentas/).fill("300");
  await page.getByTestId("apertura-cajon").getByLabel(/^Sobre .* · total que cuentas$/).fill("3350");
  await page.getByLabel("No, nadie más participó").check();
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.getByTestId("tabla-recuento-separado")).toContainText("Sobre · cajón$3,400.00$3,350.00−$50.00");
  await expect(page.getByTestId("tabla-recuento-separado")).toContainText("Fondo · cajón$300.00$300.00$0.00");
  await capturar(page, "fondo-recuento");
  await page.getByLabel("No pudimos recontar juntos: abro con lo que conté").check();
  await page.getByLabel("Motivo (obligatorio)").fill("El Encargado no estaba para recontar");
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.getByTestId("lugar-cajon_mensualidades").getByTestId("contado-al-abrir")).toHaveText("$3,650.00");

  await entrar(page, e.admin.correo);
  await page.goto(`/sucursales/${e.codigo}/diferencias`);
  await page.getByTestId("caso-diferencia").first().getByRole("link").click();
  await expect(page.getByTestId("caso-fondo-sobre")).toContainText("Sobre · cajón$3,400.00$3,350.00—");
  await expect(page.getByTestId("caso-fondos")).toContainText("Cajón con llave de recepción");
});

test("misma persona con Recepción y Encargado: cierra, custodia y abre con una sola cuenta; el historial lo indica", async ({ page }) => {
  const e = await escenario();
  await sql`insert into asignacion (usuario_id, rol, sucursal_id, motivo) select ${e.encargado.id}, 'recepcion', id, 'Prueba de cierre' from sucursal where codigo = ${e.codigo}`;
  await sql`update responsable_lugar r set usuario_id = ${e.encargado.id} from turno t join sucursal s on s.id = t.sucursal_id
            where r.turno_id = t.id and s.codigo = ${e.codigo} and r.hasta is null`;
  await entrar(page, e.dir.correo);
  await page.goto(`/sucursales/${e.codigo}/custodia/configurar`);
  await configurarCustodia(page, e);
  await page.getByRole("button", { name: "Guardar la custodia" }).click();
  await expect(page.getByTestId("historial-custodia")).toBeVisible();

  await entrar(page, e.encargado.correo);
  await page.goto(`/sucursales/${e.codigo}/turno/cierre`);
  await page.getByTestId("generar-folios").click();
  await page.getByTestId("cierre-bolsa").getByLabel("Total contado al cerrar").fill("900");
  await page.getByTestId("cierre-cajon").getByLabel("Total contado al cerrar").fill("3400");
  await page.getByLabel("Custodio nocturno").selectOption({ label: `Yo · ${e.encargado.nombre} — cierro y custodio` });
  await expect(page.getByTestId("aviso-misma-persona")).toContainText("Puedes abrir tú misma");
  await sobresCorrectos(page);
  await page.getByLabel(/^Sí: el cajón quedó cerrado/).check();
  await page.getByLabel("No, nadie más participó").check();
  await capturar(page, "fondo-misma-persona");
  await page.getByRole("button", { name: "Cerrar el turno y guardar sobres y llave" }).click();
  await expect(page.getByTestId("cerro-y-custodio")).toHaveText("Cerró y custodia la misma persona");
  await expect(page.getByTestId("estado-custodia")).toContainText("Confirmada");
  // Abre la misma persona.
  await page.getByTestId("ir-apertura").click();
  await expect(page.getByTestId("misma-persona")).toBeVisible();
  await sobresCorrectos(page);
  await page.getByTestId("apertura-bolsa").getByLabel(/^Sobre .* · total que cuentas$/).fill("900");
  await page.getByTestId("apertura-cajon").getByLabel(/^Sobre .* · total que cuentas$/).fill("3400");
  await page.getByLabel("No, nadie más participó").check();
  await page.getByRole("button", { name: "Abrir el turno" }).click();
  await expect(page.locator("p.aviso[role=status]")).toHaveText("Turno abierto desde el cierre. Desde ahora eres la responsable de la bolsa y del cajón.");
});

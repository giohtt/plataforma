import { expect, test } from "@playwright/test";

test("la portada muestra la franja de pruebas y el logo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("franja-entorno")).toHaveText(/entorno de pruebas/i);
  await expect(page.getByRole("img", { name: /fitness land/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plataforma administrativa" })).toBeVisible();
});

test("la página no tiene desplazamiento horizontal", async ({ page }) => {
  await page.goto("/");
  const desborde = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(desborde).toBeLessThanOrEqual(0);
});

test("/api/estado responde sin datos de operación", async ({ request }) => {
  const res = await request.get("/api/estado");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  const cuerpo = await res.json();
  expect(cuerpo).toMatchObject({ estado: "ok", entorno: "pruebas" });
  expect(Object.keys(cuerpo).sort()).toEqual(["entorno", "estado", "hora", "version"]);
});

test("el sitio de pruebas pide no aparecer en buscadores y envía encabezados de seguridad", async ({
  request,
}) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["x-robots-tag"]).toContain("noindex");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-powered-by"]).toBeUndefined();
});

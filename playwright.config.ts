import { defineConfig, devices } from "@playwright/test";

const PUERTO = Number(process.env.PUERTO_E2E ?? 3100);

/**
 * Pruebas de extremo a extremo contra la aplicación compilada (`npm run build`).
 * Se levanta un servidor local en modo "pruebas" con datos ficticios.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${PUERTO}` },
  projects: [
    { name: "escritorio", use: { ...devices["Desktop Chrome"] } },
    { name: "celular", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx next start -p ${PUERTO} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PUERTO}/api/estado`,
    reuseExistingServer: false,
    env: { APP_ENV: "pruebas" },
    timeout: 60_000,
  },
});

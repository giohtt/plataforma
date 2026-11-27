import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integracion/**/*.test.ts"],
    environment: "node",
    // Las pruebas de integración corren en paralelo contra PostgreSQL; con pocos núcleos, algunas pasaban de 5 s
    // aunque solas tardan alrededor de 1 s (27 nov 2026).
    testTimeout: 20_000,
  },
});

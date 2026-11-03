import { describe, expect, it } from "vitest";
import { prepararUrlConexion } from "../../scripts/conexion.mjs";

const NEON =
  "postgresql://usuario:secreto@ep-ejemplo-pooler.c-15.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

describe("prepararUrlConexion", () => {
  it("quita channel_binding, que el cliente postgres no entiende", () => {
    expect(new URL(prepararUrlConexion(NEON)).searchParams.has("channel_binding")).toBe(false);
  });

  it("exige verificar el certificado en servidores remotos", () => {
    expect(new URL(prepararUrlConexion(NEON)).searchParams.get("sslmode")).toBe("verify-full");
    const sinModo = "postgresql://u:p@db.ejemplo.com/base";
    expect(new URL(prepararUrlConexion(sinModo)).searchParams.get("sslmode")).toBe("verify-full");
  });

  it("conserva usuario, contraseña, servidor y base", () => {
    const u = new URL(prepararUrlConexion(NEON));
    expect([u.username, u.password, u.hostname, u.pathname]).toEqual([
      "usuario",
      "secreto",
      "ep-ejemplo-pooler.c-15.us-east-1.aws.neon.tech",
      "/neondb",
    ]);
  });

  it("no cambia el modo SSL de una base local", () => {
    const local = "postgres://postgres@127.0.0.1:5433/postgres";
    expect(new URL(prepararUrlConexion(local)).searchParams.has("sslmode")).toBe(false);
  });
});

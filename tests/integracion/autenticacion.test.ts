import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cerrarSesion,
  consultarEnlace,
  establecerContrasena,
  iniciarSesion,
  MAX_ENLACES_POR_HORA,
  MAX_FALLOS,
  solicitarEnlace,
  validarSesion,
} from "@/lib/autenticacion";
import { cifrarContrasena } from "@/lib/contrasena";
import { crearBaseTemporal, URL_ADMIN } from "./bd-temporal";

const CLAVE = "una frase larga de prueba 2026";
const PRUEBAS = { entorno: "pruebas" as const, urlBase: "https://pruebas.example.invalid" };

let sql: postgres.Sql;
let cerrar: () => Promise<void>;
let contador = 0;

async function crearUsuario({ contrasena, prueba = true }: { contrasena?: string; prueba?: boolean } = {}) {
  contador++;
  const correo = `persona${contador}@prueba.fitnessland.invalid`;
  const hash = contrasena ? await cifrarContrasena(contrasena) : null;
  const [u] = await sql<{ id: string }[]>`
    insert into usuario (nombre, correo, es_prueba, hash_contrasena)
    values (${"Persona " + contador}, ${correo}, ${prueba}, ${hash}) returning id`;
  return { id: u.id, correo };
}

/** Pide un enlace y lo saca del buzón de pruebas, como lo haría la persona. */
async function obtenerEnlace(correo: string): Promise<string> {
  const r = await solicitarEnlace(sql, correo, PRUEBAS);
  expect(r).toEqual({ creado: true, destino: "buzon_prueba" });
  const [m] = await sql<{ enlace: string }[]>`select enlace from buzon_prueba where para = ${correo} order by id desc limit 1`;
  expect(m.enlace.startsWith("https://pruebas.example.invalid/recuperar/")).toBe(true);
  return m.enlace.split("/recuperar/")[1];
}

describe.skipIf(!URL_ADMIN)("inicio de sesión y recuperación de cuenta", () => {
  beforeAll(async () => {
    ({ sql, cerrar } = await crearBaseTemporal({ conexiones: 8 }));
  });
  afterAll(async () => cerrar?.());

  describe("inicio y cierre de sesión", () => {
    it("con la contraseña correcta crea una sesión válida; al cerrarla deja de valer", async () => {
      const u = await crearUsuario({ contrasena: CLAVE });
      const r = await iniciarSesion(sql, `  ${u.correo.toUpperCase()} `, CLAVE);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const s = await validarSesion(sql, r.token);
      expect(s?.correo).toBe(u.correo);

      await cerrarSesion(sql, r.token);
      expect(await validarSesion(sql, r.token)).toBeNull();
    });

    it("la base guarda solo la huella del código de sesión", async () => {
      const u = await crearUsuario({ contrasena: CLAVE });
      const r = await iniciarSesion(sql, u.correo, CLAVE);
      if (!r.ok) throw new Error("no inició");
      const [{ n }] = await sql`select count(*)::int as n from sesion where token_hash = ${r.token}`;
      expect(n).toBe(0);
    });

    it("contraseña incorrecta y correo inexistente dan la misma respuesta", async () => {
      const u = await crearUsuario({ contrasena: CLAVE });
      expect(await iniciarSesion(sql, u.correo, "otra frase distinta 123")).toEqual({ ok: false, motivo: "credenciales" });
      expect(await iniciarSesion(sql, "nadie@prueba.fitnessland.invalid", CLAVE)).toEqual({ ok: false, motivo: "credenciales" });
    });

    it("un usuario sin contraseña todavía no puede entrar", async () => {
      const u = await crearUsuario();
      expect(await iniciarSesion(sql, u.correo, CLAVE)).toEqual({ ok: false, motivo: "credenciales" });
      const [i] = await sql`select motivo from intento_acceso where correo = ${u.correo} order by id desc limit 1`;
      expect(i.motivo).toBe("sin_contrasena");
    });

    it(`tras ${MAX_FALLOS} fallos se bloquea aunque después escriba la contraseña correcta`, async () => {
      const u = await crearUsuario({ contrasena: CLAVE });
      for (let i = 0; i < MAX_FALLOS; i++) await iniciarSesion(sql, u.correo, "equivocada equivocada");
      expect(await iniciarSesion(sql, u.correo, CLAVE)).toEqual({ ok: false, motivo: "bloqueado" });
    });

    it("una sesión vencida no vale", async () => {
      const u = await crearUsuario({ contrasena: CLAVE });
      const r = await iniciarSesion(sql, u.correo, CLAVE);
      if (!r.ok) throw new Error("no inició");
      await sql`update sesion set creada_en = now() - interval '13 hours', expira_en = now() - interval '1 hour'
                where usuario_id = ${u.id}`;
      expect(await validarSesion(sql, r.token)).toBeNull();
    });

    it("desactivar al usuario invalida sus sesiones y le impide entrar", async () => {
      const u = await crearUsuario({ contrasena: CLAVE });
      const r = await iniciarSesion(sql, u.correo, CLAVE);
      if (!r.ok) throw new Error("no inició");
      await sql`update usuario set activo = false where id = ${u.id}`;
      expect(await validarSesion(sql, r.token)).toBeNull();
      expect(await iniciarSesion(sql, u.correo, CLAVE)).toEqual({ ok: false, motivo: "credenciales" });
    });

    it("códigos de sesión inventados o vacíos no valen", async () => {
      expect(await validarSesion(sql, undefined)).toBeNull();
      expect(await validarSesion(sql, "x")).toBeNull();
      expect(await validarSesion(sql, "A".repeat(43))).toBeNull();
    });
  });

  describe("enlaces de recuperación", () => {
    it("la persona fija su contraseña con el enlace y después puede entrar", async () => {
      const u = await crearUsuario();
      const token = await obtenerEnlace(u.correo);
      expect(await consultarEnlace(sql, token)).toEqual({ estado: "valido", correo: u.correo });
      expect(await establecerContrasena(sql, token, CLAVE, CLAVE)).toEqual({ ok: true });
      expect((await iniciarSesion(sql, u.correo, CLAVE)).ok).toBe(true);

      const [h] = await sql`select accion from historial_cambio where entidad_id = ${u.id} order by id desc limit 1`;
      expect(h.accion).toBe("establecer_contrasena");
      const [{ n }] = await sql`select count(*)::int as n from enlace_recuperacion where token_hash = ${token}`;
      expect(n).toBe(0); // solo se guarda la huella
    });

    it("un enlace ya utilizado no se puede volver a usar", async () => {
      const u = await crearUsuario();
      const token = await obtenerEnlace(u.correo);
      await establecerContrasena(sql, token, CLAVE, CLAVE);
      expect(await consultarEnlace(sql, token)).toEqual({ estado: "usado" });
      const r = await establecerContrasena(sql, token, "otra frase muy larga 99", "otra frase muy larga 99");
      expect(r).toMatchObject({ ok: false, estado: "usado" });
      expect((await iniciarSesion(sql, u.correo, "otra frase muy larga 99")).ok).toBe(false);
    });

    it("un enlace vencido no sirve", async () => {
      const u = await crearUsuario();
      const token = await obtenerEnlace(u.correo);
      await sql`update enlace_recuperacion set creado_en = now() - interval '2 hours', expira_en = now() - interval '1 hour'
                where usuario_id = ${u.id}`;
      expect(await consultarEnlace(sql, token)).toEqual({ estado: "vencido" });
      expect(await establecerContrasena(sql, token, CLAVE, CLAVE)).toMatchObject({ ok: false, estado: "vencido" });
    });

    it("pedir un enlace nuevo invalida el anterior", async () => {
      const u = await crearUsuario();
      const viejo = await obtenerEnlace(u.correo);
      const nuevo = await obtenerEnlace(u.correo);
      expect(await consultarEnlace(sql, viejo)).toEqual({ estado: "invalidado" });
      expect((await consultarEnlace(sql, nuevo)).estado).toBe("valido");
    });

    it("si dos personas usan el mismo enlace a la vez, solo una lo consigue", async () => {
      const u = await crearUsuario();
      const token = await obtenerEnlace(u.correo);
      const resultados = await Promise.all([
        establecerContrasena(sql, token, "primera frase larga 111", "primera frase larga 111"),
        establecerContrasena(sql, token, "segunda frase larga 222", "segunda frase larga 222"),
      ]);
      expect(resultados.filter((r) => r.ok)).toHaveLength(1);
      expect(resultados.filter((r) => !r.ok)[0]).toMatchObject({ estado: "usado" });
    });

    it("una contraseña rechazada no gasta el enlace", async () => {
      const u = await crearUsuario();
      const token = await obtenerEnlace(u.correo);
      expect(await establecerContrasena(sql, token, "corta", "corta")).toMatchObject({ ok: false });
      expect(await establecerContrasena(sql, token, CLAVE, "otra cosa distinta 1")).toMatchObject({ ok: false });
      expect((await consultarEnlace(sql, token)).estado).toBe("valido");
    });

    it("fijar una contraseña nueva cierra las sesiones abiertas", async () => {
      const u = await crearUsuario({ contrasena: CLAVE });
      const r = await iniciarSesion(sql, u.correo, CLAVE);
      if (!r.ok) throw new Error("no inició");
      const token = await obtenerEnlace(u.correo);
      await establecerContrasena(sql, token, "frase completamente nueva 7", "frase completamente nueva 7");
      expect(await validarSesion(sql, r.token)).toBeNull();
    });

    it(`limita a ${MAX_ENLACES_POR_HORA} enlaces por hora`, async () => {
      const u = await crearUsuario();
      for (let i = 0; i < MAX_ENLACES_POR_HORA; i++) await obtenerEnlace(u.correo);
      expect(await solicitarEnlace(sql, u.correo, PRUEBAS)).toEqual({ creado: false, motivo: "limite" });
    });

    it("no crea enlaces para correos inexistentes ni usuarios inactivos", async () => {
      expect(await solicitarEnlace(sql, "nadie@prueba.fitnessland.invalid", PRUEBAS)).toEqual({ creado: false, motivo: "desconocido" });
      const u = await crearUsuario();
      await sql`update usuario set activo = false where id = ${u.id}`;
      expect(await solicitarEnlace(sql, u.correo, PRUEBAS)).toEqual({ creado: false, motivo: "desconocido" });
    });

    it("en producción y para usuarios reales no usa el buzón de pruebas", async () => {
      const prueba = await crearUsuario();
      const real = await crearUsuario({ prueba: false });
      expect(await solicitarEnlace(sql, prueba.correo, { ...PRUEBAS, entorno: "produccion" })).toEqual({ creado: false, motivo: "sin_canal" });
      expect(await solicitarEnlace(sql, real.correo, PRUEBAS)).toEqual({ creado: false, motivo: "sin_canal" });
      const [{ n }] = await sql`select count(*)::int as n from buzon_prueba where para in (${prueba.correo}, ${real.correo})`;
      expect(n).toBe(0);
    });

    it("enlaces inventados o con formato inválido no valen", async () => {
      expect(await consultarEnlace(sql, "abc")).toEqual({ estado: "inexistente" });
      expect(await consultarEnlace(sql, "B".repeat(43))).toEqual({ estado: "inexistente" });
      expect(await establecerContrasena(sql, "abc", CLAVE, CLAVE)).toMatchObject({ ok: false, estado: "inexistente" });
    });
  });

  describe("concurrencia", () => {
    /** Enlaces que hoy servirían: ni usados, ni reemplazados, ni vencidos. */
    async function enlacesValidos(usuarioId: string) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from enlace_recuperacion
        where usuario_id = ${usuarioId} and usado_en is null and invalidado_en is null and expira_en > now()`;
      return n;
    }

    it("solicitudes simultáneas dejan como máximo un enlace válido y respetan el límite por hora", async () => {
      const u = await crearUsuario();
      const resultados = await Promise.all(
        Array.from({ length: 6 }, () => solicitarEnlace(sql, u.correo, PRUEBAS)),
      );
      const creados = resultados.filter((r) => r.creado).length;
      expect(creados).toBe(MAX_ENLACES_POR_HORA);
      expect(resultados.filter((r) => !r.creado)).toEqual(
        Array.from({ length: 6 - MAX_ENLACES_POR_HORA }, () => ({ creado: false, motivo: "limite" })),
      );
      const [{ total }] = await sql<{ total: number }[]>`
        select count(*)::int as total from enlace_recuperacion where usuario_id = ${u.id}`;
      expect(total).toBe(MAX_ENLACES_POR_HORA);
      expect(await enlacesValidos(u.id)).toBe(1);
    });

    it("la base impide dos enlaces válidos para la misma cuenta aunque falle la aplicación", async () => {
      const u = await crearUsuario();
      await obtenerEnlace(u.correo);
      await expect(sql`
        insert into enlace_recuperacion (token_hash, usuario_id, expira_en)
        values (${"c".repeat(64)}, ${u.id}, now() + interval '30 minutes')`).rejects.toThrow();
    });

    it("si la contraseña cambia mientras se verifica la anterior, no queda sesión válida", async () => {
      const u = await crearUsuario({ contrasena: CLAVE });
      const nueva = "contraseña nueva durante el inicio 1";
      const r = await iniciarSesion(sql, u.correo, CLAVE, {
        trasVerificar: async () => {
          const token = await obtenerEnlace(u.correo);
          expect(await establecerContrasena(sql, token, nueva, nueva)).toEqual({ ok: true });
        },
      });
      expect(r).toEqual({ ok: false, motivo: "credenciales" });
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from sesion where usuario_id = ${u.id} and cerrada_en is null`;
      expect(n).toBe(0);
      expect((await iniciarSesion(sql, u.correo, nueva)).ok).toBe(true);
    });

    it("si el cambio de contraseña llega mientras se crea la sesión, esa sesión queda cerrada", async () => {
      const u = await crearUsuario({ contrasena: CLAVE });
      const nueva = "contraseña nueva durante la creación 2";
      const token = await obtenerEnlace(u.correo);
      let cambio: Promise<unknown> | null = null;
      const r = await iniciarSesion(sql, u.correo, CLAVE, {
        dentroDeTransaccion: async () => {
          cambio = establecerContrasena(sql, token, nueva, nueva);
          await new Promise((listo) => setTimeout(listo, 300)); // el cambio debe esperar al inicio en curso
        },
      });
      await cambio;
      if (r.ok) expect(await validarSesion(sql, r.token)).toBeNull();
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from sesion where usuario_id = ${u.id} and cerrada_en is null`;
      expect(n).toBe(0);
    });
  });

  it("los intentos de acceso no se pueden editar ni borrar", async () => {
    await expect(sql`update intento_acceso set exito = true`).rejects.toThrow();
    await expect(sql`delete from intento_acceso`).rejects.toThrow();
  });
});

import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { CabeceraMarca } from "@/components/CabeceraMarca";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";

export const metadata = { title: "Buzón de pruebas · Fitnessland", referrer: "no-referrer" };

/**
 * Buzón de pruebas: muestra los mensajes que se enviarían por correo. No existe en producción.
 * En el sitio de pruebas lo protege la autenticación de Vercel; solo hay usuarios ficticios.
 */
export default async function PaginaBuzon() {
  await connection(); // siempre en el momento de la visita, nunca una copia de la compilación
  if (leerEntorno() === "produccion") notFound();
  const sql = obtenerBaseDatos();
  const mensajes = sql
    ? await sql<{ id: number; para: string; asunto: string; cuerpo: string; enlace: string | null; creado_en: Date }[]>`
        select id, para, asunto, cuerpo, enlace, creado_en from buzon_prueba order by id desc limit 50`
    : [];
  const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });

  return (
    <main className="contenedor">
      <CabeceraMarca titulo="Buzón de pruebas" subtitulo="Mensajes que se enviarían por correo. No se envía nada." />
      <p className="aviso aviso-info">
        Solo existe fuera de producción y solo recibe mensajes de usuarios ficticios. Cada enlace funciona una vez y caduca
        en 30 minutos. <Link href="/iniciar-sesion">Ir a iniciar sesión</Link>
      </p>
      {mensajes.length === 0 ? (
        <section className="tarjeta"><p className="sub">Todavía no hay mensajes.</p></section>
      ) : (
        <ul className="lista-mensajes">
          {mensajes.map((m) => (
            <li key={m.id} className="tarjeta" data-para={m.para}>
              <p className="sub">{hora.format(m.creado_en)} · Para: <strong>{m.para}</strong></p>
              <h2 className="titulo-seccion">{m.asunto}</h2>
              <p>{m.cuerpo}</p>
              {m.enlace ? (
                <p>
                  <a className="boton" href={m.enlace} rel="noreferrer">Abrir enlace</a>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

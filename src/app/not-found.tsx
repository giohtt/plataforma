import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "No encontrada · Fitnessland" };

/**
 * Página 404 en español. Se usa igual cuando la dirección no existe y cuando la persona no tiene
 * permiso (por ejemplo, otra sucursal): el mismo texto en ambos casos, para no revelar qué existe.
 */
export default function NoEncontrada() {
  return (
    <main className="contenedor">
      <section className="tarjeta" data-testid="no-encontrada">
        <h1 className="cabecera-titulo">No encontrada</h1>
        <p>La página no existe o no tienes acceso a ella.</p>
        <p><Link href="/">← Volver al inicio</Link></p>
      </section>
    </main>
  );
}

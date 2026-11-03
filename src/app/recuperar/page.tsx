import Link from "next/link";
import { CabeceraMarca } from "@/components/CabeceraMarca";
import { FormularioSolicitarEnlace } from "@/components/FormulariosSesion";
import { leerEntorno } from "@/lib/entorno";

export const metadata = { title: "Establecer contraseña · Fitnessland" };

export default function PaginaRecuperar() {
  const entorno = leerEntorno();
  return (
    <main className="contenedor contenedor-angosto">
      <CabeceraMarca titulo="Plataforma administrativa" />
      <section className="tarjeta" aria-labelledby="titulo-recuperar">
        <h2 id="titulo-recuperar" className="titulo-seccion">Establecer o recuperar tu contraseña</h2>
        <p className="sub">
          Escribe el correo de tu cuenta. Recibirás un enlace de un solo uso, válido por 30 minutos, para que tú misma
          o tú mismo fijes tu contraseña. Nadie más la conoce.
        </p>
        <FormularioSolicitarEnlace />
        {entorno !== "produccion" ? (
          <p className="sub">
            Entorno de pruebas: no se envían correos. El enlace aparece en el <Link href="/pruebas/buzon">buzón de pruebas</Link>.
          </p>
        ) : null}
        <p className="sub">
          <Link href="/iniciar-sesion">Volver a iniciar sesión</Link>
        </p>
      </section>
    </main>
  );
}

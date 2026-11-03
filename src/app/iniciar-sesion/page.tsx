import Link from "next/link";
import { redirect } from "next/navigation";
import { CabeceraMarca } from "@/components/CabeceraMarca";
import { FormularioInicioSesion } from "@/components/FormulariosSesion";
import { leerEntorno } from "@/lib/entorno";
import { obtenerSesionActual } from "@/lib/sesion-servidor";

export const metadata = { title: "Iniciar sesión · Fitnessland" };

export default async function PaginaIniciarSesion({ searchParams }: PageProps<"/iniciar-sesion">) {
  if (await obtenerSesionActual()) redirect("/");
  const parametros = await searchParams;
  const avisos: Record<string, string> = {
    lista: "Contraseña guardada. Ya puedes iniciar sesión.",
    cerrada: "Cerraste tu sesión.",
  };
  const aviso = avisos[String(parametros.contrasena ?? "")] ?? avisos[String(parametros.sesion ?? "")];
  const entorno = leerEntorno();

  return (
    <main className="contenedor contenedor-angosto">
      <CabeceraMarca titulo="Plataforma administrativa" subtitulo="Inicia sesión con tu cuenta individual" />
      <section className="tarjeta" aria-labelledby="titulo-inicio">
        <h2 id="titulo-inicio" className="titulo-seccion">Iniciar sesión</h2>
        {aviso ? <p className="aviso aviso-ok" role="status">{aviso}</p> : null}
        <FormularioInicioSesion />
        <p className="sub">
          ¿Es tu primera vez u olvidaste tu contraseña? <Link href="/recuperar">Solicita un enlace</Link>.
        </p>
      </section>
      {entorno !== "produccion" ? (
        <p className="sub">
          Entorno de pruebas: los enlaces llegan al <Link href="/pruebas/buzon">buzón de pruebas</Link>, no a un correo real.
        </p>
      ) : null}
    </main>
  );
}

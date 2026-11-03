import Link from "next/link";
import { CabeceraMarca } from "@/components/CabeceraMarca";
import { FormularioNuevaContrasena } from "@/components/FormulariosSesion";
import { consultarEnlace } from "@/lib/autenticacion";
import { obtenerBaseDatos } from "@/lib/db";

export const metadata = { title: "Nueva contraseña · Fitnessland", referrer: "no-referrer" };

const MENSAJES = {
  vencido: "Este enlace caducó. Los enlaces duran 30 minutos.",
  usado: "Este enlace ya se usó. Cada enlace funciona una sola vez.",
  invalidado: "Este enlace fue reemplazado por uno más reciente. Usa el último que recibiste.",
  inexistente: "Este enlace no es válido.",
} as const;

export default async function PaginaNuevaContrasena({ params }: PageProps<"/recuperar/[token]">) {
  const { token } = await params;
  const sql = obtenerBaseDatos();
  const estado = sql ? await consultarEnlace(sql, token) : { estado: "inexistente" as const };

  return (
    <main className="contenedor contenedor-angosto">
      <CabeceraMarca titulo="Plataforma administrativa" />
      <section className="tarjeta" aria-labelledby="titulo-nueva">
        <h2 id="titulo-nueva" className="titulo-seccion">Establece tu contraseña</h2>
        {estado.estado === "valido" ? (
          <>
            <p className="sub">Cuenta: <strong>{estado.correo}</strong></p>
            <FormularioNuevaContrasena token={token} correo={estado.correo} />
          </>
        ) : (
          <>
            <p className="aviso aviso-error" role="alert" data-estado-enlace={estado.estado}>
              {MENSAJES[estado.estado]}
            </p>
            <p className="sub">
              <Link href="/recuperar">Solicita un enlace nuevo</Link>
            </p>
          </>
        )}
      </section>
    </main>
  );
}

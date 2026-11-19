import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioNuevaPersona } from "@/components/Usuarios";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";
import { facultadesAdministrar } from "@/lib/usuarios";

export const metadata = { title: "Nueva persona · Fitnessland" };

export default async function NuevaPersona() {
  const sesion = await requerirSesion();
  if (!(await facultadesAdministrar(obtenerBaseDatos()!, sesion.usuarioId)).crear) notFound();
  return (
    <main className="contenedor contenedor-angosto">
      <p className="sub"><Link href="/usuarios">← Usuarios, roles y permisos</Link></p>
      <h1 className="cabecera-titulo">Nueva persona</h1>
      <section className="tarjeta"><FormularioNuevaPersona /></section>
    </main>
  );
}

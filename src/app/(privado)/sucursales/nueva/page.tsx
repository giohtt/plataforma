import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioSucursal } from "@/components/FormulariosSucursal";
import { obtenerBaseDatos } from "@/lib/db";
import { tienePermiso } from "@/lib/permisos";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Nueva sucursal · Fitnessland" };

/** Alta de sucursal. Sin el permiso general de crear: «No encontrada», igual que cualquier otra página ajena. */
export default async function NuevaSucursal() {
  const sesion = await requerirSesion();
  if (!(await tienePermiso(obtenerBaseDatos()!, sesion.usuarioId, "sucursal.crear"))) notFound();
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href="/">← Tus sucursales</Link></p>
      <h1 className="cabecera-titulo">Nueva sucursal</h1>
      <p className="aviso aviso-info">
        Crear una sucursal no le da acceso a nadie. Solo la verán quienes ya tienen acceso a todas las sucursales;
        a las demás personas hay que asignarlas después.
      </p>
      <section className="tarjeta">
        <FormularioSucursal
          modo="crear"
          inicial={{ nombre: "", codigo: "", color: null, direccion: null, estadoRepublica: null, estadoOperativo: "proxima" }}
        />
      </section>
    </main>
  );
}

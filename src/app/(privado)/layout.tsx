import { accionCerrarSesion } from "@/app/acciones-sesion";
import { requerirSesion } from "@/lib/sesion-servidor";

/**
 * Todo lo que está dentro de (privado) exige sesión. Esta comprobación es en el servidor;
 * las acciones y rutas futuras deben volver a comprobar la sesión y los permisos por sí mismas.
 */
export default async function LayoutPrivado({ children }: LayoutProps<"/">) {
  const sesion = await requerirSesion();
  return (
    <>
      <div className="barra-sesion">
        <div className="barra-sesion-interior">
          <span>
            Sesión de <strong data-testid="usuario-sesion">{sesion.nombre}</strong>
            <span className="sub barra-correo"> · {sesion.correo}</span>
          </span>
          <form action={accionCerrarSesion}>
            <button className="boton" type="submit">Cerrar sesión</button>
          </form>
        </div>
      </div>
      {children}
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { temaSucursal } from "@/lib/color";
import { obtenerBaseDatos } from "@/lib/db";
import { NOMBRE_PERFIL, sucursalAccesiblePorCodigo, type Rol } from "@/lib/permisos";
import { requerirSesion } from "@/lib/sesion-servidor";

const ESTADO: Record<string, string> = { activa: "Activa", proxima: "Próxima apertura", inactiva: "Inactiva" };

/** Qué ofrece cada perfil. Las funciones de operación llegan en los bloques siguientes. */
const VISTAS: Partial<Record<Rol, { descripcion: string; pendientes: string[] }>> = {
  recepcion: {
    descripcion: "Registrar la operación de tu turno y solicitar lo que requiere aprobación.",
    pendientes: ["Abrir turno y recibir la bolsa de visitas o el cajón", "Registrar visitas y cobros", "Conteo, entrega y cierre de turno", "Solicitar gastos"],
  },
  encargado: {
    descripcion: "Consultar y dar seguimiento a la sucursal. Autorizas solo lo que Dirección te delegue expresamente.",
    pendientes: ["Revisión de cierres hechos por otra persona", "Seguimiento de gastos", "Aprobaciones delegadas"],
  },
  administracion: {
    descripcion: "Revisar movimientos, comprobantes, gastos y cierres dentro de tu alcance.",
    pendientes: ["Revisión de cierres y entregas", "Gastos y comprobantes", "Conciliación bancaria"],
  },
  direccion: {
    descripcion: "Consultar la sucursal y configurar según los permisos y facultades que tengas otorgados.",
    pendientes: ["Resumen y comparación entre sucursales", "Bandeja de autorizaciones", "Configuración de sucursales y usuarios"],
  },
};

export default async function PaginaSucursal({ params }: PageProps<"/sucursales/[codigo]">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const sql = obtenerBaseDatos()!;
  const sucursal = await sucursalAccesiblePorCodigo(sql, sesion.usuarioId, codigo);
  // Sin permiso, la misma respuesta que si no existiera.
  if (!sucursal) notFound();

  const permisos = await sql<{ clave: string; descripcion: string }[]>`
    select clave, descripcion from permiso
    where ambito = 'sucursal' and tiene_permiso(${sesion.usuarioId}, clave, ${sucursal.id})
    order by bloque, clave`;

  return (
    <main className="contenedor" style={temaSucursal(sucursal.color) as CSSProperties}>
      <div className="franja-sucursal" aria-hidden="true" />
      <p className="sub"><Link href="/">← Tus sucursales</Link></p>
      <header className="cabecera-marca">
        <div>
          <h1 className="cabecera-titulo" data-testid="nombre-sucursal">{sucursal.nombre}</h1>
          <p className="sub">{ESTADO[sucursal.estadoOperativo]} · Código {sucursal.codigo}</p>
        </div>
      </header>

      {sucursal.perfiles.map((perfil) => {
        const vista = VISTAS[perfil];
        return (
          <section key={perfil} className="tarjeta" data-perfil={perfil}>
            <p className="etiqueta-perfil">Vista de {NOMBRE_PERFIL[perfil]}</p>
            <p>{vista?.descripcion ?? "Este perfil todavía no tiene pantallas en esta etapa."}</p>
            {vista ? (
              <ul className="pendientes">
                {vista.pendientes.map((p) => (
                  <li key={p}><span>{p}</span><span className="chip-pendiente">Aún no disponible</span></li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}

      <section className="tarjeta" aria-labelledby="titulo-permisos">
        <h2 id="titulo-permisos" className="titulo-seccion">Lo que puedes hacer en esta sucursal</h2>
        <ul data-testid="permisos-sucursal">
          {permisos.map((p) => <li key={p.clave}>{p.descripcion} <span className="sub mono">{p.clave}</span></li>)}
        </ul>
        <p className="sub">Calculado en el servidor a partir de tus perfiles, alcance y facultades vigentes.</p>
      </section>
    </main>
  );
}

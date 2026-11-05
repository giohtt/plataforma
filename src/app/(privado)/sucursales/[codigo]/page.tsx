import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { temaSucursal } from "@/lib/color";
import { obtenerBaseDatos } from "@/lib/db";
import { historialSucursal } from "@/lib/catalogo-sucursales";
import { NOMBRE_PERFIL, sucursalAccesiblePorCodigo, tienePermiso, type Rol } from "@/lib/permisos";
import { requerirSesion } from "@/lib/sesion-servidor";

const ESTADO: Record<string, string> = { activa: "Activa", proxima: "Próxima apertura", inactiva: "Inactiva" };

/** Qué ofrece cada perfil. Las funciones de operación llegan en los bloques siguientes. */
const VISTAS: Partial<Record<Rol, { descripcion: string; pendientes: string[] }>> = {
  recepcion: {
    descripcion: "Registrar la operación de tu turno y solicitar lo que requiere aprobación.",
    pendientes: ["Registrar visitas y cobros", "Conteo, entrega y cierre de turno", "Solicitar gastos"],
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

const AVISOS: Record<string, string> = {
  creada: "Sucursal creada. No se asignó a nadie: asigna a las personas que correspondan.",
  guardada: "Cambios guardados.",
  desactivada: "Sucursal desactivada. No se borró nada y se puede reactivar.",
  reactivada: "Sucursal reactivada.",
};

const ACCIONES: Record<string, string> = { crear: "Creada", editar: "Editada", desactivar: "Desactivada", reactivar: "Reactivada" };
const CAMPOS: Record<string, string> = {
  nombre: "Nombre",
  color: "Color",
  direccion: "Dirección",
  estado_republica: "Estado de la república",
  estado_operativo: "Estado",
};
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const mostrar = (campo: string, v: unknown) =>
  v === null || v === undefined || v === "" ? "(vacío)" : campo === "estado_operativo" ? (ESTADO[String(v)] ?? String(v)) : String(v);

export default async function PaginaSucursal({ params, searchParams }: PageProps<"/sucursales/[codigo]">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const sql = obtenerBaseDatos()!;
  const sucursal = await sucursalAccesiblePorCodigo(sql, sesion.usuarioId, codigo);
  // Sin permiso, la misma respuesta que si no existiera.
  if (!sucursal) notFound();
  const { aviso } = await searchParams;
  const [puedeEditar, puedeDesactivar, puedeVerUsuarios, puedeBuscarVisitantes, puedeVerExpedientes, puedeAbrirTurno, puedeVerTurno, puedeVerReporteTurnos, puedeVerificarAbonos, historial] = await Promise.all([
    tienePermiso(sql, sesion.usuarioId, "sucursal.editar", sucursal.id),
    tienePermiso(sql, sesion.usuarioId, "sucursal.desactivar", sucursal.id),
    tienePermiso(sql, sesion.usuarioId, "usuario.consultar", sucursal.id),
    tienePermiso(sql, sesion.usuarioId, "visitante.buscar", sucursal.id),
    tienePermiso(sql, sesion.usuarioId, "reporte.expedientes", sucursal.id),
    tienePermiso(sql, sesion.usuarioId, "turno.abrir", sucursal.id),
    tienePermiso(sql, sesion.usuarioId, "turno.consultar", sucursal.id),
    tienePermiso(sql, sesion.usuarioId, "reporte.turnos", sucursal.id),
    tienePermiso(sql, sesion.usuarioId, "cobro.verificar_abono", sucursal.id),
    historialSucursal(sql, sesion.usuarioId, sucursal.id),
  ]);

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
      {typeof aviso === "string" && AVISOS[aviso] ? <p className="aviso aviso-ok" role="status">{AVISOS[aviso]}</p> : null}
      {sucursal.estadoOperativo === "inactiva" ? (
        <p className="aviso aviso-info" data-testid="sucursal-inactiva">Esta sucursal está desactivada.</p>
      ) : null}
      {puedeEditar || puedeDesactivar || puedeVerUsuarios || puedeBuscarVisitantes || puedeVerExpedientes || puedeAbrirTurno || puedeVerTurno || puedeVerReporteTurnos || puedeVerificarAbonos ? (
        <p className="fila-acciones">
          {puedeAbrirTurno || puedeVerTurno ? (
            <Link className="boton boton-principal" href={`/sucursales/${sucursal.codigo}/turno`} data-testid="turno">
              Turno
            </Link>
          ) : null}
          {puedeBuscarVisitantes ? (
            <Link className="boton boton-principal" href={`/sucursales/${sucursal.codigo}/visitantes`} data-testid="visitantes">
              Visitantes
            </Link>
          ) : null}
          {puedeEditar || puedeDesactivar ? (
            <Link className="boton" href={`/sucursales/${sucursal.codigo}/editar`} data-testid="editar-sucursal">
              {puedeEditar ? "Editar sucursal" : sucursal.estadoOperativo === "inactiva" ? "Reactivar sucursal" : "Desactivar sucursal"}
            </Link>
          ) : null}
          {puedeVerificarAbonos ? (
            <Link className="boton" href={`/sucursales/${sucursal.codigo}/transferencias`} data-testid="transferencias">
              Transferencias por verificar
            </Link>
          ) : null}
          {puedeVerReporteTurnos ? (
            <Link className="boton" href={`/reportes/turnos?sucursal=${sucursal.codigo}`} data-testid="reporte-turnos">
              Reporte de turnos
            </Link>
          ) : null}
          {puedeVerExpedientes ? (
            <Link className="boton" href={`/reportes/expedientes?sucursal=${sucursal.codigo}`} data-testid="reporte-expedientes">
              Reporte de expedientes
            </Link>
          ) : null}
          {puedeVerUsuarios ? (
            <Link className="boton" href={`/reportes/usuarios?sucursal=${sucursal.codigo}`} data-testid="reporte-usuarios">
              Usuarios y accesos
            </Link>
          ) : null}
        </p>
      ) : null}

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

      {historial ? (
        <section className="tarjeta" aria-labelledby="titulo-historial" data-testid="historial-sucursal">
          <h2 id="titulo-historial" className="titulo-seccion">Historial</h2>
          <ol className="historial">
            {historial.map((h) => (
              <li key={h.id}>
                <strong>{ACCIONES[h.accion] ?? h.accion}</strong>
                <span className="sub"> · {fechaHora.format(h.en)} · {h.usuario ?? "Sistema"}</span>
                {h.motivo ? <div>Motivo: {h.motivo}</div> : null}
                {h.accion !== "crear" ? (
                  <ul className="historial-cambios">
                    {Object.entries(h.cambios as Record<string, { antes: unknown; despues: unknown }>).map(([campo, c]) => (
                      <li key={campo}>
                        {CAMPOS[campo] ?? campo}: {mostrar(campo, c.antes)} → {mostrar(campo, c.despues)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </main>
  );
}

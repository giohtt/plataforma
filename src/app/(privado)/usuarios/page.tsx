import Link from "next/link";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";
import { AREAS, historialAccesos, pantallaPerfiles, pantallaPersonas } from "@/lib/usuarios";

export const metadata = { title: "Usuarios, roles y permisos · Fitnessland" };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const VISTAS = { personas: "Personas", perfiles: "Perfiles", historial: "Historial" } as const;
const ORDEN_ROLES = ["recepcion", "encargado", "encargada_retiros", "administracion", "gestion_administrativa", "direccion"];

/** Sección para administrar cuentas, perfiles y permisos. El servidor comprueba los permisos en cada consulta y operación. */
export default async function Usuarios({ searchParams }: PageProps<"/usuarios">) {
  const sesion = await requerirSesion();
  const sql = obtenerBaseDatos()!;
  const { vista: v } = await searchParams;
  const vista = (typeof v === "string" && v in VISTAS ? v : "personas") as keyof typeof VISTAS;
  const lista = await pantallaPersonas(sql, sesion.usuarioId);
  if (!lista) notFound();

  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href="/">← Inicio</Link></p>
      <h1 className="cabecera-titulo">Usuarios, roles y permisos</h1>
      <p className="sub">
        Solo datos ficticios. Cada persona tiene una sola cuenta y puede reunir varios perfiles. Los perfiles son la base; a cada persona
        le puedes sumar o quitar permisos. Nada se da por omisión. Todo cambio queda en el historial.
      </p>
      <nav className="fila-acciones" aria-label="Vistas" data-testid="pestanas">
        {Object.entries(VISTAS).map(([k, t]) => (
          <Link key={k} className={k === vista ? "boton boton-principal" : "boton"} href={`/usuarios?vista=${k}`} aria-current={k === vista ? "page" : undefined}>{t}</Link>
        ))}
      </nav>
      {vista === "personas" ? <Personas lista={lista} /> : vista === "perfiles" ? <Perfiles usuarioId={sesion.usuarioId} /> : <Historial />}
    </main>
  );
}

function Personas({ lista }: { lista: NonNullable<Awaited<ReturnType<typeof pantallaPersonas>>> }) {
  return (
    <section className="tarjeta" data-testid="lista-personas">
      {lista.facultades.crear ? <p className="fila-acciones"><Link className="boton boton-principal" href="/usuarios/nueva" data-testid="nueva-persona">+ Nueva persona</Link></p> : null}
      <div className="tabla-desplazable">
        <table className="tabla">
          <thead><tr><th>Persona</th><th>Puesto</th><th>Perfiles y sucursales</th><th>Estado</th></tr></thead>
          <tbody>
            {lista.personas.map((p) => (
              <tr key={p.id} data-testid={`persona-${p.correo}`}>
                <td><Link href={`/usuarios/${p.id}`}><strong>{p.nombre}</strong></Link><br /><span className="sub">{p.correo}</span></td>
                <td>{p.puesto ?? <span className="sub">Sin puesto</span>}</td>
                <td>
                  {p.perfiles.length ? p.perfiles.map((x) => (
                    <span key={x.rol} className="chip-estado" style={{ marginRight: 4 }}>{x.nombre} · {x.todas ? "todas" : x.sucursales.join(", ")}</span>
                  )) : <span className="sub">Sin perfiles</span>}
                  {p.restricciones ? <><br /><span className="sub">{p.restricciones} {p.restricciones === 1 ? "permiso quitado" : "permisos quitados"}</span></> : null}
                  {p.autorrevisionHasta ? <><br /><span className="sub">Revisa lo propio hasta {fecha.format(p.autorrevisionHasta)}</span></> : null}
                </td>
                <td>
                  {!p.activo ? <span className="chip-estado chip-revocada">Desactivada</span>
                    : p.invitacion === "pendiente" ? <span className="chip-estado chip-programada">Invitada · sin contraseña</span>
                    : p.sinContrasena ? <span className="chip-estado chip-pendiente">Sin contraseña</span>
                    : <span className="chip-estado chip-vigente">Activa</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

async function Perfiles({ usuarioId }: { usuarioId: string }) {
  const p = (await pantallaPerfiles(obtenerBaseDatos()!, usuarioId))!;
  const roles = [...p.roles].sort((a, b) => (ORDEN_ROLES.indexOf(a.clave) + 1 || 99) - (ORDEN_ROLES.indexOf(b.clave) + 1 || 99));
  const conFunciones = roles.filter((r) => !r.sinFunciones);
  return (
    <section className="tarjeta" data-testid="perfiles">
      <p className="sub">
        Qué incluye cada perfil hoy. Es lo que la plataforma comprueba en el servidor en cada operación. A cada persona se le pueden sumar
        permisos o quitar permisos aunque vengan en su perfil (la restricción prevalece). Ningún perfil autoriza gastos ni devoluciones por
        sí solo: eso se da a cada persona con límite de monto.
      </p>
      <div className="tabla-desplazable">
        <table className="tabla">
          <thead><tr><th>Área · permiso</th>{conFunciones.map((r) => <th key={r.clave}>{r.nombre}</th>)}</tr></thead>
          <tbody>
            {AREAS.map((a) => {
              const permisos = p.permisos.filter((x) => x.area === a);
              return permisos.length ? [
                <tr key={a}><th colSpan={conFunciones.length + 1}>{a}</th></tr>,
                ...permisos.map((x) => (
                  <tr key={x.clave}>
                    <td>{x.tipo} · {x.descripcion}</td>
                    {conFunciones.map((r) => <td key={r.clave} style={{ textAlign: "center" }}>{p.incluye[r.clave]?.includes(x.clave) ? "✓" : <span className="sub">—</span>}</td>)}
                  </tr>
                )),
              ] : null;
            })}
          </tbody>
        </table>
      </div>
      <p className="sub">
        Perfiles sin funciones todavía (no dan permisos): {roles.filter((r) => r.sinFunciones).map((r) => r.nombre).join(", ")}. Se llenarán cuando existan
        esas funciones en la plataforma.
      </p>
    </section>
  );
}

async function Historial() {
  const h = await historialAccesos(obtenerBaseDatos()!);
  return (
    <section className="tarjeta" data-testid="historial-accesos">
      <p className="sub">Todo cambio de acceso: quién lo hizo, cuándo, a quién y qué cambió. No se puede borrar ni editar.</p>
      {h.length ? (
        <ul className="lista-simple">
          {h.map((x) => (
            <li key={x.id}>
              <strong>{fechaHora.format(x.en)}</strong> · {x.por ?? "La plataforma"} · <strong>{x.accion}</strong>{x.persona ? ` · ${x.persona}` : ""}
              {x.detalle ? <><br /><span className="sub">{x.detalle}</span></> : null}
              {x.motivo ? <><br /><span className="sub">Motivo: «{x.motivo}»</span></> : null}
            </li>
          ))}
        </ul>
      ) : <p className="sub">Sin cambios registrados.</p>}
    </section>
  );
}

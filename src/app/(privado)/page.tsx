import Link from "next/link";
import { CabeceraMarca } from "@/components/CabeceraMarca";
import { obtenerBaseDatos } from "@/lib/db";
import { NOMBRE_PERFIL, resumenAccesos, sucursalesAccesibles } from "@/lib/permisos";
import { requerirSesion } from "@/lib/sesion-servidor";

const ESTADO: Record<string, string> = { activa: "Activa", proxima: "Próxima apertura", inactiva: "Inactiva" };
const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

export default async function Inicio() {
  const sesion = await requerirSesion();
  const sql = obtenerBaseDatos()!;
  const [sucursales, accesos] = await Promise.all([
    sucursalesAccesibles(sql, sesion.usuarioId),
    resumenAccesos(sql, sesion.usuarioId),
  ]);

  return (
    <main className="contenedor">
      <CabeceraMarca titulo="Plataforma administrativa" subtitulo={sesion.nombre} />

      {sucursales.length === 0 ? (
        <section className="tarjeta" data-testid="sin-sucursales">
          <h2 className="titulo-seccion">Tu cuenta no tiene acceso a ninguna sucursal</h2>
          <p className="aviso aviso-info">
            Iniciaste sesión correctamente, pero todavía no tienes un perfil asignado en ninguna sucursal, o tus asignaciones
            ya no están vigentes. Pide a Dirección que te asigne el perfil y la sucursal que correspondan.
          </p>
        </section>
      ) : (
        <section className="tarjeta" aria-labelledby="titulo-sucursales">
          <h2 id="titulo-sucursales" className="titulo-seccion">Tus sucursales</h2>
          <ul className="rejilla-sucursales" data-testid="lista-sucursales">
            {sucursales.map((s) => (
              <li key={s.id}>
                <Link className="tarjeta-sucursal" href={`/sucursales/${s.codigo}`} data-codigo={s.codigo}>
                  <span className="muestra-color" style={{ background: s.color ?? "var(--muted)" }} aria-hidden="true" />
                  <span className="tarjeta-sucursal-texto">
                    <strong>{s.nombre}</strong>
                    <span className="sub">{ESTADO[s.estadoOperativo]} · {s.perfiles.map((p) => NOMBRE_PERFIL[p]).join(", ")}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tarjeta" aria-labelledby="titulo-accesos" data-testid="resumen-accesos">
        <h2 id="titulo-accesos" className="titulo-seccion">Tus accesos vigentes</h2>
        <div className="bloque-accesos">
          <h3>Perfiles por sucursal</h3>
          {accesos.asignaciones.length ? (
            <ul>
              {accesos.asignaciones.map((a) => (
                <li key={`${a.rol}-${a.codigo}`}>
                  {NOMBRE_PERFIL[a.rol]} en {a.sucursal}
                  {a.hasta ? <span className="sub"> · hasta {fecha.format(a.hasta)}</span> : null}
                </li>
              ))}
            </ul>
          ) : <p className="sub">Ninguno.</p>}
        </div>
        <div className="bloque-accesos" data-testid="alcance-general">
          <h3>Acceso a todas las sucursales</h3>
          {accesos.alcancesGenerales.length ? (
            <ul>
              {accesos.alcancesGenerales.map((g) => (
                <li key={g.rol}>
                  {NOMBRE_PERFIL[g.rol]} en todas las sucursales, incluidas las que se creen después
                  {g.hasta ? <span className="sub"> · hasta {fecha.format(g.hasta)}</span> : null}
                </li>
              ))}
            </ul>
          ) : <p className="sub">No otorgado.</p>}
        </div>
        <div className="bloque-accesos" data-testid="facultades">
          <h3>Facultades otorgadas</h3>
          {accesos.facultades.length ? (
            <ul>
              {accesos.facultades.map((f) => (
                <li key={`${f.permiso}-${f.sucursal ?? "todas"}`}>
                  {f.descripcion} · {f.todas ? "todas las sucursales" : f.sucursal}
                  {f.limite ? ` · límite ${pesos.format(Number(f.limite))}` : ""}
                  {f.hasta ? <span className="sub"> · hasta {fecha.format(f.hasta)}</span> : null}
                </li>
              ))}
            </ul>
          ) : <p className="sub">Ninguna.</p>}
        </div>
      </section>
    </main>
  );
}

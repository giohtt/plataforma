import Link from "next/link";
import { conPunto } from "@/lib/formato";
import { notFound } from "next/navigation";
import { obtenerBaseDatos } from "@/lib/db";
import { NOMBRE_PERFIL } from "@/lib/permisos";
import { reporteUsuariosSucursal, sucursalesConReporte, type EstadoAcceso } from "@/lib/reporte-usuarios";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Usuarios y accesos · Fitnessland" };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

const ESTADO: Record<EstadoAcceso, string> = {
  vigente: "Vigente",
  programada: "Programada",
  vencida: "Vencida",
  revocada: "Revocada",
  cuenta_desactivada: "Cuenta desactivada",
};

function Vigencia({ desde, hasta, revocadaEn }: { desde: Date; hasta: Date | null; revocadaEn: Date | null }) {
  return (
    <>
      {fecha.format(desde)} – {hasta ? fecha.format(hasta) : "sin fecha final"}
      {revocadaEn ? <span className="sub"> · revocada el {fecha.format(revocadaEn)}</span> : null}
    </>
  );
}

function Estado({ estado }: { estado: EstadoAcceso }) {
  return <span className={`chip-estado chip-${estado}`}>{ESTADO[estado]}</span>;
}

const quien = (nombre: string | null) => nombre ?? <span className="sub">No registrado</span>;

/**
 * Reporte de solo consulta. La sucursal se elige por la dirección (?sucursal=TEN); el servidor comprueba
 * usuario.consultar en esa sucursal. Sin permiso o inexistente: «No encontrada».
 */
export default async function ReporteUsuarios({ searchParams }: PageProps<"/reportes/usuarios">) {
  const sesion = await requerirSesion();
  const sql = obtenerBaseDatos()!;
  const parametros = await searchParams;
  const opciones = await sucursalesConReporte(sql, sesion.usuarioId);
  if (!opciones.length) notFound();

  const pedido = typeof parametros.sucursal === "string" ? parametros.sucursal : opciones[0].codigo;
  const anteriores = parametros.anteriores === "1";
  const r = await reporteUsuariosSucursal(sql, sesion.usuarioId, pedido, { anteriores });
  if (!r) notFound();

  return (
    <main className="contenedor">
      <p className="sub"><Link href={`/sucursales/${r.sucursal.codigo}`}>← {r.sucursal.nombre}</Link></p>
      <h1 className="cabecera-titulo">Usuarios y accesos por sucursal</h1>
      <p className="sub">Solo consulta. Generado el {conPunto(fechaHora.format(r.generadoEn))}</p>

      <form className="tarjeta filtros-reporte" method="get" action="/reportes/usuarios">
        <div className="campo">
          <label htmlFor="sucursal">Sucursal</label>
          <select id="sucursal" name="sucursal" defaultValue={r.sucursal.codigo}>
            {opciones.map((s) => <option key={s.id} value={s.codigo}>{s.nombre}</option>)}
          </select>
        </div>
        <label className="casilla">
          <input type="checkbox" name="anteriores" value="1" defaultChecked={anteriores} />
          Incluir anteriores (vencidas, revocadas, programadas y de cuentas desactivadas)
        </label>
        <button className="boton" type="submit">Ver</button>
      </form>

      <section className="tarjeta" data-testid="resumen-reporte">
        <p className="cifra-reporte"><strong data-testid="total-personas">{r.totalPersonas}</strong> personas con acceso vigente a {r.sucursal.nombre}</p>
        <p className="sub">Quien tiene acceso por más de una vía (por ejemplo, asignación local y acceso general) cuenta una sola vez.</p>
        {r.sucursal.estadoOperativo === "inactiva" ? <p className="aviso aviso-info">Esta sucursal está desactivada.</p> : null}
      </section>

      <section className="tarjeta" aria-labelledby="t-locales" data-testid="locales">
        <h2 id="t-locales" className="titulo-seccion">Asignaciones en {r.sucursal.nombre}</h2>
        {r.locales.length ? (
          <div className="tabla-desplazable">
            <table className="tabla">
              <thead><tr><th>Nombre</th><th>Perfil</th><th>Vigencia</th><th>Estado</th><th>Otorgado por</th></tr></thead>
              <tbody>
                {r.locales.map((a) => (
                  <tr key={a.id}>
                    <td data-etiqueta="Nombre">{a.nombre}</td><td data-etiqueta="Perfil">{NOMBRE_PERFIL[a.rol]}</td>
                    <td data-etiqueta="Vigencia"><Vigencia {...a} /></td><td data-etiqueta="Estado"><Estado estado={a.estado} /></td>
                    <td data-etiqueta="Otorgado por">{quien(a.otorgadoPor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub">Ninguna.</p>}
      </section>

      <section className="tarjeta" aria-labelledby="t-generales" data-testid="generales">
        <h2 id="t-generales" className="titulo-seccion">Acceso general que cubre {r.sucursal.nombre}</h2>
        <p className="sub">Perfiles otorgados para todas las sucursales, incluidas las que se creen después.</p>
        {r.generales.length ? (
          <div className="tabla-desplazable">
            <table className="tabla">
              <thead><tr><th>Nombre</th><th>Perfil</th><th>Vigencia</th><th>Estado</th><th>Otorgado por</th></tr></thead>
              <tbody>
                {r.generales.map((g) => (
                  <tr key={g.id}>
                    <td data-etiqueta="Nombre">{g.nombre}</td><td data-etiqueta="Perfil">{NOMBRE_PERFIL[g.rol]} en todas</td>
                    <td data-etiqueta="Vigencia"><Vigencia {...g} /></td><td data-etiqueta="Estado"><Estado estado={g.estado} /></td>
                    <td data-etiqueta="Otorgado por">{quien(g.otorgadoPor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub">Ninguno.</p>}
      </section>

      <section className="tarjeta" aria-labelledby="t-facultades" data-testid="facultades-sucursal">
        <h2 id="t-facultades" className="titulo-seccion">Facultades que aplican en {r.sucursal.nombre}</h2>
        <p className="sub">Solo las otorgadas para esta sucursal o para todas.</p>
        {r.facultades.length ? (
          <div className="tabla-desplazable">
            <table className="tabla">
              <thead><tr><th>Nombre</th><th>Facultad</th><th>Alcance</th><th>Límite</th><th>Vigencia</th><th>Estado</th><th>Otorgada por</th></tr></thead>
              <tbody>
                {r.facultades.map((f) => (
                  <tr key={f.id}>
                    <td data-etiqueta="Nombre">{f.nombre}</td><td data-etiqueta="Facultad">{f.descripcion}</td>
                    <td data-etiqueta="Alcance">{f.todas ? "Todas las sucursales" : "Esta sucursal"}</td>
                    <td data-etiqueta="Límite">{f.limite ? pesos.format(Number(f.limite)) : <span className="sub">Sin límite</span>}</td>
                    <td data-etiqueta="Vigencia"><Vigencia {...f} /></td><td data-etiqueta="Estado"><Estado estado={f.estado} /></td>
                    <td data-etiqueta="Otorgada por">{quien(f.otorgadoPor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="sub">Ninguna.</p>}
      </section>
    </main>
  );
}

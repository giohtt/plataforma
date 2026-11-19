import Link from "next/link";
import { notFound } from "next/navigation";
import {
  FormularioCambio, FormularioDatosPersona, FormularioEstadoPersona, FormularioInvitar,
} from "@/components/Usuarios";
import { obtenerBaseDatos } from "@/lib/db";
import { requerirSesion } from "@/lib/sesion-servidor";
import { AREAS, pantallaPersona, textoDonde } from "@/lib/usuarios";

export const metadata = { title: "Persona · Usuarios, roles y permisos · Fitnessland" };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const AVISOS: Record<string, string> = {
  creada: "Cuenta creada sin perfiles ni contraseña. Dale sus perfiles y sucursales, y genera su invitación.",
  editada: "Nombre y puesto guardados.", activada: "Cuenta activada.", desactivada: "Cuenta desactivada. Sus sesiones se cerraron.",
  guardado: "Cambio guardado. Quedó en el historial.",
};

function Vigencia({ desde, hasta, vigente }: { desde: Date; hasta: Date | null; vigente: boolean }) {
  return <span className="sub">{vigente ? "Desde" : "Empieza"} {fecha.format(desde)} · {hasta ? `hasta ${fechaHora.format(hasta)}` : "sin fecha de fin"}</span>;
}

export default async function Persona({ params, searchParams }: PageProps<"/usuarios/[id]">) {
  const sesion = await requerirSesion();
  const { id } = await params;
  const { aviso } = await searchParams;
  const p = await pantallaPersona(obtenerBaseDatos()!, sesion.usuarioId, id);
  if (!p) notFound();
  const f = p.facultades;
  const per = p.persona;
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href="/usuarios">← Usuarios, roles y permisos</Link></p>
      <h1 className="cabecera-titulo">{per.nombre}{p.propia ? <span className="sub"> · tu cuenta</span> : null}</h1>
      <p className="sub" data-testid="datos-persona">
        {per.correo} · Puesto: <strong data-testid="puesto">{per.puesto ?? "sin puesto"}</strong> ·{" "}
        {per.activo ? <span className="chip-estado chip-vigente">Activa</span> : <span className="chip-estado chip-revocada">Desactivada</span>}
        {per.sinContrasena ? <> · <span className="chip-estado chip-programada">{p.invitacion?.estado === "pendiente" ? "Invitada · sin contraseña" : "Sin contraseña"}</span></> : null}
      </p>
      {typeof aviso === "string" && AVISOS[aviso] ? <p className="aviso aviso-ok" role="status">{AVISOS[aviso]}</p> : null}

      <section className="tarjeta" aria-labelledby="t-perfiles" data-testid="perfiles-persona">
        <h2 id="t-perfiles" className="titulo-seccion">Perfiles</h2>
        <p className="sub">Un perfil es un paquete de permisos. Se da en una sucursal, en varias o en todas (incluidas las que se abran después), siempre con motivo.</p>
        {p.alcances.map((a) => (
          <div key={a.id} className="lista-grupo" data-testid={`perfil-${a.rol}-todas`}>
            <p><strong>{a.nombre}</strong> · <strong>Todas las sucursales</strong> (incluidas las futuras)<br /><Vigencia {...a} /> · {a.otorgadoPor ?? "—"} · «{a.motivo}»</p>
            {f.asignar ? <FormularioCambio persona={per.id} tipo="quitar_perfil" catalogo={p.catalogo} fijo={{ id: a.id, general: true, etiqueta: `${a.nombre} en todas las sucursales` }} /> : null}
          </div>
        ))}
        {p.asignaciones.map((a) => (
          <div key={a.id} className="lista-grupo" data-testid={`perfil-${a.rol}-${a.sucursal}`}>
            <p><strong>{a.nombre}</strong> · {a.sucursal}<br /><Vigencia {...a} /> · {a.otorgadoPor ?? "—"} · «{a.motivo}»</p>
            {f.asignar ? <FormularioCambio persona={per.id} tipo="quitar_perfil" catalogo={p.catalogo} fijo={{ id: a.id, etiqueta: `${a.nombre} en ${a.sucursal}` }} /> : null}
          </div>
        ))}
        {!p.alcances.length && !p.asignaciones.length ? <p className="sub">Sin perfiles.</p> : null}
        {f.asignar ? <FormularioCambio persona={per.id} tipo="dar_perfil" catalogo={p.catalogo} /> : null}
      </section>

      <section className="tarjeta" aria-labelledby="t-permisos" data-testid="permisos-persona">
        <h2 id="t-permisos" className="titulo-seccion">Permisos sumados y quitados</h2>
        <p className="sub">
          Se suman o se quitan a lo que dan sus perfiles. Un permiso quitado (restricción) <strong>prevalece</strong> sobre todos sus perfiles y
          permisos. Los permisos de autorizar siempre llevan límite de monto.
        </p>
        {p.permisos.map((x) => (
          <div key={x.id} className="lista-grupo" data-testid={`permiso-${x.permiso}`}>
            <p>+ <strong>{x.descripcion}</strong> · {x.todas ? "todas las sucursales" : x.sucursal}{x.limite ? ` · límite ${pesos.format(Number(x.limite))}` : ""}<br />
              <Vigencia {...x} /> · {x.otorgadoPor ?? "—"} · «{x.motivo}»</p>
            {f.asignar ? <FormularioCambio persona={per.id} tipo="quitar_permiso" catalogo={p.catalogo} fijo={{ id: x.id, etiqueta: `${x.descripcion} (${x.todas ? "todas" : x.sucursal})` }} /> : null}
          </div>
        ))}
        {p.restricciones.map((x) => (
          <div key={x.id} className="lista-grupo" data-testid={`restriccion-${x.permiso}`}>
            <p>− <strong>No puede: {x.descripcion}</strong> · {x.todas ? "todas las sucursales" : x.sucursal}<br />
              <Vigencia {...x} /> · {x.otorgadoPor ?? "—"} · «{x.motivo}»</p>
            {f.asignar ? <FormularioCambio persona={per.id} tipo="quitar_restriccion" catalogo={p.catalogo} fijo={{ id: x.id, etiqueta: `${x.descripcion} (${x.todas ? "todas" : x.sucursal})` }} /> : null}
          </div>
        ))}
        {!p.permisos.length && !p.restricciones.length ? <p className="sub">Ninguno: solo lo que dan sus perfiles.</p> : null}
        {f.asignar ? <p className="fila-acciones"><FormularioCambio persona={per.id} tipo="dar_permiso" catalogo={p.catalogo} /><FormularioCambio persona={per.id} tipo="restringir" catalogo={p.catalogo} /></p> : null}
      </section>

      {p.esDireccion || p.autorrevision ? (
        <section className="tarjeta" aria-labelledby="t-auto" data-testid="autorrevision">
          <h2 id="t-auto" className="titulo-seccion">Revisar lo propio (temporal)</h2>
          {p.autorrevision ? (
            <p className="aviso aviso-info" data-testid="autorrevision-vigente">
              Autorizada {p.autorrevision.todas ? "en todas las sucursales" : `en ${p.autorrevision.sucursal}`} del {fechaHora.format(p.autorrevision.desde)} al{" "}
              <strong>{fechaHora.format(p.autorrevision.hasta!)}</strong> · {p.autorrevision.otorgadoPor} · «{p.autorrevision.motivo}». Mientras esté vigente puede revisar
              diferencias e incidencias en las que participó; cada una queda marcada «Revisada por quien participó».
            </p>
          ) : (
            <p className="sub">Sin autorización: quien participó no revisa sus diferencias, aunque reúna varios perfiles.</p>
          )}
          <p className="sub">Solo para Dirección. Máximo 90 días, renovable, con motivo. Al vencer o terminarla vuelve sola la regla. Recepción y Encargado nunca revisan lo suyo.</p>
          {f.asignar ? (
            <p className="fila-acciones">
              <FormularioCambio persona={per.id} tipo="autorrevision" catalogo={p.catalogo} renovar={Boolean(p.autorrevision)} />
              {p.autorrevision ? <FormularioCambio persona={per.id} tipo="terminar_autorrevision" catalogo={p.catalogo} fijo={{ id: p.autorrevision.id, etiqueta: "la autorización para revisar lo propio" }} /> : null}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="tarjeta" aria-labelledby="t-resumen" data-testid="resumen-permisos">
        <h2 id="t-resumen" className="titulo-seccion">Lo que puede hacer hoy</h2>
        <p className="sub">
          Sucursales: <strong data-testid="sucursales-resumen">{p.resumen.todasLasSucursales
            ? `Todas (incluidas las que se abran después)${p.resumen.exceptoSucursales.length ? `, excepto ${p.resumen.exceptoSucursales.join(", ")}` : ""}`
            : p.resumen.sucursales.join(", ") || "Ninguna"}</strong>.
          Calculado con sus perfiles, permisos y restricciones vigentes (lo mismo que comprueba el servidor).
        </p>
        {AREAS.map((a) => {
          const xs = p.resumen.permisos.filter((x) => x.area === a);
          return xs.length ? (
            <div key={a} className="bloque-accesos">
              <h3>{a}</h3>
              <ul className="lista-simple">
                {xs.map((x) => (
                  <li key={x.clave} data-testid={`puede-${x.clave}`}>
                    {x.tipo} · {x.descripcion} · <span className="sub">{textoDonde(x)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null;
        })}
        {!p.resumen.permisos.length ? <p className="sub">Ningún permiso.</p> : null}
      </section>

      <section className="tarjeta" aria-labelledby="t-cuenta">
        <h2 id="t-cuenta" className="titulo-seccion">Cuenta</h2>
        {f.editar ? <FormularioDatosPersona id={per.id} nombre={per.nombre} puesto={per.puesto} /> : null}
        {f.restablecer && per.activo && per.esPrueba ? <FormularioInvitar id={per.id} nombre={per.nombre} pendiente={p.invitacion?.estado === "pendiente"} /> : null}
        {f.editar && !p.propia ? <FormularioEstadoPersona id={per.id} activo={per.activo} /> : null}
      </section>

      <section className="tarjeta" aria-labelledby="t-hist" data-testid="historial-persona">
        <h2 id="t-hist" className="titulo-seccion">Historial de accesos</h2>
        {p.historial.length ? (
          <ul className="lista-simple">
            {p.historial.map((x) => (
              <li key={x.id}>
                <strong>{fechaHora.format(x.en)}</strong> · {x.por ?? "La plataforma"} · <strong>{x.accion}</strong>
                {x.detalle ? <><br /><span className="sub">{x.detalle}</span></> : null}
                {x.motivo ? <><br /><span className="sub">Motivo: «{x.motivo}»</span></> : null}
              </li>
            ))}
          </ul>
        ) : <p className="sub">Sin cambios registrados.</p>}
      </section>
    </main>
  );
}

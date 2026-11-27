"use client";

import { useActionState, useState } from "react";
import {
  accionCambioAcceso, accionCrearPersona, accionEditarPersona, accionEstadoPersona, accionInvitar, type EstadoUsuarios,
} from "@/app/acciones-usuarios";
import type { Catalogo } from "@/lib/usuarios";

function Aviso({ estado }: { estado: EstadoUsuarios }) {
  return estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null;
}
function ErrorCampo({ estado, campo }: { estado: EstadoUsuarios; campo: string }) {
  const e = estado?.errores?.[campo];
  return e ? <span className="campo-error">{e}</span> : null;
}
function Texto({ estado, campo, etiqueta, ayuda, defecto = "", max = 120, tipo = "text" }: {
  estado: EstadoUsuarios; campo: string; etiqueta: string; ayuda?: string; defecto?: string; max?: number; tipo?: string;
}) {
  return (
    <div className="campo">
      <label htmlFor={campo}>{etiqueta}</label>
      <input id={campo} name={campo} type={tipo} maxLength={max} defaultValue={estado?.valores?.[campo] ?? defecto}
        aria-invalid={estado?.errores?.[campo] ? true : undefined} autoComplete="off" />
      {ayuda ? <span className="sub">{ayuda}</span> : null}
      <ErrorCampo estado={estado} campo={campo} />
    </div>
  );
}
function Motivo({ estado, etiqueta = "Motivo" }: { estado: EstadoUsuarios; etiqueta?: string }) {
  return (
    <div className="campo">
      <label htmlFor="motivo">{etiqueta}</label>
      <textarea id="motivo" name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""}
        aria-invalid={estado?.errores?.motivo ? true : undefined} />
      <ErrorCampo estado={estado} campo="motivo" />
    </div>
  );
}

export function FormularioNuevaPersona() {
  const [estado, accion, enviando] = useActionState(accionCrearPersona, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-nueva-persona">
      <Aviso estado={estado} />
      <Texto estado={estado} campo="nombre" etiqueta="Nombre" max={120} />
      <Texto estado={estado} campo="correo" etiqueta="Correo" tipo="email" max={254} ayuda="Con él entra a la plataforma. Cada persona tiene una sola cuenta." />
      <Texto estado={estado} campo="puesto" etiqueta="Puesto (opcional)" max={80} ayuda="Solo el nombre del cargo; no da permisos." />
      <p className="sub">La cuenta nace sin perfiles ni contraseña. Después le das sus perfiles y sucursales (con vista previa) y generas su invitación.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Creando…" : "Crear cuenta"}</button>
    </form>
  );
}

export function FormularioDatosPersona({ id, nombre, puesto }: { id: string; nombre: string; puesto: string | null }) {
  const [estado, accion, enviando] = useActionState(accionEditarPersona, null);
  return (
    <form action={accion} className="formulario formulario-compacto" key={estado?.intento ?? 0} noValidate data-testid="formulario-datos">
      <Aviso estado={estado} />
      <input type="hidden" name="id" value={id} />
      <Texto estado={estado} campo="nombre" etiqueta="Nombre" defecto={nombre} />
      <Texto estado={estado} campo="puesto" etiqueta="Puesto" defecto={puesto ?? ""} max={80} ayuda="El nombre del cargo; no cambia sus permisos." />
      <button className="boton" type="submit" disabled={enviando}>{enviando ? "Guardando…" : "Guardar nombre y puesto"}</button>
    </form>
  );
}

export function FormularioEstadoPersona({ id, activo }: { id: string; activo: boolean }) {
  const [estado, accion, enviando] = useActionState(accionEstadoPersona, null);
  return (
    <form action={accion} className="formulario formulario-compacto" key={estado?.intento ?? 0} noValidate data-testid="formulario-estado">
      <Aviso estado={estado} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="activo" value={activo ? "no" : "si"} />
      <p className="sub">
        {activo ? "Desactivar no borra: la cuenta deja de entrar y pierde todos sus permisos al instante; se cierran sus sesiones y se conserva su historial."
          : "Al activarla vuelve a entrar con los perfiles y permisos que sigan vigentes."}
      </p>
      <Motivo estado={estado} />
      <button className={activo ? "boton boton-peligro" : "boton"} type="submit" disabled={enviando}>
        {enviando ? "Guardando…" : activo ? "Desactivar la cuenta" : "Activar la cuenta"}
      </button>
    </form>
  );
}

const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "long", timeStyle: "short" });

export function FormularioInvitar({ id, nombre, pendiente }: { id: string; nombre: string; pendiente: boolean }) {
  const [estado, accion, enviando] = useActionState(accionInvitar, null);
  const [copiado, setCopiado] = useState(false);
  const inv = estado?.invitacion;
  return (
    <form action={accion} className="formulario formulario-compacto" noValidate data-testid="formulario-invitar">
      <Aviso estado={estado} />
      <input type="hidden" name="id" value={id} />
      {inv ? (
        <div className="aviso aviso-ok" data-testid="invitacion">
          <p>Invitación lista. Enlace de un solo uso para que {nombre} fije su contraseña; vence el {fechaHora.format(new Date(inv.expira))}.
            Se muestra solo esta vez; tú nunca ves ni escribes su contraseña.</p>
          <p className="mono" data-testid="enlace-invitacion" style={{ wordBreak: "break-all" }}>{inv.enlace}</p>
          <p className="fila-acciones">
            <button className="boton" type="button" onClick={() => { void navigator.clipboard?.writeText(inv.enlace); setCopiado(true); }}>
              {copiado ? "Copiado" : "Copiar enlace"}
            </button>
            <a className="boton" href={`https://wa.me/?text=${encodeURIComponent(`Hola, ${nombre}. Entra a este enlace para crear tu contraseña de Fitnessland (vence en 48 horas): ${inv.enlace}`)}`}
              target="_blank" rel="noopener noreferrer">Compartir por WhatsApp</a>
          </p>
        </div>
      ) : null}
      <p className="sub">
        {pendiente ? "Ya tiene una invitación pendiente. Generar otra invalida la anterior." : "Enlace de un solo uso, válido por 48 horas. Generar otro invalida el anterior."}
      </p>
      <button className="boton" type="submit" disabled={enviando}>{enviando ? "Generando…" : inv || pendiente ? "Generar otra invitación" : "Generar invitación"}</button>
    </form>
  );
}

function Alcance({ estado, catalogo, una = false, soloTodas = false }: { estado: EstadoUsuarios; catalogo: Catalogo; una?: boolean; soloTodas?: boolean }) {
  const [modo, setModo] = useState(estado?.valores?.alcance ?? "");
  const elegidas = (estado?.valores?.sucursales ?? "").split(",").filter(Boolean);
  return (
    <fieldset className="campo campo-grupo" aria-invalid={estado?.errores?.alcance ? true : undefined} data-testid="alcance">
      <legend>¿En qué sucursales?</legend>
      {soloTodas ? null : (
        <label className="opcion-revision">
          <input type="radio" name="alcance" value="elegir" checked={modo === "elegir"} onChange={() => setModo("elegir")} />
          <span>{una ? "Una sucursal" : "Elegir sucursales (una o varias)"}</span>
        </label>
      )}
      {modo === "elegir" && !soloTodas ? (
        <div className="lista-simple" style={{ paddingLeft: 28 }}>
          {catalogo.sucursales.map((s) => (
            <label key={s.id} className="opcion-revision">
              <input type={una ? "radio" : "checkbox"} name="sucursal" value={s.id} defaultChecked={elegidas.includes(s.id)} />
              <span>{s.nombre}</span>
            </label>
          ))}
        </div>
      ) : null}
      <label className="opcion-revision">
        <input type="radio" name="alcance" value="todas" checked={modo === "todas"} onChange={() => setModo("todas")} />
        <span><strong>Todas las sucursales</strong> · incluye las que se abran después</span>
      </label>
      <span className="sub">Ninguna opción viene marcada: elige expresamente.</span>
      <ErrorCampo estado={estado} campo="alcance" />
    </fieldset>
  );
}

function SelectorPermiso({ estado, catalogo, alElegir, excluir = [] }: {
  estado: EstadoUsuarios; catalogo: Catalogo; alElegir?: (clave: string) => void; excluir?: string[];
}) {
  const areas = [...new Set(catalogo.permisos.map((p) => p.area))];
  return (
    <div className="campo">
      <label htmlFor="permiso">Permiso</label>
      <select id="permiso" name="permiso" defaultValue={estado?.valores?.permiso ?? ""} onChange={(e) => alElegir?.(e.target.value)}
        aria-invalid={estado?.errores?.permiso ? true : undefined}>
        <option value="">Elige un permiso…</option>
        {areas.map((a) => (
          <optgroup key={a} label={a}>
            {catalogo.permisos.filter((p) => p.area === a && !excluir.includes(p.clave)).map((p) => (
              <option key={p.clave} value={p.clave}>{p.tipo} · {p.descripcion}{p.general ? " (general)" : ""}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <ErrorCampo estado={estado} campo="permiso" />
    </div>
  );
}

const TITULO: Record<string, { boton: string; ayuda?: string }> = {
  dar_perfil: { boton: "Dar un perfil" },
  dar_permiso: { boton: "Dar un permiso", ayuda: "Se suma a lo que le dan sus perfiles. Los de autorizar llevan límite de monto." },
  restringir: { boton: "Quitar un permiso (restricción)", ayuda: "Prevalece sobre todos sus perfiles y permisos: aunque un perfil lo incluya, no lo tendrá." },
  autorrevision: { boton: "Autorizar que revise lo propio", ayuda: "Solo para Dirección. Máximo 90 días, renovable. Cada revisión queda marcada «Revisada por quien participó»." },
  quitar_perfil: { boton: "Quitar" }, quitar_permiso: { boton: "Quitar" }, quitar_restriccion: { boton: "Quitar restricción" },
  terminar_autorrevision: { boton: "Terminar ahora" },
  autorresolucion: { boton: "Autorizar que resuelva lo propio", ayuda: "Solo para Dirección. Aparte de la de revisar lo propio. Máximo 90 días, se renueva solo a mano. Solo faltantes ya confirmados de retiros y sobres, con «Lo absorbe la sucursal»; cada resolución queda marcada «Resuelta por quien participó»." },
  terminar_autorresolucion: { boton: "Terminar ahora" },
  facultad_gasto: { boton: "Autorizar gastos" },
};

/**
 * Cambio de acceso en dos pasos: primero «Revisar cómo quedará» (no guarda nada) y luego «Confirmar y guardar». Si se
 * cambia algún dato después de revisar, hay que volver a revisar.
 */
export function FormularioCambio({ persona, tipo, catalogo, fijo, renovar = false, abierto = false }: {
  persona: string; tipo: keyof typeof TITULO; catalogo: Catalogo;
  /** Para quitar: el registro y cómo se llama. */
  fijo?: { id: string; general?: boolean; etiqueta: string };
  renovar?: boolean; abierto?: boolean;
}) {
  const [estado, accion, enviando] = useActionState(accionCambioAcceso, null);
  const [mostrar, setMostrar] = useState(abierto);
  // Si cambia algún dato después de revisar, se oculta la vista previa y hay que volver a revisar.
  const [cambiadoEn, setCambiadoEn] = useState<number | null>(null);
  const [permiso, setPermiso] = useState(estado?.valores?.permiso ?? "");
  const [sinLimite, setSinLimite] = useState(estado?.valores?.sinLimite === "si");
  const esAutorizacion = catalogo.permisos.find((p) => p.clave === permiso)?.esAutorizacion ?? false;
  const vista = estado?.vista && cambiadoEn !== estado.intento ? estado.vista : null;
  if (!mostrar && !estado) {
    return (
      <button className={fijo ? "boton boton-chico" : "boton"} type="button" onClick={() => setMostrar(true)} data-testid={`abrir-${tipo}`}>
        {renovar ? "Renovar…" : TITULO[tipo].boton}
      </button>
    );
  }
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid={`formulario-${tipo}`}
      onChange={() => setCambiadoEn(estado?.intento ?? 0)}>
      <Aviso estado={estado} />
      <input type="hidden" name="persona" value={persona} />
      <input type="hidden" name="tipo" value={tipo} />
      {fijo ? <><input type="hidden" name="id" value={fijo.id} /><input type="hidden" name="general" value={fijo.general ? "si" : "no"} />
        <p><strong>{TITULO[tipo].boton}:</strong> {fijo.etiqueta}</p></> : <h3>{renovar ? "Renovar la autorización" : TITULO[tipo].boton}</h3>}
      {TITULO[tipo].ayuda ? <p className="sub">{TITULO[tipo].ayuda}</p> : null}
      {tipo === "dar_perfil" ? (
        <div className="campo">
          <label htmlFor="rol">Perfil</label>
          <select id="rol" name="rol" defaultValue={estado?.valores?.rol ?? ""} aria-invalid={estado?.errores?.rol ? true : undefined}>
            <option value="">Elige un perfil…</option>
            {catalogo.roles.map((r) => <option key={r.clave} value={r.clave}>{r.nombre}{r.sinFunciones ? " (sin funciones todavía)" : ""}</option>)}
          </select>
          <ErrorCampo estado={estado} campo="rol" />
        </div>
      ) : null}
      {tipo === "dar_permiso" || tipo === "restringir"
        ? <SelectorPermiso estado={estado} catalogo={catalogo} alElegir={setPermiso} excluir={tipo === "dar_permiso" ? ["autorizacion.gasto"] : []} />
        : null}
      {tipo === "facultad_gasto" ? (
        <>
          <label className="opcion-revision">
            <input type="checkbox" name="sinLimite" value="si" checked={sinLimite} onChange={(e) => setSinLimite(e.target.checked)} />
            <span><strong>Sin límite</strong> · solo para una cuenta con Dirección en esas sucursales</span>
          </label>
          {sinLimite ? null : (
            <div className="campos-fila">
              <div className="campo">
                <label htmlFor="limite">Límite por gasto</label>
                <div className="importe"><span aria-hidden="true">$</span>
                  <input id="limite" name="limite" inputMode="decimal" defaultValue={estado?.valores?.limite ?? ""} aria-invalid={estado?.errores?.limite ? true : undefined} />
                </div>
                <ErrorCampo estado={estado} campo="limite" />
              </div>
              <div className="campo">
                <label htmlFor="diario">Acumulado diario</label>
                <div className="importe"><span aria-hidden="true">$</span>
                  <input id="diario" name="diario" inputMode="decimal" defaultValue={estado?.valores?.diario ?? ""} aria-invalid={estado?.errores?.diario ? true : undefined} />
                </div>
                <span className="sub">Suma de lo que autoriza en un día en esa sucursal.</span>
                <ErrorCampo estado={estado} campo="diario" />
              </div>
            </div>
          )}
          {sinLimite ? <ErrorCampo estado={estado} campo="limite" /> : null}
        </>
      ) : null}
      {tipo === "dar_permiso" && (esAutorizacion || estado?.valores?.limite) ? (
        <div className="campo">
          <label htmlFor="limite">Límite de monto por autorización</label>
          <div className="importe"><span aria-hidden="true">$</span>
            <input id="limite" name="limite" inputMode="decimal" defaultValue={estado?.valores?.limite ?? ""} aria-invalid={estado?.errores?.limite ? true : undefined} />
          </div>
          <ErrorCampo estado={estado} campo="limite" />
        </div>
      ) : null}
      {["dar_perfil", "dar_permiso", "restringir", "autorrevision", "autorresolucion", "facultad_gasto"].includes(tipo) ? (
        <Alcance estado={estado} catalogo={catalogo} una={tipo === "autorrevision" || tipo === "autorresolucion"} />
      ) : null}
      {["dar_perfil", "dar_permiso", "restringir", "facultad_gasto"].includes(tipo) ? (
        <div className="campo">
          <label htmlFor="hasta">Hasta (opcional)</label>
          <input id="hasta" name="hasta" type="date" min={catalogo.hoy} defaultValue={estado?.valores?.hasta ?? ""} aria-invalid={estado?.errores?.hasta ? true : undefined} />
          <span className="sub">Vacío: sin fecha de fin. Vence al terminar ese día.</span>
          <ErrorCampo estado={estado} campo="hasta" />
        </div>
      ) : null}
      {tipo === "autorrevision" || tipo === "autorresolucion" ? (
        <div className="campo">
          <label htmlFor="hasta">Hasta</label>
          <input id="hasta" name="hasta" type="date" min={catalogo.hoy} max={catalogo.maxAutorrevision}
            defaultValue={estado?.valores?.hasta ?? catalogo.maxAutorrevision} aria-invalid={estado?.errores?.hasta ? true : undefined} />
          <span className="sub">Máximo 90 días desde ahora (a más tardar el {catalogo.maxAutorrevision.split("-").reverse().join("/")}, a esta hora).</span>
          <ErrorCampo estado={estado} campo="hasta" />
        </div>
      ) : null}
      <Motivo estado={estado} />
      {vista ? (
        <div className="vista-previa" data-testid="vista-previa">
          <h3>Así quedará</h3>
          <p>{vista.detalle}</p>
          <p className="sub"><strong>Sucursales:</strong> {vista.sucursalesAntes === vista.sucursalesDespues ? vista.sucursalesDespues : `${vista.sucursalesAntes} → ${vista.sucursalesDespues}`}</p>
          {vista.gana.length ? (
            <><p><strong>Podrá:</strong></p><ul className="lista-simple" data-testid="gana">{vista.gana.map((g) => <li key={g.clave}>{g.descripcion} · {g.despues}</li>)}</ul></>
          ) : null}
          {vista.pierde.length ? (
            <><p><strong>Ya no podrá:</strong></p><ul className="lista-simple" data-testid="pierde">{vista.pierde.map((g) => <li key={g.clave}>{g.descripcion} · antes: {g.antes}</li>)}</ul></>
          ) : null}
          {vista.cambia.length ? (
            <><p><strong>Cambia dónde:</strong></p><ul className="lista-simple" data-testid="cambia">{vista.cambia.map((g) => <li key={g.clave}>{g.descripcion} · {g.antes} → {g.despues}</li>)}</ul></>
          ) : null}
          {!vista.gana.length && !vista.pierde.length && !vista.cambia.length ? <p className="sub" data-testid="sin-cambio-permisos">Sus permisos no cambian (ya los tiene por otra vía, o el cambio no da ni quita permisos).</p> : null}
          <p className="sub">«Todas» incluye las sucursales que se abran después.</p>
        </div>
      ) : null}
      <p className="fila-acciones">
        <button className="boton" type="submit" name="paso" value="revisar" disabled={enviando}>{enviando ? "Revisando…" : vista ? "Volver a revisar" : "Revisar cómo quedará"}</button>
        {vista ? <button className="boton boton-principal" type="submit" name="paso" value="confirmar" disabled={enviando}>Confirmar y guardar</button> : null}
      </p>
    </form>
  );
}

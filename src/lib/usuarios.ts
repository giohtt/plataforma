import type postgres from "postgres";
import { generarToken, huellaToken } from "@/lib/tokens";
import { normalizarCorreo } from "@/lib/autenticacion";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido, NOMBRE_PERFIL, type Rol } from "@/lib/permisos";

/**
 * Sección «Usuarios, roles y permisos» (aprobada el 19 nov 2026, 16:22; solo datos ficticios).
 *
 * - Cada persona tiene una sola cuenta y puede reunir varios perfiles. Los perfiles son la base; a cada persona se le
 *   pueden sumar permisos (facultades) y quitar permisos (restricciones), aunque vengan en su perfil. Una restricción
 *   prevalece siempre (la base la aplica en tiene_permiso).
 * - Sucursales elegidas expresamente: una, varias o «todas» (incluye las que se abran después).
 * - Antes de guardar se muestra cómo quedarán sus permisos y sucursales: el cambio se aplica en una transacción que se
 *   deshace, se calcula el resultado con las mismas funciones de la base y se compara con lo de antes.
 * - Todo cambio queda en el historial (quién, cuándo, qué y motivo). Cada operación vuelve a comprobar el permiso en el
 *   servidor; ocultar botones es solo comodidad.
 * - Invitaciones de un solo uso por 48 horas; generar otra invalida la anterior.
 * - Autorización personal (máximo 90 días, renovable) para que Dirección revise lo que le tocó participar.
 * - Siempre queda una cuenta activa que administra accesos sin vencimiento (lo exige la base).
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export const HORAS_INVITACION = 48;
export const DIAS_AUTORREVISION = 90;
const ZONA = "America/Mexico_City";

// ---------------------------------------------------------------------------
// Áreas y tipo de cada permiso (para agrupar en pantalla)
// ---------------------------------------------------------------------------
export const AREAS = [
  "Cuentas y accesos", "Sucursales y configuración", "Cobros y visitas", "Expedientes", "Control de acceso", "Efectivo y turnos",
  "Diferencias", "Fondos", "Retiros", "Sobres, buzón y depósitos", "Gastos", "Reportes",
] as const;
export type Area = (typeof AREAS)[number];
export type TipoPermiso = "Consultar" | "Registrar" | "Revisar" | "Autorizar";

export function areaDe(clave: string): Area {
  if (clave === "caja.retirar" || clave.startsWith("retiro.")) return "Retiros";
  if (clave.startsWith("usuario.") || clave === "historial.consultar") return "Cuentas y accesos";
  if (clave.startsWith("sucursal.") || clave.startsWith("promocion.") || clave === "historial.cobertura") return "Sucursales y configuración";
  if (clave.startsWith("visita.") || clave.startsWith("cobro.") || clave.startsWith("pase.") || clave.startsWith("beneficio.") || clave === "autorizacion.devolucion") return "Cobros y visitas";
  if (clave.startsWith("visitante.")) return "Expedientes";
  if (clave.startsWith("acceso.")) return "Control de acceso";
  if (clave.startsWith("turno.") || clave.startsWith("caja.")) return "Efectivo y turnos";
  if (clave.startsWith("diferencia.")) return "Diferencias";
  if (clave.startsWith("fondo.")) return "Fondos";
  if (clave.startsWith("sobre.") || clave.startsWith("custodia.")) return "Sobres, buzón y depósitos";
  if (clave.startsWith("gasto.") || clave === "autorizacion.gasto") return "Gastos";
  return "Reportes";
}
export function tipoDe(clave: string, esAutorizacion: boolean): TipoPermiso {
  if (esAutorizacion || /autorizar|asignar/.test(clave)) return "Autorizar";
  if (/consultar|buscar|^reporte\.|resumen|historial_general/.test(clave)) return "Consultar";
  if (/revisar|verificar|comprobar|resolver/.test(clave)) return "Revisar";
  return "Registrar";
}

// ---------------------------------------------------------------------------
// Permisos de quien administra
// ---------------------------------------------------------------------------
export type Facultades = { crear: boolean; editar: boolean; asignar: boolean; restablecer: boolean };
export async function facultadesAdministrar(db: Sql | Tx, usuarioId: string): Promise<Facultades> {
  const [f] = await db<Facultades[]>`
    select tiene_permiso(${usuarioId}, 'usuario.crear', null) as crear, tiene_permiso(${usuarioId}, 'usuario.editar', null) as editar,
           tiene_permiso(${usuarioId}, 'usuario.asignar', null) as asignar, tiene_permiso(${usuarioId}, 'usuario.restablecer', null) as restablecer`;
  return f;
}
const algunaFacultad = (f: Facultades) => f.crear || f.editar || f.asignar || f.restablecer;

// ---------------------------------------------------------------------------
// Resumen de lo que puede hacer una persona (calculado con tiene_permiso)
// ---------------------------------------------------------------------------
export type LimiteAplicado = { limite: string; sucursales: string[]; futuras: boolean };
export type PermisoEfectivo = {
  clave: string; descripcion: string; area: Area; tipo: TipoPermiso;
  /** Vale en todas las sucursales, incluidas las futuras (por perfil o permiso en «todas»). */
  todas: boolean;
  /** Sucursales donde lo tiene hoy. */
  sucursales: string[];
  /** Con «todas»: sucursales de hoy donde NO lo tiene (restricción por sucursal). */
  excepto: string[];
  /** Permisos de autorizar: el límite que realmente aplica en cada sucursal (el mayor vigente que la cubre). */
  limites: LimiteAplicado[];
};
export type ResumenPermisos = { permisos: PermisoEfectivo[]; sucursales: string[]; todasLasSucursales: boolean; exceptoSucursales: string[] };

export async function resumenPermisos(db: Sql | Tx, usuarioId: string): Promise<ResumenPermisos> {
  const permisos = await db<{ clave: string; descripcion: string; ambito: string; es_autorizacion: boolean; general: boolean; futuras: boolean;
                              limite_futuras: string | null }[]>`
    select p.clave, p.descripcion, p.ambito, p.es_autorizacion,
           p.ambito = 'general' and tiene_permiso(${usuarioId}, p.clave, null) as general,
           -- Alcance en todas (incluidas las futuras): por perfil general o permiso en «todas», sin restricción en todas.
           p.ambito = 'sucursal' and exists (select 1 from usuario u where u.id = ${usuarioId} and u.activo)
             and (exists (select 1 from alcance_general g join rol_permiso rp on rp.rol = g.rol and rp.permiso = p.clave
                          where g.usuario_id = ${usuarioId} and vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en))
                  or exists (select 1 from facultad_otorgada f where f.usuario_id = ${usuarioId} and f.permiso = p.clave and f.todas_las_sucursales
                             and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en)))
             and not exists (select 1 from restriccion_permiso r where r.usuario_id = ${usuarioId} and r.permiso = p.clave and r.todas_las_sucursales
                             and vigente(r.vigente_desde, r.vigente_hasta, r.revocada_en)) as futuras,
           (select max(f.limite_monto)::text from facultad_otorgada f where f.usuario_id = ${usuarioId} and f.permiso = p.clave and f.todas_las_sucursales
              and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en)) as limite_futuras
    from permiso p order by p.clave`;
  // Cada permiso en cada sucursal, con el límite que aplica ahí (el mismo cálculo que usa la autorización).
  const celdas = await db<{ clave: string; sucursal: string; ok: boolean; limite: string | null }[]>`
    select p.clave, s.nombre as sucursal, tiene_permiso(${usuarioId}, p.clave, s.id) as ok,
           case when p.es_autorizacion then (select max(f.limite_monto)::text from facultad_otorgada f
                where f.usuario_id = ${usuarioId} and f.permiso = p.clave and (f.sucursal_id = s.id or f.todas_las_sucursales)
                  and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en)) end as limite
    from permiso p cross join sucursal s where p.ambito = 'sucursal' order by s.nombre`;
  const de = new Map<string, (typeof celdas)[number][]>();
  for (const c of celdas) de.set(c.clave, [...(de.get(c.clave) ?? []), c]);
  const [s] = await db<{ sucursales: string[]; excepto: string[]; todas: boolean }[]>`
    select coalesce(array(select s.nombre from sucursal s where tiene_permiso(${usuarioId}, 'sucursal.consultar', s.id) order by s.nombre), '{}') as sucursales,
           coalesce(array(select s.nombre from sucursal s where not tiene_permiso(${usuarioId}, 'sucursal.consultar', s.id) order by s.nombre), '{}') as excepto,
           exists (select 1 from usuario u where u.id = ${usuarioId} and u.activo)
             and exists (select 1 from alcance_general g where g.usuario_id = ${usuarioId} and vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en))
             and not permiso_restringido(${usuarioId}, 'sucursal.consultar', null) as todas`;
  const salida: PermisoEfectivo[] = [];
  for (const p of permisos) {
    const cs = de.get(p.clave) ?? [];
    const si = cs.filter((c) => c.ok);
    if (!p.general && !p.futuras && !si.length) continue;
    const limites: LimiteAplicado[] = [];
    if (p.es_autorizacion) {
      for (const c of si) {
        if (!c.limite) continue;
        const l = limites.find((x) => x.limite === c.limite);
        if (l) l.sucursales.push(c.sucursal);
        else limites.push({ limite: c.limite, sucursales: [c.sucursal], futuras: false });
      }
      if (p.futuras && p.limite_futuras) {
        const l = limites.find((x) => x.limite === p.limite_futuras);
        if (l) l.futuras = true;
        else limites.push({ limite: p.limite_futuras, sucursales: [], futuras: true });
      }
      limites.sort((a, b) => Number(a.limite) - Number(b.limite));
    }
    salida.push({
      clave: p.clave, descripcion: p.descripcion, area: areaDe(p.clave), tipo: tipoDe(p.clave, p.es_autorizacion),
      todas: p.general || p.futuras, sucursales: si.map((c) => c.sucursal),
      excepto: p.futuras ? cs.filter((c) => !c.ok).map((c) => c.sucursal) : [], limites,
    });
  }
  return { permisos: salida, sucursales: s.sucursales, todasLasSucursales: s.todas, exceptoSucursales: s.todas ? s.excepto : [] };
}

export type CambioPermiso = { clave: string; descripcion: string; area: Area; antes: string; despues: string };
export type VistaPrevia = {
  gana: CambioPermiso[]; pierde: CambioPermiso[]; cambia: CambioPermiso[];
  sucursalesAntes: string; sucursalesDespues: string;
};
const pesosTexto = (v: string) => `$${Number(v).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lista = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`;
/** Dónde vale un permiso, con sus excepciones por sucursal y el límite que aplica en cada una. */
export function textoDonde(p: PermisoEfectivo | undefined): string {
  if (!p) return "—";
  const base = p.todas ? `Todas (incluidas las futuras)${p.excepto.length ? `, excepto ${lista(p.excepto)}` : ""}` : p.sucursales.join(", ");
  if (!p.limites.length) return base;
  const lims = p.limites.map((l) => {
    const donde = l.futuras && l.sucursales.length === p.sucursales.length ? "todas" : lista(l.futuras ? [...l.sucursales, "las futuras"] : l.sucursales);
    return `límite ${pesosTexto(l.limite)} en ${donde}`;
  });
  return `${base} · ${lims.join(" · ")}`;
}
const dondeSucursales = (r: ResumenPermisos) => r.todasLasSucursales
  ? `Todas (incluidas las que se abran después)${r.exceptoSucursales.length ? `, excepto ${lista(r.exceptoSucursales)}` : ""}`
  : r.sucursales.length ? r.sucursales.join(", ") : "Ninguna";
export function compararResumen(antes: ResumenPermisos, despues: ResumenPermisos): VistaPrevia {
  const a = new Map(antes.permisos.map((p) => [p.clave, p]));
  const d = new Map(despues.permisos.map((p) => [p.clave, p]));
  const fila = (clave: string): CambioPermiso => {
    const p = (d.get(clave) ?? a.get(clave))!;
    return { clave, descripcion: p.descripcion, area: p.area, antes: textoDonde(a.get(clave)), despues: textoDonde(d.get(clave)) };
  };
  return {
    gana: [...d.keys()].filter((k) => !a.has(k)).map(fila),
    pierde: [...a.keys()].filter((k) => !d.has(k)).map(fila),
    cambia: [...d.keys()].filter((k) => a.has(k) && textoDonde(a.get(k)) !== textoDonde(d.get(k))).map(fila),
    sucursalesAntes: dondeSucursales(antes), sucursalesDespues: dondeSucursales(despues),
  };
}

// ---------------------------------------------------------------------------
// Pantallas
// ---------------------------------------------------------------------------
export type PerfilPersona = { rol: Rol; nombre: string; todas: boolean; sucursales: string[] };
export type PersonaLista = {
  id: string; nombre: string; correo: string; puesto: string | null; activo: boolean; sinContrasena: boolean;
  invitacion: "pendiente" | "vencida" | null; perfiles: PerfilPersona[]; restricciones: number; autorrevisionHasta: Date | null;
};

async function perfilesDe(db: Sql | Tx, usuarioId: string): Promise<PerfilPersona[]> {
  const filas = await db<{ rol: Rol; todas: boolean; sucursales: string[] }[]>`
    select r.clave as rol,
           exists (select 1 from alcance_general g where g.usuario_id = ${usuarioId} and g.rol = r.clave and vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en)) as todas,
           coalesce(array(select s.nombre from asignacion a join sucursal s on s.id = a.sucursal_id
                          where a.usuario_id = ${usuarioId} and a.rol = r.clave and vigente(a.vigente_desde, a.vigente_hasta, a.revocada_en) order by s.nombre), '{}') as sucursales
    from rol r order by r.clave`;
  return filas.filter((f) => f.todas || f.sucursales.length).map((f) => ({ ...f, nombre: NOMBRE_PERFIL[f.rol] ?? f.rol }));
}

export async function pantallaPersonas(sql: Sql, usuarioId: string) {
  const f = await facultadesAdministrar(sql, usuarioId);
  if (!algunaFacultad(f)) return null;
  const filas = await sql<{ id: string; nombre: string; correo: string; puesto: string | null; activo: boolean; sin_contrasena: boolean;
                            invitacion: "pendiente" | "vencida" | null; restricciones: number; autorrevision_hasta: Date | null }[]>`
    select u.id, u.nombre, u.correo, u.puesto, u.activo, u.hash_contrasena is null as sin_contrasena,
           (select case when e.expira_en > now() then 'pendiente' else 'vencida' end from enlace_recuperacion e
            where e.usuario_id = u.id and e.tipo = 'invitacion' and e.usado_en is null and e.invalidado_en is null) as invitacion,
           (select count(*)::int from restriccion_permiso r where r.usuario_id = u.id and vigente(r.vigente_desde, r.vigente_hasta, r.revocada_en)) as restricciones,
           (select max(a.vigente_hasta) from autorrevision a where a.usuario_id = u.id and vigente(a.vigente_desde, a.vigente_hasta, a.revocada_en)) as autorrevision_hasta
    from usuario u order by u.activo desc, u.nombre`;
  const personas: PersonaLista[] = [];
  for (const p of filas) {
    personas.push({
      id: p.id, nombre: p.nombre, correo: p.correo, puesto: p.puesto, activo: p.activo, sinContrasena: p.sin_contrasena,
      invitacion: p.invitacion, perfiles: await perfilesDe(sql, p.id), restricciones: p.restricciones, autorrevisionHasta: p.autorrevision_hasta,
    });
  }
  return { facultades: f, personas };
}

export type Otorgamiento = {
  id: string; desde: Date; hasta: Date | null; otorgadoPor: string | null; motivo: string; vigente: boolean;
};
export type PersonaDetalle = {
  facultades: Facultades; propia: boolean;
  persona: { id: string; nombre: string; correo: string; puesto: string | null; activo: boolean; sinContrasena: boolean; esPrueba: boolean };
  invitacion: { estado: "pendiente" | "vencida"; expira: Date; generadoPor: string | null } | null;
  alcances: (Otorgamiento & { rol: Rol; nombre: string })[];
  asignaciones: (Otorgamiento & { rol: Rol; nombre: string; sucursal: string })[];
  permisos: (Otorgamiento & { permiso: string; descripcion: string; todas: boolean; sucursal: string | null; limite: string | null })[];
  restricciones: (Otorgamiento & { permiso: string; descripcion: string; todas: boolean; sucursal: string | null })[];
  autorrevision: (Otorgamiento & { todas: boolean; sucursal: string | null }) | null;
  esDireccion: boolean;
  resumen: ResumenPermisos;
  historial: EntradaHistorial[];
  catalogo: Catalogo;
};
export type Catalogo = {
  roles: { clave: Rol; nombre: string; descripcion: string; sinFunciones: boolean }[];
  permisos: { clave: string; descripcion: string; area: Area; tipo: TipoPermiso; general: boolean; esAutorizacion: boolean }[];
  sucursales: { id: string; nombre: string }[];
  /** Fecha máxima (AAAA-MM-DD) para una autorización de revisión propia que empieza hoy. */
  maxAutorrevision: string;
  hoy: string;
};

export async function catalogo(db: Sql | Tx): Promise<Catalogo> {
  const roles = await db<{ clave: Rol; nombre: string; descripcion: string; sin_funciones: boolean }[]>`
    select r.clave, r.nombre, r.descripcion, not exists (select 1 from rol_permiso rp where rp.rol = r.clave) as sin_funciones from rol r order by r.nombre`;
  const permisos = await db<{ clave: string; descripcion: string; ambito: string; es_autorizacion: boolean }[]>`
    select clave, descripcion, ambito, es_autorizacion from permiso order by clave`;
  const sucursales = await db<{ id: string; nombre: string }[]>`select id, nombre from sucursal order by nombre`;
  const [f] = await db<{ hoy: string; max: string }[]>`
    select to_char((now() at time zone ${ZONA})::date, 'YYYY-MM-DD') as hoy,
           to_char(((now() + make_interval(days => ${DIAS_AUTORREVISION})) at time zone ${ZONA})::date, 'YYYY-MM-DD') as max`;
  return {
    roles: roles.map((r) => ({ clave: r.clave, nombre: r.nombre, descripcion: r.descripcion, sinFunciones: r.sin_funciones })),
    permisos: permisos.map((p) => ({ clave: p.clave, descripcion: p.descripcion, area: areaDe(p.clave), tipo: tipoDe(p.clave, p.es_autorizacion), general: p.ambito === "general", esAutorizacion: p.es_autorizacion })),
    sucursales: [...sucursales], maxAutorrevision: f.max, hoy: f.hoy,
  };
}

export async function pantallaPersona(sql: Sql, usuarioId: string, id: string): Promise<PersonaDetalle | null> {
  const f = await facultadesAdministrar(sql, usuarioId);
  if (!algunaFacultad(f) || !esIdentificadorValido(id)) return null;
  const [p] = await sql<{ id: string; nombre: string; correo: string; puesto: string | null; activo: boolean; sin_contrasena: boolean; es_prueba: boolean }[]>`
    select id, nombre, correo, puesto, activo, hash_contrasena is null as sin_contrasena, es_prueba from usuario where id = ${id}`;
  if (!p) return null;
  const [inv] = await sql<{ expira_en: Date; vencida: boolean; por: string | null }[]>`
    select e.expira_en, e.expira_en <= now() as vencida, g.nombre as por from enlace_recuperacion e left join usuario g on g.id = e.generado_por
    where e.usuario_id = ${id} and e.tipo = 'invitacion' and e.usado_en is null and e.invalidado_en is null`;
  const alcances = await sql<{ id: string; rol: Rol; desde: Date; hasta: Date | null; por: string | null; motivo: string; vigente: boolean }[]>`
    select g.id, g.rol, g.vigente_desde as desde, g.vigente_hasta as hasta, o.nombre as por, g.motivo, vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en) as vigente
    from alcance_general g left join usuario o on o.id = g.otorgado_por
    where g.usuario_id = ${id} and g.revocado_en is null and (g.vigente_hasta is null or g.vigente_hasta > now()) order by g.rol`;
  const asignaciones = await sql<{ id: string; rol: Rol; sucursal: string; desde: Date; hasta: Date | null; por: string | null; motivo: string; vigente: boolean }[]>`
    select a.id, a.rol, s.nombre as sucursal, a.vigente_desde as desde, a.vigente_hasta as hasta, o.nombre as por, a.motivo,
           vigente(a.vigente_desde, a.vigente_hasta, a.revocada_en) as vigente
    from asignacion a join sucursal s on s.id = a.sucursal_id left join usuario o on o.id = a.otorgada_por
    where a.usuario_id = ${id} and a.revocada_en is null and (a.vigente_hasta is null or a.vigente_hasta > now()) order by a.rol, s.nombre`;
  const permisos = await sql<{ id: string; permiso: string; descripcion: string; todas: boolean; sucursal: string | null; limite: string | null;
                               desde: Date; hasta: Date | null; por: string | null; motivo: string; vigente: boolean }[]>`
    select f.id, f.permiso, p.descripcion, f.todas_las_sucursales as todas, s.nombre as sucursal, f.limite_monto::text as limite,
           f.vigente_desde as desde, f.vigente_hasta as hasta, o.nombre as por, f.motivo, vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en) as vigente
    from facultad_otorgada f join permiso p on p.clave = f.permiso left join sucursal s on s.id = f.sucursal_id left join usuario o on o.id = f.otorgada_por
    where f.usuario_id = ${id} and f.revocada_en is null and (f.vigente_hasta is null or f.vigente_hasta > now()) order by f.permiso`;
  const restricciones = await sql<{ id: string; permiso: string; descripcion: string; todas: boolean; sucursal: string | null;
                                    desde: Date; hasta: Date | null; por: string | null; motivo: string; vigente: boolean }[]>`
    select r.id, r.permiso, p.descripcion, r.todas_las_sucursales as todas, s.nombre as sucursal,
           r.vigente_desde as desde, r.vigente_hasta as hasta, o.nombre as por, r.motivo, vigente(r.vigente_desde, r.vigente_hasta, r.revocada_en) as vigente
    from restriccion_permiso r join permiso p on p.clave = r.permiso left join sucursal s on s.id = r.sucursal_id left join usuario o on o.id = r.otorgada_por
    where r.usuario_id = ${id} and r.revocada_en is null and (r.vigente_hasta is null or r.vigente_hasta > now()) order by r.permiso`;
  const [auto] = await sql<{ id: string; todas: boolean; sucursal: string | null; desde: Date; hasta: Date; por: string; motivo: string; vigente: boolean }[]>`
    select a.id, a.todas_las_sucursales as todas, s.nombre as sucursal, a.vigente_desde as desde, a.vigente_hasta as hasta, o.nombre as por, a.motivo,
           vigente(a.vigente_desde, a.vigente_hasta, a.revocada_en) as vigente
    from autorrevision a left join sucursal s on s.id = a.sucursal_id join usuario o on o.id = a.otorgada_por
    where a.usuario_id = ${id} and a.revocada_en is null and a.vigente_hasta > now() order by a.vigente_desde desc limit 1`;
  const [{ direccion }] = await sql<{ direccion: boolean }[]>`
    select exists (select 1 from alcance_general g where g.usuario_id = ${id} and g.rol = 'direccion' and vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en))
        or exists (select 1 from asignacion a where a.usuario_id = ${id} and a.rol = 'direccion' and vigente(a.vigente_desde, a.vigente_hasta, a.revocada_en)) as direccion`;
  const otorg = <T extends { por: string | null }>(x: T) => {
    const { por, ...resto } = x;
    return { ...resto, otorgadoPor: por };
  };
  return {
    facultades: f, propia: id === usuarioId,
    persona: { id: p.id, nombre: p.nombre, correo: p.correo, puesto: p.puesto, activo: p.activo, sinContrasena: p.sin_contrasena, esPrueba: p.es_prueba },
    invitacion: inv ? { estado: inv.vencida ? "vencida" : "pendiente", expira: inv.expira_en, generadoPor: inv.por } : null,
    alcances: alcances.map((a) => ({ ...otorg(a), nombre: NOMBRE_PERFIL[a.rol] ?? a.rol })),
    asignaciones: asignaciones.map((a) => ({ ...otorg(a), nombre: NOMBRE_PERFIL[a.rol] ?? a.rol })),
    permisos: permisos.map(otorg), restricciones: restricciones.map(otorg),
    autorrevision: auto ? otorg(auto) : null,
    esDireccion: direccion,
    resumen: await resumenPermisos(sql, id),
    historial: await historialAccesos(sql, id),
    catalogo: await catalogo(sql),
  };
}

export async function pantallaPerfiles(sql: Sql, usuarioId: string) {
  const f = await facultadesAdministrar(sql, usuarioId);
  if (!algunaFacultad(f)) return null;
  const c = await catalogo(sql);
  const rp = await sql<{ rol: string; permiso: string }[]>`select rol, permiso from rol_permiso`;
  const de = new Map<string, Set<string>>();
  for (const x of rp) de.set(x.rol, (de.get(x.rol) ?? new Set()).add(x.permiso));
  return { facultades: f, roles: c.roles, permisos: c.permisos, incluye: Object.fromEntries([...de].map(([k, v]) => [k, [...v]])) as Record<string, string[]> };
}

export type EntradaHistorial = { id: string; en: Date; por: string | null; persona: string | null; accion: string; detalle: string; motivo: string | null };
const ACCIONES: Record<string, string> = {
  crear_cuenta: "Creó la cuenta", editar_cuenta: "Cambió nombre o puesto", activar: "Activó la cuenta", desactivar: "Desactivó la cuenta",
  invitar: "Generó invitación (48 horas)", dar_perfil: "Dio un perfil", quitar_perfil: "Quitó un perfil", dar_permiso: "Dio un permiso",
  quitar_permiso: "Quitó un permiso otorgado", restringir: "Restringió un permiso", quitar_restriccion: "Quitó una restricción",
  autorrevision: "Autorizó revisar lo propio", renovar_autorrevision: "Renovó la autorización para revisar lo propio",
  terminar_autorrevision: "Terminó la autorización para revisar lo propio", establecer_contrasena: "Fijó su contraseña",
  otorgar_alcance_general: "Dio un perfil en todas las sucursales", asignar: "Dio un perfil", crear: "Creó la cuenta",
};
export async function historialAccesos(db: Sql | Tx, personaId: string | null = null, limite = 200): Promise<EntradaHistorial[]> {
  const filas = await db<{ id: string; en: Date; por: string | null; persona: string | null; accion: string; cambios: Record<string, unknown>; motivo: string | null }[]>`
    select h.id::text, h.en, a.nombre as por, p.nombre as persona, h.accion, h.cambios, h.motivo
    from historial_cambio h left join usuario a on a.id = h.usuario_id left join usuario p on p.id::text = h.entidad_id
    where h.entidad = 'usuario' and (${personaId}::uuid is null or h.entidad_id = ${personaId}::text)
    order by h.en desc, h.id desc limit ${limite}`;
  return filas.map((f) => ({
    id: f.id, en: f.en, por: f.por, persona: f.persona, accion: ACCIONES[f.accion] ?? f.accion, motivo: f.motivo,
    detalle: typeof f.cambios?.detalle === "string" ? f.cambios.detalle : "",
  }));
}

// ---------------------------------------------------------------------------
// Cuentas: crear, editar, activar o desactivar, invitar
// ---------------------------------------------------------------------------
export type ErrorUsuarios =
  | "sin_permiso" | "no_encontrada" | "nombre" | "correo" | "correo_repetido" | "puesto" | "motivo" | "propia" | "sin_canal"
  | "ultimo_administrador" | "rol" | "permiso" | "alcance" | "sucursales" | "limite" | "sin_limite" | "hasta" | "ya_tiene"
  | "no_vigente" | "no_direccion" | "ya_autorizada" | "sin_cambio" | "bloqueado_produccion";

const motivoValido = (m: string) => m.trim().length >= 5 && m.trim().length <= 300;
const ULTIMO = /al menos una cuenta activa que administre accesos/;
async function conProteccion<T>(f: () => Promise<T>): Promise<T | { ok: false; error: "ultimo_administrador" }> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Error && ULTIMO.test(e.message)) return { ok: false, error: "ultimo_administrador" };
    throw e;
  }
}
async function historial(tx: Tx, actor: string, persona: string, accion: string, detalle: string, motivo: string | null, extra: object = {}) {
  await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
           values ('usuario', ${persona}, ${accion}, ${tx.json({ detalle, ...extra } as postgres.JSONValue)}, ${motivo}, ${actor})`;
}

export async function crearPersona(
  sql: Sql, usuarioId: string, datos: { nombre: string; correo: string; puesto: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; id: string } | { ok: false; error: ErrorUsuarios }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const nombre = datos.nombre.trim().replace(/\s+/g, " ");
  const correo = normalizarCorreo(datos.correo);
  const puesto = datos.puesto.trim().replace(/\s+/g, " ") || null;
  if (nombre.length < 2 || nombre.length > 120) return { ok: false, error: "nombre" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || correo.length > 254) return { ok: false, error: "correo" };
  if (puesto && (puesto.length < 2 || puesto.length > 80)) return { ok: false, error: "puesto" };
  return sql.begin(async (tx) => {
    if (!(await facultadesAdministrar(tx, usuarioId)).crear) return { ok: false as const, error: "sin_permiso" as const };
    const [ya] = await tx`select 1 from usuario where correo = ${correo}`;
    if (ya) return { ok: false as const, error: "correo_repetido" as const };
    // Fuera de producción toda cuenta nueva es de prueba (datos ficticios). Nace sin perfiles ni contraseña.
    const [u] = await tx<{ id: string }[]>`
      insert into usuario (nombre, correo, puesto, es_prueba) values (${nombre}, ${correo}, ${puesto}, true) returning id`;
    await historial(tx, usuarioId, u.id, "crear_cuenta", `${nombre} · ${correo}${puesto ? ` · puesto «${puesto}»` : ""} · sin perfiles`, null);
    return { ok: true as const, id: u.id };
  });
}

export async function editarPersona(
  sql: Sql, usuarioId: string, datos: { id: string; nombre: string; puesto: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorUsuarios }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.id)) return { ok: false, error: "no_encontrada" };
  const nombre = datos.nombre.trim().replace(/\s+/g, " ");
  const puesto = datos.puesto.trim().replace(/\s+/g, " ") || null;
  if (nombre.length < 2 || nombre.length > 120) return { ok: false, error: "nombre" };
  if (puesto && (puesto.length < 2 || puesto.length > 80)) return { ok: false, error: "puesto" };
  return sql.begin(async (tx) => {
    if (!(await facultadesAdministrar(tx, usuarioId)).editar) return { ok: false as const, error: "sin_permiso" as const };
    const [u] = await tx<{ nombre: string; puesto: string | null }[]>`select nombre, puesto from usuario where id = ${datos.id} for no key update`;
    if (!u) return { ok: false as const, error: "no_encontrada" as const };
    if (u.nombre === nombre && u.puesto === puesto) return { ok: false as const, error: "sin_cambio" as const };
    await tx`update usuario set nombre = ${nombre}, puesto = ${puesto}, actualizado_en = now() where id = ${datos.id}`;
    const partes = [
      u.nombre !== nombre ? `Nombre: «${u.nombre}» → «${nombre}»` : null,
      u.puesto !== puesto ? `Puesto: ${u.puesto ? `«${u.puesto}»` : "sin puesto"} → ${puesto ? `«${puesto}»` : "sin puesto"}` : null,
    ].filter(Boolean).join(" · ");
    await historial(tx, usuarioId, datos.id, "editar_cuenta", partes, null, { antes: u, despues: { nombre, puesto } });
    return { ok: true as const };
  });
}

/** Desactivar no borra: la cuenta deja de entrar y pierde todos sus permisos al instante; se cierran sus sesiones. */
export async function cambiarEstadoPersona(
  sql: Sql, usuarioId: string, datos: { id: string; activo: boolean; motivo: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorUsuarios }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.id)) return { ok: false, error: "no_encontrada" };
  if (!motivoValido(datos.motivo)) return { ok: false, error: "motivo" };
  if (!datos.activo && datos.id === usuarioId) return { ok: false, error: "propia" };
  return conProteccion(() => sql.begin(async (tx) => {
    if (!(await facultadesAdministrar(tx, usuarioId)).editar) return { ok: false as const, error: "sin_permiso" as const };
    const [u] = await tx<{ activo: boolean; nombre: string }[]>`select activo, nombre from usuario where id = ${datos.id} for no key update`;
    if (!u) return { ok: false as const, error: "no_encontrada" as const };
    if (u.activo === datos.activo) return { ok: false as const, error: "sin_cambio" as const };
    await tx`update usuario set activo = ${datos.activo}, actualizado_en = now() where id = ${datos.id}`;
    if (!datos.activo) {
      await tx`update sesion set cerrada_en = now(), motivo_cierre = 'administrativo' where usuario_id = ${datos.id} and cerrada_en is null`;
      await tx`update enlace_recuperacion set invalidado_en = now() where usuario_id = ${datos.id} and usado_en is null and invalidado_en is null`;
    }
    await historial(tx, usuarioId, datos.id, datos.activo ? "activar" : "desactivar",
      datos.activo ? "La cuenta puede volver a entrar con sus perfiles vigentes" : "La cuenta ya no entra y pierde todos sus permisos; su historial se conserva", datos.motivo.trim());
    await tx`set constraints all immediate`;
    return { ok: true as const };
  }));
}

/**
 * Invitación de un solo uso por 48 horas para que la persona fije su contraseña. Generar otra invalida la anterior (y
 * cualquier enlace de recuperación pendiente). Fuera de producción y solo para cuentas de prueba; el enlace se muestra
 * una vez a quien la generó para que lo comparta (no se envían correos).
 */
export async function invitarPersona(
  sql: Sql, usuarioId: string, datos: { id: string }, { entorno, urlBase }: { entorno: Entorno; urlBase: string },
): Promise<{ ok: true; enlace: string; expira: Date } | { ok: false; error: ErrorUsuarios }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(datos.id)) return { ok: false, error: "no_encontrada" };
  const token = generarToken();
  return sql.begin(async (tx) => {
    if (!(await facultadesAdministrar(tx, usuarioId)).restablecer) return { ok: false as const, error: "sin_permiso" as const };
    const [u] = await tx<{ activo: boolean; es_prueba: boolean }[]>`select activo, es_prueba from usuario where id = ${datos.id} for no key update`;
    if (!u) return { ok: false as const, error: "no_encontrada" as const };
    if (!u.activo || !u.es_prueba) return { ok: false as const, error: "sin_canal" as const };
    const anteriores = await tx`update enlace_recuperacion set invalidado_en = now()
                                where usuario_id = ${datos.id} and usado_en is null and invalidado_en is null returning id`;
    const [e] = await tx<{ expira_en: Date }[]>`
      insert into enlace_recuperacion (token_hash, usuario_id, expira_en, tipo, generado_por)
      values (${huellaToken(token)}, ${datos.id}, now() + make_interval(hours => ${HORAS_INVITACION}), 'invitacion', ${usuarioId}) returning expira_en`;
    await historial(tx, usuarioId, datos.id, "invitar",
      `Enlace de un solo uso, vence en ${HORAS_INVITACION} horas${anteriores.length ? " · invalidó el enlace anterior" : ""}`, null);
    return { ok: true as const, enlace: `${urlBase}/recuperar/${token}`, expira: e.expira_en };
  });
}

// ---------------------------------------------------------------------------
// Cambios de acceso, con vista previa
// ---------------------------------------------------------------------------
export type Alcance = { todas: true } | { todas: false; sucursales: string[] };
export type CambioAcceso =
  | { tipo: "dar_perfil"; rol: string; alcance: Alcance; hasta: string; motivo: string }
  | { tipo: "quitar_perfil"; id: string; general: boolean; motivo: string }
  | { tipo: "dar_permiso"; permiso: string; alcance: Alcance; limite: string; hasta: string; motivo: string }
  | { tipo: "quitar_permiso"; id: string; motivo: string }
  | { tipo: "restringir"; permiso: string; alcance: Alcance; hasta: string; motivo: string }
  | { tipo: "quitar_restriccion"; id: string; motivo: string }
  | { tipo: "autorrevision"; alcance: Alcance; hasta: string; motivo: string }
  | { tipo: "terminar_autorrevision"; id: string; motivo: string };

class Deshacer extends Error {
  constructor(public resultado: unknown) { super("deshacer"); }
}
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** Fin del día elegido en la zona de México. */
const finDelDia = (tx: Tx, fecha: string) => tx`((${fecha}::date + 1)::timestamp at time zone ${ZONA})`;

async function sucursalesValidas(tx: Tx, a: Alcance): Promise<{ id: string; nombre: string }[] | null> {
  if (a.todas) return [];
  const ids = [...new Set(a.sucursales)];
  if (!ids.length || ids.length > 50 || !ids.every(esIdentificadorValido)) return null;
  const filas = await tx<{ id: string; nombre: string }[]>`select id, nombre from sucursal where id in ${tx(ids)} order by nombre`;
  return filas.length === ids.length ? [...filas] : null;
}
const textoAlcance = (a: Alcance, s: { nombre: string }[]) => a.todas ? "todas las sucursales (incluidas las que se abran después)" : s.map((x) => x.nombre).join(", ");

/** Aplica el cambio dentro de la transacción. Devuelve el texto para el historial o un error. */
async function aplicar(tx: Tx, actor: string, personaId: string, c: CambioAcceso): Promise<{ ok: true; accion: string; detalle: string } | { ok: false; error: ErrorUsuarios }> {
  const motivo = c.motivo.trim();
  if (!motivoValido(motivo)) return { ok: false, error: "motivo" };
  const hastaDe = async (h: string) => {
    if (!h) return { ok: true as const, valor: null };
    if (!FECHA.test(h)) return { ok: false as const };
    const [x] = await tx<{ valido: boolean }[]>`select ${h}::date >= (now() at time zone ${ZONA})::date as valido`;
    return x.valido ? { ok: true as const, valor: h } : { ok: false as const };
  };
  switch (c.tipo) {
    case "dar_perfil": {
      const [r] = await tx<{ clave: string; nombre: string }[]>`select clave, nombre from rol where clave = ${c.rol}`;
      if (!r) return { ok: false, error: "rol" };
      const s = await sucursalesValidas(tx, c.alcance);
      if (!s) return { ok: false, error: "sucursales" };
      const h = await hastaDe(c.hasta);
      if (!h.ok) return { ok: false, error: "hasta" };
      // Primero se valida todo; después se escribe (y cualquier error deshace la operación completa).
      if (c.alcance.todas) {
        const [ya] = await tx`select 1 from alcance_general where usuario_id = ${personaId} and rol = ${r.clave} and revocado_en is null`;
        if (ya) return { ok: false, error: "ya_tiene" };
        await tx`insert into alcance_general (usuario_id, rol, vigente_hasta, otorgado_por, motivo)
                 values (${personaId}, ${r.clave}, ${h.valor ? finDelDia(tx, h.valor) : null}, ${actor}, ${motivo})`;
      } else {
        const [ya] = await tx`select 1 from asignacion where usuario_id = ${personaId} and rol = ${r.clave} and revocada_en is null
                              and sucursal_id in ${tx(s.map((x) => x.id))}`;
        if (ya) return { ok: false, error: "ya_tiene" };
        for (const x of s) {
          await tx`insert into asignacion (usuario_id, rol, sucursal_id, vigente_hasta, otorgada_por, motivo)
                   values (${personaId}, ${r.clave}, ${x.id}, ${h.valor ? finDelDia(tx, h.valor) : null}, ${actor}, ${motivo})`;
        }
      }
      return { ok: true, accion: "dar_perfil", detalle: `${r.nombre} en ${textoAlcance(c.alcance, s)}${h.valor ? ` · hasta ${h.valor}` : ""}` };
    }
    case "quitar_perfil": {
      if (!esIdentificadorValido(c.id)) return { ok: false, error: "no_vigente" };
      if (c.general) {
        const [g] = await tx<{ rol: Rol }[]>`
          update alcance_general set revocado_en = now(), revocado_por = ${actor}
          where id = ${c.id} and usuario_id = ${personaId} and revocado_en is null returning rol`;
        if (!g) return { ok: false, error: "no_vigente" };
        return { ok: true, accion: "quitar_perfil", detalle: `${NOMBRE_PERFIL[g.rol] ?? g.rol} en todas las sucursales` };
      }
      const [a] = await tx<{ rol: Rol; sucursal: string }[]>`
        update asignacion a set revocada_en = now(), revocada_por = ${actor} from sucursal s
        where a.id = ${c.id} and a.usuario_id = ${personaId} and a.revocada_en is null and s.id = a.sucursal_id returning a.rol, s.nombre as sucursal`;
      if (!a) return { ok: false, error: "no_vigente" };
      return { ok: true, accion: "quitar_perfil", detalle: `${NOMBRE_PERFIL[a.rol] ?? a.rol} en ${a.sucursal}` };
    }
    case "dar_permiso":
    case "restringir": {
      const [p] = await tx<{ clave: string; descripcion: string; ambito: string; es_autorizacion: boolean }[]>`
        select clave, descripcion, ambito, es_autorizacion from permiso where clave = ${c.permiso}`;
      if (!p) return { ok: false, error: "permiso" };
      if (p.ambito === "general" && !c.alcance.todas) return { ok: false, error: "alcance" };
      const s = await sucursalesValidas(tx, c.alcance);
      if (!s) return { ok: false, error: "sucursales" };
      const h = await hastaDe(c.hasta);
      if (!h.ok) return { ok: false, error: "hasta" };
      const lugares: (string | null)[] = c.alcance.todas ? [null] : s.map((x) => x.id);
      if (c.tipo === "dar_permiso") {
        let limite: string | null = null;
        if (p.es_autorizacion) {
          const n = Number(c.limite.replace(/[$,\s]/g, ""));
          if (!c.limite.trim() || !Number.isFinite(n) || n <= 0 || n > 10_000_000) return { ok: false, error: "limite" };
          limite = n.toFixed(2);
        } else if (c.limite.trim()) return { ok: false, error: "sin_limite" };
        for (const l of lugares) {
          await tx`insert into facultad_otorgada (usuario_id, permiso, sucursal_id, todas_las_sucursales, limite_monto, vigente_hasta, otorgada_por, motivo)
                   values (${personaId}, ${p.clave}, ${l}, ${l === null}, ${limite}, ${h.valor ? finDelDia(tx, h.valor) : null}, ${actor}, ${motivo})`;
        }
        return { ok: true, accion: "dar_permiso", detalle: `${p.descripcion} en ${textoAlcance(c.alcance, s)}${limite ? ` · límite $${limite}` : ""}${h.valor ? ` · hasta ${h.valor}` : ""}` };
      }
      for (const l of lugares) {
        const [ya] = await tx`select 1 from restriccion_permiso where usuario_id = ${personaId} and permiso = ${p.clave}
                              and sucursal_id is not distinct from ${l} and revocada_en is null`;
        if (ya) return { ok: false, error: "ya_tiene" };
      }
      for (const l of lugares) {
        await tx`insert into restriccion_permiso (usuario_id, permiso, sucursal_id, todas_las_sucursales, vigente_hasta, otorgada_por, motivo)
                 values (${personaId}, ${p.clave}, ${l}, ${l === null}, ${h.valor ? finDelDia(tx, h.valor) : null}, ${actor}, ${motivo})`;
      }
      return { ok: true, accion: "restringir", detalle: `No puede: ${p.descripcion} en ${textoAlcance(c.alcance, s)} (prevalece sobre sus perfiles)${h.valor ? ` · hasta ${h.valor}` : ""}` };
    }
    case "quitar_permiso": {
      if (!esIdentificadorValido(c.id)) return { ok: false, error: "no_vigente" };
      const [f] = await tx<{ descripcion: string; sucursal: string | null }[]>`
        update facultad_otorgada f set revocada_en = now(), revocada_por = ${actor} from permiso p
        where f.id = ${c.id} and f.usuario_id = ${personaId} and f.revocada_en is null and p.clave = f.permiso
        returning p.descripcion, (select nombre from sucursal where id = f.sucursal_id) as sucursal`;
      if (!f) return { ok: false, error: "no_vigente" };
      return { ok: true, accion: "quitar_permiso", detalle: `${f.descripcion} en ${f.sucursal ?? "todas las sucursales"}` };
    }
    case "quitar_restriccion": {
      if (!esIdentificadorValido(c.id)) return { ok: false, error: "no_vigente" };
      const [r] = await tx<{ descripcion: string; sucursal: string | null }[]>`
        update restriccion_permiso r set revocada_en = now(), revocada_por = ${actor} from permiso p
        where r.id = ${c.id} and r.usuario_id = ${personaId} and r.revocada_en is null and p.clave = r.permiso
        returning p.descripcion, (select nombre from sucursal where id = r.sucursal_id) as sucursal`;
      if (!r) return { ok: false, error: "no_vigente" };
      return { ok: true, accion: "quitar_restriccion", detalle: `Vuelve a poder: ${r.descripcion} en ${r.sucursal ?? "todas las sucursales"} (si sus perfiles o permisos lo incluyen)` };
    }
    case "autorrevision": {
      if (!c.alcance.todas && c.alcance.sucursales.length !== 1) return { ok: false, error: "sucursales" };
      const s = await sucursalesValidas(tx, c.alcance);
      if (!s) return { ok: false, error: "sucursales" };
      if (!FECHA.test(c.hasta)) return { ok: false, error: "hasta" };
      // Máximo 90 días desde ahora: hasta el fin del día elegido, sin pasar de 90 días exactos.
      const [h] = await tx<{ valido: boolean; hasta: Date }[]>`
        select ${c.hasta}::date >= (now() at time zone ${ZONA})::date
               and ${c.hasta}::date <= ((now() + make_interval(days => ${DIAS_AUTORREVISION})) at time zone ${ZONA})::date as valido,
               least(${finDelDia(tx, c.hasta)}, now() + make_interval(days => ${DIAS_AUTORREVISION})) as hasta`;
      if (!h.valido) return { ok: false, error: "hasta" };
      const sucursal = c.alcance.todas ? null : s[0].id;
      const [d] = await tx<{ ok: boolean }[]>`
        select case when ${sucursal}::uuid is null
                    then exists (select 1 from alcance_general g where g.usuario_id = ${personaId} and g.rol = 'direccion' and vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en))
                    else exists (select 1 from perfiles_en_sucursal(${personaId}, ${sucursal}::uuid) p where p = 'direccion') end as ok`;
      if (!d.ok) return { ok: false, error: "no_direccion" };
      // Renovar: se termina la vigente y empieza otra de hasta 90 días desde hoy.
      const anteriores = await tx<{ id: string }[]>`
        update autorrevision set revocada_en = now(), revocada_por = ${actor}, motivo_revocacion = 'Renovada'
        where usuario_id = ${personaId} and revocada_en is null and vigente_hasta > now() returning id`;
      await tx`insert into autorrevision (usuario_id, sucursal_id, todas_las_sucursales, vigente_hasta, otorgada_por, motivo, renueva_a)
               values (${personaId}, ${sucursal}, ${sucursal === null}, ${h.hasta}, ${actor}, ${motivo}, ${anteriores[0]?.id ?? null})`;
      const hasta = new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "long", timeStyle: "short" }).format(h.hasta);
      return {
        ok: true, accion: anteriores.length ? "renovar_autorrevision" : "autorrevision",
        detalle: `Puede revisar diferencias e incidencias en las que participó, en ${textoAlcance(c.alcance, s)}, hasta el ${hasta}; cada revisión queda marcada «Revisada por quien participó»`,
      };
    }
    case "terminar_autorrevision": {
      if (!esIdentificadorValido(c.id)) return { ok: false, error: "no_vigente" };
      const [a] = await tx`update autorrevision set revocada_en = now(), revocada_por = ${actor}, motivo_revocacion = ${motivo}
                           where id = ${c.id} and usuario_id = ${personaId} and revocada_en is null and vigente_hasta > now() returning id`;
      if (!a) return { ok: false, error: "no_vigente" };
      return { ok: true, accion: "terminar_autorrevision", detalle: "Vuelve la regla: quien participó no revisa" };
    }
  }
}

async function preparar(tx: Tx, actor: string, personaId: string) {
  if (!(await facultadesAdministrar(tx, actor)).asignar) return { ok: false as const, error: "sin_permiso" as const };
  // «for no key update»: serializa los cambios a la misma persona sin bloquear a quien solo la referencia (por ejemplo,
  // revocado_por), para que dos cuentas que se cambian entre sí no se bloqueen mutuamente.
  const [u] = await tx<{ id: string }[]>`select id from usuario where id = ${personaId} for no key update`;
  if (!u) return { ok: false as const, error: "no_encontrada" as const };
  return { ok: true as const };
}

/** Muestra cómo quedarán sus permisos y sucursales, sin guardar nada (la transacción se deshace). */
export async function previsualizarCambio(
  sql: Sql, usuarioId: string, personaId: string, cambio: CambioAcceso, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; vista: VistaPrevia; detalle: string } | { ok: false; error: ErrorUsuarios }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(personaId)) return { ok: false, error: "no_encontrada" };
  try {
    await sql.begin(async (tx) => {
      const p = await preparar(tx, usuarioId, personaId);
      if (!p.ok) throw new Deshacer(p);
      const antes = await resumenPermisos(tx, personaId);
      const r = await aplicar(tx, usuarioId, personaId, cambio);
      if (!r.ok) throw new Deshacer(r);
      try {
        await tx`set constraints all immediate`;
      } catch (e) {
        if (e instanceof Error && ULTIMO.test(e.message)) throw new Deshacer({ ok: false, error: "ultimo_administrador" });
        throw e;
      }
      throw new Deshacer({ ok: true, vista: compararResumen(antes, await resumenPermisos(tx, personaId)), detalle: r.detalle });
    });
  } catch (e) {
    if (e instanceof Deshacer) return e.resultado as { ok: true; vista: VistaPrevia; detalle: string } | { ok: false; error: ErrorUsuarios };
    throw e;
  }
  throw new Error("inalcanzable");
}

/** Guarda el cambio (las mismas validaciones que la vista previa) y lo deja en el historial. */
export async function aplicarCambio(
  sql: Sql, usuarioId: string, personaId: string, cambio: CambioAcceso, { entorno }: { entorno: Entorno },
): Promise<{ ok: true } | { ok: false; error: ErrorUsuarios }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(personaId)) return { ok: false, error: "no_encontrada" };
  // Todo o nada: si algo falla a la mitad (por ejemplo, la segunda de varias sucursales), se deshace la operación
  // completa; nunca queda un permiso guardado a medias ni sin su historial.
  const r = await conProteccion(() => sql.begin(async (tx) => {
    const p = await preparar(tx, usuarioId, personaId);
    if (!p.ok) throw new Deshacer(p);
    const antes = await resumenPermisos(tx, personaId);
    const r = await aplicar(tx, usuarioId, personaId, cambio);
    if (!r.ok) throw new Deshacer(r);
    await tx`set constraints all immediate`;
    const vista = compararResumen(antes, await resumenPermisos(tx, personaId));
    await historial(tx, usuarioId, personaId, r.accion, r.detalle, cambio.motivo.trim(), {
      gana: vista.gana.map((g) => `${g.descripcion}: ${g.despues}`), pierde: vista.pierde.map((g) => `${g.descripcion}: ${g.antes}`),
      cambia: vista.cambia.map((g) => `${g.descripcion}: ${g.antes} → ${g.despues}`),
      sucursales: { antes: vista.sucursalesAntes, despues: vista.sucursalesDespues },
    });
    return { ok: true as const };
  }).catch((e) => {
    if (e instanceof Deshacer) return e.resultado as { ok: false; error: ErrorUsuarios };
    throw e;
  }));
  return r;
}

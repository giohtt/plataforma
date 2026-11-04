import type postgres from "postgres";
import { claveNombre, type DatosNuevaSucursal, type DatosSucursal, type EstadoEditable } from "@/lib/datos-sucursal";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Catálogo de sucursales: crear, editar, desactivar y reactivar.
 *
 * Cada operación comprueba el permiso en el servidor, dentro de la misma transacción que guarda el
 * cambio y registra el historial. Una solicitud directa (sin pasar por la pantalla) recibe la misma
 * respuesta que la pantalla. Crear una sucursal no la asigna a nadie.
 *
 * Orden de bloqueos: primero el candado del catálogo (solo crear y editar, porque comparan nombres),
 * después la fila de la sucursal. Desactivar y reactivar bloquean solo la fila.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type ErrorCatalogo =
  | "no_encontrada" // no existe o la persona no puede consultarla: misma respuesta
  | "sin_permiso"
  | "nombre_duplicado"
  | "codigo_duplicado"
  | "modificada" // alguien guardó otra versión mientras tanto
  | "sin_cambios"
  | "estado_invalido"; // ya estaba desactivada, o ya estaba activa

export type ResultadoCatalogo = { ok: true; id: string; codigo: string } | { ok: false; error: ErrorCatalogo };

export type SucursalEditable = {
  id: string;
  codigo: string;
  nombre: string;
  color: string | null;
  direccion: string | null;
  estadoRepublica: string | null;
  estadoOperativo: "proxima" | "activa" | "inactiva";
  version: number;
  desactivadaEn: Date | null;
  puedeEditar: boolean;
  puedeDesactivar: boolean;
};

const CANDADO_CATALOGO = "catalogo_sucursales";

async function tiene(tx: Tx, usuarioId: string, permiso: string, sucursalId: string | null) {
  const [{ ok }] = await tx<{ ok: boolean }[]>`select tiene_permiso(${usuarioId}, ${permiso}, ${sucursalId}) as ok`;
  return ok;
}

/** ¿Hay otra sucursal con el mismo nombre, sin contar mayúsculas, acentos ni espacios? */
async function nombreOcupado(tx: Tx, nombre: string, exceptoId: string | null) {
  const clave = claveNombre(nombre);
  const filas = await tx<{ id: string; nombre: string }[]>`select id, nombre from sucursal`;
  return filas.some((f) => f.id !== exceptoId && claveNombre(f.nombre) === clave);
}

/** Un nombre o código repetido que se coló entre la comprobación y el guardado lo detiene la base. */
function traducirDuplicado(error: unknown): ResultadoCatalogo | null {
  const e = error as { code?: string; constraint_name?: string };
  if (e?.code !== "23505") return null;
  if (e.constraint_name === "sucursal_codigo_unico") return { ok: false, error: "codigo_duplicado" };
  if (e.constraint_name === "sucursal_nombre_unico") return { ok: false, error: "nombre_duplicado" };
  return null;
}

export async function crearSucursal(
  sql: Sql,
  usuarioId: string,
  datos: DatosNuevaSucursal,
  motivo: string | null,
): Promise<ResultadoCatalogo> {
  try {
    return await sql.begin(async (tx): Promise<ResultadoCatalogo> => {
      if (!(await tiene(tx, usuarioId, "sucursal.crear", null))) return { ok: false, error: "sin_permiso" };
      await tx`select pg_advisory_xact_lock(hashtext(${CANDADO_CATALOGO}))`;
      if ((await tx`select 1 from sucursal where codigo = ${datos.codigo}`).length) return { ok: false, error: "codigo_duplicado" };
      if (await nombreOcupado(tx, datos.nombre, null)) return { ok: false, error: "nombre_duplicado" };

      const [s] = await tx<{ id: string }[]>`
        insert into sucursal (nombre, codigo, color, direccion, estado_republica, estado_operativo, creado_por)
        values (${datos.nombre}, ${datos.codigo}, ${datos.color}, ${datos.direccion}, ${datos.estadoRepublica},
                ${datos.estadoOperativo}, ${usuarioId})
        returning id`;
      await tx`
        insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
        values ('sucursal', ${s.id}, 'crear', ${tx.json(datos)}, ${motivo}, ${usuarioId})`;
      return { ok: true, id: s.id, codigo: datos.codigo };
    });
  } catch (error) {
    const duplicado = traducirDuplicado(error);
    if (duplicado) return duplicado;
    throw error;
  }
}

type FilaSucursal = {
  id: string;
  codigo: string;
  nombre: string;
  color: string | null;
  direccion: string | null;
  estado_republica: string | null;
  estado_operativo: "proxima" | "activa" | "inactiva";
  version: number;
};

/** Bloquea la fila y comprueba que la persona la pueda consultar y tenga el permiso pedido. */
async function bloquearConPermiso(
  tx: Tx,
  usuarioId: string,
  id: string,
  permiso: string,
): Promise<{ ok: true; fila: FilaSucursal } | { ok: false; error: ErrorCatalogo }> {
  const [fila] = await tx<FilaSucursal[]>`
    select id, codigo, nombre, color, direccion, estado_republica, estado_operativo, version
    from sucursal where id = ${id} for update`;
  if (!fila || !(await tiene(tx, usuarioId, "sucursal.consultar", id))) return { ok: false, error: "no_encontrada" };
  if (!(await tiene(tx, usuarioId, permiso, id))) return { ok: false, error: "sin_permiso" };
  return { ok: true, fila };
}

export async function editarSucursal(
  sql: Sql,
  usuarioId: string,
  id: string,
  versionVista: number,
  datos: DatosSucursal,
  motivo: string,
): Promise<ResultadoCatalogo> {
  if (!esIdentificadorValido(id)) return { ok: false, error: "no_encontrada" };
  try {
    return await sql.begin(async (tx): Promise<ResultadoCatalogo> => {
      await tx`select pg_advisory_xact_lock(hashtext(${CANDADO_CATALOGO}))`;
      const r = await bloquearConPermiso(tx, usuarioId, id, "sucursal.editar");
      if (!r.ok) return r;
      const actual = r.fila;
      if (actual.version !== versionVista) return { ok: false, error: "modificada" };

      // Una sucursal desactivada solo cambia de estado al reactivarla, no desde aquí.
      const nuevo = {
        nombre: datos.nombre,
        color: datos.color,
        direccion: datos.direccion,
        estado_republica: datos.estadoRepublica,
        estado_operativo: actual.estado_operativo === "inactiva" ? "inactiva" : datos.estadoOperativo,
      };
      const cambios: Record<string, { antes: string | null; despues: string | null }> = {};
      for (const campo of Object.keys(nuevo) as (keyof typeof nuevo)[]) {
        if (actual[campo] !== nuevo[campo]) cambios[campo] = { antes: actual[campo], despues: nuevo[campo] };
      }
      if (!Object.keys(cambios).length) return { ok: false, error: "sin_cambios" };
      if (cambios.nombre && (await nombreOcupado(tx, nuevo.nombre, id))) return { ok: false, error: "nombre_duplicado" };

      await tx`
        update sucursal set nombre = ${nuevo.nombre}, color = ${nuevo.color}, direccion = ${nuevo.direccion},
               estado_republica = ${nuevo.estado_republica}, estado_operativo = ${nuevo.estado_operativo},
               version = version + 1, actualizado_en = now()
        where id = ${id}`;
      await tx`
        insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
        values ('sucursal', ${id}, 'editar', ${tx.json(cambios)}, ${motivo}, ${usuarioId})`;
      return { ok: true, id, codigo: actual.codigo };
    });
  } catch (error) {
    const duplicado = traducirDuplicado(error);
    if (duplicado) return duplicado;
    throw error;
  }
}

/**
 * Desactiva o reactiva. No borra nada ni toca asignaciones, alcances o facultades: la sucursal
 * conserva su historial y las personas asignadas siguen pudiendo consultarla.
 */
export async function cambiarActividadSucursal(
  sql: Sql,
  usuarioId: string,
  id: string,
  versionVista: number,
  motivo: string,
  accion: { tipo: "desactivar" } | { tipo: "reactivar"; estado: EstadoEditable },
): Promise<ResultadoCatalogo> {
  if (!esIdentificadorValido(id)) return { ok: false, error: "no_encontrada" };
  return sql.begin(async (tx): Promise<ResultadoCatalogo> => {
    const r = await bloquearConPermiso(tx, usuarioId, id, "sucursal.desactivar");
    if (!r.ok) return r;
    const actual = r.fila;
    if (actual.version !== versionVista) return { ok: false, error: "modificada" };

    const inactiva = actual.estado_operativo === "inactiva";
    if ((accion.tipo === "desactivar") === inactiva) return { ok: false, error: "estado_invalido" };
    const estado = accion.tipo === "desactivar" ? "inactiva" : accion.estado;

    await tx`
      update sucursal set estado_operativo = ${estado},
             desactivada_en = ${accion.tipo === "desactivar" ? tx`now()` : null},
             version = version + 1, actualizado_en = now()
      where id = ${id}`;
    await tx`
      insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
      values ('sucursal', ${id}, ${accion.tipo},
              ${tx.json({ estado_operativo: { antes: actual.estado_operativo, despues: estado } })},
              ${motivo}, ${usuarioId})`;
    return { ok: true, id, codigo: actual.codigo };
  });
}

/** Datos para la pantalla de edición. null si no existe, no puede consultarla o no puede cambiar nada. */
export async function sucursalEditable(sql: Sql, usuarioId: string, codigo: string): Promise<SucursalEditable | null> {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  const [s] = await sql<SucursalEditable[]>`
    select id, codigo, nombre, color, direccion, estado_republica as "estadoRepublica",
           estado_operativo as "estadoOperativo", version, desactivada_en as "desactivadaEn",
           tiene_permiso(${usuarioId}, 'sucursal.editar', id) as "puedeEditar",
           tiene_permiso(${usuarioId}, 'sucursal.desactivar', id) as "puedeDesactivar"
    from sucursal
    where codigo = ${codigo} and tiene_permiso(${usuarioId}, 'sucursal.consultar', id)`;
  if (!s || (!s.puedeEditar && !s.puedeDesactivar)) return null;
  return s;
}

export type EntradaHistorial = {
  id: string;
  accion: string;
  cambios: Record<string, unknown>;
  motivo: string | null;
  usuario: string | null;
  en: Date;
};

/** Historial de una sucursal. Solo con el permiso historial.consultar; si no, null. */
export async function historialSucursal(sql: Sql, usuarioId: string, sucursalId: string): Promise<EntradaHistorial[] | null> {
  if (!esIdentificadorValido(sucursalId)) return null;
  const [{ ok }] = await sql<{ ok: boolean }[]>`
    select tiene_permiso(${usuarioId}, 'historial.consultar', null)
       and tiene_permiso(${usuarioId}, 'sucursal.consultar', ${sucursalId}) as ok`;
  if (!ok) return null;
  return sql<EntradaHistorial[]>`
    select h.id::text, h.accion, h.cambios, h.motivo, u.nombre as usuario, h.en
    from historial_cambio h left join usuario u on u.id = h.usuario_id
    where h.entidad = 'sucursal' and h.entidad_id = ${sucursalId}
    order by h.en desc, h.id desc
    limit 50`;
}

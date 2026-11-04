import type postgres from "postgres";
import { claveNombre, validarMotivo } from "@/lib/datos-sucursal";
import { enmascararTelefono, type DatosCorreccion } from "@/lib/datos-visitante";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";
import { coincidencias, sucursalConPermiso, type ResultadoVisitante } from "@/lib/visitantes";

/**
 * Corrección de expedientes (bloque 2, solo datos ficticios).
 *
 * - Para ver el expediente hace falta visitante.consultar en la sucursal desde la que se trabaja.
 * - Para corregirlo hace falta visitante.corregir **en la sucursal donde se creó el expediente**
 *   (indicado para esta primera entrega). Hoy lo tienen Encargado y Dirección; Recepción y Administración no.
 * - Todo se comprueba en el servidor, dentro de la transacción que guarda el cambio: un envío directo del
 *   formulario recibe la misma respuesta.
 * - Cada campo cambiado queda en visitante_cambio con valor anterior, nuevo, motivo, quién, desde qué
 *   sucursal y cuándo. Al mostrarse, el teléfono se enmascara.
 * - Si el cambio produce coincidencias con otros expedientes, se avisa y se pide confirmar; las fichas
 *   siguen separadas (unirlas es la fusión, que se hace aparte).
 */
type Sql = postgres.Sql;

const CAMPOS = { nombre: "nombre", telefono: "telefono", estado_procedencia: "estado_procedencia" } as const;
type Campo = keyof typeof CAMPOS;

export type ResultadoCorreccion =
  | { ok: true }
  | { ok: false; error: "no_encontrada" | "sin_permiso" | "modificada" | "sin_cambios" | "motivo" | "bloqueado_produccion" }
  | { ok: false; error: "coincidencias"; coincidencias: ResultadoVisitante[] };

export async function corregirVisitante(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  id: string,
  versionVista: number,
  datos: DatosCorreccion,
  motivoEscrito: string,
  { entorno, coincidenciasVistas = [] }: { entorno: Entorno; coincidenciasVistas?: string[] },
): Promise<ResultadoCorreccion> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!esIdentificadorValido(id)) return { ok: false, error: "no_encontrada" };
  const motivo = validarMotivo(motivoEscrito);
  const vistas = new Set(coincidenciasVistas.filter(esIdentificadorValido));

  return sql.begin(async (tx): Promise<ResultadoCorreccion> => {
    const sucursal = await sucursalConPermiso(tx, usuarioId, codigo, "visitante.consultar");
    if (!sucursal) return { ok: false, error: "no_encontrada" };
    const [v] = await tx<{ nombre: string; telefono: string | null; estado_procedencia: string | null; sucursal_alta_id: string; version: number }[]>`
      select nombre, telefono, estado_procedencia, sucursal_alta_id, version from visitante where id = ${id} for update`;
    if (!v) return { ok: false, error: "no_encontrada" };
    const [{ puede }] = await tx<{ puede: boolean }[]>`
      select tiene_permiso(${usuarioId}, 'visitante.corregir', ${v.sucursal_alta_id}) as puede`;
    if (!puede) return { ok: false, error: "sin_permiso" };
    if (!motivo) return { ok: false, error: "motivo" };
    if (v.version !== versionVista) return { ok: false, error: "modificada" };

    const nuevo: Record<Campo, string | null> = {
      nombre: datos.nombre,
      telefono: datos.telefono.accion === "mantener" ? v.telefono : datos.telefono.accion === "quitar" ? null : datos.telefono.telefono,
      estado_procedencia: datos.estadoProcedencia,
    };
    const cambiados = (Object.keys(CAMPOS) as Campo[]).filter((c) => (v[c] ?? null) !== nuevo[c]);
    if (!cambiados.length) return { ok: false, error: "sin_cambios" };

    // Coincidencias solo si cambia lo que identifica (nombre o teléfono). No se vuelve a avisar de quien
    // ya se confirmó antes como otra persona.
    let avisadas: ResultadoVisitante[] = [];
    if (cambiados.includes("nombre") || cambiados.includes("telefono")) {
      const ya = new Set(
        (await tx<{ otro: string }[]>`
          select case when visitante_id = ${id} then distinto_de_id else visitante_id end as otro
          from visitante_distinto where visitante_id = ${id} or distinto_de_id = ${id}`).map((r) => r.otro),
      );
      avisadas = (
        await coincidencias(tx, { nombre: nuevo.nombre!, telefono: nuevo.telefono, estadoProcedencia: nuevo.estado_procedencia }, claveNombre(nuevo.nombre!), id)
      ).filter((c) => !ya.has(c.id));
      if (avisadas.some((c) => !vistas.has(c.id))) return { ok: false, error: "coincidencias", coincidencias: avisadas };
    }

    await tx`
      update visitante set nombre = ${nuevo.nombre}, telefono = ${nuevo.telefono},
             estado_procedencia = ${nuevo.estado_procedencia}, version = version + 1
      where id = ${id}`;
    for (const campo of cambiados) {
      await tx`
        insert into visitante_cambio (visitante_id, campo, valor_anterior, valor_nuevo, motivo, usuario_id, sucursal_id)
        values (${id}, ${campo}, ${v[campo] ?? null}, ${nuevo[campo]}, ${motivo}, ${usuarioId}, ${sucursal.id})`;
    }
    // El historial general no repite datos personales: solo qué campos cambiaron.
    await tx`
      insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
      values ('visitante', ${id}, 'corregir', ${tx.json({ campos: cambiados, coincidencias_avisadas: avisadas.length, sucursal: codigo })},
              ${motivo}, ${usuarioId})`;
    return { ok: true };
  });
}

export type ExpedienteEditable = {
  id: string;
  nombre: string;
  telefonoEnmascarado: string | null;
  estadoProcedencia: string | null;
  version: number;
  sucursalAlta: string;
  puedeCorregir: boolean;
};

/** Para la pantalla: null si no puede consultarlo desde esta sucursal (misma respuesta que si no existe). */
export async function expedienteParaCorregir(sql: Sql, usuarioId: string, codigo: string, id: string): Promise<ExpedienteEditable | null> {
  if (!esIdentificadorValido(id)) return null;
  if (!(await sucursalConPermiso(sql, usuarioId, codigo, "visitante.consultar"))) return null;
  const [v] = await sql<(Omit<ExpedienteEditable, "telefonoEnmascarado"> & { telefono: string | null })[]>`
    select v.id, v.nombre, v.telefono, v.estado_procedencia as "estadoProcedencia", v.version, s.nombre as "sucursalAlta",
           tiene_permiso(${usuarioId}, 'visitante.corregir', v.sucursal_alta_id) as "puedeCorregir"
    from visitante v join sucursal s on s.id = v.sucursal_alta_id where v.id = ${id}`;
  if (!v) return null;
  const { telefono, ...resto } = v;
  return { ...resto, telefonoEnmascarado: enmascararTelefono(telefono) };
}

export type Correccion = {
  id: string;
  campo: Campo;
  anterior: string | null;
  nuevo: string | null;
  motivo: string;
  usuario: string;
  sucursal: string;
  en: Date;
};

/**
 * Correcciones de un expediente, más recientes primero, con el teléfono enmascarado.
 * Solo para quien puede corregir ese expediente (permiso visitante.corregir en la sucursal donde se
 * creó). Para cualquier otra cuenta devuelve null: ni datos anteriores ni motivos salen del servidor.
 */
export async function correccionesDeVisitante(sql: Sql, usuarioId: string, codigo: string, id: string): Promise<Correccion[] | null> {
  if (!esIdentificadorValido(id)) return null;
  if (!(await sucursalConPermiso(sql, usuarioId, codigo, "visitante.consultar"))) return null;
  const [permitido] = await sql<{ ok: boolean }[]>`
    select tiene_permiso(${usuarioId}, 'visitante.corregir', sucursal_alta_id) as ok from visitante where id = ${id}`;
  if (!permitido?.ok) return null;
  const filas = await sql<Correccion[]>`
    select c.id::text, c.campo, c.valor_anterior as anterior, c.valor_nuevo as nuevo, c.motivo,
           u.nombre as usuario, s.nombre as sucursal, c.en
    from visitante_cambio c join usuario u on u.id = c.usuario_id join sucursal s on s.id = c.sucursal_id
    where c.visitante_id = ${id}
    order by c.en desc, c.id desc`;
  return filas.map((f) =>
    f.campo === "telefono" ? { ...f, anterior: enmascararTelefono(f.anterior), nuevo: enmascararTelefono(f.nuevo) } : f,
  );
}

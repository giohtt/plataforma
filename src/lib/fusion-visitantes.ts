import type postgres from "postgres";
import { validarMotivo } from "@/lib/datos-sucursal";
import { enmascararTelefono } from "@/lib/datos-visitante";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";
import { sucursalConPermiso } from "@/lib/visitantes";

/**
 * Fusión manual de fichas duplicadas (bloque 2, solo datos ficticios). Indicado el 4 nov 2026:
 *
 * - Solo se usa cuando por error se crearon dos fichas de la misma persona.
 * - Solo Dirección con el permiso visitante.fusionar **en la sucursal donde se creó cada ficha**.
 *   Se comprueba en el servidor al preparar y otra vez al guardar, dentro de la misma transacción.
 * - Dirección elige la ficha que queda activa y de cuál ficha se toma cada dato. El teléfono viaja
 *   enmascarado: se elige la ficha de origen, no el número.
 * - La otra ficha se conserva con su historial y un vínculo a la activa; deja de aparecer en la búsqueda.
 * - Si alguna vez se confirmó que son personas distintas (en cualquiera de las fichas ya unidas a ellas),
 *   la fusión se bloquea.
 * - Deshacer queda pendiente para otra entrega.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type Lado = "a" | "b";
export type CampoFusion = "nombre" | "telefono" | "estado_procedencia";

export type FichaFusion = {
  id: string;
  nombre: string;
  telefono: string | null; // enmascarado
  estadoProcedencia: string | null;
  sucursalAlta: string;
  creadoEn: Date;
  version: number;
};

export type ErrorFusion =
  | "no_encontrada"
  | "misma_ficha"
  | "ya_unida"
  | "sin_permiso"
  | "confirmados_distintos"
  | "modificada"
  | "motivo"
  | "eleccion_invalida"
  | "bloqueado_produccion";

export type Preparacion = { ok: true; a: FichaFusion; b: FichaFusion } | { ok: false; error: ErrorFusion };

type FilaCompleta = {
  id: string;
  nombre: string;
  telefono: string | null;
  estado_procedencia: string | null;
  sucursal_alta_id: string;
  sucursal_alta: string;
  creado_en: Date;
  version: number;
  unida: boolean;
};

function aFicha(f: FilaCompleta): FichaFusion {
  return {
    id: f.id,
    nombre: f.nombre,
    telefono: enmascararTelefono(f.telefono),
    estadoProcedencia: f.estado_procedencia,
    sucursalAlta: f.sucursal_alta,
    creadoEn: f.creado_en,
    version: f.version,
  };
}

/** Todas las comprobaciones que no dependen de lo que se elija. Con `bloquear`, deja las dos filas bloqueadas. */
async function verificar(
  tx: Tx,
  usuarioId: string,
  codigo: string,
  aId: string,
  bId: string,
  bloquear: boolean,
): Promise<{ ok: true; sucursalId: string; a: FilaCompleta; b: FilaCompleta } | { ok: false; error: ErrorFusion }> {
  if (!esIdentificadorValido(aId) || !esIdentificadorValido(bId)) return { ok: false, error: "no_encontrada" };
  aId = aId.toLowerCase();
  bId = bId.toLowerCase();
  if (aId === bId) return { ok: false, error: "misma_ficha" };
  const sucursal = await sucursalConPermiso(tx, usuarioId, codigo, "visitante.consultar");
  if (!sucursal) return { ok: false, error: "no_encontrada" };

  // Mismo orden de bloqueo siempre (por identificador), para que dos fusiones cruzadas no se traben.
  const filas = await tx<FilaCompleta[]>`
    select v.id, v.nombre, v.telefono, v.estado_procedencia, v.sucursal_alta_id, s.nombre as sucursal_alta, v.creado_en,
           v.version, v.fusionado_en_id is not null as unida
    from visitante v join sucursal s on s.id = v.sucursal_alta_id
    where v.id in (${aId}, ${bId})
    order by v.id
    ${bloquear ? tx`for update of v` : tx``}`;
  const a = filas.find((f) => f.id === aId);
  const b = filas.find((f) => f.id === bId);
  if (!a || !b) return { ok: false, error: "no_encontrada" };
  if (a.unida || b.unida) return { ok: false, error: "ya_unida" };

  const [{ puede }] = await tx<{ puede: boolean }[]>`
    select tiene_permiso(${usuarioId}, 'visitante.fusionar', ${a.sucursal_alta_id})
       and tiene_permiso(${usuarioId}, 'visitante.fusionar', ${b.sucursal_alta_id}) as puede`;
  if (!puede) return { ok: false, error: "sin_permiso" };

  // Confirmadas como distintas, también a través de fichas que ya se les habían unido.
  const [{ distintas }] = await tx<{ distintas: boolean }[]>`
    select exists (
      select 1 from visitante_distinto d
      where (d.visitante_id in (select visitante_grupo(${a.id})) and d.distinto_de_id in (select visitante_grupo(${b.id})))
         or (d.visitante_id in (select visitante_grupo(${b.id})) and d.distinto_de_id in (select visitante_grupo(${a.id})))
    ) as distintas`;
  if (distintas) return { ok: false, error: "confirmados_distintos" };

  return { ok: true, sucursalId: sucursal.id, a, b };
}

/** Datos para la pantalla de comparación, ya enmascarados. No modifica nada. */
export async function prepararFusion(sql: Sql, usuarioId: string, codigo: string, aId: string, bId: string): Promise<Preparacion> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const r = await verificar(tx, usuarioId, codigo, aId, bId, false);
    if (!r.ok) return r;
    return { ok: true, a: aFicha(r.a), b: aFicha(r.b) };
  });
}

/** ¿Puede esta persona iniciar una fusión desde esta ficha? (Para mostrar el botón; al guardar se vuelve a comprobar todo.) */
export async function puedeFusionarDesde(sql: Sql, usuarioId: string, codigo: string, id: string): Promise<boolean> {
  if (!esIdentificadorValido(id)) return false;
  if (!(await sucursalConPermiso(sql, usuarioId, codigo, "visitante.consultar"))) return false;
  const [r] = await sql<{ ok: boolean }[]>`
    select fusionado_en_id is null and tiene_permiso(${usuarioId}, 'visitante.fusionar', sucursal_alta_id) as ok
    from visitante where id = ${id}`;
  return !!r?.ok;
}

export type Eleccion = {
  a: string;
  b: string;
  versionA: number;
  versionB: number;
  activa: Lado;
  tomar: Record<CampoFusion, Lado>;
};

export type ResultadoFusion = { ok: true; activaId: string } | { ok: false; error: ErrorFusion };

export async function fusionarVisitantes(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  eleccion: Eleccion,
  motivoEscrito: string,
  { entorno }: { entorno: Entorno },
): Promise<ResultadoFusion> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const lados = ["a", "b"];
  if (!lados.includes(eleccion.activa) || !(["nombre", "telefono", "estado_procedencia"] as const).every((c) => lados.includes(eleccion.tomar?.[c]))) {
    return { ok: false, error: "eleccion_invalida" };
  }
  const motivo = validarMotivo(motivoEscrito);

  return sql.begin(async (tx): Promise<ResultadoFusion> => {
    const r = await verificar(tx, usuarioId, codigo, eleccion.a, eleccion.b, true);
    if (!r.ok) return r;
    if (!motivo) return { ok: false, error: "motivo" };
    // Si alguna ficha cambió después de la vista previa, se vuelve a mostrar con los datos actuales.
    if (r.a.version !== eleccion.versionA || r.b.version !== eleccion.versionB) return { ok: false, error: "modificada" };

    const fila = { a: r.a, b: r.b };
    const activa = fila[eleccion.activa];
    const otra = fila[eleccion.activa === "a" ? "b" : "a"];
    const nuevo = {
      nombre: fila[eleccion.tomar.nombre].nombre,
      telefono: fila[eleccion.tomar.telefono].telefono,
      estado_procedencia: fila[eleccion.tomar.estado_procedencia].estado_procedencia,
    };

    await tx`
      update visitante set nombre = ${nuevo.nombre}, telefono = ${nuevo.telefono},
             estado_procedencia = ${nuevo.estado_procedencia}, version = version + 1
      where id = ${activa.id}`;
    // Los datos que la ficha activa toma de la otra quedan como correcciones, con el mismo motivo.
    for (const campo of ["nombre", "telefono", "estado_procedencia"] as const) {
      if ((activa[campo] ?? null) !== nuevo[campo]) {
        await tx`
          insert into visitante_cambio (visitante_id, campo, valor_anterior, valor_nuevo, motivo, usuario_id, sucursal_id)
          values (${activa.id}, ${campo}, ${activa[campo] ?? null}, ${nuevo[campo]}, ${motivo}, ${usuarioId}, ${r.sucursalId})`;
      }
    }
    await tx`
      update visitante set fusionado_en = now(), fusionado_en_id = ${activa.id}, version = version + 1
      where id = ${otra.id}`;

    const datos = (f: FilaCompleta) => ({ nombre: f.nombre, telefono: f.telefono, estado_procedencia: f.estado_procedencia, sucursal_alta: f.sucursal_alta });
    const origen = (lado: Lado) => (lado === eleccion.activa ? "activa" : "unida");
    await tx`
      insert into visitante_fusion (activo_id, absorbido_id, datos_activo, datos_absorbido, campos_tomados, motivo, usuario_id, sucursal_id)
      values (${activa.id}, ${otra.id}, ${tx.json(datos(activa))}, ${tx.json(datos(otra))},
              ${tx.json({ nombre: origen(eleccion.tomar.nombre), telefono: origen(eleccion.tomar.telefono), estado_procedencia: origen(eleccion.tomar.estado_procedencia) })},
              ${motivo}, ${usuarioId}, ${r.sucursalId})`;
    // El historial general no repite datos personales.
    await tx`
      insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id) values
        ('visitante', ${activa.id}, 'fusionar', ${tx.json({ unida: otra.id, sucursal: codigo })}, ${motivo}, ${usuarioId}),
        ('visitante', ${otra.id}, 'unida_a', ${tx.json({ activa: activa.id, sucursal: codigo })}, ${motivo}, ${usuarioId})`;
    return { ok: true, activaId: activa.id };
  });
}

/** Ficha activa a la que lleva un enlace. null si no existe. */
export async function fichaActiva(sql: Sql, id: string): Promise<{ activa: string; unida: boolean } | null> {
  if (!esIdentificadorValido(id)) return null;
  const [r] = await sql<{ activa: string | null; unida: boolean }[]>`
    select visitante_activo(id) as activa, fusionado_en_id is not null as unida from visitante where id = ${id}`;
  return r?.activa ? { activa: r.activa, unida: r.unida } : null;
}

export type Fusion = {
  id: string;
  unida: { nombre: string; telefono: string | null; estadoProcedencia: string | null; sucursalAlta: string };
  camposTomados: Record<CampoFusion, "activa" | "unida">;
  motivo: string;
  usuario: string;
  sucursal: string;
  en: Date;
};

/**
 * Fusiones de una ficha activa, con el teléfono enmascarado. Mismo criterio que el historial de
 * correcciones: solo para quien puede corregir o fusionar esa ficha. Para los demás, null.
 */
export async function fusionesDeVisitante(sql: Sql, usuarioId: string, codigo: string, id: string): Promise<Fusion[] | null> {
  if (!esIdentificadorValido(id)) return null;
  if (!(await sucursalConPermiso(sql, usuarioId, codigo, "visitante.consultar"))) return null;
  const [p] = await sql<{ ok: boolean }[]>`
    select tiene_permiso(${usuarioId}, 'visitante.corregir', sucursal_alta_id)
        or tiene_permiso(${usuarioId}, 'visitante.fusionar', sucursal_alta_id) as ok
    from visitante where id = ${id}`;
  if (!p?.ok) return null;
  const filas = await sql<{ id: string; datos: Record<string, string | null>; campos: Record<CampoFusion, "activa" | "unida">; motivo: string; usuario: string; sucursal: string; en: Date }[]>`
    select f.id::text, f.datos_absorbido as datos, f.campos_tomados as campos, f.motivo, u.nombre as usuario, s.nombre as sucursal, f.en
    from visitante_fusion f join usuario u on u.id = f.usuario_id join sucursal s on s.id = f.sucursal_id
    where f.activo_id = ${id}
    order by f.en desc, f.id desc`;
  return filas.map((f) => ({
    id: f.id,
    unida: {
      nombre: f.datos.nombre ?? "",
      telefono: enmascararTelefono(f.datos.telefono ?? null),
      estadoProcedencia: f.datos.estado_procedencia ?? null,
      sucursalAlta: f.datos.sucursal_alta ?? "",
    },
    camposTomados: f.campos,
    motivo: f.motivo,
    usuario: f.usuario,
    sucursal: f.sucursal,
    en: f.en,
  }));
}

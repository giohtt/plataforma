import type postgres from "postgres";
import {
  enmascararTelefono,
  formatoTelefono,
  REGLAS_PROVISIONALES,
  type Consulta,
  type DatosVisitante,
} from "@/lib/datos-visitante";
import { claveNombre } from "@/lib/datos-sucursal";
import type { Entorno } from "@/lib/entorno";
import { resumenesHistorial, type ResumenHistorial } from "@/lib/historial";
import { esIdentificadorValido } from "@/lib/permisos";

/**
 * Expedientes de visitantes: búsqueda, posibles coincidencias y alta.
 *
 * - El expediente es único para toda Fitnessland: la búsqueda cubre todas las sucursales.
 * - El permiso (visitante.buscar / visitante.crear / visitante.consultar) se comprueba en el servidor
 *   para la sucursal desde la que trabaja la persona.
 * - El teléfono se enmascara aquí, en el servidor: el número completo no llega al navegador salvo que
 *   la persona lo haya escrito completo y coincida (regla provisional).
 * - Nunca se decide solo por el nombre: si hay posibles coincidencias, la persona elige una o confirma
 *   que es otra persona, y esa confirmación queda registrada.
 * - En producción el alta está bloqueada hasta aprobar la privacidad del expediente (decisión 3).
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type ResultadoVisitante = {
  id: string;
  nombre: string;
  /** Ya enmascarado o completo, según la regla provisional. */
  telefono: string | null;
  estadoProcedencia: string | null;
  sucursalAlta: string;
  creadoEn: Date;
  motivos: ("mismo_telefono" | "mismo_nombre" | "nombre_parecido")[];
  /** Visitas registradas y última visita, dentro del alcance de la cuenta (src/lib/historial.ts). */
  historial?: ResumenHistorial;
};

export type Fila = {
  id: string;
  nombre: string;
  nombre_clave: string;
  telefono: string | null;
  estado_procedencia: string | null;
  sucursal_alta: string;
  creado_en: Date;
  contiene: boolean;
  parecido: number;
};

export type Busqueda =
  | { ok: true; resultados: ResultadoVisitante[]; limitado: boolean }
  | { ok: false; error: "no_encontrada" | "consulta_invalida"; motivo?: string };

const LIMITE = 20;

function patron(palabra: string) {
  return `%${palabra.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Lo que se muestra de una fila: el teléfono completo solo si la persona ya lo escribió completo. */
export function presentar(f: Fila, telefonoEscrito: string | null, claveEscrita: string | null): ResultadoVisitante {
  const mismoTelefono = !!telefonoEscrito && f.telefono === telefonoEscrito;
  const motivos: ResultadoVisitante["motivos"] = [];
  if (mismoTelefono) motivos.push("mismo_telefono");
  if (claveEscrita && f.nombre_clave === claveEscrita) motivos.push("mismo_nombre");
  else if (claveEscrita && (f.contiene || f.parecido > 0)) motivos.push("nombre_parecido");
  return {
    id: f.id,
    nombre: f.nombre,
    telefono:
      f.telefono && (mismoTelefono || !REGLAS_PROVISIONALES.enmascararTelefono)
        ? formatoTelefono(f.telefono)
        : enmascararTelefono(f.telefono),
    estadoProcedencia: f.estado_procedencia,
    sucursalAlta: f.sucursal_alta,
    creadoEn: f.creado_en,
    motivos,
  };
}

export async function sucursalConPermiso(tx: Tx | Sql, usuarioId: string, codigo: string, permiso: string) {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  const [s] = await tx<{ id: string; nombre: string }[]>`
    select id, nombre from sucursal where codigo = ${codigo} and tiene_permiso(${usuarioId}, ${permiso}, id)`;
  return s ?? null;
}

export async function puedeEnSucursal(sql: Sql, usuarioId: string, codigo: string, permiso: string) {
  return (await sucursalConPermiso(sql, usuarioId, codigo, permiso)) !== null;
}

export async function buscarVisitantes(sql: Sql, usuarioId: string, codigo: string, consulta: Consulta): Promise<Busqueda> {
  if (!(await sucursalConPermiso(sql, usuarioId, codigo, "visitante.buscar"))) return { ok: false, error: "no_encontrada" };
  if (consulta.modo === "invalida") return { ok: false, error: "consulta_invalida", motivo: consulta.motivo };

  const filas =
    consulta.modo === "telefono"
      ? await sql<Fila[]>`
          select v.id, v.nombre, v.nombre_clave, v.telefono, v.estado_procedencia, s.nombre as sucursal_alta, v.creado_en,
                 false as contiene, 0::real as parecido
          from visitante v join sucursal s on s.id = v.sucursal_alta_id
          where v.telefono = ${consulta.telefono} and v.fusionado_en_id is null
          order by v.nombre_clave, v.creado_en
          limit ${LIMITE + 1}`
      : await sql<Fila[]>`
          select v.id, v.nombre, v.nombre_clave, v.telefono, v.estado_procedencia, s.nombre as sucursal_alta, v.creado_en,
                 v.nombre_clave like all(${sql.array(consulta.palabras.map(patron))}) as contiene,
                 similarity(v.nombre_clave, ${consulta.clave}) as parecido
          from visitante v join sucursal s on s.id = v.sucursal_alta_id
          where (v.nombre_clave like all(${sql.array(consulta.palabras.map(patron))})
                 or v.nombre_clave % ${consulta.clave})
            and v.fusionado_en_id is null
          order by contiene desc, parecido desc, v.nombre_clave, v.creado_en
          limit ${LIMITE + 1}`;

  const telefono = consulta.modo === "telefono" ? consulta.telefono : null;
  const clave = consulta.modo === "nombre" ? consulta.clave : null;
  const resultados = filas.slice(0, LIMITE).map((f) => presentar(f, telefono, clave));
  const historial = await sql.begin("read only", (tx) => resumenesHistorial(tx, usuarioId, resultados.map((r) => r.id)));
  for (const r of resultados) {
    const h = historial.get(r.id);
    if (h) r.historial = h;
  }
  return { ok: true, resultados, limitado: filas.length > LIMITE };
}

/** Posibles coincidencias para un alta: mismo teléfono, mismo nombre o nombre parecido. */
/** Posibles coincidencias. `excluirId` deja fuera al propio expediente cuando se corrige. */
export async function coincidencias(tx: Tx, datos: DatosVisitante, clave: string, excluirId: string | null = null): Promise<ResultadoVisitante[]> {
  const palabras = clave.split(" ").filter(Boolean);
  const filas = await tx<Fila[]>`
    select v.id, v.nombre, v.nombre_clave, v.telefono, v.estado_procedencia, s.nombre as sucursal_alta, v.creado_en,
           v.nombre_clave like all(${tx.array(palabras.map(patron))}) as contiene,
           similarity(v.nombre_clave, ${clave}) as parecido
    from visitante v join sucursal s on s.id = v.sucursal_alta_id
    where ((${datos.telefono}::text is not null and v.telefono = ${datos.telefono})
           or v.nombre_clave like all(${tx.array(palabras.map(patron))})
           or v.nombre_clave % ${clave})
      and (${excluirId}::uuid is null or v.id <> ${excluirId}::uuid)
      and v.fusionado_en_id is null
    order by (v.telefono = ${datos.telefono}) desc nulls last, parecido desc, v.creado_en
    limit 10`;
  // El teléfono capturado en el alta cuenta como escrito completo: solo se muestra el de quien coincide.
  return filas.map((f) => presentar(f, datos.telefono, clave));
}

export type ResultadoAlta =
  | { ok: true; id: string }
  | { ok: false; error: "no_encontrada" | "sin_permiso" | "bloqueado_produccion" }
  | { ok: false; error: "coincidencias"; coincidencias: ResultadoVisitante[] };

/**
 * Alta de expediente. `confirmadosDistintos` son los expedientes que la persona vio y confirmó que no son
 * el visitante. Si aparece una coincidencia que no confirmó (por ejemplo, otra recepción la creó un
 * momento antes), no se crea nada y se le muestran de nuevo.
 */
export async function crearVisitante(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: DatosVisitante,
  confirmadosDistintos: string[],
  { entorno }: { entorno: Entorno },
): Promise<ResultadoAlta> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  const clave = claveNombre(datos.nombre);
  const confirmados = new Set(confirmadosDistintos.filter(esIdentificadorValido));

  return sql.begin(async (tx): Promise<ResultadoAlta> => {
    const sucursal = await sucursalConPermiso(tx, usuarioId, codigo, "visitante.buscar");
    if (!sucursal) return { ok: false, error: "no_encontrada" };
    if (!(await sucursalConPermiso(tx, usuarioId, codigo, "visitante.crear"))) return { ok: false, error: "sin_permiso" };

    // Una sola alta a la vez: así dos recepciones no crean dos veces a la misma persona sin verse.
    await tx`select pg_advisory_xact_lock(hashtext('alta_visitante'))`;
    const posibles = await coincidencias(tx, datos, clave);
    if (posibles.some((p) => !confirmados.has(p.id))) return { ok: false, error: "coincidencias", coincidencias: posibles };

    const [v] = await tx<{ id: string }[]>`
      insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id, creado_por)
      values (${datos.nombre}, ${datos.telefono}, ${datos.estadoProcedencia}, ${sucursal.id}, ${usuarioId})
      returning id`;
    for (const p of posibles) {
      await tx`
        insert into visitante_distinto (visitante_id, distinto_de_id, motivo, confirmado_por, sucursal_id)
        values (${v.id}, ${p.id}, ${`Confirmó que es otra persona al crear el expediente (${p.motivos.join(", ")})`},
                ${usuarioId}, ${sucursal.id})`;
    }
    // El historial no repite el teléfono: solo indica si se capturó.
    await tx`
      insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
      values ('visitante', ${v.id}, 'crear',
              ${tx.json({ nombre: datos.nombre, telefono_capturado: !!datos.telefono, estado_procedencia: datos.estadoProcedencia, sucursal: codigo, distinto_de: posibles.length })},
              ${usuarioId})`;
    return { ok: true, id: v.id };
  });
}

export type Expediente = Omit<ResultadoVisitante, "motivos"> & { confirmacionesDistinto: number };

/** Expediente para consultar desde una sucursal. null si no existe o no hay permiso (misma respuesta). */
export async function consultarVisitante(sql: Sql, usuarioId: string, codigo: string, id: string): Promise<Expediente | null> {
  if (!esIdentificadorValido(id)) return null;
  if (!(await sucursalConPermiso(sql, usuarioId, codigo, "visitante.consultar"))) return null;
  const [f] = await sql<(Fila & { distintos: number })[]>`
    select v.id, v.nombre, v.nombre_clave, v.telefono, v.estado_procedencia, s.nombre as sucursal_alta, v.creado_en,
           false as contiene, 0::real as parecido,
           (select count(*)::int from visitante_distinto d where d.visitante_id = v.id or d.distinto_de_id = v.id) as distintos
    from visitante v join sucursal s on s.id = v.sucursal_alta_id
    where v.id = ${id}`;
  if (!f) return null;
  const r = presentar(f, null, null);
  return {
    id: r.id,
    nombre: r.nombre,
    telefono: r.telefono,
    estadoProcedencia: r.estadoProcedencia,
    sucursalAlta: r.sucursalAlta,
    creadoEn: r.creadoEn,
    confirmacionesDistinto: f.distintos,
  };
}

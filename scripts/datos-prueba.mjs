#!/usr/bin/env node
/**
 * Carga datos ficticios para desarrollo y pruebas: sucursales, usuarios de prueba y sus accesos.
 *
 * - Nunca se ejecuta en producción.
 * - Los accesos de prueba se otorgan por separado: perfil por sucursal, alcance general y
 *   facultades de autorización (siempre con un límite ficticio).
 * - Se puede repetir: lo que ya existe no se modifica ni se duplica, y lo revocado no se vuelve a crear.
 *
 * Uso:
 *   DATABASE_URL=... node scripts/datos-prueba.mjs              carga los datos (falla en producción)
 *   DATABASE_URL=... node scripts/datos-prueba.mjs --solo-pruebas
 *       solo actúa si APP_ENV=pruebas; en cualquier otro caso no hace nada. Se usa al publicar en Vercel.
 */
import { pathToFileURL } from "node:url";
import { conectar } from "./migrar.mjs";

const VALIDOS = ["desarrollo", "pruebas", "produccion"];
export function normalizarEntorno(valor) {
  const limpio = (valor ?? "").trim().toLowerCase();
  return VALIDOS.includes(limpio) ? limpio : "desarrollo";
}

/** Sucursales precargadas. Colores acordados; datos operativos de demostración. */
export const SUCURSALES_PRUEBA = [
  { codigo: "TEN", nombre: "Tenango", color: "#c62828" },
  { codigo: "STG", nombre: "Santiago", color: "#1b7a3e" },
  { codigo: "ATL", nombre: "Atlacomulco", color: "#f4c20d" },
  { codigo: "RAY", nombre: "Rayón", color: "#6a2c9e" },
  { codigo: "SAD", nombre: "San Andrés", color: "#161616" },
  { codigo: "SCR", nombre: "San Cristóbal", color: "#161616" }, // Negra, como San Andrés (sucursales «Black»)
];

/** Usuarios ficticios. El dominio .invalid está reservado y nunca recibe correo real. */
export const USUARIOS_PRUEBA = [
  { correo: "recepcion.tenango@prueba.fitnessland.invalid", nombre: "Recepción Tenango (prueba)" },
  { correo: "recepcion.santiago@prueba.fitnessland.invalid", nombre: "Recepción Santiago (prueba)" },
  { correo: "encargado.tenango@prueba.fitnessland.invalid", nombre: "Encargado Tenango (prueba)" },
  { correo: "administracion@prueba.fitnessland.invalid", nombre: "Administración (prueba)" },
  { correo: "administracion.tenango@prueba.fitnessland.invalid", nombre: "Administración Tenango (prueba)" },
  { correo: "direccion@prueba.fitnessland.invalid", nombre: "Dirección (prueba)" },
  { correo: "direccion.general@prueba.fitnessland.invalid", nombre: "Dirección general (prueba)" },
  { correo: "sin.asignaciones@prueba.fitnessland.invalid", nombre: "Sin asignaciones (prueba)" },
  { correo: "recepcion.vencida@prueba.fitnessland.invalid", nombre: "Recepción con asignación vencida (prueba)" },
];

const D = "@prueba.fitnessland.invalid";

/** Perfil por sucursal. "vencida" crea una asignación que terminó hace 30 días. */
export const ASIGNACIONES_PRUEBA = [
  { correo: `recepcion.tenango${D}`, rol: "recepcion", codigo: "TEN" },
  { correo: `recepcion.santiago${D}`, rol: "recepcion", codigo: "STG" },
  { correo: `encargado.tenango${D}`, rol: "encargado", codigo: "TEN" },
  { correo: `administracion${D}`, rol: "administracion", codigo: "TEN" },
  { correo: `administracion${D}`, rol: "administracion", codigo: "STG" },
  // Indicado el 10 nov 2026: Administración asignada solo a Tenango, para probar el alcance del historial.
  { correo: `administracion.tenango${D}`, rol: "administracion", codigo: "TEN" },
  { correo: `direccion${D}`, rol: "direccion", codigo: "TEN" },
  { correo: `direccion.general${D}`, rol: "direccion", codigo: "TEN" },
  { correo: `recepcion.vencida${D}`, rol: "recepcion", codigo: "TEN", vencida: true },
];

/** Alcance general (todas las sucursales), otorgado aparte de la asignación. */
export const ALCANCES_PRUEBA = [{ correo: `direccion.general${D}`, rol: "direccion" }];

/** Facultades de autorización, otorgadas aparte y con un límite ficticio. */
export const FACULTADES_PRUEBA = [
  { correo: `direccion.general${D}`, permiso: "autorizacion.gasto", limite: 1000 },
  // Indicado el 8 nov 2026, solo para la prueba: Dirección Tenango autoriza cancelaciones hasta $150, solo en Tenango.
  { correo: `direccion${D}`, permiso: "autorizacion.devolucion", limite: 150, codigo: "TEN" },
  // Respaldo de Encargado para autorizar accesos (sin importe): permiso explícito, solo en Tenango.
  { correo: `direccion${D}`, permiso: "acceso.autorizar", limite: null, codigo: "TEN" },
];

/**
 * Expedientes de visitantes ficticios para probar búsqueda y coincidencias: dos homónimas, un teléfono
 * compartido, un nombre con acentos y uno sin teléfono. Los teléfonos empiezan con 0: ningún número
 * de México empieza así, de modo que no pueden pertenecer a nadie.
 */
export const VISITANTES_PRUEBA = [
  { nombre: "María Hernández García", telefono: "0000000101", estado: "Estado de México", codigo: "TEN" },
  { nombre: "María Hernández García", telefono: "0000000102", estado: "Estado de México", codigo: "STG" },
  { nombre: "Luis Martínez Ruiz", telefono: "0000000201", estado: "Estado de México", codigo: "TEN" },
  { nombre: "Ana Martínez Ruiz", telefono: "0000000201", estado: "Estado de México", codigo: "TEN" },
  { nombre: "José Ramírez Sánchez", telefono: "0000000301", estado: "Ciudad de México", codigo: "ATL" },
  { nombre: "Fernanda López Torres", telefono: null, estado: "Michoacán", codigo: "TEN" },
  // Caso de fusión permitida: la misma persona registrada dos veces en Tenango por error (una con falta de ortografía).
  { nombre: "Valeria Gómez Pineda", telefono: "0000000401", estado: "Estado de México", codigo: "TEN" },
  { nombre: "Valeria Gomes Pineda", telefono: "0000000401", estado: null, codigo: "TEN" },
];

/**
 * Caso de fusión bloqueada: Luis y Ana comparten teléfono y ya se confirmó que son personas distintas.
 * Compartir nombre o teléfono no demuestra que sean la misma persona.
 */
export const DISTINTOS_PRUEBA = [
  { a: { nombre: "Ana Martínez Ruiz", telefono: "0000000201" }, b: { nombre: "Luis Martínez Ruiz", telefono: "0000000201" } },
];

const MOTIVO = "Datos ficticios de prueba";

export async function cargarDatosPrueba(sql, { entorno }) {
  if (normalizarEntorno(entorno) === "produccion") {
    throw new Error("Los datos ficticios no se cargan en producción.");
  }
  return sql.begin(async (tx) => {
    let sucursales = 0;
    let usuarios = 0;
    for (const s of SUCURSALES_PRUEBA) {
      const filas = await tx`
        insert into sucursal (nombre, codigo, color, estado_operativo)
        values (${s.nombre}, ${s.codigo}, ${s.color}, 'activa')
        on conflict do nothing
        returning id`;
      if (filas.length) {
        sucursales++;
        await tx`
          insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo)
          values ('sucursal', ${filas[0].id}, 'crear', ${tx.json(s)}, ${MOTIVO})`;
      }
    }
    for (const u of USUARIOS_PRUEBA) {
      const filas = await tx`
        insert into usuario (nombre, correo, es_prueba)
        values (${u.nombre}, ${u.correo}, true)
        on conflict do nothing
        returning id`;
      if (filas.length) {
        usuarios++;
        await tx`
          insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo)
          values ('usuario', ${filas[0].id}, 'crear', ${tx.json(u)}, ${MOTIVO})`;
      }
    }
    let asignaciones = 0;
    for (const a of ASIGNACIONES_PRUEBA) {
      const filas = await tx`
        insert into asignacion (usuario_id, rol, sucursal_id, vigente_desde, vigente_hasta, motivo)
        select u.id, ${a.rol}, s.id,
               ${a.vencida ? tx`now() - interval '60 days'` : tx`now()`},
               ${a.vencida ? tx`now() - interval '30 days'` : null},
               ${MOTIVO}
        from usuario u, sucursal s
        where u.correo = ${a.correo} and s.codigo = ${a.codigo}
          and not exists (select 1 from asignacion x where x.usuario_id = u.id and x.rol = ${a.rol} and x.sucursal_id = s.id)
        returning id, usuario_id`;
      if (filas.length) {
        asignaciones++;
        await tx`
          insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo)
          values ('usuario', ${filas[0].usuario_id}, 'asignar_perfil', ${tx.json(a)}, ${MOTIVO})`;
      }
    }
    let alcances = 0;
    for (const g of ALCANCES_PRUEBA) {
      const filas = await tx`
        insert into alcance_general (usuario_id, rol, motivo)
        select u.id, ${g.rol}, ${MOTIVO} from usuario u
        where u.correo = ${g.correo}
          and not exists (select 1 from alcance_general x where x.usuario_id = u.id and x.rol = ${g.rol})
        returning usuario_id`;
      if (filas.length) {
        alcances++;
        await tx`
          insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo)
          values ('usuario', ${filas[0].usuario_id}, 'otorgar_alcance_general', ${tx.json(g)}, ${MOTIVO})`;
      }
    }
    let facultades = 0;
    for (const f of FACULTADES_PRUEBA) {
      const filas = await tx`
        insert into facultad_otorgada (usuario_id, permiso, sucursal_id, todas_las_sucursales, limite_monto, motivo)
        select u.id, ${f.permiso}, s.id, s.id is null, ${f.limite}, ${MOTIVO + (f.limite === null ? "" : " (límite ficticio)")}
        from usuario u left join sucursal s on s.codigo = ${f.codigo ?? null}
        where u.correo = ${f.correo} and (${f.codigo ?? null}::text is null or s.id is not null)
          and not exists (select 1 from facultad_otorgada x where x.usuario_id = u.id and x.permiso = ${f.permiso})
        returning usuario_id`;
      if (filas.length) {
        facultades++;
        await tx`
          insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo)
          values ('usuario', ${filas[0].usuario_id}, 'otorgar_facultad', ${tx.json(f)}, ${MOTIVO})`;
      }
    }
    let visitantes = 0;
    for (const v of VISITANTES_PRUEBA) {
      const filas = await tx`
        insert into visitante (nombre, telefono, estado_procedencia, sucursal_alta_id)
        select ${v.nombre}, ${v.telefono}, ${v.estado}, s.id from sucursal s
        where s.codigo = ${v.codigo}
          and not exists (select 1 from visitante x where x.nombre = ${v.nombre}
                          and x.telefono is not distinct from ${v.telefono}::text and x.sucursal_alta_id = s.id)
        returning id`;
      if (filas.length) {
        visitantes++;
        await tx`
          insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo)
          values ('visitante', ${filas[0].id}, 'crear',
                  ${tx.json({ nombre: v.nombre, telefono_capturado: !!v.telefono, estado_procedencia: v.estado, sucursal: v.codigo })},
                  ${MOTIVO})`;
      }
    }
    let distintos = 0;
    for (const d of DISTINTOS_PRUEBA) {
      const filas = await tx`
        insert into visitante_distinto (visitante_id, distinto_de_id, motivo)
        select a.id, b.id, ${MOTIVO + ": comparten teléfono, son personas distintas"}
        from visitante a, visitante b
        where a.nombre = ${d.a.nombre} and a.telefono = ${d.a.telefono} and a.creado_por is null
          and b.nombre = ${d.b.nombre} and b.telefono = ${d.b.telefono} and b.creado_por is null
          and not exists (select 1 from visitante_distinto x
                          where (x.visitante_id = a.id and x.distinto_de_id = b.id) or (x.visitante_id = b.id and x.distinto_de_id = a.id))
        limit 1
        returning id`;
      distintos += filas.length;
    }
    return { sucursales, usuarios, asignaciones, alcances, facultades, visitantes, distintos };
  });
}

async function principal() {
  const soloPruebas = process.argv.includes("--solo-pruebas");
  const entorno = normalizarEntorno(process.env.APP_ENV);
  const url = process.env.DATABASE_URL;

  if (soloPruebas && entorno !== "pruebas") {
    console.log(`Entorno «${entorno}»: no se cargan datos ficticios automáticamente.`);
    return;
  }
  if (entorno === "produccion") {
    console.error("Los datos ficticios no se cargan en producción.");
    process.exit(1);
  }
  if (!url) {
    if (soloPruebas) {
      console.log("Sin DATABASE_URL: no se cargan datos ficticios.");
      return;
    }
    console.error("Falta DATABASE_URL.");
    process.exit(1);
  }
  const sql = conectar(url);
  try {
    const r = await cargarDatosPrueba(sql, { entorno });
    console.log(
      `Datos ficticios nuevos: ${r.sucursales} sucursales, ${r.usuarios} usuarios, ${r.asignaciones} asignaciones, ` +
        `${r.alcances} alcances generales, ${r.facultades} facultades, ${r.visitantes} expedientes de visitantes y ${r.distintos} confirmaciones de personas distintas.`,
    );
  } catch (e) {
    console.error(`No se pudieron cargar los datos ficticios: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await principal();
}

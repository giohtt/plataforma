import postgres from "postgres";

/**
 * Conexión a PostgreSQL. La dirección viene de DATABASE_URL, que se configura en el
 * alojamiento (nunca en el repositorio). Si falta, la aplicación funciona sin base.
 */
let cliente: postgres.Sql | null = null;

export function obtenerBaseDatos(): postgres.Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  cliente ??= postgres(url, {
    prepare: false, // compatible con el agrupador de conexiones de Neon
    max: 1,
    idle_timeout: 20,
    connect_timeout: 5,
    onnotice: () => {},
  });
  return cliente;
}

export type EstadoBaseDatos =
  | { estado: "sin_configurar"; migracionesAplicadas: null }
  | { estado: "conectada"; migracionesAplicadas: number }
  | { estado: "error"; migracionesAplicadas: null };

/** Comprueba la conexión sin devolver datos de operación ni detalles del servidor. */
export async function consultarEstadoBaseDatos(): Promise<EstadoBaseDatos> {
  const sql = obtenerBaseDatos();
  if (!sql) return { estado: "sin_configurar", migracionesAplicadas: null };
  try {
    const [fila] = await sql<{ total: number }[]>`
      select count(*)::int as total from esquema_migracion`;
    return { estado: "conectada", migracionesAplicadas: fila.total };
  } catch (e) {
    const codigo = (e as { code?: string }).code ?? "desconocido";
    console.error(`Base de datos no disponible (código ${codigo}).`);
    return { estado: "error", migracionesAplicadas: null };
  }
}

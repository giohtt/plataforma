/**
 * Validación y normalización de los datos de una sucursal. Sin acceso a la base: se usa igual en
 * el servidor y en las pruebas. La base vuelve a comprobar formato y unicidad por su cuenta.
 */

export type EstadoEditable = "proxima" | "activa";

export type DatosSucursal = {
  nombre: string;
  color: string | null;
  direccion: string | null;
  estadoRepublica: string | null;
  estadoOperativo: EstadoEditable;
};

export type DatosNuevaSucursal = DatosSucursal & { codigo: string };

export type ErroresCampos = Partial<Record<"nombre" | "codigo" | "color" | "direccion" | "estadoRepublica" | "estadoOperativo" | "motivo", string>>;

export type Validacion<T> = { ok: true; datos: T } | { ok: false; errores: ErroresCampos };

/** Quita espacios al inicio y al final y deja uno solo entre palabras. */
export function limpiarTexto(valor: unknown): string {
  return typeof valor === "string" ? valor.replace(/\s+/g, " ").trim() : "";
}

/**
 * Forma de comparar nombres: sin mayúsculas, sin acentos y sin espacios repetidos.
 * «Rayón», «rayon» y «RAYÓN » cuentan como el mismo nombre.
 */
export function claveNombre(nombre: string): string {
  return limpiarTexto(nombre).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function opcional(valor: unknown, maximo: number, campo: keyof ErroresCampos, errores: ErroresCampos): string | null {
  const texto = limpiarTexto(valor);
  if (texto.length > maximo) errores[campo] = `Máximo ${maximo} caracteres.`;
  return texto || null;
}

export function validarDatosSucursal(entrada: Record<string, unknown>): Validacion<DatosSucursal> {
  const errores: ErroresCampos = {};

  const nombre = limpiarTexto(entrada.nombre);
  if (nombre.length < 2 || nombre.length > 80) errores.nombre = "Escribe un nombre de 2 a 80 caracteres.";

  let color: string | null = null;
  if (entrada.color !== null && entrada.color !== undefined && entrada.color !== "") {
    const c = limpiarTexto(entrada.color).toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(c)) color = c;
    else errores.color = "El color debe tener el formato #rrggbb.";
  }

  const direccion = opcional(entrada.direccion, 200, "direccion", errores);
  const estadoRepublica = opcional(entrada.estadoRepublica, 60, "estadoRepublica", errores);

  const estadoOperativo = entrada.estadoOperativo;
  if (estadoOperativo !== "proxima" && estadoOperativo !== "activa") {
    errores.estadoOperativo = "Elige «Próxima apertura» o «Activa».";
  }

  if (Object.keys(errores).length) return { ok: false, errores };
  return {
    ok: true,
    datos: { nombre, color, direccion, estadoRepublica, estadoOperativo: estadoOperativo as EstadoEditable },
  };
}

export function validarNuevaSucursal(entrada: Record<string, unknown>): Validacion<DatosNuevaSucursal> {
  const base = validarDatosSucursal(entrada);
  const errores: ErroresCampos = base.ok ? {} : { ...base.errores };
  const codigo = limpiarTexto(entrada.codigo).toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) errores.codigo = "El código lleva de 2 a 5 letras sin acento o números, por ejemplo TEN.";
  if (!base.ok || Object.keys(errores).length) return { ok: false, errores };
  return { ok: true, datos: { ...base.datos, codigo } };
}

/** Motivo obligatorio para cambiar, desactivar o reactivar: queda en el historial. */
export function validarMotivo(valor: unknown): string | null {
  const motivo = limpiarTexto(valor);
  return motivo.length >= 5 && motivo.length <= 300 ? motivo : null;
}

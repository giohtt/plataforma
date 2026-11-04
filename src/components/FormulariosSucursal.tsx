"use client";

import { useActionState, useState } from "react";
import {
  accionCambiarActividad,
  accionCrearSucursal,
  accionEditarSucursal,
  type EstadoFormularioSucursal,
} from "@/app/acciones-sucursales";

export type ValoresSucursal = {
  nombre: string;
  codigo: string;
  color: string | null;
  direccion: string | null;
  estadoRepublica: string | null;
  estadoOperativo: "proxima" | "activa" | "inactiva";
};

function MensajeCampo({ texto, id }: { texto?: string; id: string }) {
  return texto ? <span className="campo-error" id={id}>{texto}</span> : null;
}

function Aviso({ estado }: { estado: EstadoFormularioSucursal }) {
  return estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null;
}

/** Valor a mostrar: lo que la persona escribió (si hubo que corregir) o el valor guardado. */
function valorInicial(estado: EstadoFormularioSucursal, campo: string, guardado: string | null | undefined) {
  return estado?.valores?.[campo] ?? guardado ?? "";
}

function Campo(props: {
  nombre: string;
  etiqueta: string;
  estado: EstadoFormularioSucursal;
  guardado?: string | null;
  ayuda?: string;
  requerido?: boolean;
  maximo?: number;
  campoError?: keyof NonNullable<NonNullable<EstadoFormularioSucursal>["errores"]>;
  estilo?: React.CSSProperties;
}) {
  const error = props.estado?.errores?.[props.campoError ?? (props.nombre as "nombre")];
  return (
    <div className="campo">
      <label htmlFor={props.nombre}>{props.etiqueta}</label>
      <input
        id={props.nombre}
        name={props.nombre}
        defaultValue={valorInicial(props.estado, props.nombre, props.guardado)}
        required={props.requerido}
        maxLength={props.maximo}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${props.nombre}-error` : undefined}
        style={props.estilo}
      />
      {props.ayuda ? <span className="sub">{props.ayuda}</span> : null}
      <MensajeCampo texto={error} id={`${props.nombre}-error`} />
    </div>
  );
}

function CampoColor({ estado, guardado }: { estado: EstadoFormularioSucursal; guardado: string | null }) {
  const inicialSin = estado?.valores ? estado.valores.sinColor === "si" : guardado === null;
  const [sinColor, setSinColor] = useState(inicialSin);
  const error = estado?.errores?.color;
  return (
    <fieldset className="campo campo-grupo">
      <legend>Color de la sucursal</legend>
      <div className="fila-color">
        <input
          type="color"
          id="color"
          name="color"
          aria-label="Color"
          defaultValue={estado?.valores?.color || guardado || "#888888"}
          disabled={sinColor}
        />
        <label className="casilla">
          <input type="checkbox" name="sinColor" value="si" checked={sinColor} onChange={(e) => setSinColor(e.target.checked)} />
          Sin color definido todavía
        </label>
      </div>
      <MensajeCampo texto={error} id="color-error" />
    </fieldset>
  );
}

function SelectorEstado({ estado, guardado, etiqueta = "Estado", prefijo = "" }: { estado: EstadoFormularioSucursal; guardado: string; etiqueta?: string; prefijo?: string }) {
  const error = estado?.errores?.estadoOperativo;
  return (
    <div className="campo">
      <label htmlFor={`${prefijo}estadoOperativo`}>{etiqueta}</label>
      <select id={`${prefijo}estadoOperativo`} name="estadoOperativo" defaultValue={valorInicial(estado, "estadoOperativo", guardado)}>
        <option value="proxima">Próxima apertura</option>
        <option value="activa">Activa</option>
      </select>
      <MensajeCampo texto={error} id={`${prefijo}estadoOperativo-error`} />
    </div>
  );
}

function Motivo({ estado, obligatorio, ayuda, prefijo = "" }: { estado: EstadoFormularioSucursal; obligatorio: boolean; ayuda: string; prefijo?: string }) {
  const error = estado?.errores?.motivo;
  return (
    <div className="campo">
      <label htmlFor={`${prefijo}motivo`}>{obligatorio ? "Motivo" : "Motivo (opcional)"}</label>
      <textarea
        id={`${prefijo}motivo`}
        name="motivo"
        rows={2}
        maxLength={300}
        required={obligatorio}
        defaultValue={estado?.valores?.motivo ?? ""}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${prefijo}motivo-error` : undefined}
      />
      <span className="sub">{ayuda}</span>
      <MensajeCampo texto={error} id={`${prefijo}motivo-error`} />
    </div>
  );
}

/** Alta o edición. En edición el código no se cambia y una sucursal desactivada no cambia de estado aquí. */
export function FormularioSucursal({ modo, inicial, id, version }: { modo: "crear" | "editar"; inicial: ValoresSucursal; id?: string; version?: number }) {
  const [estado, accion, enviando] = useActionState(modo === "crear" ? accionCrearSucursal : accionEditarSucursal, null);
  return (
    // La clave cambia en cada intento para mostrar lo que la persona escribió tras un error.
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate>
      <Aviso estado={estado} />
      {modo === "editar" ? (
        <>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="version" value={version} />
        </>
      ) : null}
      <Campo nombre="nombre" etiqueta="Nombre" estado={estado} guardado={inicial.nombre} requerido maximo={80} />
      {modo === "crear" ? (
        <Campo
          nombre="codigo"
          etiqueta="Código"
          estado={estado}
          guardado={inicial.codigo}
          requerido
          maximo={5}
          ayuda="De 2 a 5 letras sin acento o números (por ejemplo, TEN). Aparece en la dirección de la página y no se podrá cambiar después."
          estilo={{ textTransform: "uppercase" }}
        />
      ) : (
        <div className="campo">
          <span className="campo-etiqueta">Código</span>
          <span className="mono">{inicial.codigo}</span>
          <span className="sub">El código no se cambia después de crear la sucursal.</span>
        </div>
      )}
      <CampoColor estado={estado} guardado={inicial.color} />
      <Campo nombre="direccion" etiqueta="Dirección (opcional)" estado={estado} guardado={inicial.direccion} maximo={200} />
      <Campo nombre="estadoRepublica" etiqueta="Estado de la república (opcional)" estado={estado} guardado={inicial.estadoRepublica} maximo={60} />
      {inicial.estadoOperativo === "inactiva" ? (
        <p className="aviso aviso-info">Esta sucursal está desactivada. Para cambiar su estado, usa «Reactivar» más abajo.</p>
      ) : (
        <SelectorEstado estado={estado} guardado={inicial.estadoOperativo} />
      )}
      <Motivo
        estado={estado}
        obligatorio={modo === "editar"}
        ayuda={modo === "editar" ? "Queda en el historial junto con lo que cambió, quién y cuándo." : "Queda en el historial de la sucursal."}
      />
      <button className="boton boton-principal" type="submit" disabled={enviando}>
        {enviando ? "Guardando…" : modo === "crear" ? "Crear sucursal" : "Guardar cambios"}
      </button>
    </form>
  );
}

/** Desactivar o reactivar. Desactivar pide confirmación con una casilla, sin ventanas emergentes. */
export function FormularioActividad({ id, version, inactiva, nombre }: { id: string; version: number; inactiva: boolean; nombre: string }) {
  const [estado, accion, enviando] = useActionState(accionCambiarActividad, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate>
      <Aviso estado={estado} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="tipo" value={inactiva ? "reactivar" : "desactivar"} />
      {inactiva ? (
        <SelectorEstado estado={estado} guardado="activa" etiqueta="Vuelve como" prefijo="actividad-" />
      ) : (
        <label className="casilla">
          <input type="checkbox" name="confirmo" value="si" defaultChecked={estado?.valores?.confirmo === "si"} />
          Confirmo que quiero desactivar {nombre}.
        </label>
      )}
      {!inactiva && estado?.errores?.estadoOperativo ? <span className="campo-error">{estado.errores.estadoOperativo}</span> : null}
      <Motivo estado={estado} obligatorio ayuda="Queda en el historial." prefijo="actividad-" />
      <button className={inactiva ? "boton boton-principal" : "boton boton-peligro"} type="submit" disabled={enviando}>
        {enviando ? "Guardando…" : inactiva ? "Reactivar sucursal" : "Desactivar sucursal"}
      </button>
    </form>
  );
}

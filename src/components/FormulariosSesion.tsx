"use client";

import { useActionState } from "react";
import {
  accionEstablecerContrasena,
  accionIniciarSesion,
  accionSolicitarEnlace,
  type EstadoFormulario,
} from "@/app/acciones-sesion";

function Mensaje({ estado }: { estado: EstadoFormulario }) {
  if (estado?.error) return <p className="aviso aviso-error" role="alert">{estado.error}</p>;
  if (estado?.aviso) return <p className="aviso aviso-ok" role="status">{estado.aviso}</p>;
  return null;
}

export function FormularioInicioSesion() {
  const [estado, accion, enviando] = useActionState(accionIniciarSesion, null);
  return (
    <form action={accion} className="formulario">
      <Mensaje estado={estado} />
      <div className="campo">
        <label htmlFor="correo">Correo</label>
        <input id="correo" name="correo" type="email" autoComplete="username" required />
      </div>
      <div className="campo">
        <label htmlFor="contrasena">Contraseña</label>
        <input id="contrasena" name="contrasena" type="password" autoComplete="current-password" required />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>
        {enviando ? "Entrando…" : "Iniciar sesión"}
      </button>
    </form>
  );
}

export function FormularioSolicitarEnlace() {
  const [estado, accion, enviando] = useActionState(accionSolicitarEnlace, null);
  return (
    <form action={accion} className="formulario">
      <Mensaje estado={estado} />
      <div className="campo">
        <label htmlFor="correo">Correo de tu cuenta</label>
        <input id="correo" name="correo" type="email" autoComplete="username" required />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>
        {enviando ? "Enviando…" : "Solicitar enlace"}
      </button>
    </form>
  );
}

export function FormularioNuevaContrasena({ token, correo }: { token: string; correo: string }) {
  const [estado, accion, enviando] = useActionState(accionEstablecerContrasena, null);
  return (
    <form action={accion} className="formulario">
      <Mensaje estado={estado} />
      <input type="hidden" name="token" value={token} />
      {/* Ayuda a los administradores de contraseñas a asociar la contraseña con la cuenta. */}
      <input type="email" name="usuario" value={correo} autoComplete="username" readOnly hidden />
      <div className="campo">
        <label htmlFor="contrasena">Nueva contraseña</label>
        <input id="contrasena" name="contrasena" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
        <span className="sub">Al menos 12 caracteres. Puede ser una frase. No incluyas tu correo.</span>
      </div>
      <div className="campo">
        <label htmlFor="confirmacion">Escríbela otra vez</label>
        <input id="confirmacion" name="confirmacion" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>
        {enviando ? "Guardando…" : "Guardar contraseña"}
      </button>
    </form>
  );
}

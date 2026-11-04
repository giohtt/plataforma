"use client";

import { useActionState } from "react";
import { accionCorregirVisitante, type EstadoCorreccion } from "@/app/acciones-visitantes";
import { TarjetaVisitante } from "@/components/Visitantes";

type Props = {
  codigo: string;
  id: string;
  version: number;
  inicial: { nombre: string; telefonoEnmascarado: string | null; estadoProcedencia: string | null };
  estados: readonly string[];
};

function MensajeCampo({ estado, campo }: { estado: EstadoCorreccion; campo: "nombre" | "telefono" | "estadoProcedencia" | "motivo" }) {
  const t = estado?.errores?.[campo];
  return t ? <span className="campo-error" id={`${campo}-error`}>{t}</span> : null;
}

/** Corrección de nombre, teléfono y procedencia, con motivo obligatorio. Se envía por POST. */
export function FormularioCorreccion({ codigo, id, version, inicial, estados }: Props) {
  const [estado, accion, enviando] = useActionState(accionCorregirVisitante, null);
  const v = estado?.valores;
  const coincidencias = estado?.coincidencias ?? [];
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate>
      {estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null}
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />

      {coincidencias.length ? (
        <section className="coincidencias" aria-labelledby="t-coincidencias" data-testid="coincidencias">
          <h2 id="t-coincidencias" className="titulo-seccion">Expedientes parecidos</h2>
          <p className="sub">Si guardas, las fichas siguen separadas. Unir duplicados se hará con la fusión, que es aparte.</p>
          <ul className="lista-visitantes">
            {coincidencias.map((c) => <TarjetaVisitante key={c.id} v={c} codigo={codigo} mostrarMotivos />)}
          </ul>
          {coincidencias.map((c) => <input key={c.id} type="hidden" name="coincidencia" value={c.id} />)}
          <label className="casilla">
            <input type="checkbox" name="confirmo" value="si" />
            Revisé los expedientes parecidos y quiero guardar la corrección. Las fichas seguirán separadas.
          </label>
        </section>
      ) : null}

      <div className="campo">
        <label htmlFor="nombre">Nombre completo</label>
        <input id="nombre" name="nombre" defaultValue={v?.nombre ?? inicial.nombre} maxLength={120} autoComplete="off"
          aria-invalid={estado?.errores?.nombre ? true : undefined} />
        <MensajeCampo estado={estado} campo="nombre" />
      </div>
      <fieldset className="campo campo-grupo">
        <legend>Teléfono</legend>
        <span className="sub">Actual: {inicial.telefonoEnmascarado ?? "no registrado"}. Déjalo vacío para no cambiarlo.</span>
        <input id="telefono" name="telefono" inputMode="tel" aria-label="Teléfono nuevo" placeholder="Teléfono nuevo (10 dígitos)"
          defaultValue={v?.telefono ?? ""} maxLength={20} autoComplete="off" aria-invalid={estado?.errores?.telefono ? true : undefined} />
        {inicial.telefonoEnmascarado ? (
          <label className="casilla">
            <input type="checkbox" name="quitarTelefono" value="si" defaultChecked={v?.quitarTelefono === "si"} />
            Quitar el teléfono
          </label>
        ) : null}
        <MensajeCampo estado={estado} campo="telefono" />
      </fieldset>
      <div className="campo">
        <label htmlFor="estadoProcedencia">Estado de procedencia</label>
        <select id="estadoProcedencia" name="estadoProcedencia" defaultValue={v?.estadoProcedencia ?? inicial.estadoProcedencia ?? ""}>
          <option value="">Sin indicar</option>
          {estados.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <MensajeCampo estado={estado} campo="estadoProcedencia" />
      </div>
      <div className="campo">
        <label htmlFor="motivo">Motivo de la corrección</label>
        <textarea id="motivo" name="motivo" rows={2} maxLength={300} defaultValue={v?.motivo ?? ""}
          aria-invalid={estado?.errores?.motivo ? true : undefined} />
        <span className="sub">Obligatorio. Queda en el historial junto con el dato anterior, el nuevo, quién y cuándo.</span>
        <MensajeCampo estado={estado} campo="motivo" />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>
        {enviando ? "Guardando…" : "Guardar corrección"}
      </button>
    </form>
  );
}

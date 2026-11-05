"use client";

import { useActionState, useState } from "react";
import { accionBuscarVisitantes, accionFusionar, accionPrepararFusion, type EstadoFusion } from "@/app/acciones-visitantes";
import type { CampoFusion, FichaFusion, Lado } from "@/lib/fusion-visitantes";

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });
const CAMPOS: { campo: CampoFusion; etiqueta: string; valor: (f: FichaFusion) => string | null }[] = [
  { campo: "nombre", etiqueta: "Nombre", valor: (f) => f.nombre },
  { campo: "telefono", etiqueta: "Teléfono", valor: (f) => f.telefono },
  { campo: "estado_procedencia", etiqueta: "Estado de procedencia", valor: (f) => f.estadoProcedencia },
];
const otro = (l: Lado): Lado => (l === "a" ? "b" : "a");

/** Comparación, elección, vista previa y confirmación. Todo se envía por POST; nada viaja en la dirección. */
function Comparacion({ codigo, a, b, estado, accion, enviando }: {
  codigo: string; a: FichaFusion; b: FichaFusion; estado: EstadoFusion; accion: (d: FormData) => void; enviando: boolean;
}) {
  const v = estado?.valores;
  const ld = (x: string | undefined, def: Lado): Lado => (x === "a" || x === "b" ? x : def);
  const [activa, setActiva] = useState<Lado>(ld(v?.activa, "a"));
  const [tomar, setTomar] = useState<Record<CampoFusion, Lado>>({
    nombre: ld(v?.nombre, "a"),
    telefono: ld(v?.telefono, a.telefono ? "a" : b.telefono ? "b" : "a"),
    estado_procedencia: ld(v?.estado_procedencia, a.estadoProcedencia ? "a" : b.estadoProcedencia ? "b" : "a"),
  });
  const fichas = { a, b };
  const etiqueta = (l: Lado) => `Ficha ${l === "a" ? "1" : "2"}`;

  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="comparacion">
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="a" value={a.id} />
      <input type="hidden" name="b" value={b.id} />
      <input type="hidden" name="versionA" value={a.version} />
      <input type="hidden" name="versionB" value={b.version} />

      <fieldset className="campo campo-grupo">
        <legend>¿Qué ficha queda activa?</legend>
        <div className="comparacion-fichas">
          {(["a", "b"] as Lado[]).map((l) => (
            <label key={l} className={`ficha-opcion${activa === l ? " ficha-elegida" : ""}`} data-testid={`ficha-${l}`}>
              <input type="radio" name="activa" value={l} checked={activa === l} onChange={() => setActiva(l)} />
              <span>
                <strong>{etiqueta(l)}</strong>
                <span className="sub"> · creada en {fichas[l].sucursalAlta} el {fecha.format(new Date(fichas[l].creadoEn))}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <table className="tabla tabla-fusion">
        <thead><tr><th>Dato que se conserva</th><th>{etiqueta("a")}</th><th>{etiqueta("b")}</th></tr></thead>
        <tbody>
          {CAMPOS.map(({ campo, etiqueta: e, valor }) => (
            <tr key={campo}>
              <th scope="row">{e}</th>
              {(["a", "b"] as Lado[]).map((l) => (
                <td key={l} data-etiqueta={etiqueta(l)}>
                  <label className="casilla">
                    <input type="radio" name={campo} value={l} checked={tomar[campo] === l}
                      onChange={() => setTomar({ ...tomar, [campo]: l })} aria-label={`${e}: usar el de la ${etiqueta(l)}`} />
                    {valor(fichas[l]) ?? <span className="sub">(vacío)</span>}
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <section className="vista-previa" aria-labelledby="t-vista" data-testid="vista-previa">
        <h2 id="t-vista" className="titulo-seccion">Vista previa</h2>
        <dl className="datos-expediente">
          {CAMPOS.map(({ campo, etiqueta: e, valor }) => (
            <div key={campo} className="contents"><dt>{e}</dt><dd>{valor(fichas[tomar[campo]]) ?? "No registrado"}</dd></div>
          ))}
          <dt>Ficha activa</dt><dd>{etiqueta(activa)}, creada en {fichas[activa].sucursalAlta}</dd>
          <dt>Se une a ella</dt><dd>{etiqueta(otro(activa))}: se conserva con su historial y deja de aparecer en la búsqueda</dd>
        </dl>
      </section>

      <div className="campo">
        <label htmlFor="motivo">Motivo de la fusión</label>
        <textarea id="motivo" name="motivo" rows={2} maxLength={300} defaultValue={v?.motivo ?? ""} aria-describedby="motivo-ayuda" />
        <span className="sub" id="motivo-ayuda">Obligatorio. Explica por qué son la misma persona, sin escribir teléfonos completos.</span>
      </div>

      <p className="aviso aviso-error" data-testid="aviso-irreversible">La fusión no se puede deshacer desde la pantalla.</p>
      <label className="casilla">
        <input type="checkbox" name="entiendo" value="si" />
        Entiendo que la fusión no se puede deshacer desde la pantalla.
      </label>
      <button className="boton boton-peligro" type="submit" disabled={enviando}>{enviando ? "Uniendo…" : "Unir fichas"}</button>
    </form>
  );
}

export function FlujoFusion({ codigo, base }: { codigo: string; base: { id: string } }) {
  const [busqueda, buscar, buscando] = useActionState(accionBuscarVisitantes, null);
  const [prep, preparar, preparando] = useActionState(accionPrepararFusion, null);
  const [fusion, fusionar, fusionando] = useActionState(accionFusionar, null);

  // La comparación más reciente: la de la fusión (si se volvió a mostrar) o la de la preparación.
  const actual = (fusion?.intento ?? 0) > 0 && (fusion?.a || fusion?.bloqueo) ? fusion : prep;
  const resultados = (busqueda?.resultados ?? []).filter((r) => r.id !== base.id);

  return (
    <>
      <form className="tarjeta buscador" action={buscar} role="search" key={`b${busqueda?.intento ?? 0}`}>
        <input type="hidden" name="codigo" value={codigo} />
        <div className="campo">
          <label htmlFor="q">Buscar la ficha duplicada (nombre o teléfono)</label>
          <input id="q" name="q" type="search" defaultValue={busqueda?.texto ?? ""} autoComplete="off" maxLength={120} />
        </div>
        <button className="boton boton-principal" type="submit" disabled={buscando}>{buscando ? "Buscando…" : "Buscar"}</button>
      </form>
      {busqueda?.error ? <p className="aviso aviso-error" role="alert">{busqueda.error}</p> : null}
      {busqueda?.resultados ? (
        <section className="tarjeta" data-testid="candidatas">
          <h2 className="titulo-seccion">{resultados.length ? "Elige la ficha que es la misma persona" : "Sin otras fichas"}</h2>
          <ul className="lista-visitantes">
            {resultados.map((r) => (
              <li key={r.id} className="tarjeta-visitante" data-testid="candidata">
                <div className="tarjeta-visitante-datos">
                  <strong>{r.nombre}</strong>
                  <span className="sub">Tel. {r.telefono ?? "no registrado"} · {r.estadoProcedencia ?? "procedencia no registrada"}</span>
                  <span className="sub">Creada en {r.sucursalAlta}</span>
                </div>
                <form action={preparar}>
                  <input type="hidden" name="codigo" value={codigo} />
                  <input type="hidden" name="a" value={base.id} />
                  <input type="hidden" name="b" value={r.id} />
                  <button className="boton" type="submit" disabled={preparando}>Comparar con esta ficha</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {actual?.error ? (
        <p className="aviso aviso-error" role="alert" data-testid={actual.bloqueo ? "fusion-bloqueada" : undefined}>{actual.error}</p>
      ) : null}
      {actual?.a && actual?.b && !actual.bloqueo ? (
        <section className="tarjeta" aria-label="Comparación de fichas">
          <Comparacion codigo={codigo} a={actual.a} b={actual.b} estado={actual} accion={fusionar} enviando={fusionando} />
        </section>
      ) : null}
    </>
  );
}

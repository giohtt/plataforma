"use client";

import { useActionState, useState } from "react";
import type { EstadoFormularioEntrega } from "@/app/acciones-entrega";
import {
  accionCancelarEntregaSobres, accionConfirmarRecoleccion, accionEntregarSobres, accionRegistrarDeposito, accionRevisarDiferenciaSobre,
} from "@/app/acciones-recoleccion";
import { VerificarSobres } from "@/components/Caja";
import { Importe } from "@/components/Entrega";

type Persona = { id: string; nombre: string };
type Sobre = { id: string; lugar: "bolsa_visitas" | "cajon_mensualidades"; folio: string };
type SobreCaja = Sobre & { dias: number; aviso: boolean; enEntrega: boolean; importe: string | null };

const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const LUGAR = { bolsa_visitas: "bolsa", cajon_mensualidades: "cajón" } as const;

function Aviso({ estado }: { estado: EstadoFormularioEntrega }) {
  return estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null;
}

/** La responsable en turno elige qué sobres entrega y a quién de Dirección. Nada se marca por omisión. */
export function FormularioEntregarSobres({ codigo, caja, direccion }: { codigo: string; caja: SobreCaja[]; direccion: Persona[] }) {
  const [estado, accion, enviando] = useActionState(accionEntregarSobres, null);
  const marcados = (estado?.valores?.entregar ?? "").split(",").filter(Boolean);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-entregar-sobres">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <fieldset className="campo campo-grupo" aria-invalid={estado?.errores?.sobres ? true : undefined}>
        <legend>Sobres que entregas</legend>
        {caja.map((s) => (
          <label key={s.id} className="opcion-revision" data-testid={`elegir-${s.folio}`}>
            <input type="checkbox" name="entregar" value={s.id} defaultChecked={marcados.includes(s.id)} />
            <span>
              <span className="mono">{s.folio}</span> · {LUGAR[s.lugar]}{s.importe ? ` · ${pesos.format(Number(s.importe))}` : ""} · {s.dias} {s.dias === 1 ? "día" : "días"}
              {s.aviso ? <strong> · aviso: 8 días o más</strong> : null}
            </span>
          </label>
        ))}
        <span className="sub">Los que no elijas se quedan en la caja y siguen visibles.</span>
        {estado?.errores?.sobres ? <span className="campo-error">{estado.errores.sobres}</span> : null}
      </fieldset>
      <div className="campo">
        <label htmlFor="recibe">Recoge (Dirección)</label>
        <select id="recibe" name="recibe" defaultValue={estado?.valores?.recibe ?? (direccion.length === 1 ? direccion[0].id : "")}
          aria-invalid={estado?.errores?.recibe ? true : undefined}>
          <option value="">Elige a quién entregas</option>
          {direccion.map((d) => <option key={d.id} value={d.id}>{d.nombre}</option>)}
        </select>
        {estado?.errores?.recibe ? <span className="campo-error">{estado.errores.recibe}</span> : null}
      </div>
      <p className="sub">Dirección confirma desde su cuenta: verifica cada sobre y lo cuenta sin ver lo anotado.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Entregar los sobres elegidos"}</button>
    </form>
  );
}

export function FormularioCancelarEntregaSobres({ codigo, recoleccionId, version }: { codigo: string; recoleccionId: string; version: number }) {
  const [estado, accion, enviando] = useActionState(accionCancelarEntregaSobres, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-cancelar-entrega-sobres">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="recoleccion" value={recoleccionId} />
      <input type="hidden" name="version" value={version} />
      <div className="campo">
        <label htmlFor="motivo-cancelar">Motivo para cancelar la entrega</label>
        <textarea id="motivo-cancelar" name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""}
          aria-invalid={estado?.errores?.motivo ? true : undefined} />
        {estado?.errores?.motivo ? <span className="campo-error">{estado.errores.motivo}</span> : null}
      </div>
      <button className="boton" type="submit" disabled={enviando}>{enviando ? "Cancelando…" : "Cancelar la entrega (los sobres siguen en la caja)"}</button>
    </form>
  );
}

/** Dirección verifica sello y folio de cada sobre y lo cuenta a ciegas. */
export function FormularioConfirmarRecoleccion({ codigo, recoleccionId, version, sobres }: {
  codigo: string; recoleccionId: string; version: number; sobres: Sobre[];
}) {
  const [estado, accion, enviando] = useActionState(accionConfirmarRecoleccion, null);
  const [llave, setLlave] = useState(estado?.valores?.llave ?? "correcta");
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-confirmar-recoleccion">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="recoleccion" value={recoleccionId} />
      <input type="hidden" name="version" value={version} />
      <VerificarSobres estado={estado} sobres={sobres} porFolio pregunta="¿Lo recibes cerrado, con el sello intacto y con este folio?" />
      <fieldset className="campo campo-grupo" data-testid="conteo-ciego">
        <legend>Conteo a ciegas de cada sobre</legend>
        <span className="sub">Abre y cuenta cada sobre. No ves lo anotado al cerrar; la diferencia por sobre queda por revisar.</span>
        {sobres.map((s) => (
          <Importe key={s.id} estado={estado} campo={`contado-${s.id}`} etiqueta={`Sobre ${s.folio} · ${LUGAR[s.lugar]} · contado`}
 />
        ))}
      </fieldset>
      <fieldset className="campo campo-grupo" data-testid="caja-recoleccion" aria-invalid={estado?.errores?.motivo_llave ? true : undefined}>
        <legend>Caja de sobres</legend>
        <label className="opcion-revision">
          <input type="radio" name="llave" value="correcta" checked={llave === "correcta"} onChange={() => setLlave("correcta")} />
          <span>La caja estaba cerrada con llave y la abrió la custodia</span>
        </label>
        <label className="opcion-revision">
          <input type="radio" name="llave" value="incidencia" checked={llave === "incidencia"} onChange={() => setLlave("incidencia")} />
          <span>Hubo un problema con la caja o la llave</span>
        </label>
        {llave === "incidencia" ? (
          <div className="campo">
            <label htmlFor="motivo_llave">Motivo</label>
            <textarea id="motivo_llave" name="motivo_llave" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo_llave ?? ""} />
          </div>
        ) : null}
        {estado?.errores?.motivo_llave ? <span className="campo-error">{estado.errores.motivo_llave}</span> : null}
      </fieldset>
      <p className="sub">Desde que confirmes, lo recogido queda bajo tu responsabilidad hasta depositarlo.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Confirmando…" : "Confirmar lo que recojo"}</button>
    </form>
  );
}

/** Quien recogió registra cada depósito (parcial o total). Referencia ficticia: nunca datos bancarios reales. */
export function FormularioDeposito({ codigo, recoleccionId, saldo, hoy }: { codigo: string; recoleccionId: string; saldo: string; hoy: string }) {
  const [estado, accion, enviando] = useActionState(accionRegistrarDeposito, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-deposito">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="recoleccion" value={recoleccionId} />
      <Importe estado={estado} campo="importe" etiqueta={`Importe depositado (falta ${pesos.format(Number(saldo))})`} ayuda="Puede ser parcial; el resto sigue bajo tu responsabilidad." />
      <div className="campo">
        <label htmlFor="fecha">Fecha del depósito</label>
        <input id="fecha" name="fecha" type="date" max={hoy} defaultValue={estado?.valores?.fecha ?? hoy} aria-invalid={estado?.errores?.fecha ? true : undefined} />
        {estado?.errores?.fecha ? <span className="campo-error">{estado.errores.fecha}</span> : null}
      </div>
      <div className="campo">
        <label htmlFor="referencia">Referencia del depósito (ficticia)</label>
        <input id="referencia" name="referencia" maxLength={60} autoComplete="off" defaultValue={estado?.valores?.referencia ?? ""}
          aria-invalid={estado?.errores?.referencia ? true : undefined} />
        <span className="sub">Solo datos ficticios: no escribas números de cuenta ni datos bancarios reales.</span>
        {estado?.errores?.referencia ? <span className="campo-error">{estado.errores.referencia}</span> : null}
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar el depósito"}</button>
    </form>
  );
}

/** Administración (que no participó) revisa la diferencia de un sobre. */
export function FormularioRevisarDiferenciaSobre({ codigo, diferenciaId, importe }: { codigo: string; diferenciaId: string; importe: string }) {
  const [estado, accion, enviando] = useActionState(accionRevisarDiferenciaSobre, null);
  const c = Math.round(Number(importe) * 100);
  const opciones: [string, string][] = c < 0
    ? [["aclarada", "Aclarada (no falta dinero)"], ["faltante_confirmado", "Faltante confirmado"]]
    : c > 0
    ? [["aclarada", "Aclarada (no sobra dinero)"], ["sobrante_confirmado", "Sobrante confirmado"]]
    : [["aclarada", "Aclarada"], ["incidencia_confirmada", "Incidencia confirmada"]];
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-revisar-sobre">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="diferencia" value={diferenciaId} />
      <fieldset className="campo campo-grupo" aria-invalid={estado?.errores?.resultado ? true : undefined}>
        <legend>Resultado de la revisión</legend>
        {opciones.map(([v, t]) => (
          <label key={v} className="opcion-revision">
            <input type="radio" name="resultado" value={v} defaultChecked={estado?.valores?.resultado === v} />
            <span>{t}</span>
          </label>
        ))}
        {estado?.errores?.resultado ? <span className="campo-error">{estado.errores.resultado}</span> : null}
      </fieldset>
      <div className="campo">
        <label htmlFor={`motivo-${diferenciaId}`}>Motivo</label>
        <textarea id={`motivo-${diferenciaId}`} name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""}
          aria-invalid={estado?.errores?.motivo ? true : undefined} />
        {estado?.errores?.motivo ? <span className="campo-error">{estado.errores.motivo}</span> : null}
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Guardando…" : "Guardar la revisión"}</button>
    </form>
  );
}

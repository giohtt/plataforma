"use client";

import { useActionState, useState } from "react";
import type { EstadoFormularioEntrega } from "@/app/acciones-entrega";
import { accionCambiarMontoFondo, accionCancelarEntradaFondo, accionConfirmarEntradaFondo, accionRegistrarReposicion } from "@/app/acciones-fondos";
import { Importe } from "@/components/Entrega";

type Lugar = "bolsa_visitas" | "cajon_mensualidades";
const NOMBRE = { bolsa_visitas: "Fondo de visitas (bolsa)", cajon_mensualidades: "Fondo de mensualidades (cajón)" } as const;
const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

function Aviso({ estado }: { estado: EstadoFormularioEntrega }) {
  return estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null;
}
function CampoError({ estado, campo }: { estado: EstadoFormularioEntrega; campo: string }) {
  const e = estado?.errores?.[campo];
  return e ? <span className="campo-error">{e}</span> : null;
}
function ElegirLugar({ estado, valor, alCambiar }: { estado: EstadoFormularioEntrega; valor: string; alCambiar: (v: string) => void }) {
  return (
    <fieldset className="campo campo-grupo">
      <legend>Fondo</legend>
      {(["bolsa_visitas", "cajon_mensualidades"] as const).map((l) => (
        <label key={l} className="opcion-revision">
          <input type="radio" name="lugar" value={l} checked={valor === l} onChange={() => alCambiar(l)} />
          <span>{NOMBRE[l]}</span>
        </label>
      ))}
      <CampoError estado={estado} campo="lugar" />
    </fieldset>
  );
}

/** Dirección cambia el monto: un aumento pide de dónde sale el dinero; una reducción, a dónde va. */
export function FormularioCambioFondo({ codigo, vigentes }: { codigo: string; vigentes: { tipo: Lugar; monto: string }[] }) {
  const [estado, accion, enviando] = useActionState(accionCambiarMontoFondo, null);
  const [lugar, setLugar] = useState(estado?.valores?.lugar ?? "");
  const [monto, setMonto] = useState(estado?.valores?.monto ?? "");
  const [origen, setOrigen] = useState(estado?.valores?.origen ?? "");
  const vigente = vigentes.find((v) => v.tipo === lugar);
  const nuevo = Number(monto.replace(/[$,\s]/g, ""));
  const sentido = !vigente || monto.trim() === "" || Number.isNaN(nuevo) ? null : nuevo > Number(vigente.monto) ? "aumento" : nuevo < Number(vigente.monto) ? "reduccion" : "igual";
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-cambio-fondo">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <ElegirLugar estado={estado} valor={lugar} alCambiar={setLugar} />
      <Importe estado={estado} campo="monto" etiqueta={`Monto nuevo${vigente ? ` (vigente ${pesos.format(Number(vigente.monto))})` : ""}`} alCambiar={setMonto} />
      {sentido === "aumento" ? (
        <fieldset className="campo campo-grupo" data-testid="origen-aumento">
          <legend>De dónde sale el dinero ({pesos.format(nuevo - Number(vigente!.monto))})</legend>
          <label className="opcion-revision">
            <input type="radio" name="origen" value="entrega_persona" checked={origen === "entrega_persona"} onChange={() => setOrigen("entrega_persona")} />
            <span>Lo entrego yo en efectivo: la responsable confirma cuánto recibe</span>
          </label>
          <label className="opcion-revision">
            <input type="radio" name="origen" value="excedente_cierre" checked={origen === "excedente_cierre"} onChange={() => setOrigen("excedente_cierre")} />
            <span>Del excedente del próximo cierre, antes de llenar el sobre</span>
          </label>
          {origen === "entrega_persona" ? (
            <div className="campo">
              <label htmlFor="detalle">Origen del dinero que entregas</label>
              <input id="detalle" name="detalle" maxLength={200} defaultValue={estado?.valores?.detalle ?? ""} />
            </div>
          ) : null}
          <CampoError estado={estado} campo="origen" />
        </fieldset>
      ) : sentido === "reduccion" ? (
        <fieldset className="campo campo-grupo" data-testid="destino-reduccion">
          <legend>A dónde va el dinero ({pesos.format(Number(vigente!.monto) - nuevo)})</legend>
          <label className="opcion-revision">
            <input type="radio" name="destino" value="sobre_cierre" defaultChecked={estado?.valores?.destino === "sobre_cierre"} />
            <span>Al sobre del próximo cierre, junto con el excedente</span>
          </label>
          <label className="opcion-revision">
            <input type="radio" name="destino" value="retiro" defaultChecked={estado?.valores?.destino === "retiro"} />
            <span>Se entrega a Encargada de retiros con el flujo de retiros</span>
          </label>
          <CampoError estado={estado} campo="destino" />
        </fieldset>
      ) : sentido === "igual" ? <p className="sub">Es el monto vigente.</p> : null}
      <div className="campo">
        <label htmlFor="motivo-monto">Motivo</label>
        <textarea id="motivo-monto" name="motivo" rows={2} maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} />
        <CampoError estado={estado} campo="motivo" />
      </div>
      <p className="sub">Solo Dirección autoriza. Aplica desde el siguiente cierre.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Guardando…" : "Autorizar el cambio de monto"}</button>
    </form>
  );
}

/** Dirección o Administración registra una reposición: cuánto entrega y de dónde sale. */
export function FormularioReposicion({ codigo }: { codigo: string }) {
  const [estado, accion, enviando] = useActionState(accionRegistrarReposicion, null);
  const [lugar, setLugar] = useState(estado?.valores?.lugar ?? "");
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-reposicion">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <ElegirLugar estado={estado} valor={lugar} alCambiar={setLugar} />
      <Importe estado={estado} campo="importe" etiqueta="Cuánto entregas" />
      <div className="campo">
        <label htmlFor="origen-reposicion">De dónde sale el dinero</label>
        <input id="origen-reposicion" name="origen" maxLength={200} defaultValue={estado?.valores?.origen ?? ""} />
        <CampoError estado={estado} campo="origen" />
      </div>
      <p className="sub">La responsable vigente confirma desde su cuenta cuánto recibe. Reponer no cierra la revisión del faltante.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Registrando…" : "Registrar reposición"}</button>
    </form>
  );
}

/** Quien recibe confirma cuánto recibió. */
export function FormularioConfirmarEntrada({ codigo, entradaId }: { codigo: string; entradaId: string }) {
  const [estado, accion, enviando] = useActionState(accionConfirmarEntradaFondo, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate data-testid="formulario-recibir-fondo">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="entrada" value={entradaId} />
      <Importe estado={estado} campo="recibido" etiqueta="Cuánto recibiste" />
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Confirmando…" : "Confirmo lo que recibí"}</button>
    </form>
  );
}

/** Quien registró una entrada pendiente la cancela con motivo. */
export function FormularioCancelarEntrada({ codigo, entradaId }: { codigo: string; entradaId: string }) {
  const [estado, accion, enviando] = useActionState(accionCancelarEntradaFondo, null);
  return (
    <form action={accion} className="formulario" key={estado?.intento ?? 0} noValidate>
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="entrada" value={entradaId} />
      <div className="campo">
        <label htmlFor={`motivo-cancelar-${entradaId}`}>Motivo para cancelar</label>
        <input id={`motivo-cancelar-${entradaId}`} name="motivo" maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} />
        <CampoError estado={estado} campo="motivo" />
      </div>
      <button className="boton" type="submit" disabled={enviando}>Cancelar esta entrada</button>
    </form>
  );
}

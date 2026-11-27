"use client";

import { useActionState, useState } from "react";
import { accionCorregirGasto, accionSolicitarGasto, type EstadoGasto } from "@/app/acciones-gastos";
import type { Categoria, SucursalOpcion } from "@/lib/gastos";

function ErrorCampo({ estado, campo }: { estado: EstadoGasto; campo: string }) {
  const e = estado?.errores?.[campo];
  return e ? <span className="campo-error">{e}</span> : null;
}
function Aviso({ estado }: { estado: EstadoGasto }) {
  return estado?.error ? <p className="aviso aviso-error" role="alert">{estado.error}</p> : null;
}

/** Campos de una versión: concepto, categoría, importe, proveedor y nota. */
function CamposVersion({ estado, categorias, inicial }: {
  estado: EstadoGasto; categorias: Categoria[];
  inicial?: { concepto: string; categoria: string; importe: string; proveedor: string | null; nota: string | null };
}) {
  const v = (c: string, d = "") => estado?.valores?.[c] ?? d;
  return (
    <>
      <div className="campo">
        <label htmlFor="concepto">Qué se va a comprar o pagar</label>
        <input id="concepto" name="concepto" maxLength={120} defaultValue={v("concepto", inicial?.concepto)} aria-invalid={estado?.errores?.concepto ? true : undefined} />
        <ErrorCampo estado={estado} campo="concepto" />
      </div>
      <div className="campos-fila">
        <div className="campo">
          <label htmlFor="categoria">Categoría</label>
          <select id="categoria" name="categoria" defaultValue={v("categoria", inicial?.categoria)} aria-invalid={estado?.errores?.categoria ? true : undefined}>
            <option value="">Elige una categoría…</option>
            {categorias.map((c) => <option key={c.clave} value={c.clave}>{c.nombre}</option>)}
          </select>
          {categorias.some((c) => c.dePrueba) ? <span className="sub">Categorías de prueba: la lista real está pendiente.</span> : null}
          <ErrorCampo estado={estado} campo="categoria" />
        </div>
        <div className="campo">
          <label htmlFor="importe">Importe</label>
          <div className="importe"><span aria-hidden="true">$</span>
            <input id="importe" name="importe" inputMode="decimal" defaultValue={v("importe", inicial?.importe)} aria-invalid={estado?.errores?.importe ? true : undefined} />
          </div>
          <ErrorCampo estado={estado} campo="importe" />
        </div>
      </div>
      <div className="campo">
        <label htmlFor="proveedor">Proveedor o a quién se paga (opcional)</label>
        <input id="proveedor" name="proveedor" maxLength={120} defaultValue={v("proveedor", inicial?.proveedor ?? "")} aria-invalid={estado?.errores?.proveedor ? true : undefined} />
        <ErrorCampo estado={estado} campo="proveedor" />
      </div>
      <div className="campo">
        <label htmlFor="nota">Nota (opcional)</label>
        <textarea id="nota" name="nota" maxLength={300} defaultValue={v("nota", inicial?.nota ?? "")} aria-invalid={estado?.errores?.nota ? true : undefined} />
        <ErrorCampo estado={estado} campo="nota" />
      </div>
    </>
  );
}

export function FormularioSolicitud({ codigo, sucursalId, categorias, sucursales, compras }: {
  codigo: string; sucursalId: string; categorias: Categoria[]; sucursales: SucursalOpcion[];
  compras: { id: string; clave: string; concepto: string }[];
}) {
  const [estado, accion, enviando] = useActionState(accionSolicitarGasto, null);
  const [envio] = useState(() => crypto.randomUUID());
  const [parte, setParte] = useState(estado?.valores?.parte === "si");
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-solicitud">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="envio" value={envio} />
      <CamposVersion estado={estado} categorias={categorias} />
      <div className="campo">
        <label htmlFor="paga">Sucursal que paga</label>
        <select id="paga" name="paga" defaultValue={estado?.valores?.paga ?? sucursalId} aria-invalid={estado?.errores?.paga ? true : undefined}>
          {sucursales.map((s) => <option key={s.id} value={s.id}>{s.id === sucursalId ? `${s.nombre} (esta sucursal)` : s.nombre}</option>)}
        </select>
        <span className="sub">El gasto se carga a esta sucursal; el dinero sale de la que paga.</span>
        <ErrorCampo estado={estado} campo="paga" />
      </div>
      <label className="opcion-revision">
        <input type="checkbox" name="parte" value="si" checked={parte} onChange={(e) => setParte(e.target.checked)} />
        <span>Es parte de una compra ya solicitada</span>
      </label>
      {parte ? (
        <div className="campo">
          <label htmlFor="compra">Compra original</label>
          <select id="compra" name="compra" defaultValue={estado?.valores?.compra ?? ""} aria-invalid={estado?.errores?.compra ? true : undefined}>
            <option value="">Elige la solicitud original…</option>
            {compras.map((c) => <option key={c.id} value={c.id}>{c.clave} · {c.concepto}</option>)}
          </select>
          <span className="sub">Una misma compra no se divide: se suma a la original para los límites.</span>
          <ErrorCampo estado={estado} campo="compra" />
        </div>
      ) : null}
      <p className="sub">Solicitar no mueve dinero ni autoriza el gasto.</p>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Enviando…" : "Enviar solicitud"}</button>
    </form>
  );
}

export function FormularioCorreccion({ codigo, clave, version, categorias, actual }: {
  codigo: string; clave: string; version: number; categorias: Categoria[];
  actual: { concepto: string; categoria: string; importe: string; proveedor: string | null; nota: string | null };
}) {
  const [estado, accion, enviando] = useActionState(accionCorregirGasto, null);
  const [abierto, setAbierto] = useState(false);
  if (!abierto && !estado) {
    return <button className="boton" type="button" onClick={() => setAbierto(true)} data-testid="abrir-correccion">Corregir solicitud</button>;
  }
  return (
    <form action={accion} className="formulario" noValidate key={estado?.intento ?? 0} data-testid="formulario-correccion">
      <Aviso estado={estado} />
      <input type="hidden" name="codigo" value={codigo} />
      <input type="hidden" name="clave" value={clave} />
      <input type="hidden" name="version" value={version} />
      <h3>Corregir solicitud</h3>
      <p className="sub">Se guarda como versión {version + 1}; la versión {version} se conserva.</p>
      <CamposVersion estado={estado} categorias={categorias} inicial={actual} />
      <div className="campo">
        <label htmlFor="motivo">Motivo de la corrección (obligatorio)</label>
        <textarea id="motivo" name="motivo" maxLength={300} defaultValue={estado?.valores?.motivo ?? ""} aria-invalid={estado?.errores?.motivo ? true : undefined} />
        <ErrorCampo estado={estado} campo="motivo" />
      </div>
      <button className="boton boton-principal" type="submit" disabled={enviando}>{enviando ? "Guardando…" : "Guardar corrección"}</button>
    </form>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import type { ResultadoVisitante } from "@/lib/visitantes";

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });

const MOTIVO: Record<ResultadoVisitante["motivos"][number], string> = {
  mismo_telefono: "Mismo teléfono",
  mismo_nombre: "Mismo nombre",
  nombre_parecido: "Nombre parecido",
};

/** Una coincidencia: datos para distinguir a la persona y el botón para elegirla. Sin hooks: sirve en servidor y cliente. */
/** `accion` reemplaza el enlace «Es esta persona» (por ejemplo, para elegir la ficha al registrar una visita). */
export function TarjetaVisitante({ v, codigo, mostrarMotivos, accion }: { v: ResultadoVisitante; codigo: string; mostrarMotivos?: boolean; accion?: ReactNode }) {
  return (
    <li className="tarjeta-visitante" data-testid="visitante" data-id={v.id}>
      <div className="tarjeta-visitante-datos">
        <strong>{v.nombre}</strong>
        <span className="sub">
          Tel. {v.telefono ?? "no registrado"} · {v.estadoProcedencia ?? "procedencia no registrada"}
        </span>
        <span className="sub">Registrado en {v.sucursalAlta} el {fecha.format(new Date(v.creadoEn))}</span>
        {v.historial ? (
          <span className="historial-resumen" data-testid="historial-resumen">
            <span>
              {v.historial.visitas
                ? <><strong>{v.historial.visitas} {v.historial.visitas === 1 ? "visita registrada" : "visitas registradas"}</strong>
                    {v.historial.ultima ? ` · Última el ${fecha.format(new Date(v.historial.ultima.en))} en ${v.historial.ultima.sucursal}` : ""}</>
                : "Sin visitas registradas"}
            </span>
            <span>
              {v.historial.incompleto ? <span className="chip-estado chip-incompleto" data-testid="historial-incompleto">Historial incompleto</span> : null}{" "}
              <Link href={`/sucursales/${codigo}/visitantes/${v.id}#historial`} target={accion ? "_blank" : undefined} data-testid="ver-historial">
                Ver historial
              </Link>
            </span>
          </span>
        ) : null}
        {mostrarMotivos && v.motivos.length ? (
          <span className="motivos-coincidencia">{v.motivos.map((m) => <span key={m} className="chip-estado chip-programada">{MOTIVO[m]}</span>)}</span>
        ) : null}
      </div>
      {accion ?? (
        <Link className="boton" href={`/sucursales/${codigo}/visitantes/${v.id}?aviso=seleccionado`}>
          Es esta persona
        </Link>
      )}
    </li>
  );
}

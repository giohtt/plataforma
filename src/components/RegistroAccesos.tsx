import Link from "next/link";
import { MOTIVOS, type AccesoRegistro } from "@/lib/accesos";

const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const TIPO = { entrada: "Entrada", reingreso: "Reingreso", sin_pase: "Sin pase" } as const;

/** Tabla de accesos registrados (solo lectura). */
export function TablaAccesos({ codigo, filas, conTurno }: { codigo: string; filas: AccesoRegistro[]; conTurno?: boolean }) {
  if (!filas.length) return <p className="sub" data-testid="sin-accesos">No hay accesos registrados.</p>;
  return (
    <div className="tabla-desplazable">
      <table className="tabla" data-testid="tabla-accesos">
        <thead>
          <tr><th>Hora</th><th>Tipo</th><th>Persona o motivo</th><th>Registró</th>{conTurno ? <th>Turno</th> : null}</tr>
        </thead>
        <tbody>
          {filas.map((a) => (
            <tr key={a.id} data-testid="acceso">
              <td data-etiqueta="Hora">{fechaHora.format(new Date(a.en))}</td>
              <td data-etiqueta="Tipo">
                {TIPO[a.tipo]}
                {a.transferenciaPendiente ? " · con transferencia pendiente" : ""}
                {a.motivo === "emergencia" ? " · emergencia" : ""}
              </td>
              <td data-etiqueta="Persona o motivo">
                {a.persona ? (
                  <>{a.persona}{a.operacionId ? <> · <Link href={`/sucursales/${codigo}/turno/cobros/${a.operacionId}`}>ver cobro</Link></> : null}</>
                ) : a.motivo ? (
                  <>{MOTIVOS[a.motivo]}{a.detalle ? ` · «${a.detalle}»` : ""}</>
                ) : null}
                {a.motivo === "emergencia" && !a.detalle ? <strong className="estado-mal"> · Falta el motivo</strong> : null}
                {a.detallePor ? <span className="sub"> · motivo completado por {a.detallePor}</span> : null}
                {a.autorizadaPor ? <span className="sub"> · autorizó {a.autorizadaPor}: «{a.motivoAutorizacion}»</span> : null}
              </td>
              <td data-etiqueta="Registró">{a.por}</td>
              {conTurno ? <td data-etiqueta="Turno">abierto el {fechaHora.format(new Date(a.turnoAbiertoEn))}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

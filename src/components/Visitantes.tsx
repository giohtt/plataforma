import Link from "next/link";
import type { ResultadoVisitante } from "@/lib/visitantes";

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" });

const MOTIVO: Record<ResultadoVisitante["motivos"][number], string> = {
  mismo_telefono: "Mismo teléfono",
  mismo_nombre: "Mismo nombre",
  nombre_parecido: "Nombre parecido",
};

/** Una coincidencia: datos para distinguir a la persona y el botón para elegirla. Sin hooks: sirve en servidor y cliente. */
export function TarjetaVisitante({ v, codigo, mostrarMotivos }: { v: ResultadoVisitante; codigo: string; mostrarMotivos?: boolean }) {
  return (
    <li className="tarjeta-visitante" data-testid="visitante" data-id={v.id}>
      <div className="tarjeta-visitante-datos">
        <strong>{v.nombre}</strong>
        <span className="sub">
          Tel. {v.telefono ?? "no registrado"} · {v.estadoProcedencia ?? "procedencia no registrada"}
        </span>
        <span className="sub">Registrado en {v.sucursalAlta} el {fecha.format(new Date(v.creadoEn))}</span>
        {mostrarMotivos && v.motivos.length ? (
          <span className="motivos-coincidencia">{v.motivos.map((m) => <span key={m} className="chip-estado chip-programada">{MOTIVO[m]}</span>)}</span>
        ) : null}
      </div>
      <Link className="boton" href={`/sucursales/${codigo}/visitantes/${v.id}?aviso=seleccionado`}>
        Es esta persona
      </Link>
    </li>
  );
}

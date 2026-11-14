import Link from "next/link";
import { notFound } from "next/navigation";
import { FormularioRetiro } from "@/components/Retiros";
import { obtenerBaseDatos } from "@/lib/db";
import { leerEntorno } from "@/lib/entorno";
import { pantallaRetiro } from "@/lib/retiros";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Entregar a Encargada de retiros · Fitnessland" };

const MOTIVO: Record<string, string> = {
  sin_permiso: "Tu cuenta no puede entregar retiros en esta sucursal.",
  sucursal_inactiva: "Esta sucursal está desactivada: no se registran retiros.",
  sin_turno: "No hay turno abierto en esta sucursal.",
  no_responsable: "Solo la responsable vigente de un lugar entrega su efectivo.",
  entrega_en_curso: "Hay un cambio de turno en curso: no se registran retiros hasta que se confirme o se cancele.",
  bloqueado_produccion: "Los retiros están desactivados fuera del entorno de pruebas.",
};

/** Recepción entrega en persona a Encargada de retiros: un registro por lugar, cada uno con su folio. */
export default async function EntregarRetiro({ params, searchParams }: PageProps<"/sucursales/[codigo]/turno/retiro">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const { cancelado } = await searchParams;
  const p = await pantallaRetiro(obtenerBaseDatos()!, sesion.usuarioId, codigo, leerEntorno());
  if (!p.ok && p.error === "no_encontrada") notFound();
  return (
    <main className="contenedor contenedor-amplio">
      <p className="sub"><Link href={`/sucursales/${codigo}/turno`}>← Turno</Link></p>
      <h1 className="cabecera-titulo">Entregar efectivo a Encargada de retiros{p.ok ? ` · ${p.sucursal}` : ""}</h1>
      <p className="sub">
        Solo datos ficticios. Entrega en persona, un registro por lugar: genera el folio, anótalo en el sobre y, ya entregado,
        confirma la entrega. Encargada de retiros confirma desde su propia cuenta. Puedes seguir cobrando mientras confirma.
      </p>
      {typeof cancelado === "string" ? (
        <p className="aviso aviso-ok" role="status">Preparación cancelada: no hubo salida de efectivo. El folio {cancelado} queda cancelado y no se vuelve a usar.</p>
      ) : null}
      {!p.ok ? (
        <p className="aviso aviso-info" data-testid="retiro-impedido">{MOTIVO[p.error] ?? "No disponible."}</p>
      ) : !p.encargadas.length ? (
        <p className="aviso aviso-info" data-testid="retiro-impedido">No hay una Encargada de retiros autorizada en esta sucursal.</p>
      ) : (
        <div className="lugares-turno">
          {p.lugares.filter((l) => l.responsable).map((l) => (
            <FormularioRetiro key={l.tipo} codigo={codigo} turnoId={p.turnoId} lugar={l.tipo} esperado={l.esperado} diferenciaRetiros={l.diferenciaRetiros} encargadas={p.encargadas} reserva={l.reserva} />
          ))}
        </div>
      )}
    </main>
  );
}

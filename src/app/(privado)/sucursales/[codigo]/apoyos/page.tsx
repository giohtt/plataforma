import Link from "next/link";
import { notFound } from "next/navigation";
import { accionConfirmarApoyo } from "@/app/acciones-entrega";
import { obtenerBaseDatos } from "@/lib/db";
import { conPunto } from "@/lib/formato";
import { apoyosPorConfirmar } from "@/lib/entregas";
import { requerirSesion } from "@/lib/sesion-servidor";

export const metadata = { title: "Confirmar apoyo · Fitnessland" };

const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
const ETAPA = { conteo_entrega: "el conteo de quien entregó", conteo_recepcion: "el conteo de quien recibió", recuento: "el recuento" } as const;
const AVISO: Record<string, string> = {
  confirmado: "Participación confirmada.",
  ya_confirmado: "Ya habías confirmado esa participación.",
  no_encontrada: "No encontrada.",
  bloqueado_produccion: "Desactivado fuera del entorno de pruebas.",
};

/** Participaciones como apoyo en un conteo o recuento que la cuenta debe confirmar desde su propia sesión. */
export default async function Apoyos({ params, searchParams }: PageProps<"/sucursales/[codigo]/apoyos">) {
  const sesion = await requerirSesion();
  const { codigo } = await params;
  const { aviso } = await searchParams;
  const r = await apoyosPorConfirmar(obtenerBaseDatos()!, sesion.usuarioId, codigo);
  if (!r) notFound();
  return (
    <main className="contenedor contenedor-medio">
      <p className="sub"><Link href={`/sucursales/${codigo}`}>← {r.sucursal}</Link></p>
      <h1 className="cabecera-titulo">Confirmar tu apoyo en un conteo</h1>
      <p className="sub">Alguien declaró que le ayudaste a contar. Confírmalo desde tu cuenta. Solo datos ficticios.</p>
      {typeof aviso === "string" && AVISO[aviso] ? (
        <p className={`aviso ${aviso === "confirmado" ? "aviso-ok" : "aviso-info"}`} role="status">{AVISO[aviso]}</p>
      ) : null}
      <section className="tarjeta">
        {r.pendientes.length ? (
          <ul className="lista-simple">
            {r.pendientes.map((a) => (
              <li key={a.id} data-testid="apoyo-pendiente">
                <p>
                  <strong>{a.declaradoPor}</strong> declaró que participaste en {ETAPA[a.etapa]} · {hora.format(a.declaradoEn)}
                </p>
                <p className="sub">Cambio de turno de {a.entregaPor} a {a.recibe}, entregado {conPunto(hora.format(a.entregadaEn))} Desde la declaración ya no puedes revisar las diferencias de esa entrega.</p>
                <form action={accionConfirmarApoyo}>
                  <input type="hidden" name="codigo" value={codigo} />
                  <input type="hidden" name="apoyo" value={a.id} />
                  <button className="boton boton-principal" type="submit">Confirmo que participé</button>
                </form>
              </li>
            ))}
          </ul>
        ) : <p className="sub" data-testid="sin-apoyos">No tienes participaciones pendientes de confirmar en esta sucursal.</p>}
      </section>
    </main>
  );
}

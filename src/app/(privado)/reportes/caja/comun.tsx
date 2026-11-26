import Link from "next/link";
import type { ReporteCaja } from "@/lib/reporte-caja";
import type { Cifra, Total } from "@/lib/resumen-caja";

/** Piezas compartidas por las pantallas de «Caja y depósitos» (resumen y más detalle). */
const pesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
export const $ = (v: string) => (Number(v) < 0 ? `−${pesos.format(-Number(v))}` : pesos.format(Number(v)));
/** Con signo siempre: «+» en sobrantes y «−» en faltantes (lista de diferencias). */
export const $signo = (v: string) => (Number(v) > 0 ? `+${$(v)}` : $(v));
export const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
export const diaCorto = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short" });
const dia = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", dateStyle: "medium" });
export const fecha = (f: string) => dia.format(new Date(`${f}T00:00:00Z`));
export const texto = (v: string | string[] | undefined, max = 40) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** Periodo y corte que se conservan al ir de una pantalla a otra. */
export function consulta(r: Pick<ReporteCaja, "desde" | "hasta" | "corte">, extra: Record<string, string>) {
  return new URLSearchParams({ desde: r.desde, hasta: r.hasta, corte: r.corte.toISOString(), ...extra });
}
/** Detalle e historial de un importe, con el mismo periodo y corte. */
export const enlaceDetalle = (r: Pick<ReporteCaja, "desde" | "hasta" | "corte">, codigo: string, tipo: string, id: string) =>
  `/reportes/caja/detalle?${consulta(r, { sucursal: codigo, tipo, id })}`;
/** Segundo nivel («Más detalle»), con el mismo periodo y corte. */
export const enlaceMas = (r: Pick<ReporteCaja, "desde" | "hasta" | "corte">, sucursal: string, vista: string, extra: Record<string, string> = {}) =>
  `/reportes/caja/mas?${consulta(r, { sucursal, vista, ...extra })}`;

export function Importe({ v, href, testid, oculto = "Oculto: sin contar" }: { v: string | null; href?: string; testid?: string; oculto?: string }) {
  if (v === null) return <span className="importe-oculto" data-testid={testid}>{oculto}</span>;
  return href ? <Link href={href} prefetch={false} data-testid={testid}><strong>{$(v)}</strong></Link> : <strong data-testid={testid}>{$(v)}</strong>;
}
export const Anterior = ({ si }: { si: boolean }) => (si ? <> <span className="marca-anterior">Anterior al periodo</span></> : null);

/** Una de las cuatro cifras de custodia. Sin ningún importe conocido: «Sin datos» u «Oculto», nunca $0.00. */
export function Kpi({ etiqueta, cifra, href, testid, fuera }: { etiqueta: string; cifra: Pick<Cifra, "importe" | "ocultos" | "nota">; href?: string; testid: string; fuera?: boolean }) {
  return (
    <div className={`kpi${fuera ? " kpi-fuera" : ""}`} data-testid={testid}>
      <span className="kpi-etiqueta">{etiqueta}</span>
      <span className="kpi-cifra" data-testid={`${testid}-importe`}>
        {cifra.importe === null
          ? <span className="importe-oculto">{cifra.ocultos ? "Oculto: sin contar" : "Sin datos"}</span>
          : href ? <Link href={href} prefetch={false}>{$(cifra.importe)}</Link> : $(cifra.importe)}
      </span>
      <span className="kpi-nota">{cifra.nota}</span>
    </div>
  );
}

export function RecuadroTotal({ t, ocultos }: { t: Total; ocultos: number }) {
  return (
    <div className="total-caja" data-testid="total-caja">
      <div>
        <strong data-testid="total-etiqueta">{t.etiqueta}</strong>
        <p className="total-limitacion" data-testid="total-nota">{t.nota}</p>
      </div>
      <p className="cifra-grande" data-testid="total-importe">
        {t.importe === null ? <span className="importe-oculto">Sin datos</span> : $(t.importe)}
        {t.importe !== null && ocultos > 0 ? <span className="total-ocultos"> + {ocultos} {ocultos === 1 ? "oculto" : "ocultos"}</span> : null}
      </p>
    </div>
  );
}

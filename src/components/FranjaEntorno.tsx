import { etiquetaEntorno, leerEntorno } from "@/lib/entorno";

/** Franja visible en desarrollo y pruebas. No aparece en producción. */
export function FranjaEntorno() {
  const texto = etiquetaEntorno(leerEntorno());
  if (!texto) return null;
  return (
    <div className="franja-entorno" role="note" data-testid="franja-entorno">
      {texto}
    </div>
  );
}

/**
 * Color de identificación de una sucursal, con contraste calculado (tomado del prototipo).
 * Sin color asignado se usa un gris neutro.
 */
const NEUTRO = "#4b5563";

function rgb(hex: string): number[] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function aHex(c: number[]): string {
  return "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function luminancia(c: number[]): number {
  const [r, g, b] = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contraste(a: number[], b: number[]): number {
  const [x, y] = [luminancia(a), luminancia(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function mezclar(a: number[], b: number[], w: number): number[] {
  return a.map((v, i) => v * (1 - w) + b[i] * w);
}
function oscurecerHasta(c: number[], minimo: number): number[] {
  const blanco = [255, 255, 255];
  for (let i = 0; i <= 20; i++) {
    const r = mezclar(c, [0, 0, 0], i * 0.05);
    if (contraste(r, blanco) >= minimo) return r;
  }
  return [0, 0, 0];
}

export function temaSucursal(color: string | null): Record<string, string> {
  const c = rgb(color && /^#[0-9a-f]{6}$/i.test(color) ? color : NEUTRO);
  const blanco = [255, 255, 255];
  const oscuro = [26, 26, 26];
  return {
    "--brand": aHex(c),
    "--brand-ink": contraste(c, blanco) >= contraste(c, oscuro) ? "#ffffff" : "#1a1a1a",
    "--brand-soft": aHex(mezclar(c, blanco, 0.88)),
    "--brand-text": aHex(oscurecerHasta(c, 4.5)),
    "--brand-line": aHex(oscurecerHasta(c, 3)),
  };
}

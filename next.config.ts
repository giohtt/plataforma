import type { NextConfig } from "next";
import { leerEntorno, permitirIndexado } from "./src/lib/entorno";

const entorno = leerEntorno();

const encabezadosSeguridad = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ...(permitirIndexado(entorno) ? [] : [{ key: "X-Robots-Tag", value: "noindex, nofollow" }]),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: encabezadosSeguridad }];
  },
};

export default nextConfig;

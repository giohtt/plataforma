import type { Metadata } from "next";
import "@fontsource-variable/figtree";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { FranjaEntorno } from "@/components/FranjaEntorno";
import { leerEntorno, permitirIndexado } from "@/lib/entorno";

export const metadata: Metadata = {
  title: "Fitnessland · Plataforma",
  description: "Plataforma administrativa de Fitnessland.",
  robots: permitirIndexado(leerEntorno()) ? undefined : { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-MX">
      <body>
        <FranjaEntorno />
        {children}
      </body>
    </html>
  );
}

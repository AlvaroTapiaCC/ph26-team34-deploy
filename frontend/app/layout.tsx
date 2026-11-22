import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import localFont from "next/font/local";
import EditorPaleta from "@/components/paleta/EditorPaleta";
import { EDITABLES, scriptInicialPaleta } from "@/lib/paleta";
import "./globals.css";

const space = localFont({
  src: "./fonts/space-grotesk-700.woff2",
  weight: "700",
  variable: "--ff-space",
});
const geist = localFont({
  src: "./fonts/geist.woff2",
  weight: "100 900",
  variable: "--ff-geist",
});
const geistMono = localFont({
  src: "./fonts/geist-mono.woff2",
  weight: "100 900",
  variable: "--ff-geist-mono",
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: "Drena · prioriza sumideros",
  description: "Prioriza qué sumideros limpiar antes y durante una tormenta. Providencia · Ñuñoa · Las Condes.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: EDITABLES.find((c) => c.id === "fondo")!.defecto };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning className={`${space.variable} ${geist.variable} ${geistMono.variable}`}>
      <head>
        {/* Paleta editada en este navegador (#131), antes del primer pintado para que no parpadee */}
        <script dangerouslySetInnerHTML={{ __html: scriptInicialPaleta() }} />
      </head>
      <body>
        {children}
        {/* useSearchParams en el editor: Next pide un límite de Suspense para el prerender estático */}
        <Suspense fallback={null}>
          <EditorPaleta />
        </Suspense>
      </body>
    </html>
  );
}

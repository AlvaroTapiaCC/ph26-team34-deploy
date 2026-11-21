import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
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

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#EDEDEB" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${space.variable} ${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

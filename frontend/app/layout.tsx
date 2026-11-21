import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const space = Space_Grotesk({ subsets: ["latin"], weight: ["700"], variable: "--ff-space" });
const geist = Geist({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--ff-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], weight: ["500", "700"], variable: "--ff-geist-mono" });

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

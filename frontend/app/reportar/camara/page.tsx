import type { Metadata } from "next";
import CamaraFija from "@/components/reportar/CamaraFija";

export const metadata: Metadata = {
  title: "Cámara fija · Drena",
  description: "Envía cuadros de agua desde una ubicación fija.",
};

export default function Page() {
  return <CamaraFija />;
}

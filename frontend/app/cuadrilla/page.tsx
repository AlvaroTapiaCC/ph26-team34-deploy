import type { Metadata } from "next";
import Cuadrilla from "@/components/cuadrilla/Cuadrilla";

export const metadata: Metadata = {
  title: "Cuadrilla · Drena",
  description: "Siguiente parada de la cuadrilla, avance de la misión y cierre con foto.",
};

export default function Page() {
  return <Cuadrilla />;
}

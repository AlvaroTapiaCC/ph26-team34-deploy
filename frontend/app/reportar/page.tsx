import type { Metadata } from "next";
import Reportar from "@/components/reportar/Reportar";

export const metadata: Metadata = {
  title: "Reportar · Drena",
  description: "Reporta una rejilla tapada o agua acumulada con foto, texto y ubicación.",
};

export default function Page() {
  return <Reportar />;
}

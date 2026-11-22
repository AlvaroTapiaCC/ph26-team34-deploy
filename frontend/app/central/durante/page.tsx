import type { Metadata } from "next";
import CentralDurante from "@/components/central/CentralDurante";

export const metadata: Metadata = { title: "Drena · Central durante la lluvia" };

export default function DurantePage() {
  return <CentralDurante />;
}

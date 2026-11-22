import type { ReactNode } from "react";
import Sala from "@/components/sala/Sala";

// Inicio, Antes y Durante comparten este layout: el mapa y los datos se montan una sola vez.
export default function SalaLayout({ children }: { children: ReactNode }) {
  return <Sala>{children}</Sala>;
}

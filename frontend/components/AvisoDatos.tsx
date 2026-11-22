"use client";

import { useStore } from "@/lib/store";

/** Aviso discreto sobre el origen de los datos del modo Antes (servidor despertando o datos de ejemplo). */
export default function AvisoDatos({ movil = false }: { movil?: boolean }) {
  const { fuente, despertando, s } = useStore();
  if (s.modo !== "antes") return null;
  const texto = despertando
    ? "Despertando el servidor… puede tardar hasta un minuto"
    : fuente === "ejemplo"
      ? "Datos de ejemplo · sin conexión con el servidor"
      : null;
  if (!texto) return null;
  return (
    <div className={`aviso-datos ${movil ? "aviso-datos--m" : ""}`} role="status">
      {texto}
    </div>
  );
}

import type { ApiClima } from "../api";
import type { EstadoConsulta } from "../transporte";

export function pronosticoEscurrimiento({ datos, estado }: {
  datos: Pick<ApiClima, "lluvia_pronosticada_prox_24h_mm" | "vigente"> | null;
  estado: EstadoConsulta;
}) {
  if (estado === "cargando") return { mmh: null, texto: "Consultando pronóstico (Open-Meteo)…" };

  const total = datos?.lluvia_pronosticada_prox_24h_mm;
  if (estado !== "ok" || !datos?.vigente || total == null || !Number.isFinite(total) || total < 0) {
    return { mmh: null, texto: "Pronóstico no disponible (Open-Meteo)." };
  }

  return {
    mmh: total / 24,
    texto: total === 0
      ? "Sin lluvia pronosticada para las próximas 24 h (Open-Meteo)."
      : "Lluvia de Open-Meteo: promedio pronosticado para las próximas 24 h.",
  };
}

import type { ObservacionPublica } from "./central";

export const SIN_DATO = "Sin dato";

export interface PuestosReporte {
  /** Ámbito de los puestos registrados: en vivo es el ranking completo del escenario, no la zona MUT. */
  alcance: string;
  antes: string;
  despues: string;
  /** La API no registra el puesto dentro de la zona MUT; null en la demo, que no usa esa zona. */
  zonaMut: string | null;
}

const puesto = (rank: number | null | undefined) => (rank != null ? `#${rank}` : SIN_DATO);

/** Puestos que la API registró antes y después del reporte (evento `prioridad_observacion`), sin reconstruirlos. */
export function puestosReporte(o: ObservacionPublica, enDemo: boolean): PuestosReporte {
  const { antes, despues } = o.prioridad ?? {};
  const escenario = despues?.scenario_id ?? antes?.scenario_id;
  return {
    alcance: enDemo ? "San Carlos y entorno" : escenario ? `escenario ${escenario}, todas las rejillas` : "escenario sin dato",
    antes: puesto(antes?.rank),
    despues: puesto(despues?.rank),
    zonaMut: enDemo ? null : SIN_DATO,
  };
}

// Parámetros de la simulación del flujo. Todo lo que se pueda ajustar vive aquí, no en el código del motor ni del mapa.
//
// Es una simulación del escurrimiento según pendiente y área de aporte; NO es una medición.
// Las intensidades de lluvia y los estados de rejilla de cada escenario son SUPUESTOS ilustrativos de la demo
// (no datos medidos): se marcan como tales en la interfaz.
import type { LngLat, ScenarioId } from "../data";

export type EstadoRejilla = "limpia" | "parcial" | "tapada";
export type NivelAgua = "sin_agua" | "cuneta" | "hasta_vereda" | "sobre_vereda" | "no_evaluable";

export interface LluviaEscenario {
  /** Intensidad en mm/h para cada hora desde el inicio del escenario; se interpola entre horas. */
  perfilMmH: number[];
  /** Si existe, la lluvia no es pareja: dentro de la celda cae `dentro` veces la intensidad y fuera `fuera` veces. */
  celda?: { centro: LngLat; radioM: number; dentro: number; fuera: number };
}

export const FLUJO_CONFIG = {
  // --- Lluvia -> caudal ---
  /** Fracción de la lluvia que escurre por la calle (calzada y veredas impermeables). */
  coefEscorrentia: 0.85,
  // Caudal local (L/s) = mm/h × m² × coef / 3600, porque 1 mm sobre 1 m² son 1 L.

  // --- Velocidad del agua: proporcional a la pendiente del tramo ---
  pendienteRef: 0.056, // m/m, percentil 90 de las rejillas de la zona MUT (data/terreno_mut.meta.json)
  velocidadMin: 0.3, // m/s en tramos planos
  velocidadMax: 2.5, // m/s con pendiente >= pendienteRef

  // --- Sumideros ---
  /** Caudal máximo (L/s) que traga una rejilla limpia. */
  capacidadRejillaLs: 60,
  /** Qué fracción de esa capacidad conserva según su estado. */
  factorEstado: { limpia: 1, parcial: 0.5, tapada: 0.08 } as Record<EstadoRejilla, number>,
  /** Estado de las rejillas que nadie reportó ni el escenario supone. */
  estadoPorDefecto: "limpia" as EstadoRejilla,
  /** Exceso (L/s) que no entra a la rejilla y sigue por la calle, para pasar de un nivel de agua al siguiente. */
  umbralesExcesoLs: { cuneta: 3, hasta_vereda: 25, sobre_vereda: 70 },
  /** Un punto "se desborda" desde este nivel. */
  nivelDesborde: "hasta_vereda" as NivelAgua,

  // --- Efecto en la prioridad (mismos valores que backend/config/formula.yaml, sección durante) ---
  wAgua: 1.0,
  valorNivelAgua: { sobre_vereda: 1, hasta_vereda: 0.6, cuneta: 0.3, sin_agua: 0, no_evaluable: 0 } as Record<NivelAgua, number>,

  // --- Reloj ---
  velocidades: [1, 10, 60] as const,
  /** Paso máximo de simulación por cuadro (s simulados): evita saltos bruscos a 60×. */
  pasoMaxSimS: 20,

  // --- Dibujo ---
  particulasMax: 2200,
  /** Una partícula por cada tanto de caudal (L/s) en un tramo de 100 m. */
  lsPorParticula: 12,
  /** Velocidad visual de las partículas (m/s en pantalla); no depende de la velocidad del reloj. */
  velocidadVisualMs: 22,
  /** Caudal (L/s) a partir del cual el trazo llega a su grosor máximo. */
  caudalGrosorMaxLs: 400,
  /** Debajo de este caudal el tramo no se dibuja. */
  caudalMinimoLs: 0.5,
  colores: {
    agua: "#5F7F9A", // azul grisáceo
    aguaClaro: "#9DB4C7",
    desborde: "#FF3D0A", // accent
  },
  /** Lluvia que se aplica al "tiempo real" cuando no hay otra fuente: el escenario elegido, a 1×. */
  intervaloFuenteMs: 10_000,
};

// Perfiles ilustrativos por escenario (mm/h por hora, contadas desde que empieza la lluvia). No son registros de la DMC.
export const LLUVIA_ESCENARIO: Record<ScenarioId, LluviaEscenario> = {
  "13oct": { perfilMmH: [20, 36, 30, 14, 4, 0] },
  poniente: { perfilMmH: [14, 40, 34, 12, 3, 0], celda: { centro: [-70.625, -33.425], radioM: 1800, dentro: 1.7, fuera: 0.35 } },
  pareja: { perfilMmH: [16, 24, 22, 14, 6, 0] },
};

/** Estado supuesto de las rejillas cercanas a cada punto del ranking, por escenario. Supuesto de la demo, no observación. */
export const ESTADOS_ESCENARIO: Record<ScenarioId, Record<string, EstadoRejilla>> = {
  "13oct": { p1: "tapada", p2: "parcial", p5: "tapada", p6: "parcial", p10: "parcial" },
  poniente: { p6: "tapada", p10: "tapada", p1: "parcial", p2: "parcial" },
  pareja: { p1: "tapada", p5: "parcial", p2: "parcial", p10: "parcial" },
};

/** Radio (m) para asociar un punto del ranking con las rejillas del catastro que lo rodean. */
export const RADIO_PUNTO_M = 90;

// Parámetros de la simulación hidráulica. Todo lo que se pueda ajustar vive aquí, no en el motor ni en el mapa.
//
// Modelo simplificado (método racional + pendiente de un DEM de 30 m); es una simulación, NO una medición.
// Las intensidades de lluvia y los estados de rejilla de cada escenario son SUPUESTOS ilustrativos de la demo
// (no datos medidos): se marcan como tales en la interfaz.
import type { LngLat, ScenarioId } from "../data";

export type EstadoRejilla = "limpia" | "parcial" | "tapada";
export type NivelAgua = "sin_agua" | "cuneta" | "hasta_vereda" | "sobre_vereda" | "no_evaluable";
export const ESTADOS: EstadoRejilla[] = ["limpia", "parcial", "tapada"];

export interface LluviaEscenario {
  /** Intensidad en mm/h para cada hora desde el inicio del escenario; se interpola entre horas. */
  perfilMmH: number[];
  /** Si existe, la lluvia no es pareja: dentro de la celda cae `dentro` veces la intensidad y fuera `fuera` veces. */
  celda?: { centro: LngLat; radioM: number; dentro: number; fuera: number };
}

export const FLUJO_CONFIG = {
  // --- Caudal de entrada: método racional, Q = C · i · A ---
  /** C: coeficiente de escorrentía urbana (calzada y veredas impermeables). */
  coefEscorrentia: 0.85,
  // Q (L/s) = C × i (mm/h) × A (m²) / 3600, porque 1 mm sobre 1 m² es 1 L. A = área de aporte propia del tramo.

  // --- Velocidad: Manning simplificado, v = (1/n) · R^(2/3) · S^(1/2), con piso y tope ---
  manningN: 0.016, // asfalto
  radioHidraulicoM: 0.04, // agua de pocos centímetros en la cuneta
  velocidadMin: 0.15, // m/s en tramos casi planos
  velocidadMax: 3.0, // m/s, tope

  // --- Capacidad de la calle = área mojada × velocidad ---
  areaCunetaM2: 0.03, // cuneta: sección triangular de ~0,6 m de ancho y 0,1 m de alto
  areaCalzadaM2: 0.25, // media calzada hasta el borde de la solera: ~3,5 m de ancho y 15 cm de alto (triángulo)

  // --- Rejillas ---
  /** Caudal máximo (L/s) que traga una rejilla limpia. */
  capacidadRejillaLs: 60,
  /** Qué fracción de esa capacidad conserva según su estado. */
  factorEstado: { limpia: 1, parcial: 0.5, tapada: 0.05 } as Record<EstadoRejilla, number>,
  /** Estado de las rejillas que nadie tocó ni el escenario supone. */
  estadoPorDefecto: "limpia" as EstadoRejilla,
  /** Nivel de agua en una rejilla según lo que no traga: "cuneta" en fracción de la cuneta; los otros, de la calzada. */
  umbralesExceso: { cuneta: 0.05, hasta_vereda: 1, sobre_vereda: 2 },
  /** Una rejilla "se desborda" desde este nivel: lo que no traga ya no cabe en la calzada y sube a la vereda. */
  nivelDesborde: "hasta_vereda" as NivelAgua,

  // --- Efecto en la prioridad (mismos valores que backend/config/formula.yaml, sección durante) ---
  wAgua: 1.0,
  valorNivelAgua: { sobre_vereda: 1, hasta_vereda: 0.6, cuneta: 0.3, sin_agua: 0, no_evaluable: 0 } as Record<NivelAgua, number>,

  // --- Reloj ---
  velocidades: [1, 10, 60] as const,
  /** Paso máximo de simulación por cuadro (s simulados): evita saltos bruscos a 60×. */
  pasoMaxSimS: 20,
  /** Puntos que guarda el gráfico de caudal del punto seleccionado. */
  serieMax: 120,
  /** Tope del slider de lluvia (mm/h). */
  lluviaMaxMmH: 120,

  // --- Dibujo ---
  particulasMax: 2200,
  /** Una partícula por cada tanto de caudal (L/s) en un tramo de 100 m. */
  lsPorParticula: 12,
  /** Escala visual: metros de pantalla por cada m/s de agua (las partículas avanzan según la velocidad del tramo). */
  escalaVisual: 14,
  /** Caudal (L/s) a partir del cual el trazo llega a su grosor máximo (escala logarítmica). */
  caudalGrosorMaxLs: 2000,
  /** Debajo de este caudal el tramo no se dibuja. */
  caudalMinimoLs: 0.5,
  colores: {
    agua: "#5F7F9A", // azul grisáceo
    aguaClaro: "#9DB4C7",
    desborde: "#FF3D0A", // accent
  },
  intervaloFuenteMs: 10_000,
};

// Perfiles ilustrativos por escenario (mm/h por hora, contadas desde que empieza la lluvia). No son registros de la DMC.
export const LLUVIA_ESCENARIO: Record<ScenarioId, LluviaEscenario> = {
  "13oct": { perfilMmH: [20, 36, 30, 14, 4, 0] },
  poniente: { perfilMmH: [14, 40, 34, 12, 3, 0], celda: { centro: [-70.625, -33.425], radioM: 1800, dentro: 1.7, fuera: 0.35 } },
  pareja: { perfilMmH: [16, 24, 22, 14, 6, 0] },
};

/** Intensidad máxima del perfil del escenario: punto de partida del slider de lluvia. */
export const picoEscenario = (id: ScenarioId) => Math.max(...LLUVIA_ESCENARIO[id].perfilMmH);

/** Estado supuesto de las rejillas cercanas a cada punto del ranking, por escenario. Supuesto de la demo, no observación. */
export const ESTADOS_ESCENARIO: Record<ScenarioId, Record<string, EstadoRejilla>> = {
  "13oct": { p1: "tapada", p2: "parcial", p5: "tapada", p6: "parcial", p10: "parcial" },
  poniente: { p6: "tapada", p10: "tapada", p1: "parcial", p2: "parcial" },
  pareja: { p1: "tapada", p5: "parcial", p2: "parcial", p10: "parcial" },
};

/** Radio (m) para asociar un punto del ranking con las rejillas del catastro que lo rodean. */
export const RADIO_PUNTO_M = 90;

/** Aviso visible junto al mapa. La pendiente sale del DEM Copernicus GLO-30 de 30 m (pipeline/flujo/pendientes.py). */
export const AVISO_MODELO = "Modelo simplificado (método racional + pendiente del DEM de 30 m, Copernicus GLO-30). Simulación, no medición.";

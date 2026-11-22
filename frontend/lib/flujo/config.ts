// Parámetros del flujo estimado y de su dibujo. Todo lo que se pueda ajustar vive aquí, no en el motor ni en el mapa.
//
// Flujo estimado por las calles según la pendiente (método racional + pendiente de un DEM de 30 m). No es una
// simulación hidráulica ni una medición. La lluvia y el estado de las rejillas son SUPUESTOS de la demo.
import type { LngLat, ScenarioId } from "../data";

export type EstadoRejilla = "limpia" | "parcial" | "tapada";
export type NivelAgua = "sin_agua" | "cuneta" | "hasta_vereda" | "sobre_vereda" | "no_evaluable";
export const ESTADOS: EstadoRejilla[] = ["limpia", "parcial", "tapada"];

export interface LluviaEscenario {
  /** Intensidad (mm/h) del escenario por hora; el slider parte de la máxima. */
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
  /** Desde este nivel el agua ya no cabe en la calzada: se marca en accent ("punto con agua"). */
  nivelDesborde: "hasta_vereda" as NivelAgua,
  /** El volumen que no entra a la rejilla se acumula mientras dura y se vacía con esta constante de tiempo (s simulados). */
  vaciadoS: 600,

  // --- Reloj ---
  velocidades: [1, 10, 60] as const,
  /** Paso máximo de cálculo por cuadro (s): evita saltos bruscos a 60×. */
  pasoMaxSimS: 20,
  /** Tope del slider de lluvia (mm/h). */
  lluviaMaxMmH: 80,

  // --- Dibujo: código de color estricto ---
  /** Bajo este caudal (L/s) la calle no se pinta: solo se ve el agua que importa. */
  caudalMinimoLs: 30,
  /** Caudal (L/s) con el que el trazo llega a su grosor y azul máximos (escala logarítmica). */
  caudalGrosorMaxLs: 2000,
  colores: {
    agua: "#2F6FDE", // agua circulando, poco caudal
    aguaHondo: "#0B3D91", // agua circulando, mucho caudal
    brillo: "#8FB4F5", // brillo suave del trazo animado
    desborde: "#FF3D0A", // accent: solo donde el agua no cabe en la calle
    gris: "#8A8A86", // capas de contexto (catastro, GORE)
  },
  /** Velocidad del trazo animado (pasos del patrón por segundo) para calles lentas, medias y rápidas. */
  trazoPasosPorS: [5, 9, 15],
  /** Límites de velocidad (m/s) entre calles lentas, medias y rápidas. */
  trazoLimitesV: [0.7, 1.3],

  // --- Columnas de agua que no entra a la rejilla (fill-extrusion) ---
  columnaLadoM: 15,
  /** Metros de alto por m³ acumulado, con tope. */
  columnaMPorM3: 1.2,
  columnaAltoMaxM: 220,
  columnasMax: 40,

  // --- Capas de contexto ---
  zoomContexto: 15, // catastro y GORE solo desde este zoom
  zoomRejillas: 14, // rejillas de la red desde este zoom (las tapadas, siempre)
  zoomIconos: 17, // ícono de rejilla desde este zoom; antes, un círculo de 6 px
  topPrioridad: 10, // pines de prioridad en el mapa

  // --- Vista 3D (MapLibre, sin clave) ---
  terreno: {
    tiles: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    exageracion: 1.5,
    pitch: 55,
    bearing: 90, // mirando al oriente: la cordillera queda arriba y el agua baja hacia el poniente (abajo)
  },
  edificios: "https://tiles.openfreemap.org/planet", // OpenFreeMap: teselas vectoriales gratuitas y sin clave

  intervaloFuenteMs: 10_000,
};

// Lluvia supuesta por escenario (mm/h por hora). No son registros de la DMC.
export const LLUVIA_ESCENARIO: Record<ScenarioId, LluviaEscenario> = {
  "13oct": { perfilMmH: [20, 36, 30, 14, 4, 0] },
  poniente: { perfilMmH: [14, 40, 34, 12, 3, 0], celda: { centro: [-70.625, -33.425], radioM: 1800, dentro: 1.7, fuera: 0.35 } },
  pareja: { perfilMmH: [16, 24, 22, 14, 6, 0] },
};

/** Escenario de ejemplo cuyo perfil se usa cuando el id no tiene uno (p. ej. los escenarios reales del backend, "base"). */
export const ESCENARIO_POR_DEFECTO: ScenarioId = "pareja";

/** Lluvia supuesta del escenario; si el id no tiene perfil (escenario real), la del escenario por defecto. */
export const lluviaDe = (id: ScenarioId): LluviaEscenario => LLUVIA_ESCENARIO[id] ?? LLUVIA_ESCENARIO[ESCENARIO_POR_DEFECTO];

/** Intensidad máxima del perfil del escenario: valor inicial del slider de lluvia. */
export const picoEscenario = (id: ScenarioId) => Math.max(...lluviaDe(id).perfilMmH);

/** Estado supuesto de las rejillas cercanas a cada punto del ranking, por escenario. Supuesto de la demo, no observación. */
export const ESTADOS_ESCENARIO: Record<ScenarioId, Record<string, EstadoRejilla>> = {
  "13oct": { p1: "tapada", p2: "parcial", p5: "tapada", p6: "parcial", p10: "parcial" },
  poniente: { p6: "tapada", p10: "tapada", p1: "parcial", p2: "parcial" },
  pareja: { p1: "tapada", p5: "parcial", p2: "parcial", p10: "parcial" },
};

/** Estado supuesto de las rejillas del escenario; un escenario real no supone ninguno. */
export const estadosDe = (id: ScenarioId): Record<string, EstadoRejilla> => ESTADOS_ESCENARIO[id] ?? {};

/** Radio (m) para asociar un punto del ranking con las rejillas del catastro que lo rodean. */
export const RADIO_PUNTO_M = 90;

/** Lluvia del recorrido guiado (mm/h). */
export const LLUVIA_RECORRIDO = 30;

/** Aviso visible junto al mapa (revisión de #99: no se presenta como simulación hidráulica). */
export const AVISO_MODELO =
  "Flujo estimado por las calles según la pendiente; no es una simulación hidráulica ni una medición. Lluvia y estado de las rejillas: supuestos de la demo.";
export const AVISO_NO_HACE = "No recomienda cerrar calles ni desviar agua, ni muestra profundidades o minutos de llegada.";

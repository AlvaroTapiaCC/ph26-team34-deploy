// Guion local y determinista. No llama a la API ni clasifica fotos en vivo.
// Coordenadas/IDs: catastro SIALL y transporte_mut.json. Puntajes y eventos: simulados.
import type { ApiRankingItem } from "./api";
import type { ObservacionPublica } from "./central";
import type { Cuadrilla, RutaCuadrilla } from "./cuadrilla";
import type { Expuestos } from "./transporte";

export const PASOS_DEMO = [
  { segundo: 0, titulo: "Antes de la lluvia", texto: "Un plan inicial: Nueva Providencia está en el puesto #4. La cuadrilla tiene otra primera parada." },
  { segundo: 12, titulo: "Llega la foto de un vecino", texto: "Foto de ejemplo: rejilla tapada con hojas. La clasificación y el puntaje están simulados: #4 → #1." },
  { segundo: 28, titulo: "Cambia la siguiente parada", texto: "La propuesta de la cuadrilla MUT ahora parte por Nueva Providencia. La central decide el despacho." },
  { segundo: 45, titulo: "El mismo incidente afecta a los buses", texto: "Agua simulada hasta la vereda: el paradero PC207 queda expuesto. El 405 muestra su recorrido y un paradero alternativo." },
  { segundo: 62, titulo: "Dos decisiones, una misma evidencia", texto: "Priorizar la limpieza y advertir la exposición del transporte. El desvío lo confirma Red; no se envió ningún aviso ni despacho." },
] as const;
export const DURACION_DEMO = 75;
export const DEMO_SUMIDERO = "AL13SU010087";
export const DEMO_PARADERO = "PC207";
export const DEMO_SERVICIO = "405|0";
const HORA = "2026-10-13T15:00:00Z";
export const pasoDemo = (segundo: number) => PASOS_DEMO.reduce((paso, p, i) => segundo >= p.segundo ? i : paso, 0);

// Extracto de cinco puntos del ranking congelado, usado únicamente como escenario de ejemplo.
const PUNTOS = [
  ["AL13SU016875", "Avenida Presidente Riesco", -70.602586, -33.411534, 0.814781, 0.326276, 0.466665, 1.745966],
  ["AL13SU014265", "Napoleón", -70.596984, -33.418077, 0.814147, 0.373618, 0.435359, 1.870059],
  ["AL13SU016872", "Avenida Presidente Riesco", -70.601949, -33.411693, 0.724388, 0.371297, 0.453166, 1.598504],
  [DEMO_SUMIDERO, "Avenida Nueva Providencia", -70.604457, -33.417855, 0.697506, 0.368061, 0.376854, 1.850865],
  ["AL13SU010155", "Avenida Holanda", -70.604984, -33.417958, 0.572031, 0.300364, 0.326382, 1.752644],
] as const;
const inicial: ApiRankingItem[] = PUNTOS.map(([id, nombre, lon, lat, prioridad, p_pred, p_ef, c], i) => ({
  rank: i + 1, sumidero_id: id, intersection_nombre: nombre, lon, lat, prioridad,
  p_pred, p_obs: null, p_ef, c, detalle: null,
  explicacion: "Puntaje de ejemplo para la demo local; no es un cálculo en vivo.",
  computed_at: HORA, intersection_id: null, street_id: null, is_simulated: true,
}));
const despues = inicial.map((p) => p.sumidero_id === DEMO_SUMIDERO ? {
  ...p, prioridad: 0.8 * p.c!, p_obs: 0.8, p_ef: 0.8,
  explicacion: "Demo simulada: la foto de ejemplo muestra una rejilla tapada con hojas.",
  detalle: { fuente_p: "foto", confianza_foto: "alta" as const, factor_confianza_foto: 1 },
} : p).sort((a, b) => (b.prioridad ?? 0) - (a.prioridad ?? 0)).map((p, i) => ({ ...p, rank: i + 1 }));

const cuadrilla: Cuadrilla = { id: "demo-local-mut", nombre: "Cuadrilla MUT · demo", equipamiento: ["herramientas manuales"], estado: "disponible", is_simulated: true, carga: 3, lon: -70.6035, lat: -33.4165 };
const foto: ObservacionPublica = {
  id: "demo-local-foto", sumidero_id: DEMO_SUMIDERO, caso_id: null, ts: HORA,
  fuente: "vecino", tipo: "foto_rejilla", is_simulated: true, urgente: false,
  clasificacion: { evaluable: true, rejilla: "tapada", material: ["hojas"], confianza: "alta" },
  prioridad: { antes: { scenario_id: "base", rank: 4, prioridad: 0.697506 }, despues: { scenario_id: "base", rank: 1, prioridad: despues[0].prioridad } },
};

export function datosDemo(paso: number) {
  const cambioRuta = paso >= 2;
  const agua = paso >= 3;
  const orden = cambioRuta ? [inicial[3], inicial[0], inicial[1]] : [inicial[0], inicial[1], inicial[3]];
  const misiones = orden.map((p, i) => ({ mission_id: `demo-local-${p.sumidero_id}`, orden: i + 1, estado: "pendiente" as const, sumidero_id: p.sumidero_id, case_id: null, nombre: p.intersection_nombre!, lat: p.lat, lon: p.lon }));
  const ruta: RutaCuadrilla = {
    crew_id: cuadrilla.id, origen: "calculada", version: cambioRuta ? 2 : 1, misiones,
    // Conexión ilustrativa entre paradas, no un cálculo de conducción de OSRM.
    geojson: { type: "LineString", coordinates: [[cuadrilla.lon!, cuadrilla.lat!], ...orden.map((p): [number, number] => [p.lon, p.lat])] },
  };
  const despachos = cambioRuta ? [{ crew_id: cuadrilla.id, cuadrilla: cuadrilla.nombre, is_simulated: true, hora: HORA, siguiente_antes: inicial[0].intersection_nombre, siguiente_despues: inicial[3].intersection_nombre }] : [];
  const observaciones: ObservacionPublica[] = paso >= 1 ? [{ ...foto, despachos }] : [];
  const transporte: Expuestos = {
    scenario_id: "demo-local", calculado_at: HORA,
    nota: "Exposición simulada sobre paraderos y servicios del GTFS de DTPM.",
    aviso: "Demo simulada: no se envían avisos. El desvío lo confirma Red.",
    fuente: { nombre: "GTFS de DTPM · incidente simulado", url: null, fecha_descarga: "2026-11-21" },
    parametros: { radio_m: 80, aguas_abajo_m: 150, riesgo_top_n: 5, vigencia_agua_horas: 6 },
    evidencia_agua: agua ? [{ sumidero_id: DEMO_SUMIDERO, nivel: "hasta_vereda", ts: HORA, is_simulated: true }] : [],
    expuestos: agua ? [{
      id: DEMO_PARADERO, nombre: "PC207-Parada 2 / (M) Tobalaba", lon: -70.604705861, lat: -33.417610859, nivel: "expuesto",
      causa: { observation_id: "demo-local-agua", sumidero_observado: DEMO_SUMIDERO, sumidero_id: DEMO_SUMIDERO, nivel: "hasta_vereda", ts: HORA, tipo: "foto_agua", fuente: "vecino", is_simulated: true, via: "observado", calle_abajo_m: 0, distancia_m: 36 },
      servicios: [{ servicio: "405", sentido: "0", destino: "Cantagallo", motivo: null,
        alternativo: { id: "PC208", nombre: "PC208-Avenida Vitacura / esq. Zurich", lon: -70.604038948, lat: -33.415516916, en_secuencia: "siguiente", distancia_m: 241, en_riesgo: false } }],
    }] : [], en_riesgo: [],
  };
  return { inicial, durante: paso >= 1 ? despues : inicial, cuadrilla, ruta, observaciones, transporte };
}

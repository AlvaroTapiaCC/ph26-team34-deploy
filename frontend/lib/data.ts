// Datos de ejemplo (mocks) tomados de los diseños "Drena · Diseño final".
// Coordenadas aproximadas; reemplazar por puntos.geojson / escurrimiento.geojson del pipeline.

export type Comuna = "Providencia" | "Ñuñoa" | "Las Condes";
export type Prioridad = "alta" | "media" | "baja";
export type ScenarioId = "13oct" | "poniente" | "pareja";
export type LngLat = [number, number];
import { FLUJO_CONFIG, type NivelAgua } from "./flujo/config";

export interface Punto {
  id: string;
  nodeId: string;
  nombre: string;
  comuna: Comuna;
  coord: LngLat;
  pctExterno: number;
  origen: string | null; // comuna desde donde viene el agua externa
  area: number; // km²
  cerca: string; // texto corto bajo el título del héroe
  cercaFrase: string; // "Metro a 80 m cerca."
  motivo?: string; // motivo alternativo para la tabla
  criticidad: string[];
  aguasAbajo: string[];
}

export const PUNTOS: Record<string, Punto> = {
  p1: {
    id: "p1", nodeId: "n123", nombre: "Pedro de Valdivia / Bilbao", comuna: "Providencia",
    coord: [-70.6085, -33.4388], pctExterno: 41, origen: "Las Condes", area: 1.25,
    cerca: "Metro a 80 m", cercaFrase: "Metro a 80 m cerca.",
    criticidad: ["Ⓜ Metro Pedro de Valdivia · 80 m", "Colegio · 140 m"],
    aguasAbajo: ["Pocuro / Antonio Varas", "Providencia / Manuel Montt", "Av. Providencia / Lyon"],
  },
  p2: {
    id: "p2", nodeId: "n087", nombre: "Tobalaba / Providencia", comuna: "Providencia",
    coord: [-70.6013, -33.418], pctExterno: 63, origen: "Las Condes", area: 1.48,
    cerca: "Metro Tobalaba", cercaFrase: "Metro Tobalaba cerca.",
    criticidad: ["Ⓜ Metro Tobalaba · 60 m"],
    aguasAbajo: ["Pedro de Valdivia / Bilbao", "Pocuro / Antonio Varas", "Providencia / Manuel Montt"],
  },
  p3: {
    id: "p3", nodeId: "n412", nombre: "Irarrázaval / Pedro de Valdivia", comuna: "Ñuñoa",
    coord: [-70.604, -33.4545], pctExterno: 28, origen: "Providencia", area: 0.96,
    cerca: "Metro Irarrázaval", cercaFrase: "Metro Irarrázaval cerca.",
    criticidad: ["Ⓜ Metro Irarrázaval · 120 m"],
    aguasAbajo: ["Irarrázaval / Ramón Cruz"],
  },
  p4: {
    id: "p4", nodeId: "n566", nombre: "Grecia / Ossa", comuna: "Ñuñoa",
    coord: [-70.579, -33.4658], pctExterno: 52, origen: "Peñalolén", area: 1.6,
    cerca: "Paso bajo nivel", cercaFrase: "Paso bajo nivel cerca.",
    criticidad: ["Paso bajo nivel · 40 m"],
    aguasAbajo: ["Irarrázaval / Ramón Cruz", "Irarrázaval / Pedro de Valdivia"],
  },
  p5: {
    id: "p5", nodeId: "n231", nombre: "Tobalaba / Bilbao", comuna: "Providencia",
    coord: [-70.5935, -33.4335], pctExterno: 47, origen: "Las Condes", area: 1.1,
    cerca: "Colegio a 90 m", cercaFrase: "Colegio a 90 m cerca.",
    criticidad: ["Colegio · 90 m"],
    aguasAbajo: ["Pedro de Valdivia / Bilbao", "Pocuro / Antonio Varas"],
  },
  p6: {
    id: "p6", nodeId: "n045", nombre: "Providencia / Manuel Montt", comuna: "Providencia",
    coord: [-70.62, -33.429], pctExterno: 22, origen: "Las Condes", area: 0.71,
    cerca: "Metro", cercaFrase: "Metro cerca.",
    criticidad: ["Ⓜ Metro Manuel Montt · 50 m"],
    aguasAbajo: ["Av. Providencia / Lyon"],
  },
  p7: {
    id: "p7", nodeId: "n702", nombre: "Colón / Tomás Moro", comuna: "Las Condes",
    coord: [-70.5465, -33.4205], pctExterno: 9, origen: null, area: 0.54,
    cerca: "Colegio cerca", cercaFrase: "Colegio cerca.", motivo: "Las Condes · colegio cerca",
    criticidad: ["Colegio · 110 m"],
    aguasAbajo: ["Tobalaba / Bilbao"],
  },
  p8: {
    id: "p8", nodeId: "n598", nombre: "Irarrázaval / Ramón Cruz", comuna: "Ñuñoa",
    coord: [-70.5745, -33.4538], pctExterno: 35, origen: "Peñalolén", area: 0.88,
    cerca: "Hospital a 140 m", cercaFrase: "Hospital a 140 m cerca.",
    criticidad: ["Hospital · 140 m"],
    aguasAbajo: ["Irarrázaval / Pedro de Valdivia"],
  },
  p9: {
    id: "p9", nodeId: "n733", nombre: "Apoquindo / Manquehue", comuna: "Las Condes",
    coord: [-70.568, -33.4115], pctExterno: 6, origen: null, area: 0.42,
    cerca: "Metro Manquehue", cercaFrase: "Metro Manquehue cerca.", motivo: "Las Condes · acumula agua local",
    criticidad: ["Ⓜ Metro Manquehue · 70 m"],
    aguasAbajo: ["Tobalaba / Providencia"],
  },
  p10: {
    id: "p10", nodeId: "n061", nombre: "Pocuro / Antonio Varas", comuna: "Providencia",
    coord: [-70.614, -33.434], pctExterno: 18, origen: null, area: 0.62,
    cerca: "Colegio a 120 m", cercaFrase: "Colegio a 120 m cerca.", motivo: "Providencia · acumula agua local",
    criticidad: ["Colegio · 120 m"],
    aguasAbajo: ["Providencia / Manuel Montt"],
  },
  p11: {
    id: "p11", nodeId: "n640", nombre: "Ossa / Simón Bolívar", comuna: "Ñuñoa",
    coord: [-70.5715, -33.4425], pctExterno: 31, origen: "La Reina", area: 0.77,
    cerca: "Colegio a 100 m", cercaFrase: "Colegio a 100 m cerca.",
    criticidad: ["Colegio · 100 m"],
    aguasAbajo: ["Grecia / Ossa"],
  },
};

export interface Scenario {
  id: ScenarioId;
  label: string;
  short: string;
  ranking: [string, number][]; // [puntoId, puntaje]
  aguaExterna: number;
  criticosTop30: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "13oct", label: "13 de octubre", short: "13 oct", aguaExterna: 38, criticosTop30: 11,
    ranking: [["p1", 0.92], ["p2", 0.88], ["p3", 0.81], ["p4", 0.76], ["p5", 0.69], ["p6", 0.63], ["p7", 0.58], ["p8", 0.51], ["p9", 0.44], ["p10", 0.39], ["p11", 0.33]],
  },
  {
    id: "poniente", label: "Celda sobre el poniente", short: "Poniente", aguaExterna: 21, criticosTop30: 9,
    ranking: [["p6", 0.94], ["p10", 0.87], ["p1", 0.8], ["p3", 0.71], ["p2", 0.62], ["p8", 0.55], ["p4", 0.49], ["p5", 0.41], ["p7", 0.36], ["p11", 0.31], ["p9", 0.27]],
  },
  {
    id: "pareja", label: "Lluvia pareja", short: "Pareja", aguaExterna: 33, criticosTop30: 12,
    ranking: [["p4", 0.79], ["p1", 0.77], ["p3", 0.72], ["p2", 0.7], ["p8", 0.61], ["p5", 0.57], ["p6", 0.52], ["p10", 0.47], ["p7", 0.4], ["p11", 0.35], ["p9", 0.3]],
  },
];

export const TOTAL_INTERSECCIONES = 2041;
export const COMUNAS: { id: "Todas" | Comuna; total: number }[] = [
  { id: "Todas", total: 2041 },
  { id: "Providencia", total: 612 },
  { id: "Ñuñoa", total: 701 },
  { id: "Las Condes", total: 728 },
];

export interface RankedPunto extends Punto {
  rank: number;
  score: number;
  prio: Prioridad;
}

export function prioFromRank(rank: number): Prioridad {
  return rank <= 4 ? "alta" : rank <= 8 ? "media" : "baja";
}

export function rankingFor(sc: ScenarioId, agua: Record<string, NivelAgua> = {}): RankedPunto[] {
  const s = SCENARIOS.find((x) => x.id === sc)!;
  // Fase Durante (plan §6.5): C_durante = C · (1 + w_agua · nivel de agua). Con agua observada o simulada el orden se
  // recalcula; sin agua es el orden del escenario. El puntaje no se muestra, pero sí ordena.
  const ajustado = s.ranking.map(([id, score]) => ({ id, score: score * (1 + FLUJO_CONFIG.wAgua * (FLUJO_CONFIG.valorNivelAgua[agua[id] ?? "sin_agua"] ?? 0)) }));
  ajustado.sort((a, b) => b.score - a.score);
  return ajustado.map(({ id, score }, i) => ({ ...PUNTOS[id], rank: i + 1, score, prio: prioFromRank(i + 1) }));
}

export const fmt = (n: number, d = 2) => n.toFixed(d).replace(".", ",");
export const pad2 = (n: number) => String(n).padStart(2, "0");

export function motivo(p: Punto) {
  if (p.motivo) return p.motivo;
  return `${p.comuna} · ${p.pctExterno} % del agua viene de ${p.origen}`;
}

export function cita(p: Punto) {
  return `“Recibe el agua de ${fmt(p.area)} km², el ${p.pctExterno} % desde ${p.origen ?? p.comuna}. ${p.cercaFrase} Limpiar los sumideros de la esquina antes de que empiece la lluvia.”`;
}

export function instruccion(p: RankedPunto) {
  return `Prioridad ${p.rank}. Recibe el agua de ${fmt(p.area)} km², el ${p.pctExterno} % desde ${p.origen ?? p.comuna}, ${p.cerca.toLowerCase().startsWith("metro a") ? `a ${p.cerca.slice(8)} de la estación de metro` : p.cerca.toLowerCase()}. Limpiar los sumideros de la esquina antes de las 14:00.`;
}

// "Qué hay cerca" para el héroe: la infraestructura más crítica de `criticidad` ("Ⓜ Metro X · 80 m", "Colegio · 140 m").
export function cercaResumen(p: Punto): { valor: string; etiqueta: string } {
  const orden = ["metro", "paso bajo nivel", "hospital", "colegio"];
  const items = p.criticidad.map((c) => {
    const [nombre, dist] = c.replace(/^Ⓜ\s*/, "").split(" · ");
    const tipo = orden.find((t) => nombre.toLowerCase().startsWith(t)) ?? nombre.toLowerCase();
    return { tipo, nombre, dist };
  });
  items.sort((a, b) => (orden.indexOf(a.tipo) + 1 || 9) - (orden.indexOf(b.tipo) + 1 || 9));
  const it = items[0];
  if (!it) return { valor: "Nada", etiqueta: "crítico a menos de 200 m" };
  const valor = it.tipo.charAt(0).toUpperCase() + it.tipo.slice(1);
  const resto = it.nombre.slice(it.tipo.length).trim();
  return { valor, etiqueta: [it.dist ? `a ${it.dist}` : null, resto || null].filter(Boolean).join(" · ") };
}

export const PRIO_LABEL: Record<Prioridad, string> = { alta: "▲ Alta", media: "◆ Media", baja: "● Baja" };

// Ruta de cuadrilla: derivada del escenario, la comuna, las cuadrillas y los puntos agregados.
// La vista, el enlace de Google Maps y el texto de WhatsApp consumen esta misma lista.
export interface Parada {
  id: string;
  nombre: string;
  prio: Prioridad;
  dist: string; // "inicio" o "+x,x km" desde la parada anterior (línea recta)
  coord: LngLat;
}
export interface RutaCuadrilla {
  paradas: Parada[];
  km: string;
}

function kmEntre(a: LngLat, b: LngLat) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function buildRuta(ranking: RankedPunto[], comuna: "Todas" | Comuna, cuadrillas: number, enRuta: string[]): RutaCuadrilla {
  const base = (comuna === "Todas" ? ranking : ranking.filter((p) => p.comuna === comuna)).slice(0, cuadrillas * 2);
  const ids = new Set(base.map((p) => p.id));
  const extra = enRuta
    .filter((id) => !ids.has(id))
    .map((id) => ranking.find((p) => p.id === id))
    .filter((p): p is RankedPunto => !!p && (comuna === "Todas" || p.comuna === comuna));
  const puntos = [...base, ...extra].sort((a, b) => a.rank - b.rank);
  let total = 0;
  const paradas = puntos.map((p, i) => {
    const d = i === 0 ? 0 : kmEntre(puntos[i - 1].coord, p.coord);
    total += d;
    return { id: p.id, nombre: p.nombre, prio: p.prio, dist: i === 0 ? "inicio" : `+${fmt(d, 1)} km`, coord: p.coord };
  });
  return { paradas, km: `${fmt(total, 1)} km` };
}

// Google Maps URLs admite 3 waypoints en navegadores móviles y 9 en el resto
// (https://developers.google.com/maps/documentation/urls/get-started).
export const MAX_WAYPOINTS_MOVIL = 3;
export const MAX_WAYPOINTS_WEB = 9;

export interface Tramo {
  url: string;
  desde: number; // número de parada (1-based)
  hasta: number;
}

function urlTramo(paradas: Parada[]) {
  const pts = paradas.map((r) => `${r.coord[1]},${r.coord[0]}`);
  if (pts.length === 0) return "https://www.google.com/maps";
  const base = "https://www.google.com/maps/dir/?api=1&travelmode=driving";
  if (pts.length === 1) return `${base}&destination=${pts[0]}`;
  const way = pts.slice(1, -1).join("|");
  return `${base}&origin=${pts[0]}&destination=${pts[pts.length - 1]}${way ? `&waypoints=${encodeURIComponent(way)}` : ""}`;
}

// Divide la ruta en tramos que respetan el límite de waypoints. La última parada de un tramo es el origen del siguiente.
export function googleMapsTramos(paradas: Parada[], maxWaypoints: number): Tramo[] {
  const size = maxWaypoints + 2; // origen + waypoints + destino
  if (paradas.length <= size) return [{ url: urlTramo(paradas), desde: 1, hasta: paradas.length }];
  const tramos: Tramo[] = [];
  for (let i = 0; i < paradas.length - 1; i += size - 1) {
    const slice = paradas.slice(i, i + size);
    tramos.push({ url: urlTramo(slice), desde: i + 1, hasta: i + slice.length });
  }
  return tramos;
}

// Mismo texto para copiar y para enviar: lleva los enlaces reales. Se lee en el teléfono, así que usa el límite móvil.
export function textoWhatsApp(paradas: Parada[], scenarioLabel: string, comuna: string, opts: { prio?: boolean } = {}) {
  const head = `*Drena · Ruta Cuadrilla 1 · ${comuna === "Todas" ? "Todas las comunas" : comuna}*`;
  const lines = paradas.map((r, i) => `${i + 1}. ${r.nombre}${opts.prio ? ` (${r.prio})` : ""}`);
  const tramos = googleMapsTramos(paradas, MAX_WAYPOINTS_MOVIL);
  const links = tramos.length === 1 ? [`Google Maps: ${tramos[0].url}`] : tramos.map((t, i) => `Tramo ${i + 1} (paradas ${t.desde}–${t.hasta}): ${t.url}`);
  return [head, `Escenario: ${scenarioLabel}`, "", ...lines, "", ...links].join("\n");
}

// Modo Durante: cadena aguas abajo por punto anegado (ids de PUNTOS)
export const CADENA: Record<string, string[]> = {
  p2: ["p1", "p10", "p6"],
  p1: ["p10", "p6"],
  p5: ["p1", "p10", "p6"],
  p3: ["p8"],
  p4: ["p8", "p3"],
};
export const SIMULABLES = ["p1", "p2", "p3", "p4", "p5"];

// Líneas de escurrimiento (aprox.)
export const ESCURRIMIENTO: LngLat[][] = [
  [[-70.6335, -33.4375], [-70.62, -33.429], [-70.6013, -33.418], [-70.575, -33.4105], [-70.548, -33.4035]],
  [[-70.6295, -33.4405], [-70.614, -33.434], [-70.6085, -33.4388], [-70.5935, -33.4335], [-70.566, -33.4265], [-70.538, -33.4235]],
  [[-70.628, -33.4555], [-70.604, -33.4545], [-70.582, -33.454], [-70.552, -33.4532]],
  [[-70.6005, -33.4625], [-70.579, -33.4658], [-70.556, -33.4688]],
];

// Límites comunales (aprox.)
export const LIMITES: LngLat[][] = [
  [[-70.6075, -33.4115], [-70.6005, -33.42], [-70.5975, -33.4305], [-70.5925, -33.4405], [-70.589, -33.4505]],
  [[-70.635, -33.4445], [-70.615, -33.4445], [-70.6, -33.4455], [-70.589, -33.4505]],
];

// Celda convectiva GOES-19 (ilustrativa)
export const CELDA: LngLat[] = [
  [-70.553, -33.4015], [-70.5395, -33.4045], [-70.5345, -33.4155], [-70.5415, -33.4265],
  [-70.556, -33.4255], [-70.561, -33.4135],
];
export const RAYOS: LngLat[] = [
  [-70.5555, -33.4085], [-70.5445, -33.4065], [-70.5385, -33.4105], [-70.5525, -33.4145], [-70.5475, -33.4095],
  [-70.5375, -33.4175], [-70.5525, -33.4205], [-70.5395, -33.4215], [-70.5445, -33.4185], [-70.5575, -33.4225],
];

// Validación 13-oct: anegamientos reales ilustrativos
export const ANEGAMIENTOS_REALES: { coord: LngLat; conTop: boolean }[] = [
  { coord: [-70.6013, -33.418], conTop: true },
  { coord: [-70.6085, -33.4388], conTop: true },
  { coord: [-70.604, -33.4545], conTop: true },
  { coord: [-70.579, -33.4658], conTop: true },
  { coord: [-70.6265, -33.4245], conTop: false },
  { coord: [-70.5585, -33.4485], conTop: false },
];

// 175 puntos críticos GORE (muestra ilustrativa)
export const GORE: LngLat[] = Array.from({ length: 28 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12345.6789;
  const fx = a - Math.floor(a);
  const fy = b - Math.floor(b);
  return [-70.632 + fx * 0.09, -33.47 + fy * 0.065] as LngLat;
});

// Área de aporte aproximada: polígono hacia aguas arriba (oriente)
export function areaAporte(p: Punto): LngLat[] {
  const [x, y] = p.coord;
  const k = Math.sqrt(p.area / 1.25);
  const pts: [number, number][] = [
    [0, 0], [0.0035, 0.0062], [0.0145, 0.0115], [0.034, 0.0185], [0.0475, 0.0085], [0.04, -0.0012], [0.0205, -0.0045], [0.0055, -0.0045],
  ];
  return pts.map(([dx, dy]) => [x + dx * k, y + dy * k] as LngLat);
}

export const MAP_BOUNDS: [LngLat, LngLat] = [[-70.634, -33.472], [-70.534, -33.402]];

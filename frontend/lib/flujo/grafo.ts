// Red de escurrimiento leída de public/data/flujo.geojson (pipeline/04_flujo.py).
// Solo hay tramos con dirección: los nodos sin vecino más bajo (salidas de la red) no se exportan ni se animan.
import type { LngLat } from "../data";
import { FLUJO_CONFIG } from "./config";

export interface Tramo {
  id: number;
  a: number; // nodo OSM de origen
  b: number; // nodo OSM de destino
  L: number; // m
  s: number; // pendiente del DEM (m/m)
  sp: number; // pendiente que usa la simulación: s suavizada donde el DEM no sirve (pipeline/flujo/pendientes.py)
  relleno: boolean; // la dirección sale del relleno de una depresión (el DEM no baja aquí)
  ap: number; // área propia que aporta el nodo de origen (m²)
  acc: number; // área acumulada que pasa por el tramo (m²)
  sig: number | null; // tramo siguiente aguas abajo
  coords: LngLat[]; // de aguas arriba a aguas abajo
  cum: number[]; // metros acumulados en cada vértice
  mid: LngLat;
  v: number; // velocidad del agua (m/s), Manning simplificado
  capCuneta: number; // caudal (L/s) que cabe en la cuneta sin salirse
  capCalzada: number; // caudal (L/s) que cabe en la calzada hasta la solera
  vc: 0 | 1 | 2; // velocidad del trazo animado: lenta, media o rápida
  nombre: string | null; // calle en OpenStreetMap
  entrantes: number[];
}

export interface Sumidero {
  id: string; // ID_IDE de la DOH
  coord: LngLat;
  tramo: number | null; // null: el flujo no pasa por su tramo, solo recibe su área local
  pos: number; // 0 aguas arriba .. 1 aguas abajo
  ap: number; // m²
  s: number;
  drena: string | null; // siguiente sumidero aguas abajo
  comuna: string | null;
}

export interface Grafo {
  tramos: Tramo[];
  sumideros: Sumidero[];
  orden: number[]; // tramos de aguas arriba a aguas abajo
  sumPorTramo: Map<number, number[]>; // índices de sumideros ordenados por pos
}

const M_LAT = 110_540;
const mLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

export function distM(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * mLon((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * M_LAT;
  return Math.hypot(dx, dy);
}

/** Manning simplificado: v = (1/n) · R^(2/3) · S^(1/2), entre velocidadMin y velocidadMax (m/s). */
export function velocidad(pendiente: number, cfg = FLUJO_CONFIG): number {
  const v = (1 / cfg.manningN) * Math.pow(cfg.radioHidraulicoM, 2 / 3) * Math.sqrt(Math.max(0, pendiente));
  return Math.min(cfg.velocidadMax, Math.max(cfg.velocidadMin, v));
}

/** Caudal (L/s) que cabe en la cuneta: área de la cuneta × velocidad. */
export function capacidadCuneta(pendiente: number, cfg = FLUJO_CONFIG): number {
  return cfg.areaCunetaM2 * velocidad(pendiente, cfg) * 1000;
}

/** Caudal (L/s) que cabe en la calzada hasta la solera: área × velocidad. */
export function capacidadCalzada(pendiente: number, cfg = FLUJO_CONFIG): number {
  return cfg.areaCalzadaM2 * velocidad(pendiente, cfg) * 1000;
}

interface FeatureTramo {
  properties: { kind: "tramo"; id: number; a: number; b: number; L: number; s: number; sp?: number; n?: string; r: number; ap: number; acc: number; sig: number | null };
  geometry: { coordinates: LngLat[] };
}
interface FeatureSumidero {
  properties: { kind: "sumidero"; id: string; tramo: number | null; pos: number; ap: number; s: number; drena: string | null; comuna: string | null };
  geometry: { coordinates: LngLat };
}

export function construirGrafo(geojson: { features: (FeatureTramo | FeatureSumidero)[] }): Grafo {
  const tramos: Tramo[] = [];
  const sumideros: Sumidero[] = [];
  for (const f of geojson.features) {
    if (f.properties.kind === "tramo") {
      const p = (f as FeatureTramo).properties;
      const coords = (f as FeatureTramo).geometry.coordinates;
      const cum = [0];
      for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distM(coords[i - 1], coords[i]));
      const m = coords[Math.floor(coords.length / 2)];
      const sp = p.sp ?? p.s;
      const v = velocidad(sp);
      const [l1, l2] = FLUJO_CONFIG.trazoLimitesV;
      tramos[p.id] = { id: p.id, a: p.a, b: p.b, L: p.L, s: p.s, sp, relleno: p.r === 1, ap: p.ap, acc: p.acc, sig: p.sig, coords, cum, mid: m, v, capCuneta: capacidadCuneta(sp), capCalzada: capacidadCalzada(sp), vc: v < l1 ? 0 : v < l2 ? 1 : 2, nombre: p.n ?? null, entrantes: [] };
    } else {
      const p = (f as FeatureSumidero).properties;
      sumideros.push({ id: p.id, coord: (f as FeatureSumidero).geometry.coordinates, tramo: p.tramo, pos: p.pos, ap: p.ap, s: p.s, drena: p.drena, comuna: p.comuna });
    }
  }
  for (const t of tramos) if (t.sig !== null && tramos[t.sig]) tramos[t.sig].entrantes.push(t.id);

  // Orden topológico: un tramo va después de todos los que le entregan agua
  const faltan = tramos.map((t) => t.entrantes.length);
  const cola = tramos.filter((t) => faltan[t.id] === 0).map((t) => t.id);
  const orden: number[] = [];
  while (cola.length) {
    const i = cola.pop()!;
    orden.push(i);
    const sig = tramos[i].sig;
    if (sig !== null && --faltan[sig] === 0) cola.push(sig);
  }

  const sumPorTramo = new Map<number, number[]>();
  sumideros.forEach((s, i) => {
    if (s.tramo === null) return;
    const l = sumPorTramo.get(s.tramo) ?? [];
    l.push(i);
    sumPorTramo.set(s.tramo, l);
  });
  sumPorTramo.forEach((l) => l.sort((x, y) => sumideros[x].pos - sumideros[y].pos));
  return { tramos, sumideros, orden, sumPorTramo };
}

/** Punto a `m` metros del inicio del tramo, y el rumbo local (grados desde el norte). */
export function puntoEnTramo(t: Tramo, m: number): { coord: LngLat; rumbo: number } {
  const d = Math.min(Math.max(m, 0), t.cum[t.cum.length - 1]);
  let lo = 0;
  let hi = t.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t.cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = t.cum[hi] - t.cum[lo] || 1;
  const k = (d - t.cum[lo]) / seg;
  const [x0, y0] = t.coords[lo];
  const [x1, y1] = t.coords[hi];
  const dx = (x1 - x0) * mLon(y0);
  const dy = (y1 - y0) * M_LAT;
  return { coord: [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k], rumbo: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 };
}

// Red de escurrimiento de Providencia, Ñuñoa y Las Condes, leída por teselas de public/data/flujo/ (pipeline/04_flujo.py).
// Solo hay tramos con dirección: los nodos sin vecino más bajo (salidas de la red) no se exportan ni se animan.
// La red crece a medida que se cargan teselas: lo visible y lo que está aguas arriba de lo visible (indice.json, "arriba").
//
// Módulo puro (solo importa tipos): lo usan el hilo principal, el worker del motor y las pruebas de `npm test`.
import type { LngLat } from "../data";
import type { FlujoConfig } from "./config";

export interface Tramo {
  id: number; // número global del tramo
  L: number; // m
  sp: number; // pendiente que usa la simulación: la del DEM, suavizada donde no sirve (pipeline/flujo/pendientes.py)
  ap: number; // área propia que aporta el nodo de origen (m²), con lo que entra desde el margen de la red
  acc: number; // área acumulada que pasa por el tramo (m²): el mapa dibuja los troncales con zoom bajo
  sig: number | null; // tramo siguiente aguas abajo
  coords: LngLat[]; // de aguas arriba a aguas abajo
  cum: number[]; // metros acumulados en cada vértice
  mid: LngLat;
  caja: [number, number, number, number]; // oeste, sur, este, norte
  tesela: string;
  v: number; // velocidad del agua (m/s), Manning simplificado
  capCuneta: number; // caudal (L/s) que cabe en la cuneta sin salirse
  capCalzada: number; // caudal (L/s) que cabe en la calzada hasta la solera
  vc: 0 | 1 | 2; // velocidad del trazo animado: lenta, media o rápida
  nombre: string | null; // calle en OpenStreetMap
  entrantes: number[];
}

export interface Sumidero {
  n: number; // número global del sumidero (pipeline)
  id: string; // ID_IDE de la DOH
  coord: LngLat;
  tramo: number | null; // null: el flujo no pasa por su tramo, solo recibe su área local
  pos: number; // 0 aguas arriba .. 1 aguas abajo
  ap: number; // m²
  s: number;
  comuna: string | null;
}

export interface Grafo {
  /** Tramos por id global; quedan huecos donde la tesela no está cargada. Para recorrerlos, `lista`. */
  tramos: Tramo[];
  lista: Tramo[];
  /** Sumideros cargados, en el orden de carga (su índice es el de los arreglos del motor). */
  sumideros: Sumidero[];
  orden: number[]; // tramos cargados de aguas arriba a aguas abajo
  sumPorTramo: Map<number, number[]>; // índices de sumideros ordenados por pos
  teselas: Set<string>;
  totalTramos: number;
  totalSumideros: number;
}

/** indice.json de pipeline/04_flujo.py. */
export interface IndiceFlujo {
  version: number;
  aviso: string;
  tesela_grados: number;
  tramos: number;
  sumideros: number;
  caja: [LngLat, LngLat];
  caja_inicial: [LngLat, LngLat];
  acc_percentiles: Record<string, number>;
  teselas: Record<string, { archivo: string; caja: [LngLat, LngLat]; tramos: number; sumideros: number; bytes: number; arriba: string[] }>;
}

/** Tesela tal como la escribe el pipeline (ver el docstring de pipeline/04_flujo.py). */
export interface TeselaCruda {
  t: [number, number, number, number, number, number | null, number | null, number[]][];
  s: [number, string, number, number, number | null, number, number, number, number | null][];
  calles: string[];
  comunas: string[];
}

type CfgVel = Pick<FlujoConfig, "manningN" | "radioHidraulicoM" | "velocidadMin" | "velocidadMax" | "areaCunetaM2" | "areaCalzadaM2" | "trazoLimitesV">;

const M_LAT = 110_540;
const mLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

export function distM(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * mLon((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * M_LAT;
  return Math.hypot(dx, dy);
}

/** Manning simplificado: v = (1/n) · R^(2/3) · S^(1/2), entre velocidadMin y velocidadMax (m/s). */
export function velocidad(pendiente: number, cfg: CfgVel): number {
  const v = (1 / cfg.manningN) * Math.pow(cfg.radioHidraulicoM, 2 / 3) * Math.sqrt(Math.max(0, pendiente));
  return Math.min(cfg.velocidadMax, Math.max(cfg.velocidadMin, v));
}

/** Caudal (L/s) que cabe en la cuneta: área de la cuneta × velocidad. */
export function capacidadCuneta(pendiente: number, cfg: CfgVel): number {
  return cfg.areaCunetaM2 * velocidad(pendiente, cfg) * 1000;
}

/** Caudal (L/s) que cabe en la calzada hasta la solera: área × velocidad. */
export function capacidadCalzada(pendiente: number, cfg: CfgVel): number {
  return cfg.areaCalzadaM2 * velocidad(pendiente, cfg) * 1000;
}

export function grafoVacio(totalTramos: number, totalSumideros: number): Grafo {
  return { tramos: [], lista: [], sumideros: [], orden: [], sumPorTramo: new Map(), teselas: new Set(), totalTramos, totalSumideros };
}

/** Lee una tesela: coordenadas en enteros de 1e-5 grados, cada vértice como diferencia con el anterior. */
export function leerTesela(clave: string, cruda: TeselaCruda, cfg: CfgVel): { tramos: Tramo[]; sumideros: Sumidero[] } {
  const [l1, l2] = cfg.trazoLimitesV;
  const tramos = cruda.t.map(([id, L, sp, ap, acc, sig, calle, plano]): Tramo => {
    const coords: LngLat[] = [];
    let x = 0;
    let y = 0;
    for (let k = 0; k < plano.length; k += 2) {
      x += plano[k];
      y += plano[k + 1];
      coords.push([x / 1e5, y / 1e5]);
    }
    const cum = [0];
    let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (let i = 0; i < coords.length; i++) {
      if (i > 0) cum.push(cum[i - 1] + distM(coords[i - 1], coords[i]));
      o = Math.min(o, coords[i][0]);
      e = Math.max(e, coords[i][0]);
      s = Math.min(s, coords[i][1]);
      n = Math.max(n, coords[i][1]);
    }
    const v = velocidad(sp, cfg);
    return {
      id, L, sp, ap, acc, sig, coords, cum, mid: coords[Math.floor(coords.length / 2)], caja: [o, s, e, n], tesela: clave,
      v, capCuneta: capacidadCuneta(sp, cfg), capCalzada: capacidadCalzada(sp, cfg), vc: v < l1 ? 0 : v < l2 ? 1 : 2,
      nombre: calle === null ? null : (cruda.calles[calle] ?? null), entrantes: [],
    };
  });
  const sumideros = cruda.s.map(([n, id, x, y, tramo, pos, ap, s, comuna]): Sumidero => ({
    n, id, coord: [x / 1e5, y / 1e5], tramo, pos, ap, s, comuna: comuna === null ? null : (cruda.comunas[comuna] ?? null),
  }));
  return { tramos, sumideros };
}

/**
 * Suma una tesela a la red. Rehace los entrantes, el orden topológico y las rejillas por tramo de todo lo cargado
 * (unos pocos ms con miles de tramos: solo ocurre al cargar teselas). Devuelve los índices de los sumideros nuevos.
 */
export function agregarAlGrafo(g: Grafo, clave: string, parte: { tramos: Tramo[]; sumideros: Sumidero[] }): number[] {
  if (g.teselas.has(clave)) return [];
  g.teselas.add(clave);
  for (const t of parte.tramos) {
    if (g.tramos[t.id]) continue;
    g.tramos[t.id] = t;
    g.lista.push(t);
  }
  const nuevos: number[] = [];
  for (const s of parte.sumideros) {
    nuevos.push(g.sumideros.length);
    g.sumideros.push(s);
  }
  for (const t of g.lista) t.entrantes = [];
  for (const t of g.lista) if (t.sig !== null && g.tramos[t.sig]) g.tramos[t.sig].entrantes.push(t.id);

  // Orden topológico: un tramo va después de todos los que le entregan agua
  const faltan = new Map<number, number>();
  const cola: number[] = [];
  for (const t of g.lista) {
    faltan.set(t.id, t.entrantes.length);
    if (t.entrantes.length === 0) cola.push(t.id);
  }
  const orden: number[] = [];
  while (cola.length) {
    const i = cola.pop()!;
    orden.push(i);
    const sig = g.tramos[i].sig;
    if (sig !== null && g.tramos[sig]) {
      const f = faltan.get(sig)! - 1;
      faltan.set(sig, f);
      if (f === 0) cola.push(sig);
    }
  }
  g.orden = orden;

  g.sumPorTramo = new Map();
  g.sumideros.forEach((s, i) => {
    if (s.tramo === null || !g.tramos[s.tramo]) return;
    const l = g.sumPorTramo.get(s.tramo) ?? [];
    l.push(i);
    g.sumPorTramo.set(s.tramo, l);
  });
  g.sumPorTramo.forEach((l) => l.sort((x, y) => g.sumideros[x].pos - g.sumideros[y].pos));
  return nuevos;
}

/** Teselas que hay que cargar para ver la caja: las que la tocan y todas las que están aguas arriba de esas. */
export function teselasNecesarias(indice: IndiceFlujo, caja: [LngLat, LngLat]): string[] {
  const [[o, s], [e, n]] = caja;
  const out = new Set<string>();
  for (const [clave, t] of Object.entries(indice.teselas)) {
    const [[to, ts], [te, tn]] = t.caja;
    if (te < o || to > e || tn < s || ts > n) continue;
    out.add(clave);
    for (const a of t.arriba) out.add(a);
  }
  return [...out].filter((k) => indice.teselas[k]);
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

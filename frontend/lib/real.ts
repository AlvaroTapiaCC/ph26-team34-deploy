// Convierte las respuestas del backend a los tipos que ya usan los componentes (lib/data.ts).
// El backend entrega un ranking por SUMIDERO; la interfaz muestra INTERSECCIONES: se agrupan por
// `intersection_id` (el ranking ya trae `intersection_id` e `intersection_nombre`).
import type { ApiEscenario, ApiFicha, ApiRanking, ApiRankingItem, ApiSenal } from "./api";
import type { Comuna, LngLat, Prioridad, RankedPunto, Scenario } from "./data";

/**
 * Cortes de prioridad. El plan (§6.4) define Prioridad = P_ef × C pero no fija umbrales, y el backend
 * entrega solo el número. Mientras no existan, la prioridad es relativa al ranking del escenario:
 * el 10 % de las intersecciones con mayor puntaje es alta, el siguiente 20 % media y el resto baja.
 * Si todas tienen el mismo puntaje (variables aún sin cargar) no hay nada que distinguir: todas son baja.
 */
export const PRIO_CORTES = { alta: 0.1, media: 0.3 } as const;

export function prioDe(posicion: number, total: number, hayDiferencias: boolean): Prioridad {
  if (!hayDiferencias) return "baja";
  const f = (posicion - 1) / total;
  return f < PRIO_CORTES.alta ? "alta" : f < PRIO_CORTES.media ? "media" : "baja";
}

// Los ids de intersección vienen como "<comuna>-<calles>": las-condes-…, nunoa-…, providencia-…
function comunaDe(it: ApiRankingItem): Comuna {
  const id = it.intersection_id ?? "";
  if (id.startsWith("las-condes")) return "Las Condes";
  if (id.startsWith("providencia")) return "Providencia";
  return "Ñuñoa";
}

/** Rectángulo que contiene los puntos, con un margen, para fitBounds del mapa. */
export function boundsDe(puntos: { coord: LngLat }[]): [LngLat, LngLat] {
  if (puntos.length === 0) return [[-70.634, -33.472], [-70.534, -33.402]];
  const xs = puntos.map((p) => p.coord[0]);
  const ys = puntos.map((p) => p.coord[1]);
  const m = 0.004;
  return [
    [Math.min(...xs) - m, Math.min(...ys) - m],
    [Math.max(...xs) + m, Math.max(...ys) + m],
  ];
}

const acortar = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function aEscenario(e: ApiEscenario): Scenario {
  return { id: e.id, label: e.nombre, short: acortar(e.nombre, 22), ranking: [], aguaExterna: 0, criticosTop30: 0, real: true };
}

export interface RankingReal {
  puntos: RankedPunto[];
  /** sumidero_id → id de la intersección que lo contiene (para resolver la cadena aguas abajo) */
  sumideroAPunto: Record<string, string>;
}

/** Agrupa por intersección conservando el orden del backend (rank ya viene urgente primero, luego prioridad). */
export function aRankingReal(r: ApiRanking): RankingReal {
  const grupos = new Map<string, ApiRankingItem[]>();
  const sumideroAPunto: Record<string, string> = {};
  for (const it of r.items) {
    const id = it.intersection_id ?? `sumidero:${it.sumidero_id}`; // sin intersección: queda solo
    sumideroAPunto[it.sumidero_id] = id;
    const g = grupos.get(id);
    if (g) g.push(it);
    else grupos.set(id, [it]);
  }
  const base = [...grupos.entries()].map(([id, items]) => {
    const mejor = items[0]; // items vienen ordenados por rank
    const lat = items.reduce((a, x) => a + x.lat, 0) / items.length;
    const lon = items.reduce((a, x) => a + x.lon, 0) / items.length;
    return { id, items, mejor, coord: [lon, lat] as LngLat };
  });
  const puntajes = base.map((g) => g.mejor.prioridad ?? 0);
  const hayDiferencias = puntajes.length > 0 && Math.max(...puntajes) !== Math.min(...puntajes);
  const puntos: RankedPunto[] = base.map((g, i) => ({
    id: g.id,
    nodeId: g.id,
    nombre: g.mejor.intersection_nombre ?? `Sumidero ${g.mejor.sumidero_id}`,
    comuna: comunaDe(g.mejor),
    coord: g.coord,
    pctExterno: 0,
    origen: null,
    area: 0,
    cerca: `${g.items.length} ${g.items.length === 1 ? "sumidero" : "sumideros"}`,
    cercaFrase: "",
    criticidad: [],
    aguasAbajo: [],
    rank: i + 1,
    score: g.mejor.prioridad ?? 0,
    prio: prioDe(i + 1, base.length, hayDiferencias),
    real: {
      sumideros: g.items.map((x) => x.sumidero_id),
      mejorSumidero: g.mejor.sumidero_id,
      p: g.mejor.detalle?.p ?? g.mejor.p_pred,
      pEf: g.mejor.p_ef,
      c: g.mejor.c,
      urgente: !!g.mejor.detalle?.urgente,
      explicacion: g.mejor.explicacion,
      aportes: g.mejor.detalle?.aportes ?? {},
      areaFaltante: !!g.mejor.detalle?.area_faltante,
    },
  }));
  return { puntos, sumideroAPunto };
}

/** Resumen de la ficha: lo que sale de GET /sumideros/{id} y no está en el ranking. */
export interface FichaReal {
  variables: { clave: string; valor: number }[];
  aguasAbajo: string[]; // nombres de las intersecciones que reciben su agua, en orden
  calle: string | null;
  explicacion: string | null;
  criticidad: string[];
  ultimaLimpieza: string | null;
  nObservaciones: number;
  senales: ApiSenal[]; // observaciones vigentes con su fuente y confianza (#124)
}

export const NOMBRE_VARIABLE: Record<string, string> = {
  arboles: "Árboles",
  feria: "Feria cercana",
  obras: "Obras",
  suelo: "Suelo desnudo aguas arriba",
  pendiente: "Arrastre por pendiente",
  clima: "Viento y lluvia",
  dias_sin_limpieza: "Días sin limpieza (simulado)",
  camara: "Señal de cámara",
};

export function aFichaReal(f: ApiFicha, sumideroAPunto: Record<string, string>, nombrePunto: (id: string) => string | undefined, modo: "antes" | "durante" = "antes"): FichaReal {
  const sc = f.scores[modo];
  const vistos = new Set<string>([sumideroAPunto[f.id]]);
  const aguasAbajo: string[] = [];
  for (const sid of f.cadena?.aguas_abajo ?? []) {
    const pid = sumideroAPunto[sid];
    if (!pid || vistos.has(pid)) continue; // varios sumideros de la misma esquina cuentan una vez
    vistos.add(pid);
    const n = nombrePunto(pid);
    if (n) aguasAbajo.push(n);
  }
  const aportes = sc?.detalle?.aportes ?? {};
  const crit = f.features?.criticidad;
  return {
    variables: Object.entries(aportes)
      .map(([clave, valor]) => ({ clave, valor: Number(valor) }))
      .filter((v) => Number.isFinite(v.valor))
      .sort((a, b) => b.valor - a.valor),
    aguasAbajo,
    calle: f.cadena?.nombre ?? null,
    explicacion: sc?.explicacion ?? null,
    criticidad: Array.isArray(crit) ? crit.map(String) : typeof crit === "string" ? [crit] : [],
    ultimaLimpieza: f.ultima_limpieza?.fecha ?? null,
    nObservaciones: f.observaciones.length,
    senales: f.senales ?? [], // API anterior a #124: sin señales
  };
}

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { buildRuta, CADENA, PUNTOS, rankingFor, SCENARIOS, type Comuna, type RankedPunto, type RutaCuadrilla, type ScenarioId } from "./data";

export type Modo = "antes" | "durante";
export type Vista = "main" | "validacion" | "metodologia";
export type Status = "ok" | "loading" | "error";
export type Modal = null | "ruta" | "whatsapp" | "simular";
export type Sensor = "escuchando" | "anegado" | "caido";
export type MobileTab = "prioridades" | "ruta" | "durante";
export type MobileView = "lista" | "mapa" | "ficha" | "filtros" | "compartir" | "estados";

export interface Reporte {
  id: string;
  nombre: string;
  fuente: string;
  estado: "anegado" | "pendiente" | "limpio";
  foto?: boolean;
}

export interface Layers {
  prioridad: boolean;
  escurrimiento: boolean;
  limites: boolean;
  gore: boolean;
  rejillas: boolean;
  cadena: boolean;
  rayos: boolean;
  feed: boolean;
  reales: boolean;
}

export interface State {
  scenario: ScenarioId;
  modo: Modo;
  vista: Vista;
  comuna: "Todas" | Comuna;
  cuadrillas: number;
  ficha: string | null;
  selected: string | null;
  modal: Modal;
  toast: string | null;
  status: Status;
  layers: Layers;
  sensor: Sensor;
  anegado: string | null;
  fuenteAnegamiento: string | null;
  sensorAgo: string;
  markMode: boolean;
  reportes: Reporte[];
  enRuta: string[];
  hechos: string[]; // ids de paradas ya limpias (el avance se guarda por parada, no por posición)
  copied: boolean;
  mobileTab: MobileTab;
  mobileView: MobileView;
}

const REPORTE_BASE: Reporte = { id: "r1", nombre: "Grecia / Ossa", fuente: "Cuadrilla 2 · 17:20", estado: "limpio" };

export const initialState: State = {
  scenario: "13oct",
  modo: "antes",
  vista: "main",
  comuna: "Todas",
  cuadrillas: 3,
  ficha: null,
  selected: null,
  modal: null,
  toast: null,
  status: "loading",
  layers: { prioridad: true, escurrimiento: true, limites: false, gore: false, rejillas: false, cadena: false, rayos: false, feed: true, reales: true },
  sensor: "escuchando",
  anegado: null,
  fuenteAnegamiento: null,
  sensorAgo: "",
  markMode: false,
  reportes: [REPORTE_BASE],
  enRuta: [],
  hechos: [],
  copied: false,
  mobileTab: "prioridades",
  mobileView: "lista",
};

type Action =
  | { type: "set"; patch: Partial<State> }
  | { type: "layer"; key: keyof Layers; value?: boolean }
  | { type: "flood"; id: string; fuente: "sensor" | "manual" }
  | { type: "addRuta"; id: string };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "set":
      return { ...s, ...a.patch };
    case "layer":
      return { ...s, layers: { ...s.layers, [a.key]: a.value ?? !s.layers[a.key] } };
    case "flood": {
      const nombre = rankingFor(s.scenario).find((p) => p.id === a.id)!.nombre;
      const fuente = a.fuente === "sensor" ? "Reporte simulado · 17:44" : "Marcado en sala · 17:44";
      return {
        ...s,
        sensor: "anegado",
        anegado: a.id,
        fuenteAnegamiento: fuente,
        sensorAgo: "hace 40 s",
        markMode: false,
        modal: null,
        layers: { ...s.layers, cadena: true },
        toast: null,
        reportes: [
          { id: "r3", nombre, fuente, estado: "anegado", foto: true },
          { id: "r2", nombre: "Irarrázaval / P. de Valdivia", fuente: "Llamada vecinal · 17:31", estado: "pendiente" },
          REPORTE_BASE,
        ],
      };
    }
    case "addRuta":
      return { ...s, enRuta: s.enRuta.includes(a.id) ? s.enRuta : [...s.enRuta, a.id], toast: "Agregado a la ruta de la cuadrilla" };
  }
}

interface Ctx {
  s: State;
  set: (patch: Partial<State>) => void;
  toggleLayer: (key: keyof Layers, value?: boolean) => void;
  flood: (id: string, fuente?: "sensor" | "manual") => void;
  addRuta: (id: string) => void;
  reload: () => void;
  ranking: RankedPunto[];
  filtered: RankedPunto[];
  cadena: RankedPunto[];
  ruta: RutaCuadrilla;
  scenarioLabel: string;
}

const StoreCtx = createContext<Ctx | null>(null);

function initFromUrl(): State {
  if (typeof window === "undefined") return initialState;
  const q = new URLSearchParams(window.location.search);
  const s: State = { ...initialState };
  const esc = q.get("escenario");
  if (esc && SCENARIOS.some((x) => x.id === esc)) s.scenario = esc as ScenarioId;
  if (q.get("modo") === "durante") s.modo = "durante";
  const v = q.get("vista");
  if (v === "validacion" || v === "metodologia") s.vista = v;
  const c = q.get("comuna");
  if (c === "Providencia" || c === "Ñuñoa" || c === "Las Condes") s.comuna = c;
  const cu = Number(q.get("cuadrillas"));
  if (cu >= 1 && cu <= 6) s.cuadrillas = cu;
  if (q.get("sensor") === "caido") {
    s.sensor = "caido";
    s.sensorAgo = "hace 5 min";
  }
  if (q.get("estado") === "error") s.status = "error";
  const f = q.get("ficha");
  if (f && Object.prototype.hasOwnProperty.call(PUNTOS, f)) s.ficha = f;
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reducer, undefined, initFromUrl);
  const set = useCallback((patch: Partial<State>) => dispatch({ type: "set", patch }), []);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const simulateLoad = useCallback(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("estado") === "cargando") return; // fijo para revisar el estado
    if (loadTimer.current) clearTimeout(loadTimer.current);
    dispatch({ type: "set", patch: { status: "loading" } });
    loadTimer.current = setTimeout(() => dispatch({ type: "set", patch: { status: "ok" } }), 650);
  }, []);

  // Carga inicial y al cambiar escenario
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (s.status === "error") return;
    }
    simulateLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.scenario]);

  // Toast efímero
  useEffect(() => {
    if (!s.toast) return;
    const t = setTimeout(() => dispatch({ type: "set", patch: { toast: null } }), 3200);
    return () => clearTimeout(t);
  }, [s.toast]);

  const ranking = useMemo(() => rankingFor(s.scenario), [s.scenario]);
  const filtered = useMemo(() => (s.comuna === "Todas" ? ranking : ranking.filter((p) => p.comuna === s.comuna)), [ranking, s.comuna]);
  const cadena = useMemo(() => (s.anegado ? (CADENA[s.anegado] ?? []).map((id) => ranking.find((p) => p.id === id)!).filter(Boolean) : []), [s.anegado, ranking]);
  const ruta = useMemo(() => buildRuta(ranking, s.comuna, s.cuadrillas, s.enRuta), [ranking, s.comuna, s.cuadrillas, s.enRuta]);
  const scenarioLabel = SCENARIOS.find((x) => x.id === s.scenario)!.label;

  const value: Ctx = {
    s,
    set,
    toggleLayer: (key, value) => dispatch({ type: "layer", key, value }),
    flood: (id, fuente = "sensor") => dispatch({ type: "flood", id, fuente }),
    addRuta: (id) => {
      const p = ranking.find((x) => x.id === id);
      if (ruta.paradas.some((x) => x.id === id)) dispatch({ type: "set", patch: { toast: "Ya está en la ruta" } });
      else if (p && s.comuna !== "Todas" && p.comuna !== s.comuna) dispatch({ type: "set", patch: { toast: `${p.nombre} es de ${p.comuna}, fuera de ${s.comuna}` } });
      else dispatch({ type: "addRuta", id });
    },
    reload: simulateLoad,
    ranking,
    filtered,
    cadena,
    ruta,
    scenarioLabel,
  };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const c = useContext(StoreCtx);
  if (!c) throw new Error("useStore fuera de StoreProvider");
  return c;
}

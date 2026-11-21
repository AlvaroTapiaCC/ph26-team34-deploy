"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { getEscenarios, getFicha, getRanking } from "./api";
import { buildRuta, COMUNAS, PUNTOS, rankingFor, SCENARIOS, TOTAL_INTERSECCIONES, type Comuna, type RankedPunto, type RutaCuadrilla, type Scenario, type ScenarioId } from "./data";
import type { EstadoRejilla } from "./flujo/config";
import { aEscenario, aFichaReal, aRankingReal, type FichaReal, type RankingReal } from "./real";

// De dónde salen los datos: servidor real o respaldo de ejemplo (lib/data.ts)
export type Fuente = "cargando" | "api" | "ejemplo";

export type Status = "ok" | "loading" | "error";
export type Modal = null | "ruta" | "whatsapp";
export type MobileTab = "prioridades" | "ruta";
export type MobileView = "lista" | "mapa" | "ficha" | "filtros" | "compartir" | "estados";

export interface Layers {
  prioridad: boolean;
  escurrimiento: boolean;
  limites: boolean;
  gore: boolean;
  rejillas: boolean;
}

export const CUADRILLAS_MAX = 6;

export interface State {
  scenario: ScenarioId;
  comuna: "Todas" | Comuna;
  cuadrillas: number;
  ficha: string | null;
  selected: string | null;
  modal: Modal;
  toast: string | null;
  status: Status;
  layers: Layers;
  enRuta: string[];
  /** Estado de rejilla que marcó el operador (clic en el mapa o botones del panel); la simulación lo usa al instante. */
  rejillas: Record<string, EstadoRejilla>;
  hechos: string[]; // ids de paradas ya limpias (el avance se guarda por parada, no por posición)
  copied: boolean;
  mobileTab: MobileTab;
  mobileView: MobileView;
}

export const initialState: State = {
  scenario: "13oct",
  comuna: "Todas",
  cuadrillas: 3,
  ficha: null,
  selected: null,
  modal: null,
  toast: null,
  status: "loading",
  layers: { prioridad: true, escurrimiento: true, limites: true, gore: false, rejillas: false },
  enRuta: [],
  rejillas: {},
  hechos: [],
  copied: false,
  mobileTab: "prioridades",
  mobileView: "lista",
};

type Action =
  | { type: "set"; patch: Partial<State> }
  | { type: "layer"; key: keyof Layers; value?: boolean }
  | { type: "addRuta"; id: string }
  | { type: "rejillas"; estados: Record<string, EstadoRejilla>; toast?: string };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "set":
      return { ...s, ...a.patch };
    case "layer":
      return { ...s, layers: { ...s.layers, [a.key]: a.value ?? !s.layers[a.key] } };
    case "addRuta":
      return { ...s, enRuta: s.enRuta.includes(a.id) ? s.enRuta : [...s.enRuta, a.id], toast: "Agregado a la ruta de la cuadrilla" };
    case "rejillas":
      return { ...s, rejillas: { ...s.rejillas, ...a.estados }, toast: a.toast ?? s.toast };
  }
}

interface Ctx {
  s: State;
  set: (patch: Partial<State>) => void;
  toggleLayer: (key: keyof Layers, value?: boolean) => void;
  addRuta: (id: string) => void;
  /** Cambia el estado de varias rejillas a la vez (botones del panel o clic en el mapa). */
  setRejillas: (estados: Record<string, EstadoRejilla>, toast?: string) => void;
  reload: () => void;
  ranking: RankedPunto[];
  filtered: RankedPunto[];
  ruta: RutaCuadrilla;
  scenarioLabel: string;
  // Datos del servidor
  fuente: Fuente;
  despertando: boolean; // el servidor tarda: probablemente Render está despertando (~50 s)
  escenarios: Scenario[];
  comunas: { id: "Todas" | Comuna; total: number }[];
  totalPuntos: number;
  fichaReal: FichaReal | null;
  fichaEstado: "cargando" | "ok" | "error" | null;
}

const StoreCtx = createContext<Ctx | null>(null);

function initFromUrl(): State {
  if (typeof window === "undefined") return initialState;
  const q = new URLSearchParams(window.location.search);
  const s: State = { ...initialState };
  const esc = q.get("escenario");
  if (esc && SCENARIOS.some((x) => x.id === esc)) s.scenario = esc as ScenarioId;
  const c = q.get("comuna");
  if (c === "Providencia" || c === "Ñuñoa" || c === "Las Condes") s.comuna = c;
  const cu = Number(q.get("cuadrillas"));
  if (cu >= 1 && cu <= CUADRILLAS_MAX) s.cuadrillas = cu;
  if (q.get("estado") === "error") s.status = "error";
  const f = q.get("ficha");
  if (f && Object.prototype.hasOwnProperty.call(PUNTOS, f)) s.ficha = f;
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reducer, undefined, initFromUrl);
  const set = useCallback((patch: Partial<State>) => dispatch({ type: "set", patch }), []);
  const setRejillas = useCallback((estados: Record<string, EstadoRejilla>, toast?: string) => dispatch({ type: "rejillas", estados, toast }), []);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Datos reales (GET /scenarios, /scenarios/{id}/ranking, /sumideros/{id}) ---
  const [fuente, setFuente] = useState<Fuente>("cargando");
  const [despertando, setDespertando] = useState(false);
  const [escenarios, setEscenarios] = useState<Scenario[]>(SCENARIOS);
  const [rankings, setRankings] = useState<Record<string, RankingReal>>({});
  const pedido = useRef<{ escenario: string | null; ficha: string | null }>({ escenario: null, ficha: null });
  const enVuelo = useRef(new Set<string>());

  const cargarRanking = useCallback(async (id: string) => {
    if (enVuelo.current.has(id)) return;
    enVuelo.current.add(id);
    dispatch({ type: "set", patch: { status: "loading" } });
    try {
      const r = await getRanking(id, { onLento: () => setDespertando(true) });
      setRankings((prev) => ({ ...prev, [id]: aRankingReal(r) }));
      dispatch({ type: "set", patch: { status: "ok" } });
    } catch {
      setFuente("ejemplo");
      setEscenarios(SCENARIOS);
      dispatch({ type: "set", patch: { scenario: SCENARIOS[0].id, ficha: null, status: "ok" } });
    } finally {
      enVuelo.current.delete(id);
      setDespertando(false);
    }
  }, []);

  // Carga inicial: escenarios y ranking del primero (o del pedido en ?escenario=)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const q = new URLSearchParams(window.location.search);
      pedido.current = { escenario: q.get("escenario"), ficha: q.get("ficha") };
      if (q.get("estado") === "error" || q.get("estado") === "cargando") {
        setFuente("ejemplo"); // pantallas de estado de diseño: no tocar la red
        return;
      }
    }
    let vivo = true;
    (async () => {
      dispatch({ type: "set", patch: { status: "loading" } });
      try {
        const lista = await getEscenarios({ onLento: () => setDespertando(true) });
        if (!vivo) return;
        if (lista.length === 0) throw new Error("sin escenarios");
        const reales = lista.map(aEscenario);
        const pedidoEsc = pedido.current.escenario;
        const elegido = reales.find((x) => x.id === pedidoEsc)?.id ?? reales[0].id;
        setEscenarios(reales);
        setFuente("api");
        dispatch({ type: "set", patch: { scenario: elegido } });
      } catch {
        if (!vivo) return;
        setFuente("ejemplo");
        dispatch({ type: "set", patch: { status: "ok" } });
      } finally {
        if (vivo) setDespertando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  // Ranking del escenario elegido (una vez por escenario)
  useEffect(() => {
    if (fuente === "api" && !rankings[s.scenario] && escenarios.some((x) => x.id === s.scenario)) cargarRanking(s.scenario);
  }, [fuente, s.scenario, rankings, escenarios, cargarRanking]);

  // ?ficha= con ids reales: se aplica cuando llega el ranking
  useEffect(() => {
    const f = pedido.current.ficha;
    if (f && rankings[s.scenario]?.puntos.some((p) => p.id === f)) {
      pedido.current.ficha = null;
      dispatch({ type: "set", patch: { ficha: f } });
    }
  }, [rankings, s.scenario]);

  const simulateLoad = useCallback(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("estado") === "cargando") return; // fijo para revisar el estado
    if (loadTimer.current) clearTimeout(loadTimer.current);
    dispatch({ type: "set", patch: { status: "loading" } });
    loadTimer.current = setTimeout(() => dispatch({ type: "set", patch: { status: "ok" } }), 650);
  }, []);

  // Carga inicial y al cambiar escenario
  const first = useRef(true);
  useEffect(() => {
    if (fuente !== "ejemplo") return; // con datos reales, el estado de carga lo marca la red (cargarRanking)
    if (first.current) {
      first.current = false;
      if (s.status === "error") return;
    }
    simulateLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.scenario, fuente]);

  // Toast efímero
  useEffect(() => {
    if (!s.toast) return;
    const t = setTimeout(() => dispatch({ type: "set", patch: { toast: null } }), 3200);
    return () => clearTimeout(t);
  }, [s.toast]);

  const real = fuente === "api" ? (rankings[s.scenario] ?? null) : null;
  const ranking = useMemo(() => (real ? real.puntos : rankingFor(s.scenario)), [real, s.scenario]);
  const filtered = useMemo(() => (s.comuna === "Todas" ? ranking : ranking.filter((p) => p.comuna === s.comuna)), [ranking, s.comuna]);
  const ruta = useMemo(() => buildRuta(ranking, s.comuna, s.cuadrillas, s.enRuta), [ranking, s.comuna, s.cuadrillas, s.enRuta]);
  const scenarioLabel = (escenarios.find((x) => x.id === s.scenario) ?? SCENARIOS.find((x) => x.id === s.scenario) ?? SCENARIOS[0]).label;
  const comunas = useMemo(() => {
    if (!real) return COMUNAS;
    const n = (c: Comuna) => real.puntos.filter((p) => p.comuna === c).length;
    return [{ id: "Todas" as const, total: real.puntos.length }, ...(["Providencia", "Ñuñoa", "Las Condes"] as Comuna[]).map((c) => ({ id: c, total: n(c) }))];
  }, [real]);
  const totalPuntos = real ? real.puntos.length : TOTAL_INTERSECCIONES;

  // Ficha real: GET /sumideros/{id} del mejor sumidero de la esquina (variables, cadena, explicación)
  const [ficha, setFicha] = useState<{ id: string; escenario: string; datos: FichaReal | null; estado: "cargando" | "ok" | "error" } | null>(null);
  useEffect(() => {
    const p = real && s.ficha ? real.puntos.find((x) => x.id === s.ficha) : null;
    if (!real || !p?.real) {
      setFicha(null);
      return;
    }
    let vivo = true;
    setFicha({ id: p.id, escenario: s.scenario, datos: null, estado: "cargando" });
    getFicha(p.real.mejorSumidero, s.scenario, { onLento: () => setDespertando(true) })
      .then((f) => {
        if (!vivo) return;
        const nombres = (pid: string) => real.puntos.find((x) => x.id === pid)?.nombre;
        setFicha({ id: p.id, escenario: s.scenario, datos: aFichaReal(f, real.sumideroAPunto, nombres), estado: "ok" });
      })
      .catch(() => vivo && setFicha({ id: p.id, escenario: s.scenario, datos: null, estado: "error" }))
      .finally(() => vivo && setDespertando(false));
    return () => {
      vivo = false;
    };
  }, [real, s.ficha, s.scenario]);

  const value: Ctx = {
    s,
    set,
    toggleLayer: (key, value) => dispatch({ type: "layer", key, value }),
    addRuta: (id) => {
      const p = ranking.find((x) => x.id === id);
      if (ruta.paradas.some((x) => x.id === id)) dispatch({ type: "set", patch: { toast: "Ya está en la ruta" } });
      else if (p && s.comuna !== "Todas" && p.comuna !== s.comuna) dispatch({ type: "set", patch: { toast: `${p.nombre} es de ${p.comuna}, fuera de ${s.comuna}` } });
      else dispatch({ type: "addRuta", id });
    },
    setRejillas,
    reload: simulateLoad,
    ranking,
    filtered,
    ruta,
    scenarioLabel,
    fuente,
    despertando,
    escenarios,
    comunas,
    totalPuntos,
    fichaReal: ficha && ficha.id === s.ficha ? ficha.datos : null,
    fichaEstado: ficha && ficha.id === s.ficha ? ficha.estado : null,
  };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const c = useContext(StoreCtx);
  if (!c) throw new Error("useStore fuera de StoreProvider");
  return c;
}

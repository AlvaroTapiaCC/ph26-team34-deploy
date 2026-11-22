"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { getEscenarios, getFicha, getRanking } from "./api";
import { buildRuta, CADENA, COMUNAS, PUNTOS, rankingFor, SCENARIOS, TOTAL_INTERSECCIONES, type Comuna, type RankedPunto, type RutaCuadrilla, type Scenario, type ScenarioId } from "./data";
import { aEscenario, aFichaReal, aRankingReal, type FichaReal, type RankingReal } from "./real";

// De dónde salen los datos del modo Antes: servidor real o respaldo de ejemplo (lib/data.ts)
export type Fuente = "cargando" | "api" | "ejemplo";

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
  transporte: boolean;
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
  layers: { prioridad: true, escurrimiento: true, limites: false, gore: false, rejillas: false, cadena: false, rayos: false, feed: true, reales: true, transporte: true },
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
  | { type: "addRuta"; id: string }
  | { type: "resetSim" };

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
    case "resetSim":
      return { ...s, sensor: "escuchando", anegado: null, sensorAgo: "", markMode: false, reportes: [REPORTE_BASE], layers: { ...s.layers, cadena: false }, toast: "Simulación reiniciada" };
    case "addRuta":
      return { ...s, enRuta: s.enRuta.includes(a.id) ? s.enRuta : [...s.enRuta, a.id], toast: "Agregado a la ruta de la cuadrilla" };
  }
}

interface Ctx {
  s: State;
  set: (patch: Partial<State>) => void;
  toggleLayer: (key: keyof Layers, value?: boolean) => void;
  flood: (id: string, fuente?: "sensor" | "manual") => void;
  dispararReporte: () => Promise<void>;
  addRuta: (id: string) => void;
  reload: () => void;
  ranking: RankedPunto[];
  filtered: RankedPunto[];
  cadena: RankedPunto[];
  ruta: RutaCuadrilla;
  scenarioLabel: string;
  // Datos del servidor (modo Antes)
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

  // --- Datos reales del modo Antes (GET /scenarios, /scenarios/{id}/ranking, /sumideros/{id}) ---
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

  // Si el simulador se reinicia (/sim/reset), la vista Durante vuelve a su estado inicial
  const simVisto = useRef(0);
  useEffect(() => {
    if (s.modo !== "durante") return;
    const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${api}/sim/status`, { signal: AbortSignal.timeout(2000) });
        if (!r.ok) return;
        const n = Number((await r.json()).eventos_aplicados) || 0;
        if (n === 0 && simVisto.current > 0) {
          dispatch({ type: "resetSim" });
        }
        simVisto.current = n;
      } catch {
        /* sin backend: no hay nada que sincronizar */
      }
    }, 2500);
    return () => clearInterval(t);
  }, [s.modo]);

  // Modo Antes con datos del servidor; Durante (#36) sigue con los datos de ejemplo
  const real = fuente === "api" && s.modo === "antes" ? (rankings[s.scenario] ?? null) : null;
  const ranking = useMemo(() => (real ? real.puntos : rankingFor(s.scenario)), [real, s.scenario]);
  const filtered = useMemo(() => (s.comuna === "Todas" ? ranking : ranking.filter((p) => p.comuna === s.comuna)), [ranking, s.comuna]);
  const cadena = useMemo(() => (s.anegado ? (CADENA[s.anegado] ?? []).map((id) => ranking.find((p) => p.id === id)!).filter(Boolean) : []), [s.anegado, ranking]);
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
    flood: (id, fuente = "sensor") => dispatch({ type: "flood", id, fuente }),
    // Dispara un reporte en vivo en el simulador (POST /sim/trigger). El backend aún no procesa
    // observaciones (#28), así que la reacción en pantalla es la del mock local `flood`.
    dispararReporte: async () => {
      const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
      const token = process.env.NEXT_PUBLIC_SIM_TOKEN;
      let enviado = false;
      let n = 0; // N° de reporte en vivo de esta corrida: elige el punto, así la demo se repite igual
      try {
        const r = await fetch(`${api}/sim/trigger`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { "X-Sim-Token": token } : {}) },
          body: JSON.stringify({ texto: "Reporte en vivo desde la sala" }),
          signal: AbortSignal.timeout(2500),
        });
        enviado = r.ok;
        if (r.ok) n = Number((await r.json())?.payload?.id_en_vivo) || 0;
      } catch {
        /* sin backend: sigue la demo con el mock local */
      }
      const p = n > 0 ? ranking[(n - 1) % ranking.length] : ranking.find((x) => x.id !== s.anegado);
      if (!p) return;
      simVisto.current = Math.max(simVisto.current, 1);
      dispatch({ type: "flood", id: p.id, fuente: "manual" });
      if (!enviado) dispatch({ type: "set", patch: { toast: "Simulador sin conexión: reporte simulado solo en pantalla" } });
    },
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

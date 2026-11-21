"use client";

// Une el motor, la capa del mapa y el reloj. Corre con requestAnimationFrame y se pausa si la pestaña no está visible.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LngLat, ScenarioId } from "../data";
import type { MapLibre } from "../../components/map/maplibre";
import { montarCapaFlujo, type CapaFlujo } from "./capaMapa";
import { FLUJO_CONFIG, picoEscenario, type EstadoRejilla, type NivelAgua } from "./config";
import { fuenteSimulada, type FuenteObservaciones } from "./fuentes";
import { construirGrafo, distM, type Grafo } from "./grafo";
import { MotorFlujo, type Lecturas } from "./motor";

export type Velocidad = (typeof FLUJO_CONFIG.velocidades)[number];

export interface UiFlujo {
  cargado: boolean;
  error: boolean;
  corriendo: boolean;
  velocidad: Velocidad;
  /** Segundos simulados desde el inicio del escenario. */
  t: number;
  terminado: boolean;
  /** Lluvia de ahora (mm/h) y valor del slider: intensidad máxima del escenario, escalable. */
  lluviaMmH: number;
  lluviaPico: number;
  lecturas: Lecturas;
  /** Rejilla del gráfico: la seleccionada o, si no hay, la que recibe más agua. */
  grafico: { id: string; nombre: string; caudal: number; serie: [number, number][]; elegida: boolean } | null;
  /** Rejillas tapadas (estado efectivo) y total, por comuna. */
  tapadas: Record<string, number>;
  total: Record<string, number>;
}

let grafoPromesa: Promise<Grafo> | null = null;
function cargarGrafo(): Promise<Grafo> {
  grafoPromesa ??= fetch("/data/flujo.geojson")
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then(construirGrafo)
    .catch((e) => {
      grafoPromesa = null;
      throw e;
    });
  return grafoPromesa;
}

const LECTURAS0: Lecturas = { caudalTransito: 0, desbordados: 0, desbordadosPorComuna: {}, metrosSobreCuneta: 0, maxSumidero: null, maxCaudal: 0 };

export interface PuntoNombrado {
  id: string;
  nombre: string;
  coord: LngLat;
}

export function useFlujo(opts: {
  scenario: ScenarioId;
  puntos: PuntoNombrado[];
  /** Estados de rejilla que marcó el operador (store). */
  estados: Record<string, EstadoRejilla>;
  /** Clic en una rejilla del mapa. */
  onClickRejilla: (id: string) => void;
  /** Nivel de agua por punto del ranking cada vez que cambia (alimenta la tabla y el héroe). */
  onNiveles: (n: Record<string, NivelAgua>) => void;
  fuente?: FuenteObservaciones;
  /** Muestra u oculta las capas del flujo en el mapa. */
  visible?: boolean;
}) {
  const { scenario, puntos, estados, onNiveles } = opts;
  const visible = opts.visible ?? true;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const fuente = opts.fuente ?? fuenteSimulada;
  const [ui, setUi] = useState<UiFlujo>(() => ({
    cargado: false,
    error: false,
    corriendo: false,
    velocidad: 10,
    t: 0,
    terminado: false,
    lluviaMmH: 0,
    lluviaPico: picoEscenario(scenario),
    lecturas: LECTURAS0,
    grafico: null,
    tapadas: {},
    total: {},
  }));
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const motor = useRef<MotorFlujo | null>(null);
  const capa = useRef<CapaFlujo | null>(null);
  const mapa = useRef<MapLibre>(null);
  const niveles = useRef("");
  const onNivelesRef = useRef(onNiveles);
  onNivelesRef.current = onNiveles;
  const onClickRef = useRef(opts.onClickRejilla);
  onClickRef.current = opts.onClickRejilla;
  const estadosRef = useRef(estados);
  estadosRef.current = estados;
  const puntosRef = useRef(puntos);
  puntosRef.current = puntos;
  const puntosKey = useMemo(() => JSON.stringify(puntos.map((p) => [p.id, p.coord])), [puntos]);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const seleccionRef = useRef(seleccion);
  seleccionRef.current = seleccion;
  const serie = useRef<{ id: string | null; puntos: [number, number][] }>({ id: null, puntos: [] });

  const parche = useCallback((p: Partial<UiFlujo>) => setUi((u) => ({ ...u, ...p })), []);

  /** Nombre legible de una rejilla: el punto del ranking más cercano (< 250 m) o su id del catastro. */
  const nombreRejilla = useCallback((i: number) => {
    const s = motor.current!.grafo.sumideros[i];
    let mejor: PuntoNombrado | null = null;
    let d = 250;
    for (const p of puntosRef.current) {
      const dp = distM(p.coord, s.coord);
      if (dp < d) {
        d = dp;
        mejor = p;
      }
    }
    return mejor ? `Cerca de ${mejor.nombre}` : `Rejilla ${s.id}`;
  }, []);

  /** Lee el motor y actualiza lo que muestra la interfaz (lecturas, gráfico, conteos). */
  const leerMotor = useCallback(
    (extra: Partial<UiFlujo> = {}) => {
      const m = motor.current;
      if (!m) return;
      const lect = m.lecturas();
      const tapadas: Record<string, number> = { Todas: 0 };
      const total: Record<string, number> = { Todas: 0 };
      m.grafo.sumideros.forEach((s, i) => {
        const c = s.comuna ?? "Otra";
        total[c] = (total[c] ?? 0) + 1;
        total.Todas++;
        if (m.estadoRejilla(i) === "tapada") {
          tapadas[c] = (tapadas[c] ?? 0) + 1;
          tapadas.Todas++;
        }
      });
      const sel = seleccionRef.current;
      const iSel = sel !== null ? m.idx.get(sel) : undefined;
      const i = iSel ?? lect.maxSumidero;
      let grafico: UiFlujo["grafico"] = null;
      if (i !== null && i !== undefined) {
        const id = m.grafo.sumideros[i].id;
        if (serie.current.id !== id) serie.current = { id, puntos: [] };
        const pts = serie.current.puntos;
        if (!pts.length || m.t > pts[pts.length - 1][0]) pts.push([m.t, m.llega[i]]);
        if (pts.length > FLUJO_CONFIG.serieMax) pts.splice(0, pts.length - FLUJO_CONFIG.serieMax);
        grafico = { id, nombre: nombreRejilla(i), caudal: m.llega[i], serie: [...pts], elegida: iSel !== undefined };
      }
      setUi((x) => ({ ...x, t: m.t, lluviaMmH: m.lluviaBaseMmH(), lecturas: lect, grafico, tapadas, total, ...extra }));
    },
    [nombreRejilla],
  );

  const montar = useCallback(() => {
    if (capa.current || !mapa.current || !motor.current) return;
    capa.current = montarCapaFlujo(mapa.current, motor.current, {
      onClickSumidero: (id) => {
        setSeleccion(id);
        onClickRef.current(id);
      },
    });
    capa.current.setVisible(visibleRef.current);
    capa.current.setSeleccion(seleccionRef.current);
    capa.current.actualizarEstado();
  }, []);

  useEffect(() => {
    capa.current?.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    capa.current?.setSeleccion(seleccion);
    serie.current = { id: null, puntos: [] };
    leerMotor();
  }, [seleccion, leerMotor]);

  // Grafo -> motor
  useEffect(() => {
    let vivo = true;
    cargarGrafo()
      .then((g) => {
        if (!vivo) return;
        motor.current = new MotorFlujo(g);
        motor.current.setEstadosManuales(estadosRef.current);
        parche({ cargado: true, error: false });
        montar();
      })
      .catch(() => vivo && parche({ error: true }));
    return () => {
      vivo = false;
    };
  }, [montar, parche]);

  // Escenario y puntos del ranking: vuelve al inicio y el slider parte de la lluvia del escenario
  useEffect(() => {
    const m = motor.current;
    if (!m) return;
    m.asociarPuntos(JSON.parse(puntosKey).map(([id, coord]: [string, LngLat]) => ({ id, coord })));
    m.setEscenario(scenario);
    m.factorLluvia = 1;
    niveles.current = "";
    onNivelesRef.current({});
    serie.current = { id: null, puntos: [] };
    capa.current?.actualizarEstado();
    leerMotor({ terminado: false, lluviaPico: picoEscenario(scenario) });
  }, [scenario, puntosKey, ui.cargado, leerMotor]);

  // Estados de rejilla del operador: se aplican al instante, también con la simulación en pausa
  useEffect(() => {
    const m = motor.current;
    if (!m) return;
    m.setEstadosManuales(estados);
    m.recalcular();
    capa.current?.actualizarEstado();
    leerMotor();
  }, [estados, ui.cargado, leerMotor]);

  // Observaciones de la fuente elegida
  useEffect(() => {
    let vivo = true;
    const leer = async () => {
      const m = motor.current;
      if (!m) return;
      const obs = await fuente.obtener({ scenario, sumideroIdsPorPunto: m.sumideroIdsPorPunto, estadosEscenario: m.estadosEscenario });
      if (vivo) m.setObservaciones(obs);
    };
    leer();
    const id = setInterval(leer, FLUJO_CONFIG.intervaloFuenteMs);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [fuente, scenario, ui.cargado, puntosKey]);

  // Reloj: un cuadro por requestAnimationFrame
  useEffect(() => {
    if (!ui.corriendo) return;
    let raf = 0;
    let ultimo = performance.now();
    let ultimoUi = 0;
    const cuadro = (ahora: number) => {
      raf = requestAnimationFrame(cuadro);
      const m = motor.current;
      const c = capa.current;
      if (!m || !c) return;
      const dt = Math.min(1, (ahora - ultimo) / 1000); // si los cuadros son lentos el reloj sigue al tiempo real
      ultimo = ahora;
      m.avanzar(dt * uiRef.current.velocidad);
      c.cuadro(dt, ahora / 1000);
      if (ahora - ultimoUi > 250) {
        ultimoUi = ahora;
        c.actualizarEstado();
        const n = m.nivelesPorPunto();
        const clave = JSON.stringify(n);
        if (clave !== niveles.current) {
          niveles.current = clave;
          onNivelesRef.current(n);
        }
        const fin = m.t >= m.duracionS() + 1800;
        leerMotor(fin ? { corriendo: false, terminado: true } : {});
      }
    };
    // Con la pestaña oculta no se anima: se retoma al volver (sin saltos de tiempo)
    const visibilidad = () => {
      cancelAnimationFrame(raf);
      if (document.visibilityState === "visible") {
        ultimo = performance.now();
        raf = requestAnimationFrame(cuadro);
      }
    };
    document.addEventListener("visibilitychange", visibilidad);
    if (document.visibilityState === "visible") raf = requestAnimationFrame(cuadro);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", visibilidad);
    };
  }, [ui.corriendo, leerMotor]);

  // Mapa
  const alMapaListo = useCallback(
    (map: MapLibre) => {
      mapa.current = map;
      if (process.env.NODE_ENV !== "production") (window as unknown as { __drenaMap?: MapLibre }).__drenaMap = map; // para depurar en dev
      montar();
      return () => {
        capa.current?.destruir();
        capa.current = null;
        mapa.current = null;
      };
    },
    [montar],
  );

  const reiniciar = useCallback(() => {
    motor.current?.reiniciar();
    niveles.current = "";
    onNivelesRef.current({});
    serie.current = { id: null, puntos: [] };
    capa.current?.actualizarEstado();
    capa.current?.cuadro(0, 0);
    leerMotor({ terminado: false });
  }, [leerMotor]);

  const setLluviaPico = useCallback(
    (mmh: number) => {
      const m = motor.current;
      if (m) m.factorLluvia = mmh / picoEscenario(m.scenario);
      leerMotor({ lluviaPico: mmh });
    },
    [leerMotor],
  );

  return {
    ui,
    seleccion,
    alMapaListo,
    alternar: () => {
      if (ui.terminado) reiniciar(); // al terminar, ▶ vuelve a empezar
      parche({ corriendo: !ui.corriendo || ui.terminado });
    },
    setVelocidad: (velocidad: Velocidad) => parche({ velocidad }),
    setLluviaPico,
    reiniciar,
    /** Ids de las rejillas de la red, con su comuna (para los botones del panel). */
    rejillas: (): { id: string; comuna: string | null }[] => motor.current?.grafo.sumideros.map((s) => ({ id: s.id, comuna: s.comuna })) ?? [],
    /** Estado efectivo de una rejilla (operador, observado, escenario o limpia). */
    estadoDe: (id: string): EstadoRejilla | null => {
      const m = motor.current;
      const i = m?.idx.get(id);
      return m && i !== undefined ? m.estadoRejilla(i) : null;
    },
  };
}

export type Flujo = ReturnType<typeof useFlujo>;

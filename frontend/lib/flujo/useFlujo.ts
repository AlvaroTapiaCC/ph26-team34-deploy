"use client";

// Une el motor, la capa del mapa y el reloj. Dibuja con requestAnimationFrame (se pausa si la pestaña no está visible);
// el cálculo avanza con ▶ (parte solo al cargar la red). En pausa el trazo se congela, pero los cambios de rejilla se ven al instante.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LngLat, ScenarioId } from "../data";
import type { MapLibre } from "../../components/map/maplibre";
import { montarCapaFlujo, type CapaFlujo } from "./capaMapa";
import { FLUJO_CONFIG, picoEscenario, type EstadoRejilla } from "./config";
import { fuenteSimulada, type FuenteObservaciones } from "./fuentes";
import { construirGrafo, distM, type Grafo } from "./grafo";
import { MotorFlujo, type Lecturas } from "./motor";

export type Velocidad = (typeof FLUJO_CONFIG.velocidades)[number];

export interface UiFlujo {
  cargado: boolean;
  error: boolean;
  corriendo: boolean;
  velocidad: Velocidad;
  /** Segundos de cálculo desde el último reinicio. */
  t: number;
  /** Lluvia supuesta (mm/h), la del slider. */
  lluviaMmH: number;
  lecturas: Lecturas;
  /** Rejilla elegida en el mapa: su estado y si acumula agua (estimado); null si no hay ninguna elegida. */
  elegida: { id: string; nombre: string; estado: EstadoRejilla; conAgua: boolean } | null;
  /** Rejillas tapadas (estado efectivo) y total, por comuna ("Todas" incluida). */
  tapadas: Record<string, number>;
  total: Record<string, number>;
  /** Caja de la red de calles con flujo (para encuadrar la vista en el agua). */
  caja: [LngLat, LngLat] | null;
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

const LECTURAS0: Lecturas = { desbordados: 0, desbordadosPorComuna: {} };

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
  fuente?: FuenteObservaciones;
  /** Muestra u oculta las capas del flujo en el mapa. */
  visible?: boolean;
}) {
  const { scenario, puntos, estados } = opts;
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
    lluviaMmH: picoEscenario(scenario),
    lecturas: LECTURAS0,
    elegida: null,
    tapadas: {},
    total: {},
    caja: null,
  }));
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const motor = useRef<MotorFlujo | null>(null);
  const capa = useRef<CapaFlujo | null>(null);
  const mapa = useRef<MapLibre>(null);
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

  const parche = useCallback((p: Partial<UiFlujo>) => setUi((u) => ({ ...u, ...p })), []);

  /** Nombre legible de una rejilla: su calle (OSM) y el punto del ranking más cercano, si está a menos de 250 m. */
  const nombreRejilla = useCallback((i: number) => {
    const m = motor.current!;
    const s = m.grafo.sumideros[i];
    const calle = s.tramo !== null ? m.grafo.tramos[s.tramo].nombre : null;
    let mejor: PuntoNombrado | null = null;
    let d = 250;
    for (const p of puntosRef.current) {
      const dp = distM(p.coord, s.coord);
      if (dp < d) {
        d = dp;
        mejor = p;
      }
    }
    return calle ?? (mejor ? `Cerca de ${mejor.nombre}` : `Rejilla ${s.id}`);
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
      const i = sel !== null ? m.idx.get(sel) : undefined;
      const elegida: UiFlujo["elegida"] =
        i !== undefined ? { id: m.grafo.sumideros[i].id, nombre: nombreRejilla(i), estado: m.estadoRejilla(i), conAgua: m.desborda(i) } : null;
      setUi((x) => ({ ...x, t: m.t, lluviaMmH: m.intensidadMmH, lecturas: lect, elegida, tapadas, total, ...extra }));
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
        const xs = g.tramos.flatMap((t) => [t.coords[0][0], t.coords[t.coords.length - 1][0]]);
        const ys = g.tramos.flatMap((t) => [t.coords[0][1], t.coords[t.coords.length - 1][1]]);
        const caja: [LngLat, LngLat] = [
          [Math.min(...xs), Math.min(...ys)],
          [Math.max(...xs), Math.max(...ys)],
        ];
        parche({ cargado: true, error: false, caja, corriendo: true }); // parte sola: el agua se ve apenas abre la página
        montar();
      })
      .catch(() => vivo && parche({ error: true }));
    return () => {
      vivo = false;
    };
  }, [montar, parche]);

  // Escenario y puntos del ranking: vuelve al inicio y la lluvia parte de la máxima del escenario
  useEffect(() => {
    const m = motor.current;
    if (!m) return;
    m.asociarPuntos(JSON.parse(puntosKey).map(([id, coord]: [string, LngLat]) => ({ id, coord })));
    m.setEscenario(scenario);
    m.intensidadMmH = picoEscenario(scenario);
    capa.current?.actualizarEstado();
    leerMotor();
  }, [scenario, puntosKey, ui.cargado, leerMotor]);

  // Estados de rejilla del operador: se aplican al instante, también con el flujo en pausa
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

  // Dibujo: un cuadro por requestAnimationFrame; el cálculo avanza solo con ▶
  useEffect(() => {
    if (!ui.cargado) return;
    let raf = 0;
    let ultimo = performance.now();
    let ultimoUi = 0;
    const cuadro = (ahora: number) => {
      raf = requestAnimationFrame(cuadro);
      const m = motor.current;
      const c = capa.current;
      if (!m || !c) return;
      const dt = Math.min(0.1, (ahora - ultimo) / 1000);
      ultimo = ahora;
      const u = uiRef.current;
      if (u.corriendo) m.avanzar(dt * u.velocidad);
      c.cuadro(u.corriendo ? dt : 0, ahora / 1000);
      if (u.corriendo && ahora - ultimoUi > 250) {
        ultimoUi = ahora;
        c.actualizarEstado();
        leerMotor();
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
  }, [ui.cargado, leerMotor]);

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
    capa.current?.actualizarEstado();
    leerMotor();
  }, [leerMotor]);

  const setLluvia = useCallback(
    (mmh: number) => {
      const m = motor.current;
      if (m) m.intensidadMmH = mmh;
      leerMotor({ lluviaMmH: mmh });
    },
    [leerMotor],
  );

  return {
    ui,
    seleccion,
    alMapaListo,
    alternar: () => parche({ corriendo: !uiRef.current.corriendo }),
    reproducir: (velocidad?: Velocidad) => parche({ corriendo: true, ...(velocidad ? { velocidad } : {}) }),
    setVelocidad: (velocidad: Velocidad) => parche({ velocidad }),
    setLluvia,
    reiniciar,
    seleccionar: setSeleccion,
    /** Anillo breve sobre una rejilla (al cambiar su estado). */
    pulsar: (id: string) => capa.current?.pulsar(id),
    /** El mapa de MapLibre (para la cámara del recorrido). */
    mapa: (): MapLibre | null => mapa.current,
    /** Ids de las rejillas de la red, con su comuna (para los botones del panel). */
    rejillas: (): { id: string; comuna: string | null }[] => motor.current?.grafo.sumideros.map((s) => ({ id: s.id, comuna: s.comuna })) ?? [],
    /** Estado efectivo de una rejilla (operador, observado, escenario o limpia). */
    estadoDe: (id: string): EstadoRejilla | null => {
      const m = motor.current;
      const i = m?.idx.get(id);
      return m && i !== undefined ? m.estadoRejilla(i) : null;
    },
    /** Rejilla del recorrido guiado: tapada deja agua fuera de la calle; con su posición y la calle hacia donde se va. */
    candidataRecorrido: (cerca: LngLat[]): { id: string; coord: LngLat; calle: string | null; destino: LngLat } | null => {
      const m = motor.current;
      if (!m) return null;
      const i = m.candidataRecorrido(cerca);
      if (i === null) return null;
      const s = m.grafo.sumideros[i];
      const t = s.tramo !== null ? m.grafo.tramos[s.tramo] : null;
      const sig = t && t.sig !== null ? m.grafo.tramos[t.sig] : null;
      const destino = sig ? sig.coords[sig.coords.length - 1] : t ? t.coords[t.coords.length - 1] : s.coord;
      return { id: s.id, coord: s.coord, calle: sig?.nombre ?? t?.nombre ?? null, destino };
    },
  };
}

export type Flujo = ReturnType<typeof useFlujo>;

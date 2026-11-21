"use client";

// Une el motor, la capa del mapa y el reloj. Corre con requestAnimationFrame y se pausa si la pestaña no está visible.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LngLat, ScenarioId } from "../data";
import type { MapLibre } from "../../components/map/maplibre";
import { montarCapaFlujo, type CapaFlujo } from "./capaMapa";
import { FLUJO_CONFIG, type NivelAgua } from "./config";
import { fuenteSimulada, type FuenteObservaciones } from "./fuentes";
import { construirGrafo, type Grafo } from "./grafo";
import { MotorFlujo } from "./motor";

export type ModoFlujo = "escenario" | "tiempo_real";
export type Velocidad = (typeof FLUJO_CONFIG.velocidades)[number];

export interface UiFlujo {
  cargado: boolean;
  error: boolean;
  corriendo: boolean;
  modo: ModoFlujo;
  velocidad: Velocidad;
  /** Segundos simulados desde el inicio del escenario. */
  t: number;
  /** Hora real en que arrancó la simulación (para el reloj del modo tiempo real). */
  inicioMs: number;
  lluviaMmH: number;
  desbordados: number;
  terminado: boolean;
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

const UI0: UiFlujo = { cargado: false, error: false, corriendo: false, modo: "escenario", velocidad: 10, t: 0, inicioMs: 0, lluviaMmH: 0, desbordados: 0, terminado: false };

export function useFlujo(opts: {
  scenario: ScenarioId;
  puntos: { id: string; coord: LngLat }[];
  /** Nivel de agua por punto del ranking cada vez que cambia (alimenta la tabla y el héroe). */
  onNiveles: (n: Record<string, NivelAgua>) => void;
  fuente?: FuenteObservaciones;
  /** Muestra u oculta las capas del flujo en el mapa. */
  visible?: boolean;
}) {
  const { scenario, puntos, onNiveles } = opts;
  const visible = opts.visible ?? true;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const fuente = opts.fuente ?? fuenteSimulada;
  const [ui, setUi] = useState<UiFlujo>(UI0);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const motor = useRef<MotorFlujo | null>(null);
  const capa = useRef<CapaFlujo | null>(null);
  const mapa = useRef<MapLibre>(null);
  const niveles = useRef("");
  const onNivelesRef = useRef(onNiveles);
  onNivelesRef.current = onNiveles;
  const puntosKey = useMemo(() => JSON.stringify(puntos), [puntos]);

  const parche = useCallback((p: Partial<UiFlujo>) => setUi((u) => ({ ...u, ...p })), []);

  const montar = useCallback(() => {
    if (capa.current || !mapa.current || !motor.current) return;
    capa.current = montarCapaFlujo(mapa.current, motor.current);
    capa.current.setVisible(visibleRef.current);
    capa.current.actualizarEstado();
  }, []);

  useEffect(() => {
    capa.current?.setVisible(visible);
  }, [visible]);

  // Grafo -> motor
  useEffect(() => {
    let vivo = true;
    cargarGrafo()
      .then((g) => {
        if (!vivo) return;
        motor.current = new MotorFlujo(g);
        parche({ cargado: true, error: false });
        montar();
      })
      .catch(() => vivo && parche({ error: true }));
    return () => {
      vivo = false;
    };
  }, [montar, parche]);

  // Escenario y puntos del ranking
  useEffect(() => {
    const m = motor.current;
    if (!m) return;
    m.asociarPuntos(JSON.parse(puntosKey));
    m.setEscenario(scenario);
    niveles.current = "";
    onNivelesRef.current({});
    capa.current?.actualizarEstado();
    parche({ t: 0, terminado: false, desbordados: 0, lluviaMmH: 0, inicioMs: Date.now() });
  }, [scenario, puntosKey, ui.cargado, parche]);

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
      const u = uiRef.current;
      const factor = u.modo === "tiempo_real" ? 1 : u.velocidad;
      m.avanzar(dt * factor);
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
        setUi((x) => ({ ...x, t: m.t, desbordados: m.desbordados(), lluviaMmH: m.lluviaMmH(m.grafo.tramos[0]?.mid ?? [0, 0]), corriendo: fin ? false : x.corriendo, terminado: fin }));
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
  }, [ui.corriendo]);

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
    capa.current?.actualizarEstado();
    capa.current?.cuadro(0, 0);
    parche({ t: 0, terminado: false, desbordados: 0, lluviaMmH: 0, inicioMs: Date.now() });
  }, [parche]);

  return {
    ui,
    alMapaListo,
    alternar: () => {
      if (ui.terminado) reiniciar(); // al terminar, ▶ vuelve a empezar
      parche({ corriendo: !ui.corriendo || ui.terminado });
    },
    setVelocidad: (velocidad: Velocidad) => parche({ velocidad }),
    setModo: (modo: ModoFlujo) => {
      reiniciar();
      parche({ modo });
    },
    reiniciar,
  };
}

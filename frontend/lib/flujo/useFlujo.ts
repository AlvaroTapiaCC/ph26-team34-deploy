"use client";

// Une el motor, la capa del mapa y el reloj. El cálculo corre en un Web Worker (remoto.ts) y avanza con ▶ (parte solo al
// cargar la red); el trazo se dibuja con requestAnimationFrame (se pausa si la pestaña no está visible). En pausa el
// trazo se congela, pero los cambios de rejilla se ven al instante.
//
// La red cubre Providencia, Ñuñoa y Las Condes en teselas (public/data/flujo/): se cargan las que tocan lo visible y las
// que están aguas arriba de esas, y más al mover el mapa.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LngLat, ScenarioId } from "../data";
import type { MapLibre } from "../../components/map/maplibre";
import { montarCapaFlujo, type CapaFlujo } from "./capaMapa";
import { FLUJO_CONFIG, picoEscenario, type EstadoRejilla } from "./config";
import { fuenteSimulada, type FuenteObservaciones } from "./fuentes";
import { distM, teselasNecesarias, type IndiceFlujo } from "./grafo";
import type { Lecturas } from "./motor";
import { MotorRemoto } from "./remoto";

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
  /** Caja con la que abre el mapa (la zona del MUT; la red llega a las 3 comunas). */
  caja: [LngLat, LngLat] | null;
  /** Red completa (indice.json) y lo cargado: tramos, rejillas y teselas. */
  red: { tramos: number; sumideros: number; teselas: number; tramosCargados: number; sumiderosCargados: number; teselasCargadas: number } | null;
}

const BASE = "/data/flujo/";
let indicePromesa: Promise<IndiceFlujo> | null = null;
function cargarIndice(): Promise<IndiceFlujo> {
  indicePromesa ??= fetch(BASE + "indice.json")
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<IndiceFlujo>;
    })
    .catch((e) => {
      indicePromesa = null;
      throw e;
    });
  return indicePromesa;
}
// Texto de cada tesela (se guarda entre montajes: volver a la vista no vuelve a pedirlas)
const textos = new Map<string, Promise<string>>();
function textoTesela(archivo: string): Promise<string> {
  let p = textos.get(archivo);
  if (!p) {
    p = fetch(BASE + archivo).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    });
    p.catch(() => textos.delete(archivo));
    textos.set(archivo, p);
  }
  return p;
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
  /** Solo el agua (sin las rejillas de la red): para las vistas que no son la simulación. */
  soloAgua?: boolean;
  /** Pide la red (teselas de public/data/flujo/) solo cuando hace falta: al abrir la simulación o encender la capa. Por defecto, sí. */
  activo?: boolean;
}) {
  const { scenario, puntos, estados } = opts;
  const visible = opts.visible ?? true;
  const activo = opts.activo ?? true;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const soloAgua = opts.soloAgua ?? false;
  const soloAguaRef = useRef(soloAgua);
  soloAguaRef.current = soloAgua;
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
    red: null,
  }));
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const motor = useRef<MotorRemoto | null>(null);
  const indice = useRef<IndiceFlujo | null>(null);
  const pedidas = useRef(new Set<string>());
  const [versionAsociacion, setVersionAsociacion] = useState(0);
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
    const calle = s.tramo !== null ? (m.grafo.tramos[s.tramo]?.nombre ?? null) : null;
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
      const ix = indice.current;
      const red: UiFlujo["red"] = ix
        ? { tramos: ix.tramos, sumideros: ix.sumideros, teselas: Object.keys(ix.teselas).length, tramosCargados: m.grafo.lista.length, sumiderosCargados: m.grafo.sumideros.length, teselasCargadas: m.grafo.teselas.size }
        : null;
      setUi((x) => ({ ...x, t: m.t, lluviaMmH: m.intensidadMmH, lecturas: lect, elegida, tapadas, total, red, ...extra }));
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
    capa.current.setVisible(visibleRef.current, soloAguaRef.current);
    capa.current.setSeleccion(seleccionRef.current);
    capa.current.agregar();
  }, []);

  /** Pide las teselas que faltan para ver el mapa (o la zona inicial, si todavía no hay mapa) y las suma al motor. */
  const cargarVisibles = useCallback(async () => {
    const ix = indice.current;
    const m = motor.current;
    if (!ix || !m) return;
    const map = mapa.current;
    let caja: [LngLat, LngLat] = ix.caja_inicial;
    if (map) {
      const b = map.getBounds();
      caja = [
        [b.getWest(), b.getSouth()],
        [b.getEast(), b.getNorth()],
      ];
    }
    const faltan = teselasNecesarias(ix, caja).filter((k) => !pedidas.current.has(k));
    if (!faltan.length) return;
    faltan.forEach((k) => pedidas.current.add(k));
    const t0 = performance.now();
    const textosT = await Promise.all(faltan.map((k) => textoTesela(ix.teselas[k].archivo).catch(() => null)));
    if (motor.current !== m) return; // se desmontó mientras llegaban
    faltan.forEach((k, j) => {
      const texto = textosT[j];
      if (texto === null) pedidas.current.delete(k); // se reintenta en el próximo movimiento
      else m.agregarTesela(k, texto);
    });
    capa.current?.agregar();
    performance.measure("flujo:teselas", { start: t0, detail: { teselas: faltan.length, tramos: m.grafo.lista.length } });
  }, []);

  useEffect(() => {
    capa.current?.setVisible(visible, soloAgua);
  }, [visible, soloAgua]);

  useEffect(() => {
    capa.current?.setSeleccion(seleccion);
    leerMotor();
  }, [seleccion, leerMotor]);

  // Índice -> motor (en el worker) -> primeras teselas
  useEffect(() => {
    if (!activo || motor.current) return;
    let vivo = true;
    const t0 = performance.now();
    cargarIndice()
      .then(async (ix) => {
        if (!vivo) return;
        indice.current = ix;
        const m = new MotorRemoto(ix.tramos, ix.sumideros);
        motor.current = m;
        m.setEstadosManuales(estadosRef.current);
        let asociacion = m.sumideroIdsPorPunto;
        m.onFoto = () => {
          capa.current?.actualizarEstado();
          if (m.sumideroIdsPorPunto !== asociacion) {
            asociacion = m.sumideroIdsPorPunto;
            setVersionAsociacion((v) => v + 1);
          }
          leerMotor();
        };
        montar();
        await cargarVisibles();
        if (!vivo) return;
        performance.measure("flujo:carga", { start: t0, detail: { tramos: m.grafo.lista.length, teselas: m.grafo.teselas.size } });
        parche({ cargado: true, error: false, caja: ix.caja_inicial, corriendo: true }); // parte sola: el agua se ve apenas abre la página
      })
      .catch(() => vivo && parche({ error: true }));
    return () => {
      vivo = false;
    };
  }, [activo, montar, parche, cargarVisibles, leerMotor]);

  // Al terminar de mover el mapa, las teselas que faltan para lo nuevo que se ve
  useEffect(() => {
    const map = mapa.current;
    if (!ui.cargado || !map) return;
    const alMover = () => void cargarVisibles();
    map.on("moveend", alMover);
    alMover();
    return () => {
      map.off("moveend", alMover);
    };
  }, [ui.cargado, cargarVisibles]);

  // El worker se cierra al desmontar
  useEffect(
    () => () => {
      motor.current?.destruir();
      motor.current = null;
    },
    [],
  );

  // Reloj del motor: corre en el worker según ▶ y la velocidad; con la pestaña oculta, se detiene
  useEffect(() => {
    motor.current?.setReloj(ui.corriendo, ui.velocidad);
  }, [ui.corriendo, ui.velocidad, ui.cargado]);

  // Escenario y puntos del ranking: vuelve al inicio y la lluvia parte de la máxima del escenario
  useEffect(() => {
    const m = motor.current;
    if (!m) return;
    m.asociarPuntos(JSON.parse(puntosKey).map(([id, coord]: [string, LngLat]) => ({ id, coord })));
    m.setEscenario(scenario, picoEscenario(scenario));
    leerMotor();
  }, [scenario, puntosKey, ui.cargado, leerMotor]);

  useEffect(() => {
    motor.current?.setFuente(fuente.id);
  }, [fuente.id, ui.cargado]);

  // Estados de rejilla del operador: se aplican al instante, también con el flujo en pausa
  useEffect(() => {
    const m = motor.current;
    if (!m) return;
    m.setEstadosManuales(estados);
    capa.current?.actualizarEstado(); // las rejillas cambian al instante; el agua, cuando llega la foto del motor
    leerMotor();
  }, [estados, fuente.id, ui.cargado, leerMotor]);

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
  }, [fuente, scenario, ui.cargado, puntosKey, versionAsociacion]);

  // Dibujo: un cuadro por requestAnimationFrame (el trazo, las columnas y la flecha). El cálculo avanza en el worker
  // y su estado llega con cada foto (onFoto).
  useEffect(() => {
    if (!ui.cargado) return;
    let raf = 0;
    let ultimo = performance.now();
    const cuadro = (ahora: number) => {
      raf = requestAnimationFrame(cuadro);
      const c = capa.current;
      if (!c) return;
      const dt = Math.min(0.1, (ahora - ultimo) / 1000);
      ultimo = ahora;
      c.cuadro(uiRef.current.corriendo ? dt : 0, ahora / 1000);
    };
    // Con la pestaña oculta no se anima ni se calcula: se retoma al volver (sin saltos de tiempo)
    const visibilidad = () => {
      cancelAnimationFrame(raf);
      motor.current?.setOculto(document.visibilityState !== "visible");
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
  }, [ui.cargado]);

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
  }, []);

  const setLluvia = useCallback(
    (mmh: number) => {
      motor.current?.setLluvia(mmh);
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
    /** Ids de las rejillas de la red cargada, con su comuna (para los botones del panel). */
    rejillas: (): { id: string; comuna: string | null }[] => motor.current?.grafo.sumideros.map((s) => ({ id: s.id, comuna: s.comuna })) ?? [],
    /** Estado efectivo de una rejilla (operador, observado, escenario o limpia). */
    estadoDe: (id: string): EstadoRejilla | null => {
      const m = motor.current;
      const i = m?.idx.get(id);
      return m && i !== undefined ? m.estadoRejilla(i) : null;
    },
    /** Rejilla del recorrido guiado: tapada deja agua fuera de la calle; con su posición y la calle hacia donde se va. */
    candidataRecorrido: async (cerca: LngLat[]): Promise<{ id: string; coord: LngLat; calle: string | null; destino: LngLat } | null> => {
      const m = motor.current;
      if (!m) return null;
      const i = await m.candidataRecorrido(cerca);
      if (i === null || !m.grafo.sumideros[i]) return null;
      const s = m.grafo.sumideros[i];
      const t = s.tramo !== null ? (m.grafo.tramos[s.tramo] ?? null) : null;
      const sig = t && t.sig !== null ? (m.grafo.tramos[t.sig] ?? null) : null;
      const destino = sig ? sig.coords[sig.coords.length - 1] : t ? t.coords[t.coords.length - 1] : s.coord;
      return { id: s.id, coord: s.coord, calle: sig?.nombre ?? t?.nombre ?? null, destino };
    },
  };
}

export type Flujo = ReturnType<typeof useFlujo>;

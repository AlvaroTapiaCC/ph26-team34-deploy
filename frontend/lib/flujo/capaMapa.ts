// Dibujo del flujo estimado en MapLibre, con un código de color estricto:
// - agua circulando: AZUL (#2F6FDE a #0B3D91 según el caudal), más gruesa cuanto más caudal, con un trazo animado que
//   avanza por la calle a la velocidad de su pendiente y un brillo suave. Las calles sin agua relevante no se pintan;
// - agua que no cabe en la calle: ACCENT, solo en ese tramo y el siguiente, con una columna 3D (volumen que no entró
//   a la rejilla) y una flecha animada hacia donde se va;
// - rejillas: círculo de 6 px con el borde según su estado (tapada, rellena en accent); el ícono, solo de cerca.
// El estado de tramos y rejillas se actualiza unas 4 veces por segundo (feature-state); el trazo, la flecha y las
// columnas, en cada cuadro (requestAnimationFrame). No hay partículas: el trazo animado es mucho más liviano.
import type { MapLibre } from "../../components/map/maplibre";
import { ESTADOS, FLUJO_CONFIG, type EstadoRejilla } from "./config";
import { puntoEnTramo } from "./grafo";
import type { MotorFlujo } from "./motor";

const SRC = { tramos: "flujo-tramos", sum: "flujo-sum", flecha: "flujo-flecha-src", columnas: "flujo-columnas-src", pop: "flujo-pop-src" };
const TRAZOS = ["flujo-trazo-0", "flujo-trazo-1", "flujo-trazo-2"];
const LAYERS = ["flujo-brillo", "flujo-linea", ...TRAZOS, "flujo-columnas", "flujo-rej", "flujo-rej-tap", "flujo-rej-ico", "flujo-sel", "flujo-pop", "flujo-hit", "flujo-flecha"];
const fc = (features: unknown[]) => ({ type: "FeatureCollection", features });

// Patrón del trazo animado: cada paso corre un poco el guion a lo largo de la línea (dibujada de aguas arriba a aguas abajo)
const PATRON = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
];

export interface CapaFlujo {
  /** Estado de tramos y rejillas (llamar unas 4 veces por segundo y tras cambiar un estado). */
  actualizarEstado(): void;
  /** Un cuadro de animación. `dtS` y `tS` son segundos reales. */
  cuadro(dtS: number, tS: number): void;
  setVisible(v: boolean): void;
  setSeleccion(id: string | null): void;
  /** Animación breve sobre una rejilla (al cambiar su estado). */
  pulsar(id: string): void;
  destruir(): void;
}

type Img = { width: number; height: number; data: Uint8ClampedArray };
const PR = 2; // densidad de los íconos (se pasan con pixelRatio 2)
const M_LAT = 110_540;
const mLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

function lienzo(n: number, dibujar: (g: CanvasRenderingContext2D) => void): Img {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  dibujar(g);
  return { width: n, height: n, data: g.getImageData(0, 0, n, n).data };
}

function flechaImagen(): Img {
  return lienzo(48, (g) => {
    g.translate(24, 24);
    g.fillStyle = FLUJO_CONFIG.colores.desborde;
    g.strokeStyle = "#FFFFFF";
    g.lineWidth = 4;
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(0, -18); // apunta al norte; el rumbo la gira
    g.lineTo(13, 12);
    g.lineTo(0, 5);
    g.lineTo(-13, 12);
    g.closePath();
    g.stroke();
    g.fill();
  });
}

/** Ícono de rejilla (solo de cerca): cuadrado con barras; tapada, en accent con una ✕. */
function rejillaImagen(estado: EstadoRejilla): Img {
  const n = 18 * PR;
  return lienzo(n, (g) => {
    g.scale(PR, PR);
    g.beginPath();
    g.roundRect(1.5, 1.5, 15, 15, 3.5);
    g.fillStyle = estado === "tapada" ? FLUJO_CONFIG.colores.desborde : "#FFFFFF";
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = estado === "tapada" ? "#FFFFFF" : estado === "parcial" ? "#1B1B1B" : FLUJO_CONFIG.colores.agua;
    g.stroke();
    g.lineCap = "round";
    if (estado === "tapada") {
      g.strokeStyle = "#FFFFFF";
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(5.5, 5.5);
      g.lineTo(12.5, 12.5);
      g.moveTo(12.5, 5.5);
      g.lineTo(5.5, 12.5);
      g.stroke();
    } else {
      g.strokeStyle = estado === "parcial" ? "#1B1B1B" : "#9A9A96";
      g.lineWidth = 1.3;
      g.beginPath();
      for (const x of [6, 9, 12]) {
        g.moveTo(x, 4.5);
        g.lineTo(x, estado === "parcial" ? 8.5 : 13.5);
      }
      g.stroke();
    }
  });
}

/** Cuadrado de `lado` metros alrededor de un punto (para la columna 3D). */
function cuadrado([x, y]: [number, number], lado: number) {
  const dx = lado / 2 / mLon(y);
  const dy = lado / 2 / M_LAT;
  return [
    [
      [x - dx, y - dy],
      [x + dx, y - dy],
      [x + dx, y + dy],
      [x - dx, y + dy],
      [x - dx, y - dy],
    ],
  ];
}

export function montarCapaFlujo(map: MapLibre, motor: MotorFlujo, opts: { onClickSumidero: (id: string) => void }): CapaFlujo {
  const cfg = FLUJO_CONFIG;
  const { tramos, sumideros } = motor.grafo;
  const { agua, aguaHondo, brillo, desborde } = cfg.colores;
  const logMin = Math.log1p(cfg.caudalMinimoLs);
  const logMax = Math.log1p(cfg.caudalGrosorMaxLs);

  map.addSource(SRC.tramos, {
    type: "geojson",
    promoteId: "id",
    data: fc(tramos.map((t) => ({ type: "Feature", properties: { id: t.id, vc: t.vc }, geometry: { type: "LineString", coordinates: t.coords } }))),
  });
  map.addSource(SRC.sum, {
    type: "geojson",
    promoteId: "id",
    data: fc(sumideros.map((s, i) => ({ type: "Feature", properties: { id: s.id, est: motor.estadoRejilla(i) }, geometry: { type: "Point", coordinates: s.coord } }))),
  });
  map.addSource(SRC.flecha, { type: "geojson", data: fc([]) });
  map.addSource(SRC.columnas, { type: "geojson", data: fc([]) });
  map.addSource(SRC.pop, { type: "geojson", data: fc([]) });
  if (!map.hasImage("flujo-flecha")) map.addImage("flujo-flecha", flechaImagen());
  for (const e of ESTADOS) if (!map.hasImage(`rejilla-${e}`)) map.addImage(`rejilla-${e}`, rejillaImagen(e), { pixelRatio: PR });

  // Grosor según el caudal (escala logarítmica); 0 bajo el caudal mínimo: esas calles no se pintan
  const qn = ["coalesce", ["feature-state", "qn"], 0];
  const conAgua = ["case", [">", ["coalesce", ["feature-state", "h"], 0], 0.05], 1, 0];
  const ancho = ["interpolate", ["linear"], qn, 0, 0, 0.01, 1.2, 1, 6];
  const anchoZoom = (k: number) => ["interpolate", ["linear"], ["zoom"], 11, ["*", ancho, 0.55 * k], 14, ["*", ancho, k], 17, ["*", ancho, 2.2 * k]];
  const visibleSiAgua = (o: number) => ["case", [">", qn, 0], o, 0];

  map.addLayer({
    id: "flujo-brillo",
    type: "line",
    source: SRC.tramos,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["case", ["==", conAgua, 1], desborde, brillo], "line-width": anchoZoom(3), "line-blur": 6, "line-opacity": visibleSiAgua(0.28) },
  });
  map.addLayer({
    id: "flujo-linea",
    type: "line",
    source: SRC.tramos,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["==", conAgua, 1], desborde, ["interpolate-lab", ["linear"], qn, 0, agua, 1, aguaHondo]],
      "line-width": anchoZoom(1),
      "line-opacity": visibleSiAgua(0.92),
    },
  });
  // Trazo animado: tres capas (calles lentas, medias y rápidas) que avanzan a distinta velocidad
  TRAZOS.forEach((id, k) =>
    map.addLayer({
      id,
      type: "line",
      source: SRC.tramos,
      filter: ["==", ["get", "vc"], k],
      paint: {
        "line-color": ["case", ["==", conAgua, 1], "#FFE0D6", "#EAF1FF"],
        "line-width": anchoZoom(0.45),
        "line-opacity": visibleSiAgua(0.9),
        "line-dasharray": PATRON[0],
      },
    }),
  );
  map.addLayer({
    id: "flujo-columnas",
    type: "fill-extrusion",
    source: SRC.columnas,
    paint: { "fill-extrusion-color": desborde, "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.85 },
  });
  // Rejillas: círculo de 6 px; el borde dice el estado (limpia: azul; parcial: negro grueso; tapada: rellena en accent)
  const est = ["get", "est"];
  const circuloRejilla = {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 14, 3, 16.9, 5],
    "circle-color": ["match", est, "tapada", desborde, "parcial", "#D6D6D2", "#FFFFFF"],
    "circle-stroke-color": ["match", est, "tapada", "#FFFFFF", "parcial", "#1B1B1B", agua],
    "circle-stroke-width": ["match", est, "parcial", 2, 1.5],
  };
  map.addLayer({ id: "flujo-rej", type: "circle", source: SRC.sum, minzoom: cfg.zoomRejillas, maxzoom: cfg.zoomIconos, paint: circuloRejilla });
  map.addLayer({ id: "flujo-rej-tap", type: "circle", source: SRC.sum, maxzoom: cfg.zoomRejillas, filter: ["==", est, "tapada"], paint: circuloRejilla });
  map.addLayer({
    id: "flujo-rej-ico",
    type: "symbol",
    source: SRC.sum,
    minzoom: cfg.zoomIconos,
    layout: { "icon-image": ["concat", "rejilla-", est], "icon-size": ["interpolate", ["linear"], ["zoom"], 17, 1, 19, 1.5], "icon-allow-overlap": true, "icon-ignore-placement": true },
  });
  map.addLayer({
    id: "flujo-sel",
    type: "circle",
    source: SRC.sum,
    filter: ["==", ["get", "id"], ""],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 17, 16], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#1B1B1B", "circle-stroke-width": 2 },
  });
  map.addLayer({
    id: "flujo-pop",
    type: "circle",
    source: SRC.pop,
    paint: { "circle-radius": ["get", "r"], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["get", "c"], "circle-stroke-width": 2.5, "circle-stroke-opacity": ["get", "o"] },
  });
  // Zona de clic más grande que el círculo (solo de cerca, donde las rejillas se distinguen)
  map.addLayer({ id: "flujo-hit", type: "circle", source: SRC.sum, minzoom: 13, paint: { "circle-radius": 11, "circle-color": "#000000", "circle-opacity": 0 } });
  map.addLayer({
    id: "flujo-flecha",
    type: "symbol",
    source: SRC.flecha,
    layout: {
      "icon-image": "flujo-flecha",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 17, 0.8],
      "icon-rotate": ["get", "rumbo"],
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
    paint: { "icon-opacity": ["get", "o"] },
  });

  // Con rejillas a pocos metros las zonas de clic se pisan: se elige la más cercana al cursor, no la de encima
  const alClic = (e: { point: { x: number; y: number }; features?: { properties: { id: string }; geometry: { coordinates: [number, number] } }[] }) => {
    let id: string | null = null;
    let mejor = Infinity;
    for (const f of e.features ?? []) {
      const p = map.project(f.geometry.coordinates);
      const d = Math.hypot(p.x - e.point.x, p.y - e.point.y);
      if (d < mejor) {
        mejor = d;
        id = f.properties.id;
      }
    }
    if (id) opts.onClickSumidero(id);
  };
  const entrar = () => (map.getCanvas().style.cursor = "pointer");
  const salir = () => (map.getCanvas().style.cursor = "");
  map.on("click", "flujo-hit", alClic);
  map.on("mouseenter", "flujo-hit", entrar);
  map.on("mouseleave", "flujo-hit", salir);

  // ---- Estado de tramos y rejillas ----
  const ultimoQ = new Float32Array(tramos.length).fill(-1);
  const ultimoH = new Float32Array(tramos.length).fill(-1);
  let ultimoEst = "";
  let conAguaIdx: number[] = []; // rejillas con agua fuera de la calle, de más a menos volumen

  function actualizarEstado() {
    for (const t of tramos) {
      const q = motor.q[t.id];
      const n = q < cfg.caudalMinimoLs ? 0 : Math.min(1, Math.max(0.01, (Math.log1p(q) - logMin) / (logMax - logMin)));
      const h = q > 0 ? motor.qExc[t.id] / q : 0;
      if (Math.abs(n - ultimoQ[t.id]) > 0.01 || Math.abs(h - ultimoH[t.id]) > 0.04) {
        ultimoQ[t.id] = n;
        ultimoH[t.id] = h;
        map.setFeatureState({ source: SRC.tramos, id: t.id }, { qn: n, h });
      }
    }
    // Estado de cada rejilla: va como propiedad del dato (los símbolos no leen feature-state en el layout)
    const est = sumideros.map((_, i) => motor.estadoRejilla(i));
    const clave = est.join();
    if (clave !== ultimoEst) {
      ultimoEst = clave;
      map.getSource(SRC.sum)?.setData(fc(sumideros.map((s, i) => ({ type: "Feature", properties: { id: s.id, est: est[i] }, geometry: { type: "Point", coordinates: s.coord } }))));
    }
    const lista: { i: number; v: number }[] = [];
    sumideros.forEach((_, i) => motor.desborda(i) && lista.push({ i, v: motor.volumen[i] }));
    lista.sort((a, b) => b.v - a.v);
    conAguaIdx = lista.slice(0, cfg.columnasMax).map((x) => x.i);
  }

  // ---- Animación (cada cuadro) ----
  const fase = [0, 0, 0];
  const pasoTrazo = [-1, -1, -1];
  let pop: { id: string; t0: number } | null = null;
  let reloj = 0;

  function cuadro(dtS: number, tS: number) {
    reloj = tS;
    // Trazo: cada capa avanza su patrón a su velocidad
    TRAZOS.forEach((id, k) => {
      fase[k] = (fase[k] + dtS * cfg.trazoPasosPorS[k]) % PATRON.length;
      const paso = Math.floor(fase[k]);
      if (paso !== pasoTrazo[k]) {
        pasoTrazo[k] = paso;
        map.setPaintProperty(id, "line-dasharray", PATRON[paso]);
      }
    });

    // Columnas: alto según el volumen que no entró a la rejilla, crecen al aparecer y respiran suavemente
    const respira = 1 + 0.08 * Math.sin(tS * 2.2);
    map.getSource(SRC.columnas)?.setData(
      fc(
        conAguaIdx.map((i) => {
          const alto = Math.min(cfg.columnaAltoMaxM, 6 + motor.volumen[i] * cfg.columnaMPorM3);
          return { type: "Feature", properties: { h: alto * respira }, geometry: { type: "Polygon", coordinates: cuadrado(sumideros[i].coord, cfg.columnaLadoM) } };
        }),
      ),
    );

    // Flecha: avanza por el tramo siguiente, hacia donde se va el agua
    const avance = (tS * 0.8) % 1;
    const flechas = conAguaIdx.slice(0, 20).flatMap((i) => {
      const s = sumideros[i];
      if (s.tramo === null) return [];
      let t = tramos[s.tramo];
      let m = s.pos * t.L + 12 + 30 * avance;
      if (m > t.L && t.sig !== null) {
        m -= t.L;
        t = tramos[t.sig];
      }
      const { coord, rumbo } = puntoEnTramo(t, m);
      return [{ type: "Feature", properties: { rumbo, o: avance < 0.85 ? 1 : (1 - avance) / 0.15 }, geometry: { type: "Point", coordinates: coord } }];
    });
    map.getSource(SRC.flecha)?.setData(fc(flechas));

    // Clic en una rejilla: un anillo que crece y se apaga
    if (pop) {
      const k = (tS - pop.t0) / 0.6;
      const i = motor.idx.get(pop.id);
      if (k >= 1 || i === undefined) {
        pop = null;
        map.getSource(SRC.pop)?.setData(fc([]));
      } else {
        const c = motor.estadoRejilla(i) === "tapada" ? desborde : "#1B1B1B";
        map.getSource(SRC.pop)?.setData(fc([{ type: "Feature", properties: { r: 6 + 22 * k, o: 1 - k, c }, geometry: { type: "Point", coordinates: sumideros[i].coord } }]));
      }
    }
  }

  return {
    actualizarEstado,
    cuadro,
    setVisible(v) {
      LAYERS.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", v ? "visible" : "none"));
    },
    setSeleccion(id) {
      if (map.getLayer("flujo-sel")) map.setFilter("flujo-sel", ["==", ["get", "id"], id ?? ""]);
    },
    pulsar(id) {
      pop = { id, t0: reloj };
    },
    destruir() {
      try {
        // Si el mapa ya se destruyó (cambio de vista), no queda nada que quitar
        if (!map.getStyle()) return;
        map.off("click", "flujo-hit", alClic);
        map.off("mouseenter", "flujo-hit", entrar);
        map.off("mouseleave", "flujo-hit", salir);
        LAYERS.forEach((id) => map.getLayer(id) && map.removeLayer(id));
        Object.values(SRC).forEach((id) => map.getSource(id) && map.removeSource(id));
      } catch {
        /* mapa ya removido */
      }
    },
  };
}

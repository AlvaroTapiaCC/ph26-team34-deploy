// Dibujo del flujo en MapLibre: trazo por tramo (grosor y color según el caudal), partículas que avanzan por las
// calles, pulso y flecha en los puntos que se desbordan. El estado de los tramos y sumideros se actualiza unas
// 4 veces por segundo (feature-state); las partículas, en cada cuadro (requestAnimationFrame).
import type { MapLibre } from "../../components/map/maplibre";
import { FLUJO_CONFIG } from "./config";
import { puntoEnTramo, type Tramo } from "./grafo";
import type { MotorFlujo } from "./motor";

const SRC = { tramos: "flujo-tramos", sum: "flujo-sum", part: "flujo-part", pulso: "flujo-pulso", flecha: "flujo-flecha-src" };
const LAYERS = ["flujo-red", "flujo-linea", "flujo-sumideros", "flujo-particulas", "flujo-pulso", "flujo-flecha"];
const fc = (features: unknown[]) => ({ type: "FeatureCollection", features });

export interface CapaFlujo {
  /** Estado de tramos y sumideros (llamar unas 4 veces por segundo). */
  actualizarEstado(): void;
  /** Un cuadro de animación: mueve las partículas y el pulso. `dtS` y `tS` son segundos reales. */
  cuadro(dtS: number, tS: number): void;
  setVisible(v: boolean): void;
  destruir(): void;
}

function flechaImagen(): { width: number; height: number; data: Uint8ClampedArray } {
  const n = 48;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  g.translate(n / 2, n / 2);
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
  return { width: n, height: n, data: g.getImageData(0, 0, n, n).data };
}

/** Posición a la fracción `f` (0..1) del largo del tramo, sin crear objetos. */
function enTramo(t: Tramo, f: number, out: [number, number]) {
  const total = t.cum[t.cum.length - 1];
  const d = f * total;
  let lo = 0;
  let hi = t.cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t.cum[m] <= d) lo = m;
    else hi = m;
  }
  const k = (d - t.cum[lo]) / (t.cum[hi] - t.cum[lo] || 1);
  out[0] = t.coords[lo][0] + (t.coords[hi][0] - t.coords[lo][0]) * k;
  out[1] = t.coords[lo][1] + (t.coords[hi][1] - t.coords[lo][1]) * k;
}

export function montarCapaFlujo(map: MapLibre, motor: MotorFlujo): CapaFlujo {
  const cfg = FLUJO_CONFIG;
  const { tramos, sumideros } = motor.grafo;
  const { agua, aguaClaro, desborde } = cfg.colores;

  const maxAcc = Math.max(1, ...tramos.map((t) => t.acc));
  map.addSource(SRC.tramos, {
    type: "geojson",
    promoteId: "id",
    data: fc(tramos.map((t) => ({ type: "Feature", properties: { id: t.id, an: Math.log1p(t.acc) / Math.log1p(maxAcc) }, geometry: { type: "LineString", coordinates: t.coords } }))),
  });
  map.addSource(SRC.sum, {
    type: "geojson",
    promoteId: "id",
    data: fc(sumideros.map((s) => ({ type: "Feature", properties: { id: s.id }, geometry: { type: "Point", coordinates: s.coord } }))),
  });
  map.addSource(SRC.part, { type: "geojson", data: fc([]) });
  map.addSource(SRC.pulso, { type: "geojson", data: fc([]) });
  map.addSource(SRC.flecha, { type: "geojson", data: fc([]) });
  if (!map.hasImage("flujo-flecha")) map.addImage("flujo-flecha", flechaImagen());

  // Red de drenaje real (tramos con más área acumulada), siempre visible bajo el agua en movimiento
  map.addLayer({
    id: "flujo-red",
    type: "line",
    source: SRC.tramos,
    filter: [">", ["get", "an"], 0.55],
    layout: { "line-cap": "round" },
    paint: { "line-color": agua, "line-opacity": 0.32, "line-width": ["interpolate", ["linear"], ["get", "an"], 0.55, 0.6, 1, 2.4] },
  });
  const qn = ["coalesce", ["feature-state", "qn"], 0];
  const ancho = ["interpolate", ["linear"], qn, 0, 0, 0.01, 0.8, 1, 5];
  map.addLayer({
    id: "flujo-linea",
    type: "line",
    source: SRC.tramos,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 11, ["*", ancho, 0.6], 16, ["*", ancho, 2.2]],
      "line-color": ["interpolate", ["linear"], ["coalesce", ["feature-state", "h"], 0], 0, agua, 0.35, aguaClaro, 0.6, desborde, 1, desborde],
      "line-opacity": ["interpolate", ["linear"], qn, 0, 0, 0.005, 0.25, 1, 0.8],
    },
  });
  map.addLayer({
    id: "flujo-sumideros",
    type: "circle",
    source: SRC.sum,
    minzoom: 13,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2, 17, 5],
      "circle-color": ["match", ["coalesce", ["feature-state", "nivel"], 0], 2, desborde, 3, desborde, 1, aguaClaro, "#767672"],
      "circle-stroke-color": ["match", ["coalesce", ["feature-state", "est"], 0], 2, "#1B1B1B", 1, "#7C7C78", "#FFFFFF"],
      "circle-stroke-width": 1.2,
    },
  });
  map.addLayer({
    id: "flujo-particulas",
    type: "circle",
    source: SRC.part,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 1, 14, 1.8, 17, 3.2],
      "circle-color": ["case", ["==", ["get", "h"], 1], desborde, "#FFFFFF"],
      "circle-opacity": 0.9,
      "circle-stroke-width": 0.5,
      "circle-stroke-color": ["case", ["==", ["get", "h"], 1], desborde, agua],
    },
  });
  map.addLayer({
    id: "flujo-pulso",
    type: "circle",
    source: SRC.pulso,
    paint: {
      "circle-radius": ["get", "r"],
      "circle-color": desborde,
      "circle-opacity": ["*", ["get", "o"], 0.18],
      "circle-stroke-color": desborde,
      "circle-stroke-width": 2,
      "circle-stroke-opacity": ["get", "o"],
    },
  });
  map.addLayer({
    id: "flujo-flecha",
    type: "symbol",
    source: SRC.flecha,
    layout: { "icon-image": "flujo-flecha", "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.35, 17, 0.7], "icon-rotate": ["get", "rumbo"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true },
  });

  // ---- Estado de tramos y sumideros ----
  const ultimoT = new Float32Array(tramos.length).fill(-1);
  const ultimoH = new Float32Array(tramos.length).fill(-1);
  const ultimoS = new Int16Array(sumideros.length).fill(-1);

  function actualizarEstado() {
    for (const t of tramos) {
      const q = motor.q[t.id];
      const n = q < cfg.caudalMinimoLs ? 0 : Math.min(1, q / cfg.caudalGrosorMaxLs);
      const h = q > 0 ? motor.qExc[t.id] / q : 0;
      if (Math.abs(n - ultimoT[t.id]) > 0.004 || Math.abs(h - ultimoH[t.id]) > 0.04) {
        ultimoT[t.id] = n;
        ultimoH[t.id] = h;
        map.setFeatureState({ source: SRC.tramos, id: t.id }, { qn: n, h });
      }
    }
    const pulsos: { i: number; ex: number }[] = [];
    sumideros.forEach((s, i) => {
      const nivel = ["sin_agua", "cuneta", "hasta_vereda", "sobre_vereda"].indexOf(motor.nivelMostrado(i));
      const est = ["limpia", "parcial", "tapada"].indexOf(motor.estadoRejilla(i));
      const clave = nivel * 10 + est;
      if (clave !== ultimoS[i]) {
        ultimoS[i] = clave;
        map.setFeatureState({ source: SRC.sum, id: s.id }, { nivel, est });
      }
      if (motor.desborda(i)) pulsos.push({ i, ex: motor.exceso[i] });
    });
    pulsos.sort((a, b) => b.ex - a.ex);
    puntosPulso = pulsos.slice(0, 40).map((p) => p.i);
    // Flecha: hacia dónde se va el agua desbordada (siguiente tramo aguas abajo del punto)
    const flechas = puntosPulso.flatMap((i) => {
      const s = sumideros[i];
      if (s.tramo === null) return [];
      let t = tramos[s.tramo];
      let m = s.pos * t.L + 22;
      if (m > t.L && t.sig !== null) {
        m -= t.L;
        t = tramos[t.sig];
      }
      const { coord, rumbo } = puntoEnTramo(t, m);
      return [{ type: "Feature", properties: { rumbo }, geometry: { type: "Point", coordinates: coord } }];
    });
    map.getSource(SRC.flecha)?.setData(fc(flechas));
  }

  // ---- Partículas y pulso (cada cuadro) ----
  let puntosPulso: number[] = [];
  const fase = new Float32Array(tramos.length); // desplazamiento común de las partículas de cada tramo
  const pos: [number, number] = [0, 0];

  function cuadro(dtS: number, tS: number) {
    // Cantidad de partículas por tramo: crece con el caudal y con el largo; tope global
    const cuentas = new Uint8Array(tramos.length);
    let total = 0;
    for (const t of tramos) {
      const q = motor.q[t.id];
      if (q < cfg.caudalMinimoLs) continue;
      const n = Math.min(8, Math.max(1, Math.round((q / cfg.lsPorParticula) * (t.L / 100))));
      cuentas[t.id] = n;
      total += n;
    }
    const escala = total > cfg.particulasMax ? cfg.particulasMax / total : 1;
    const feats: unknown[] = [];
    for (const t of tramos) {
      let n = cuentas[t.id];
      if (!n) continue;
      n = Math.max(1, Math.round(n * escala));
      const vis = (cfg.velocidadVisualMs * (0.35 + (0.65 * t.v) / cfg.velocidadMax)) / Math.max(t.L, 10);
      fase[t.id] = (fase[t.id] + dtS * vis) % 1;
      const caliente = motor.q[t.id] > 0 ? motor.qExc[t.id] / motor.q[t.id] : 0;
      for (let k = 0; k < n; k++) {
        enTramo(t, (fase[t.id] + k / n) % 1, pos);
        feats.push({ type: "Feature", properties: { h: k / n < caliente ? 1 : 0 }, geometry: { type: "Point", coordinates: [pos[0], pos[1]] } });
      }
    }
    map.getSource(SRC.part)?.setData(fc(feats));

    const ph = (tS * 0.9) % 1;
    map.getSource(SRC.pulso)?.setData(
      fc(puntosPulso.map((i) => ({ type: "Feature", properties: { r: 5 + 18 * ph, o: 1 - ph }, geometry: { type: "Point", coordinates: sumideros[i].coord } }))),
    );
  }

  return {
    actualizarEstado,
    cuadro,
    setVisible(v) {
      LAYERS.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", v ? "visible" : "none"));
    },
    destruir() {
      LAYERS.forEach((id) => map.getLayer(id) && map.removeLayer(id));
      Object.values(SRC).forEach((id) => map.getSource(id) && map.removeSource(id));
    },
  };
}

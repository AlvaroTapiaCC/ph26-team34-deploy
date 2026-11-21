// Dibujo de la simulación en MapLibre: trazo por tramo (grosor según el caudal; color de azul grisáceo, agua en la
// cuneta, a accent, calzada llena),
// partículas que avanzan según la velocidad del tramo, rejillas con ícono por estado (clic para cambiarlo), pulso en
// las rejillas desbordadas y una flecha hacia donde se va el agua. El estado de tramos y rejillas se actualiza unas
// 4 veces por segundo (feature-state); las partículas y el pulso, en cada cuadro (requestAnimationFrame).
import type { MapLibre } from "../../components/map/maplibre";
import { ESTADOS, FLUJO_CONFIG, type EstadoRejilla } from "./config";
import { puntoEnTramo, type Tramo } from "./grafo";
import type { MotorFlujo } from "./motor";

const SRC = { tramos: "flujo-tramos", sum: "flujo-sum", part: "flujo-part", pulso: "flujo-pulso", flecha: "flujo-flecha-src" };
const LAYERS = ["flujo-red", "flujo-linea", "flujo-particulas", "flujo-pulso", "flujo-nivel", "flujo-rejillas", "flujo-sel", "flujo-hit", "flujo-flecha"];
const fc = (features: unknown[]) => ({ type: "FeatureCollection", features });

export interface CapaFlujo {
  /** Estado de tramos y rejillas (llamar unas 4 veces por segundo y tras cambiar un estado). */
  actualizarEstado(): void;
  /** Un cuadro de animación: mueve las partículas y el pulso. `dtS` y `tS` son segundos reales. */
  cuadro(dtS: number, tS: number): void;
  setVisible(v: boolean): void;
  setSeleccion(id: string | null): void;
  destruir(): void;
}

type Img = { width: number; height: number; data: Uint8ClampedArray };
const PR = 2; // densidad de los íconos (se pasan con pixelRatio 2)

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

/** Ícono de rejilla: cuadrado con barras. Limpia: blanca con barras grises; parcial: mitad tapada en gris oscuro; tapada: accent con una ✕. */
function rejillaImagen(estado: EstadoRejilla): Img {
  const n = 18 * PR;
  return lienzo(n, (g) => {
    g.scale(PR, PR);
    const r = (x: number, y: number, w: number, h: number, rad: number) => {
      g.beginPath();
      g.roundRect(x, y, w, h, rad);
    };
    r(1.5, 1.5, 15, 15, 3.5);
    g.fillStyle = estado === "tapada" ? FLUJO_CONFIG.colores.desborde : "#FFFFFF";
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = estado === "tapada" ? "#FFFFFF" : estado === "parcial" ? "#1B1B1B" : "#767672";
    g.stroke();
    if (estado === "parcial") {
      g.save();
      r(1.5, 1.5, 15, 15, 3.5);
      g.clip();
      g.fillStyle = "#1B1B1B";
      g.fillRect(1.5, 9, 15, 7.5);
      g.restore();
    }
    if (estado === "tapada") {
      g.strokeStyle = "#FFFFFF";
      g.lineWidth = 2.2;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(5.5, 5.5);
      g.lineTo(12.5, 12.5);
      g.moveTo(12.5, 5.5);
      g.lineTo(5.5, 12.5);
      g.stroke();
    } else {
      g.strokeStyle = estado === "parcial" ? "#767672" : "#9A9A96";
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

export function montarCapaFlujo(map: MapLibre, motor: MotorFlujo, opts: { onClickSumidero: (id: string) => void }): CapaFlujo {
  const cfg = FLUJO_CONFIG;
  const { tramos, sumideros } = motor.grafo;
  const { agua, aguaClaro, desborde } = cfg.colores;
  const logMax = Math.log1p(cfg.caudalGrosorMaxLs);

  const maxAcc = Math.max(1, ...tramos.map((t) => t.acc));
  map.addSource(SRC.tramos, {
    type: "geojson",
    promoteId: "id",
    data: fc(tramos.map((t) => ({ type: "Feature", properties: { id: t.id, an: Math.log1p(t.acc) / Math.log1p(maxAcc) }, geometry: { type: "LineString", coordinates: t.coords } }))),
  });
  map.addSource(SRC.sum, {
    type: "geojson",
    promoteId: "id",
    data: fc(sumideros.map((s, i) => ({ type: "Feature", properties: { id: s.id, est: motor.estadoRejilla(i) }, geometry: { type: "Point", coordinates: s.coord } }))),
  });
  map.addSource(SRC.part, { type: "geojson", data: fc([]) });
  map.addSource(SRC.pulso, { type: "geojson", data: fc([]) });
  map.addSource(SRC.flecha, { type: "geojson", data: fc([]) });
  if (!map.hasImage("flujo-flecha")) map.addImage("flujo-flecha", flechaImagen());
  for (const e of ESTADOS) if (!map.hasImage(`rejilla-${e}`)) map.addImage(`rejilla-${e}`, rejillaImagen(e), { pixelRatio: PR });

  // Red de drenaje (tramos con más área acumulada), siempre visible bajo el agua en movimiento
  map.addLayer({
    id: "flujo-red",
    type: "line",
    source: SRC.tramos,
    filter: [">", ["get", "an"], 0.55],
    layout: { "line-cap": "round" },
    paint: { "line-color": agua, "line-opacity": 0.32, "line-width": ["interpolate", ["linear"], ["get", "an"], 0.55, 0.6, 1, 2.4] },
  });
  // Grosor según el caudal (escala logarítmica). Color según cuánto se llena la calle: azul grisáceo con el agua en la
  // cuneta, accent cuando llena la calzada hasta la solera
  const qn = ["coalesce", ["feature-state", "qn"], 0];
  const ancho = ["interpolate", ["linear"], qn, 0, 0, 0.05, 0.8, 1, 5.5];
  map.addLayer({
    id: "flujo-linea",
    type: "line",
    source: SRC.tramos,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 11, ["*", ancho, 0.6], 16, ["*", ancho, 2.2]],
      "line-color": ["interpolate-lab", ["linear"], ["coalesce", ["feature-state", "c"], 0], 0, agua, 0.45, aguaClaro, 0.85, desborde, 1, desborde],
      "line-opacity": ["interpolate", ["linear"], qn, 0, 0, 0.05, 0.35, 1, 0.85],
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
  // Halo de agua bajo cada rejilla: celeste con agua en la cuneta, accent si se desborda
  const nivel = ["coalesce", ["feature-state", "nivel"], 0];
  map.addLayer({
    id: "flujo-nivel",
    type: "circle",
    source: SRC.sum,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, ["match", nivel, 0, 0, 1, 4, 6], 17, ["match", nivel, 0, 0, 1, 12, 16]],
      "circle-color": ["match", nivel, 1, aguaClaro, desborde],
      "circle-opacity": ["match", nivel, 1, 0.55, 0.35],
    },
  });
  map.addLayer({
    id: "flujo-rejillas",
    type: "symbol",
    source: SRC.sum,
    layout: {
      // El ícono va como propiedad del dato ("est"): los símbolos no leen feature-state en el layout
      "icon-image": ["concat", "rejilla-", ["get", "est"]],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.55, 14, 0.8, 17, 1.2],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
  map.addLayer({
    id: "flujo-sel",
    type: "circle",
    source: SRC.sum,
    filter: ["==", ["get", "id"], ""],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 17, 16], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#1B1B1B", "circle-stroke-width": 2 },
  });
  // Zona de clic más grande que el ícono
  map.addLayer({ id: "flujo-hit", type: "circle", source: SRC.sum, paint: { "circle-radius": 11, "circle-color": "#000000", "circle-opacity": 0 } });
  map.addLayer({
    id: "flujo-flecha",
    type: "symbol",
    source: SRC.flecha,
    layout: { "icon-image": "flujo-flecha", "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.35, 17, 0.7], "icon-rotate": ["get", "rumbo"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true },
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
  const ultimoT = new Float32Array(tramos.length).fill(-1);
  const ultimoC = new Float32Array(tramos.length).fill(-1);
  const ultimoNivel = new Int8Array(sumideros.length).fill(-1);
  let ultimoEst = "";
  let puntosPulso: number[] = [];

  function actualizarEstado() {
    for (const t of tramos) {
      const q = motor.q[t.id];
      const n = q < cfg.caudalMinimoLs ? 0 : Math.min(1, Math.log1p(q) / logMax);
      // Llenado de la calle en escala logarítmica: 0 con la cuneta justa, 1 con la calzada llena
      const c = q <= t.capCuneta ? 0 : Math.min(1, Math.log(q / t.capCuneta) / Math.log(t.capCalzada / t.capCuneta));
      if (Math.abs(n - ultimoT[t.id]) > 0.004 || Math.abs(c - ultimoC[t.id]) > 0.02) {
        ultimoT[t.id] = n;
        ultimoC[t.id] = c;
        map.setFeatureState({ source: SRC.tramos, id: t.id }, { qn: n, c });
      }
    }
    // Ícono por estado: se reescribe el dato solo si cambió algún estado
    const est = sumideros.map((_, i) => motor.estadoRejilla(i));
    const clave = est.join();
    if (clave !== ultimoEst) {
      ultimoEst = clave;
      map.getSource(SRC.sum)?.setData(fc(sumideros.map((s, i) => ({ type: "Feature", properties: { id: s.id, est: est[i] }, geometry: { type: "Point", coordinates: s.coord } }))));
      ultimoNivel.fill(-1); // setData borra el feature-state
    }
    const pulsos: { i: number; ex: number }[] = [];
    sumideros.forEach((s, i) => {
      const nv = ["sin_agua", "cuneta", "hasta_vereda", "sobre_vereda"].indexOf(motor.nivelMostrado(i));
      if (nv !== ultimoNivel[i]) {
        ultimoNivel[i] = nv;
        map.setFeatureState({ source: SRC.sum, id: s.id }, { nivel: Math.max(0, nv) });
      }
      if (motor.desborda(i)) pulsos.push({ i, ex: motor.exceso[i] });
    });
    pulsos.sort((a, b) => b.ex - a.ex);
    puntosPulso = pulsos.slice(0, 40).map((p) => p.i);
    // Flecha: hacia dónde se va el agua desbordada (siguiente tramo aguas abajo de la rejilla)
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
      // Avanzan según la velocidad del tramo (Manning): las calles con más pendiente se ven más rápidas
      fase[t.id] = (fase[t.id] + (dtS * cfg.escalaVisual * t.v) / Math.max(t.L, 10)) % 1;
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
    setSeleccion(id) {
      if (map.getLayer("flujo-sel")) map.setFilter("flujo-sel", ["==", ["get", "id"], id ?? ""]);
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

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LngLat, Prioridad } from "@/lib/data";
import { FLUJO_CONFIG } from "@/lib/flujo/config";
import { BASE_STYLE, loadMapLibre, type MapLibre } from "./maplibre";
import { colorDe, EVENTO_PALETA } from "@/lib/paleta";

export interface MapPin {
  id: string;
  coord: LngLat;
  rank: number | string;
  prio: Prioridad | "anegado";
  faded?: boolean;
  ring?: "flood"; // Durante: ondas del punto anegado
  onClick?: () => void;
  nombre?: string; // globo al pasar el mouse
  sub?: string;
}

export interface MapLabel {
  coord: LngLat;
  text: string;
  sub?: string;
  tone: "card" | "pill" | "danger" | "dark" | "area";
  offset?: [number, number];
  anchor?: "left" | "right" | "top" | "bottom" | "center" | "top-left" | "bottom-left";
}

/** Punto liviano (capa GL, no HTML): para mostrar muchas rejillas sin tapar el mapa. */
export interface MapPunto {
  id: string;
  coord: LngLat;
  prio: Prioridad;
  top?: boolean; // de las primeras: más grande y con brillo
  peso?: number; // 0 a 1: aporte al mapa de calor de riesgo
  nombre?: string;
  sub?: string;
}

export interface MapParadero {
  id: string;
  coord: LngLat;
  nivel: "expuesto" | "en_riesgo" | "alternativo";
  activo?: boolean;
  titulo: string;
  onClick?: () => void;
}

export interface DrenaMapProps {
  pins?: MapPin[];
  labels?: MapLabel[];
  lines?: LngLat[][];
  limites?: LngLat[][] | null;
  area?: LngLat[] | null;
  gore?: LngLat[] | null;
  comunas?: boolean; // límites de todas las comunas de la RM con su nombre (public/data/comunas_rm.geojson). Por defecto, sí
  rejillas?: boolean; // catastro de rejillas MOP, en gris y solo de cerca (public/data/rejillas.geojson)
  /** Relieve (sombreado del terreno) y, si `tresD`, terreno 3D con edificios. Sin clave: AWS Terrain Tiles y OpenFreeMap. */
  relieve?: boolean;
  tresD?: boolean;
  chain?: LngLat[] | null; // Durante: cadena aguas abajo del punto anegado
  celda?: { poly: LngLat[]; rayos: LngLat[]; link: [LngLat, LngLat] } | null; // Durante: celda convectiva ilustrativa
  camara3D?: { pitch: number; bearing: number }; // inclinación y rumbo de la vista 3D (por defecto, los del flujo)
  seleccionado?: string | null; // id del punto elegido (anillo fijo)
  resaltado?: string | null; // id de pin o punto a resaltar (p. ej. la fila bajo el mouse en la lista)
  onHover?: (id: string | null) => void; // mouse sobre un pin o punto del mapa
  focoSiempre?: boolean; // con foco: centrar aunque ya esté a la vista (llegada de un reporte)
  foco?: LngLat | null; // centra el mapa en este punto (sin cambiar el zoom) al elegirlo en una lista
  ruta?: LngLat[][] | null; // ruta propuesta de una cuadrilla (color de acción, no de agua)
  puntos?: MapPunto[] | null; // rejillas como puntos GL, coloreados por prioridad
  puntosVisibles?: boolean; // oculta los símbolos sin quitar los datos del mapa de calor; por defecto, sí
  onClickPunto?: (id: string) => void;
  /** Capas interactivas que toman el clic y el hover antes que las rejillas subyacentes. */
  capasSobrePuntos?: readonly string[];
  paraderos?: MapParadero[] | null; // transporte: expuestos, en riesgo y alternativos (#92)
  recorridos?: LngLat[][] | null; // trazado de los servicios afectados
  recorridosFondo?: LngLat[][] | null; // todos los recorridos de la zona, tenues
  recorridosDestacados?: LngLat[][] | null;
  calor?: boolean; // mapa de calor de riesgo a partir de `puntos` (peso)
  caminatas?: [LngLat, LngLat][] | null; // paradero expuesto → paradero alternativo
  bounds: [LngLat, LngLat];
  padding?: number | { top: number; bottom: number; left: number; right: number };
  attribution?: string;
  attributionSide?: "left" | "right";
  className?: string;
  children?: ReactNode;
  pinSize?: number;
  /** Se llama una vez cuando el mapa y sus capas base están listos; puede devolver una función de limpieza. */
  onMapReady?: (map: MapLibre, ml: MapLibre) => void | (() => void);
}

const TRIANGULO = "M20 3 L37.5 34 L2.5 34 Z"; // ▲ prioridad alta
const COLORS: Record<string, string> = {
  alta: "var(--prio-alta)",
  media: "var(--prio-media)",
  baja: "var(--prio-baja)",
  anegado: "var(--danger)",
};

function pinEl(p: MapPin, size: number, alClic: () => void, alHover: (dentro: boolean) => void): HTMLElement {
  const el = document.createElement("div");
  el.dataset.id = p.id;
  el.className = "pin" + (p.faded ? " pin--faded" : "") + (p.onClick ? " pin--click" : "") + (p.prio === "alta" ? " pin--tri" : "") + ` pin--${p.prio}`;
  el.style.width = el.style.height = `${size}px`;
  const fill = COLORS[p.prio];
  let shape = "";
  if (p.prio === "alta") shape = `<path d="${TRIANGULO}" fill="${fill}" stroke="var(--fondo)" stroke-width="3" stroke-linejoin="round"/>`;
  else if (p.prio === "media")
    shape = `<rect x="7" y="7" width="26" height="26" rx="4" transform="rotate(45 20 20)" fill="${fill}" stroke="var(--fondo)" stroke-width="3"/>`;
  else shape = `<circle cx="20" cy="20" r="17" fill="${fill}" stroke="var(--fondo)" stroke-width="3"/>`;
  const txt = p.prio === "anegado" ? "≋" : String(p.rank);
  el.innerHTML = `<svg viewBox="0 0 40 40" width="${size}" height="${size}">${shape}</svg><span class="pin__n">${txt}</span>`;
  if (p.ring === "flood") {
    el.insertAdjacentHTML("afterbegin", `<span class="pin__flood pin__flood--1"></span><span class="pin__flood pin__flood--2"></span><span class="pin__flood pin__flood--3"></span>`);
  }
  if (p.onClick) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      alClic();
    });
  }
  el.addEventListener("mouseenter", () => alHover(true));
  el.addEventListener("mouseleave", () => alHover(false));
  return el;
}

function paraderoEl(p: MapParadero, alClic: () => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `paradero paradero--${p.nivel}` + (p.activo ? " is-active" : "") + (p.onClick ? " pin--click" : "");
  el.title = p.titulo;
  el.setAttribute("aria-label", p.titulo);
  el.setAttribute("aria-pressed", String(!!p.activo));
  el.tabIndex = p.onClick ? 0 : -1;
  if (!p.onClick) el.setAttribute("aria-disabled", "true");
  el.innerHTML = `<span class="paradero__badge"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="16" rx="3"/><path d="M5 11h14M8 19v2m8-2v2M9 6h6"/><circle cx="8.5" cy="15.5" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1" fill="currentColor" stroke="none"/></svg></span>`;
  if (p.onClick) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      alClic();
    });
  }
  return el;
}

function labelEl(l: MapLabel): HTMLElement {
  const el = document.createElement("div");
  el.className = `map-label map-label--${l.tone}`;
  el.textContent = l.text;
  if (l.sub) {
    const s = document.createElement("span");
    s.className = "map-label__sub";
    s.textContent = l.sub;
    el.appendChild(s);
  }
  return el;
}

// Colores de los tokens de globals.css. MapLibre no lee variables CSS: se resuelven al crear el mapa y cada vez
// que cambia el esquema de color, así las capas siguen al tema (claro u oscuro) sin repetir los hex aquí.
// Colores de las capas propias, desde la paleta (lib/paleta.json). MapLibre no lee variables CSS:
// se leen con colorDe() al crear el mapa, al cambiar la paleta (EVENTO_PALETA) o el tema del sistema.
const COLORES_CAPAS: [capa: string, propiedad: string, color: string][] = [
  ["bg", "background-color", "map-bg"],
  ["relieve", "hillshade-shadow-color", "text-2"],
  ["relieve", "hillshade-highlight-color", "surface"],
  ["relieve", "hillshade-accent-color", "contexto"],
  ["edificios", "fill-extrusion-color", "surface-2"],
  ["area-fill", "fill-color", "agua"],
  ["area-line", "line-color", "agua"],
  ["celda-fill", "fill-color", "secundario"],
  ["celda-line", "line-color", "secundario"],
  ["celda-link", "line-color", "secundario"],
  ["lim", "line-color", "text-2"],
  ["rm-fill", "fill-color", "text-3"],
  ["rm-line", "line-color", "text-3"],
  ["rm-line-proy", "line-color", "secundario"],
  ["rej-cluster", "circle-color", "contexto"],
  ["rej-cluster", "circle-stroke-color", "contexto"],
  ["rej-point", "circle-color", "contexto"],
  ["rej-point", "circle-stroke-color", "surface"],
  ["esc-halo", "line-color", "agua"],
  ["esc-line", "line-color", "agua"],
  ["gore", "circle-color", "contexto"],
  ["gore", "circle-stroke-color", "surface"],
  ["rec-line", "line-color", "bus"],
  ["rec-destacado", "line-color", "bus"],
  ["caminata", "line-color", "bus"],
  ["chain-halo", "line-color", "principal"],
  ["ruta-halo", "line-color", "principal"],
  ["ruta-line", "line-color", "principal"],
  ["puntos-hover", "circle-stroke-color", "secundario"],
  ["puntos-sel", "circle-stroke-color", "principal"],
  ["puntos", "circle-stroke-color", "secundario"],
  ["rec-fondo", "line-color", "bus"],
  ["chain-line", "line-color", "principal"],
];

/** Chevrón para el sentido de los recorridos de bus, con el color de transporte de la paleta. */
function flechaBus(): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = 24;
  const ctx = c.getContext("2d")!;
  ctx.beginPath();
  ctx.moveTo(8, 6);
  ctx.lineTo(16, 12);
  ctx.lineTo(8, 18);
  ctx.strokeStyle = colorDe("bus");
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  return ctx.getImageData(0, 0, 24, 24);
}

function pintarMapa(map: MapLibre) {
  if (map.hasImage?.("bus-sentido")) map.updateImage("bus-sentido", flechaBus());
  for (const [capa, prop, color] of COLORES_CAPAS) if (map.getLayer(capa)) map.setPaintProperty(capa, prop, colorDe(color));
  if (map.getLayer("riesgo-calor")) {
    // Riesgo bajo = transparente (el mapa queda gris); medio = calipso tenue; alto = calipso a blanco
    const t = (c: string, a: number) => colorDe(c).replace(/^#(..)(..)(..)$/, (_m, r, g, b) => `rgba(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)},${a})`); // paleta-ok: transparencia sobre colores de la paleta
    map.setPaintProperty("riesgo-calor", "heatmap-color", ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.12, "rgba(0,0,0,0)", 0.3, t("principal", 0.15), 0.6, t("principal", 0.35), 0.85, t("principal", 0.55), 1, t("principal", 0.7)]); // paleta-ok: transparente
  }
  if (map.getLayer("puntos")) {
    map.setPaintProperty("puntos", "circle-color", ["match", ["get", "prio"], "alta", colorDe("prio-alta"), "media", colorDe("prio-media"), colorDe("prio-baja")]);
    map.setPaintProperty("puntos-brillo", "circle-color", ["match", ["get", "prio"], "alta", colorDe("prio-alta"), "media", colorDe("prio-media"), colorDe("prio-baja")]);
  }
}

interface ComunaRm {
  comuna: string;
  enProyecto: boolean;
  coord: LngLat;
}
let comunasRmPromise: Promise<ComunaRm[]> | null = null;
function cargarComunasRm(): Promise<ComunaRm[]> {
  comunasRmPromise ??= fetch("/data/comunas_rm.geojson")
    .then((r) => r.json())
    .then((g: { features: { properties: { comuna: string; en_proyecto: boolean; lon: number; lat: number } }[] }) =>
      g.features.map((f) => ({ comuna: f.properties.comuna, enProyecto: f.properties.en_proyecto, coord: [f.properties.lon, f.properties.lat] as LngLat })),
    )
    .catch(() => {
      comunasRmPromise = null;
      return [];
    });
  return comunasRmPromise;
}

// Las etiquetas de comuna aparecen desde este zoom
export const ZOOM_ETIQUETAS_COMUNA = 11;

const fc = (features: unknown[]) => ({ type: "FeatureCollection", features });
const line = (c: LngLat[]) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: c } });
const poly = (c: LngLat[]) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...c, c[0]]] } });

export default function DrenaMap(props: DrenaMapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre>(null);
  const libRef = useRef<MapLibre>(null);
  const markerKeys = useRef<Map<string, MapLibre>>(new Map());
  const clicks = useRef<Map<string, () => void>>(new Map());
  const rejillasCargadas = useRef(false);
  const pinesInfo = useRef(new Map<string, { coord: LngLat; nombre?: string; sub?: string }>());
  const globo = useRef<MapLibre>(null);
  const hoverRef = useRef<((id: string | null, info?: { coord: LngLat; nombre?: string; sub?: string }) => void) | null>(null);
  const comunaMarkers = useRef<{ el: HTMLElement; marker: MapLibre }[]>([]);
  const unsubTema = useRef<() => void>(() => {});
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const size = props.pinSize ?? 40;

  // Capas extra de quien usa el mapa (p. ej. la simulación del flujo o las cadenas de la central). Va antes de crear el mapa: así su limpieza corre antes de map.remove()
  const onMapReadyRef = useRef(props.onMapReady);
  onMapReadyRef.current = props.onMapReady;
  useEffect(() => {
    if (!ready) return;
    return onMapReadyRef.current?.(mapRef.current, libRef.current) || undefined;
  }, [ready]);

  // Crear mapa
  useEffect(() => {
    let cancelled = false;
    loadMapLibre()
      .then((ml) => {
        if (cancelled || !ref.current) return;
        libRef.current = ml;
        const map = new ml.Map({
          container: ref.current,
          style: BASE_STYLE,
          bounds: props.bounds,
          fitBoundsOptions: { padding: props.padding ?? 40 },
          attributionControl: false,
          dragRotate: !!props.relieve, // en 3D se puede girar e inclinar con el botón derecho
          pitchWithRotate: !!props.relieve,
          maxPitch: 70,
          // Fluidez: en pantallas de alta densidad el lienzo se dibuja a 1,5× como máximo (la diferencia no se nota y
          // el costo por cuadro baja a la mitad o menos); sin copias del mundo ni fundido de teselas.
          pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
          renderWorldCopies: false,
          fadeDuration: 0,
        });
        if (!props.relieve) map.touchZoomRotate.disableRotation();
        mapRef.current = map;
        map.once("style.load", () => {
          const add = (id: string) => map.addSource(id, { type: "geojson", data: fc([]) });
          ["esc", "chain", "lim", "area", "celda", "celda-link", "gore", "rec", "rec-destacado", "caminata"].forEach(add);
          map.addSource("comunas-rm", { type: "geojson", data: "/data/comunas_rm.geojson" });
          // El catastro completo (420 KB) se pide la primera vez que se enciende su capa
          map.addSource("rejillas", { type: "geojson", data: fc([]), cluster: true, clusterMaxZoom: 16, clusterRadius: 30 });
          if (props.relieve) {
            const ter = FLUJO_CONFIG.terreno;
            // Dos fuentes del mismo DEM: una para el terreno 3D y otra para el sombreado (MapLibre recomienda separarlas)
            const dem = { type: "raster-dem", tiles: [ter.tiles], encoding: "terrarium", tileSize: 256, maxzoom: 15, attribution: "Terrain Tiles (AWS)" };
            map.addSource("dem-terreno", dem);
            map.addSource("dem-sombra", dem);
            map.addLayer(
              {
                id: "relieve",
                type: "hillshade",
                source: "dem-sombra",
                paint: { "hillshade-exaggeration": 0.35 },
              },
              "ref",
            );
            map.addSource("ofm", { type: "vector", url: FLUJO_CONFIG.edificios });
            map.addLayer({
              id: "edificios",
              type: "fill-extrusion",
              source: "ofm",
              "source-layer": "building",
              minzoom: 14,
              layout: { visibility: "none" },
              filter: ["!=", ["get", "hide_3d"], true],
              paint: {
                "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
                "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
                "fill-extrusion-opacity": 0.55,
              },
            });
          }
          map.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-opacity": 0.12 } });
          map.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-width": 2, "line-opacity": 0.8 } });
          // Durante: celda convectiva ilustrativa (gris oscuro, no es agua ni alerta)
          map.addLayer({ id: "celda-fill", type: "fill", source: "celda", paint: { "fill-opacity": 0.14 } });
          map.addLayer({ id: "celda-line", type: "line", source: "celda", paint: { "line-width": 2, "line-dasharray": [3, 2] } });
          map.addLayer({ id: "celda-link", type: "line", source: "celda-link", paint: { "line-width": 3, "line-opacity": 0.8, "line-dasharray": [1.5, 1.5] } });
          map.addLayer({ id: "lim", type: "line", source: "lim", paint: { "line-width": 2, "line-opacity": 0.8, "line-dasharray": [4, 3] } });
          const hidden = { visibility: "none" };
          // Límites de todas las comunas: línea fina punteada en --text-3, relleno casi invisible; las 3 del proyecto, algo más marcadas.
          map.addLayer({ id: "rm-fill", type: "fill", source: "comunas-rm", paint: { "fill-opacity": 0.035 } });
          map.addLayer({ id: "rm-line", type: "line", source: "comunas-rm", paint: { "line-width": 1.2, "line-opacity": 0.9, "line-dasharray": [2, 2] } });
          map.addLayer({
            id: "rm-line-proy",
            type: "line",
            source: "comunas-rm",
            filter: ["==", ["get", "en_proyecto"], true],
            paint: { "line-width": 2.4, "line-opacity": 0.85 },
          });
          // Capas de contexto (catastro completo y GORE): pequeñas, en gris y solo de cerca, para no competir con el agua
          const zc = FLUJO_CONFIG.zoomContexto;
          map.addLayer({
            id: "rej-cluster",
            type: "circle",
            source: "rejillas",
            minzoom: zc,
            filter: ["has", "point_count"],
            layout: hidden,
            paint: { "circle-opacity": 0.18, "circle-stroke-width": 1, "circle-radius": ["step", ["get", "point_count"], 6, 10, 8, 50, 10] },
          });
          map.addLayer({
            id: "rej-point",
            type: "circle",
            source: "rejillas",
            minzoom: zc,
            filter: ["!", ["has", "point_count"]],
            layout: hidden,
            paint: { "circle-radius": 2, "circle-stroke-width": 0.5 },
          });
          // Líneas de escurrimiento de ejemplo (ficha y móvil): agua, en azul
          map.addLayer({ id: "esc-halo", type: "line", source: "esc", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 8, "line-opacity": 0.12 } });
          map.addLayer({ id: "esc-line", type: "line", source: "esc", layout: { "line-cap": "round" }, paint: { "line-width": 2, "line-opacity": 0.8 } });
          map.addLayer({ id: "gore", type: "circle", source: "gore", minzoom: zc, paint: { "circle-radius": 2.5, "circle-stroke-width": 0.75 } });
          // Durante: cadena aguas abajo del punto anegado en accent (alerta).
          // Transporte: azul fuera de la paleta de prioridad para no confundir un recorrido con escurrimiento.
          map.addLayer({ id: "rec-line", type: "line", source: "rec", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 3, "line-opacity": 0.55 } });
          map.addImage("bus-sentido", flechaBus(), { pixelRatio: 2 });
          map.addLayer({
            id: "rec-flecha",
            type: "symbol",
            source: "rec",
            layout: { "symbol-placement": "line", "symbol-spacing": 60, "icon-image": "bus-sentido", "icon-size": 0.8, "icon-rotation-alignment": "map", "icon-allow-overlap": false },
            paint: { "icon-opacity": 0.9 },
          });
          map.addLayer({ id: "caminata", type: "line", source: "caminata", layout: { "line-cap": "round" }, paint: { "line-width": 2.5, "line-dasharray": [0.5, 2] } });
          map.addLayer({ id: "chain-halo", type: "line", source: "chain", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 14, "line-opacity": 0.2 } });
          map.addLayer({ id: "chain-line", type: "line", source: "chain", paint: { "line-width": 3, "line-dasharray": [1.5, 1.5] } });
          map.addSource("ruta", { type: "geojson", data: fc([]) });
          map.addLayer({ id: "ruta-halo", type: "line", source: "ruta", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 9, "line-opacity": 0.22 } });
          map.addLayer({ id: "ruta-line", type: "line", source: "ruta", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 3, "line-dasharray": [2, 1.5] } });
          map.addSource("puntos", { type: "geojson", data: fc([]) });
          map.addLayer({
            id: "puntos-sel",
            type: "circle",
            source: "puntos",
            filter: ["==", ["get", "id"], ""],
            paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 7, 16, 11], "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2.5 }, // paleta-ok: relleno transparente
          });
          map.addLayer({
            id: "puntos-hover",
            type: "circle",
            source: "puntos",
            filter: ["==", ["get", "id"], ""],
            paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 6, 16, 10], "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2 }, // paleta-ok: relleno transparente
          });
          map.addSource("rec-fondo", { type: "geojson", data: fc([]) });
          map.addLayer({ id: "rec-fondo", type: "line", source: "rec-fondo", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 1.5, "line-opacity": 0.22 } });
          map.addLayer({
            id: "riesgo-calor",
            type: "heatmap",
            source: "puntos",
            layout: { visibility: "none" },
            paint: {
              "heatmap-weight": ["get", "w"],
              "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 13, 1.6, 16, 2.6],
              "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 13, 30, 16, 90],
              "heatmap-opacity": 0.5,
            },
          });
          map.addLayer({
            id: "puntos-brillo",
            type: "circle",
            source: "puntos",
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, ["case", ["get", "top"], 8, 5], 16, ["case", ["get", "top"], 16, 9]],
              "circle-blur": 1,
              "circle-opacity": ["case", ["get", "top"], 0.75, ["match", ["get", "prio"], "alta", 0.5, "media", 0.3, 0.15]],
            },
          });
          map.addLayer({
            id: "puntos",
            type: "circle",
            source: "puntos",
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, ["case", ["get", "top"], 3.5, 2], 16, ["case", ["get", "top"], 6.5, 4]],
              "circle-stroke-width": ["case", ["get", "top"], 1.5, 0],
              "circle-opacity": ["match", ["get", "prio"], "baja", 0.7, 1],
            },
          });
          map.addLayer({ id: "rec-destacado", type: "line", source: "rec-destacado", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 6, "line-opacity": 1 } });
          pintarMapa(map);
          // Si cambia el esquema de color del sistema, se vuelven a leer los colores
          const repintar = () => pintarMapa(map);
          const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
          mq?.addEventListener?.("change", repintar);
          unsubTema.current = () => mq?.removeEventListener?.("change", repintar);
          setReady(true);
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      unsubTema.current();
      comunaMarkers.current.forEach((c) => c.marker.remove());
      comunaMarkers.current = [];
      markerKeys.current.forEach((m) => m.remove());
      markerKeys.current = new Map();
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Terreno 3D y edificios. Va ANTES del encuadre: cambiar el terreno en medio de una animación de cámara congela el
  // render de MapLibre, así que primero se detiene la cámara, se aplica el terreno y después se mueve.
  useEffect(() => {
    if (!ready || !props.relieve) return;
    const map = mapRef.current;
    map.stop();
    map.setTerrain(props.tresD ? { source: "dem-terreno", exaggeration: FLUJO_CONFIG.terreno.exageracion } : null);
    if (map.getLayer("edificios")) map.setLayoutProperty("edificios", "visibility", props.tresD ? "visible" : "none");
  }, [ready, props.relieve, props.tresD]);

  // Paleta editable (#131): repinta las capas sin recrear el mapa
  useEffect(() => {
    if (!ready) return;
    const repintar = () => mapRef.current && pintarMapa(mapRef.current);
    window.addEventListener(EVENTO_PALETA, repintar);
    return () => window.removeEventListener(EVENTO_PALETA, repintar);
  }, [ready]);

  // Encuadre (en 3D, con la inclinación y el rumbo de la vista)
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const ter = props.camara3D ?? FLUJO_CONFIG.terreno;
    const bearing = props.tresD ? ter.bearing : 0;
    // El padding de la cámara queda guardado en el mapa: se limpia antes de calcular para que no se acumule
    if (props.camara3D) map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    const cam = map.cameraForBounds(props.bounds, { padding: props.padding ?? 40, bearing });
    if (cam && props.camara3D) {
      // Vista de la sala: centro de la zona con margen para el panel (padding de easeTo), sin que la inclinación la corra
      const [[x0, y0], [x1, y1]] = props.bounds;
      const pad = props.padding ?? 40;
      map.easeTo({ center: [(x0 + x1) / 2, (y0 + y1) / 2], zoom: cam.zoom - (props.tresD ? 0.15 : 0), bearing, pitch: props.tresD ? ter.pitch : 0, padding: pad, duration: 900 });
    } else if (cam) map.easeTo({ ...cam, bearing, pitch: props.tresD ? ter.pitch : 0, duration: 900 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, JSON.stringify(props.bounds), props.tresD]);

  // Foco: llevar a la vista la rejilla elegida en la lista, solo si quedó fuera del encuadre visible
  useEffect(() => {
    if (!ready || !props.foco) return;
    const map = mapRef.current;
    const b = map.getBounds();
    if (!props.focoSiempre && b.contains(props.foco)) return;
    const reducido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map.easeTo({ center: props.foco, zoom: props.focoSiempre ? Math.max(map.getZoom(), 15.5) : map.getZoom(), duration: reducido ? 0 : 700 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, props.foco?.[0], props.foco?.[1]]);

  // Capas vectoriales
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const set = (id: string, data: unknown) => map.getSource(id)?.setData(data);
    set("esc", fc((props.lines ?? []).map(line)));
    set("lim", fc((props.limites ?? []).map(line)));
    set("area", fc(props.area ? [poly(props.area)] : []));
    set("chain", fc(props.chain ? [line(props.chain)] : []));
    set("celda", fc(props.celda ? [poly(props.celda.poly)] : []));
    set("celda-link", fc(props.celda ? [line(props.celda.link)] : []));
    set("rec", fc((props.recorridos ?? []).map(line)));
    set("rec-destacado", fc((props.recorridosDestacados ?? []).map(line)));
    const destacado = !!props.recorridosDestacados?.length;
    map.setPaintProperty("rec-line", "line-opacity", destacado ? 0.2 : 0.55);
    map.setPaintProperty("rec-flecha", "icon-opacity", destacado ? 0.2 : 0.9);
    map.moveLayer("rec-destacado");
    set("caminata", fc((props.caminatas ?? []).map(line)));
    set("ruta", fc((props.ruta ?? []).map(line)));
    set("rec-fondo", fc((props.recorridosFondo ?? []).map(line)));
    set("puntos", fc((props.puntos ?? []).map((p) => ({ type: "Feature", properties: { id: p.id, prio: p.prio, top: !!p.top, w: p.peso ?? 0, nombre: p.nombre ?? "", sub: p.sub ?? "" }, geometry: { type: "Point", coordinates: p.coord } }))));
    set("gore", fc((props.gore ?? []).map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }))));
  }, [ready, props.lines, props.chain, props.limites, props.area, props.celda, props.gore, props.recorridos, props.recorridosDestacados, props.caminatas, props.puntos, props.ruta, props.recorridosFondo]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (map.getLayer("riesgo-calor")) map.setLayoutProperty("riesgo-calor", "visibility", props.calor ? "visible" : "none");
  }, [ready, props.calor]);

  const onClickPuntoRef = useRef(props.onClickPunto);
  onClickPuntoRef.current = props.onClickPunto;
  const capasSobrePuntosRef = useRef(props.capasSobrePuntos);
  capasSobrePuntosRef.current = props.capasSobrePuntos;
  // Globo (nombre y puntaje) y resaltado al pasar el mouse por un pin o un punto
  const onHoverRef = useRef(props.onHover);
  onHoverRef.current = props.onHover;
  useEffect(() => {
    if (!ready) return;
    const ml = libRef.current;
    const map = mapRef.current;
    globo.current = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 16, className: "globo", maxWidth: "280px" });
    let actual: string | null = null;
    hoverRef.current = (id, info) => {
      // Solo cuando cambia el punto: el globo no se rehace en cada movimiento del mouse
      if (id === actual) return;
      actual = id;
      onHoverRef.current?.(id);
      const d = id ? (info ?? pinesInfo.current.get(id)) : null;
      if (!id || !d?.nombre) {
        globo.current?.remove();
        return;
      }
      const el = document.createElement("div");
      const t = document.createElement("b");
      t.textContent = d.nombre;
      el.appendChild(t);
      if (d.sub) {
        const sub = document.createElement("span");
        sub.textContent = d.sub;
        el.appendChild(sub);
      }
      globo.current.setLngLat(d.coord).setDOMContent(el).addTo(map);
    };
    const hayCapaEncima = (point: { x: number; y: number }) => {
      const layers = (capasSobrePuntosRef.current ?? []).filter((id) => map.getLayer(id));
      return layers.length > 0 && map.queryRenderedFeatures(point, { layers }).length > 0;
    };
    const clic = (e: MapLibre) => {
      if (hayCapaEncima(e.point)) return;
      const id = e.features?.[0]?.properties?.id;
      if (id) onClickPuntoRef.current?.(String(id));
    };
    const mueve = (e: MapLibre) => {
      if (hayCapaEncima(e.point)) {
        hoverRef.current?.(null);
        map.getCanvas().style.cursor = "pointer";
        return;
      }
      // Con puntos solapados se toma el más cercano al cursor (estable), no el primero que devuelve la capa
      const fs: MapLibre[] = e.features ?? [];
      if (!fs.length) return;
      const px = e.point;
      const f = fs.reduce((a: MapLibre, b: MapLibre) => {
        const pa = map.project(a.geometry.coordinates);
        const pb = map.project(b.geometry.coordinates);
        return (pa.x - px.x) ** 2 + (pa.y - px.y) ** 2 <= (pb.x - px.x) ** 2 + (pb.y - px.y) ** 2 ? a : b;
      });
      map.getCanvas().style.cursor = onClickPuntoRef.current ? "pointer" : "";
      const pr = f.properties ?? {};
      hoverRef.current?.(String(pr.id), { coord: f.geometry.coordinates as LngLat, nombre: pr.nombre || undefined, sub: pr.sub || undefined });
    };
    const sale = () => {
      map.getCanvas().style.cursor = "";
      hoverRef.current?.(null);
    };
    map.on("click", "puntos", clic);
    map.on("mousemove", "puntos", mueve);
    map.on("mouseleave", "puntos", sale);
    return () => {
      map.off("click", "puntos", clic);
      map.off("mousemove", "puntos", mueve);
      map.off("mouseleave", "puntos", sale);
      globo.current?.remove();
    };
  }, [ready]);

  // Punto elegido: anillo fijo
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (map.getLayer("puntos-sel")) map.setFilter("puntos-sel", ["==", ["get", "id"], props.seleccionado ?? ""]);
  }, [ready, props.seleccionado]);

  // Resaltado que viene de afuera (fila de la lista bajo el mouse)
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const id = props.resaltado ?? "";
    if (map.getLayer("puntos-hover")) map.setFilter("puntos-hover", ["==", ["get", "id"], id]);
    const raiz = ref.current?.parentElement;
    raiz?.querySelectorAll(".pin.is-resaltado").forEach((e) => e.classList.remove("is-resaltado"));
    if (id) raiz?.querySelector(`.pin[data-id="${CSS.escape(id)}"]`)?.classList.add("is-resaltado");
  }, [ready, props.resaltado, props.pins]);

  // Los símbolos de prioridad y el calor comparten datos, pero se filtran por separado.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const visible = props.puntosVisibles !== false;
    for (const id of ["puntos", "puntos-brillo", "puntos-sel", "puntos-hover"]) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    if (!visible) {
      hoverRef.current?.(null);
      map.getCanvas().style.cursor = "";
    }
  }, [ready, props.puntosVisibles]);

  // Visibilidad de las capas de datos reales
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const vis = (ids: string[], on?: boolean) => ids.forEach((id) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
    vis(["rm-fill", "rm-line", "rm-line-proy"], props.comunas ?? true);
    vis(["rej-cluster", "rej-point"], props.rejillas);
    if (props.rejillas && !rejillasCargadas.current) {
      rejillasCargadas.current = true;
      map.getSource("rejillas")?.setData("/data/rejillas.geojson");
    }
  }, [ready, props.comunas, props.rejillas]);

  // Nombres de comuna: HTML en Geist Mono (el estilo base no tiene glifos para una capa de texto). Visibles desde el zoom 11.
  useEffect(() => {
    if (!ready) return;
    const ml = libRef.current;
    const map = mapRef.current;
    let vivo = true;
    const actualizar = () => {
      const z = map.getZoom();
      const on = (props.comunas ?? true) && z >= ZOOM_ETIQUETAS_COMUNA;
      comunaMarkers.current.forEach(({ el }) => el.classList.toggle("is-on", on));
      // Con los nombres de comuna a la vista, los del mapa base se atenúan para no pisarse
      map.setPaintProperty("ref", "raster-opacity", on ? (z >= 15 ? 0.75 : 0.08) : 0.75);
    };
    cargarComunasRm().then((lista) => {
      if (!vivo) return;
      comunaMarkers.current.forEach((c) => c.marker.remove());
      comunaMarkers.current = lista.map((c) => {
        const el = document.createElement("div");
        el.className = `comuna-label${c.enProyecto ? " comuna-label--proy" : ""}`;
        el.textContent = c.comuna;
        const marker = new ml.Marker({ element: el, anchor: "center" }).setLngLat(c.coord).addTo(map);
        return { el, marker };
      });
      actualizar();
    });
    map.on("zoom", actualizar);
    actualizar();
    return () => {
      vivo = false;
      map.off("zoom", actualizar);
    };
  }, [ready, props.comunas]);

  // Marcadores HTML. Se reconcilian por clave: un marcador igual al anterior se conserva (sin parpadeo cada 3 s)
  // y uno nuevo o cambiado (p. ej. una rejilla que sube de puesto) entra con una animación corta.
  useEffect(() => {
    if (!ready) return;
    const ml = libRef.current;
    const map = mapRef.current;
    const primeraVez = markerKeys.current.size === 0;
    const siguientes = new Map<string, MapLibre>();
    const reusar = (key: string, crear: () => { el: HTMLElement; coord: LngLat; anchor?: string; offset?: [number, number] }) => {
      const previo = markerKeys.current.get(key);
      if (previo) {
        markerKeys.current.delete(key);
        siguientes.set(key, previo);
        return;
      }
      const { el, coord, anchor = "center", offset = [0, 0] } = crear();
      if (!primeraVez) el.classList.add("is-nuevo");
      siguientes.set(key, new ml.Marker({ element: el, anchor, offset }).setLngLat(coord).addTo(map));
      if (el.classList.contains("paradero")) el.setAttribute("aria-label", el.title);
    };
    (props.celda?.rayos ?? []).forEach((c) =>
      reusar(`rayo|${c}`, () => {
        const el = document.createElement("div");
        el.className = "rayo";
        el.textContent = "ϟ";
        return { el, coord: c };
      }),
    );
    clicks.current.clear();
    pinesInfo.current.clear();
    // Paraderos bajo los pines de prioridad; el activo al final para que quede encima
    [...(props.paraderos ?? [])]
      .sort((a, b) => Number(!!a.activo) - Number(!!b.activo))
      .forEach((p) => {
        if (p.onClick) clicks.current.set(`par|${p.id}`, p.onClick);
        reusar(`par|${p.id}|${p.nivel}|${!!p.activo}|${p.titulo}|${p.coord}`, () => ({ el: paraderoEl(p, () => clicks.current.get(`par|${p.id}`)?.()), coord: p.coord }));
      });
    // pins: los atenuados primero para que queden debajo
    [...(props.pins ?? [])]
      .sort((a, b) => Number(!!b.faded) - Number(!!a.faded))
      .forEach((p) => {
        if (p.onClick) clicks.current.set(`pin|${p.id}`, p.onClick);
        pinesInfo.current.set(p.id, { coord: p.coord, nombre: p.nombre, sub: p.sub });
        reusar(`pin|${p.id}|${p.rank}|${p.prio}|${!!p.faded}|${p.ring ?? ""}|${!!p.onClick}|${p.coord}|${size}`, () => ({
          el: pinEl(p, size, () => clicks.current.get(`pin|${p.id}`)?.(), (dentro) => hoverRef.current?.(dentro ? p.id : null)),
          coord: p.coord,
        }));
      });
    (props.labels ?? []).forEach((l) =>
      reusar(`lbl|${l.text}|${l.sub ?? ""}|${l.tone}|${l.coord}|${l.anchor ?? ""}|${l.offset ?? ""}|${size}`, () => ({
        el: labelEl(l),
        coord: l.coord,
        anchor: l.anchor ?? "left",
        offset: l.offset ?? [size / 2 + 6, 0],
      })),
    );
    markerKeys.current.forEach((m) => m.remove());
    markerKeys.current = siguientes;
  }, [ready, props.pins, props.labels, props.celda, props.paraderos, size]);

  return (
    <div className={`map ${props.className ?? ""}`}>
      <div ref={ref} className="map__canvas" />
      {failed && <div className="map__fallback">Mapa no disponible sin conexión</div>}
      {props.children}
      {props.attribution && <div className={`map__attr map__attr--${props.attributionSide ?? "left"}`}>{props.attribution}</div>}
    </div>
  );
}

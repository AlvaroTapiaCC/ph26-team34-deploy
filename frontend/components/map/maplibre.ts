// MapLibre GL desde el paquete npm (antes, CDN de unpkg): la demo no depende de un tercero para tener mapa.
// Se importa en un chunk aparte; `precargarMapLibre()` lo pide apenas se sabe que la vista lleva mapa.
import "maplibre-gl/dist/maplibre-gl.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MapLibre = any;

let promise: Promise<MapLibre> | null = null;

export function loadMapLibre(): Promise<MapLibre> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  promise ??= import("maplibre-gl")
    .then((m) => (m as MapLibre).default ?? m)
    .catch((e) => {
      promise = null;
      throw e;
    });
  return promise;
}

export const precargarMapLibre = () => void loadMapLibre().catch(() => {});

// Mapa base: Esri World Dark Gray (Esri, HERE, Garmin, © OpenStreetMap): acompaña la paleta oscura de la central
export const BASE_STYLE = {
  version: 8,
  sources: {
    base: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 16,
    },
    ref: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 16,
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#1c1e22" } }, // paleta-ok: valor inicial; pintarMapa lo repinta con --map-bg
    { id: "base", type: "raster", source: "base", paint: { "raster-saturation": -1, "raster-opacity": 0.95 } },
    { id: "ref", type: "raster", source: "ref", paint: { "raster-opacity": 0.75 } },
  ],
};

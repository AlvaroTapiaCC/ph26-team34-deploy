// Carga MapLibre GL desde CDN (sin dependencia npm).
const VERSION = "4.7.1";
const JS = `https://unpkg.com/maplibre-gl@${VERSION}/dist/maplibre-gl.js`;
const CSS = `https://unpkg.com/maplibre-gl@${VERSION}/dist/maplibre-gl.css`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MapLibre = any;

let promise: Promise<MapLibre> | null = null;

export function loadMapLibre(): Promise<MapLibre> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.maplibregl) return Promise.resolve(w.maplibregl);
  if (promise) return promise;
  promise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CSS;
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = JS;
    s.async = true;
    s.onload = () => (w.maplibregl ? resolve(w.maplibregl) : reject(new Error("maplibregl no disponible")));
    s.onerror = () => {
      promise = null;
      reject(new Error("No se pudo cargar MapLibre"));
    };
    document.head.appendChild(s);
  });
  return promise;
}

// Mapa base: Esri World Light Gray (Esri, HERE, Garmin, © OpenStreetMap)
export const BASE_STYLE = {
  version: 8,
  sources: {
    base: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 16,
    },
    ref: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 16,
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#e8e8e6" } }, // se repinta con --map-bg (pintarMapa en DrenaMap)
    { id: "base", type: "raster", source: "base", paint: { "raster-saturation": -1, "raster-opacity": 0.95 } },
    { id: "ref", type: "raster", source: "ref", paint: { "raster-opacity": 0.75 } },
  ],
};

// Caja (bbox) de cada comuna a partir de public/data/comunas_rm.geojson, para encuadrar el mapa al filtrar por comuna.
import type { LngLat } from "./data";

type Caja = [LngLat, LngLat];
type Geom = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };

let promesa: Promise<Record<string, Caja>> | null = null;

export function cajasComunas(): Promise<Record<string, Caja>> {
  promesa ??= fetch("/data/comunas_rm.geojson")
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then((g: { features: { properties: { comuna: string }; geometry: Geom }[] }) => {
      const out: Record<string, Caja> = {};
      for (const f of g.features) {
        const anillos = f.geometry.type === "Polygon" ? f.geometry.coordinates : f.geometry.coordinates.flat();
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const anillo of anillos)
          for (const [x, y] of anillo) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
          }
        out[f.properties.comuna] = [
          [x0, y0],
          [x1, y1],
        ];
      }
      return out;
    })
    .catch(() => {
      promesa = null;
      return {};
    });
  return promesa;
}

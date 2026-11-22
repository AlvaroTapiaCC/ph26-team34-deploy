// Capas de contexto real de la zona MUT (public/data/contexto_mut.geojson, pipeline/publicar_contexto_front.py):
// infraestructura crítica de OSM (la misma que sube la consecuencia en la fórmula), colectores de aguas lluvia del
// catastro SIALL de la DOH, puntos críticos de invierno 2026 de Las Condes y el borde de la zona con ranking (700 m).
// Todo va en capas GL por debajo de los puntos del ranking: no agrega marcadores HTML ni trabajo por cuadro.

import { useCallback, useEffect, useRef } from "react";
import { colorDe, EVENTO_PALETA } from "@/lib/paleta";
import type { MapLibre } from "../map/maplibre";

export interface CapasContexto {
  infra: boolean;
  colectores: boolean;
  criticos: boolean;
}

export const TIPO_INFRA: Record<string, string> = {
  metro: "Metro",
  paso_bajo_nivel: "Paso bajo nivel",
  hospital: "Hospital",
  colegio: "Colegio",
  feria: "Feria libre",
  obra: "Obra en curso",
};

function pintar(map: MapLibre) {
  if (!map.getLayer("ctx-infra")) return;
  map.setPaintProperty("ctx-colector", "line-color", colorDe("text-2"));
  map.setPaintProperty("ctx-infra", "circle-color", [
    "match",
    ["get", "tipo"],
    "metro",
    colorDe("metro"),
    "paso_bajo_nivel",
    colorDe("secundario"),
    "hospital",
    colorDe("danger"),
    "colegio",
    colorDe("prio-media"),
    colorDe("contexto"),
  ]);
  map.setPaintProperty("ctx-infra", "circle-stroke-color", colorDe("fondo"));
  map.setPaintProperty("ctx-critico", "circle-stroke-color", colorDe("danger"));
  map.setPaintProperty("ctx-critico", "circle-color", colorDe("danger"));
}

const VIS: Record<keyof CapasContexto, string[]> = {
  infra: ["ctx-infra"],
  colectores: ["ctx-colector"],
  criticos: ["ctx-critico"],
};

export function useCapaContexto(capas: CapasContexto) {
  const mapa = useRef<MapLibre>(null);
  const capasRef = useRef(capas);
  capasRef.current = capas;

  const aplicar = useCallback(() => {
    const map = mapa.current;
    if (!map?.getLayer("ctx-infra")) return;
    for (const [k, ids] of Object.entries(VIS)) for (const id of ids) map.setLayoutProperty(id, "visibility", capasRef.current[k as keyof CapasContexto] ? "visible" : "none");
  }, []);

  useEffect(aplicar, [capas.infra, capas.colectores, capas.criticos, aplicar]);

  const onMapReady = useCallback(
    (map: MapLibre, ml: MapLibre) => {
      mapa.current = map;
      const antes = map.getLayer("puntos-brillo") ? "puntos-brillo" : undefined;
      map.addSource("ctx", { type: "geojson", data: "/data/contexto_mut.geojson" });
      map.addLayer(
        { id: "ctx-colector", type: "line", source: "ctx", filter: ["==", ["get", "capa"], "colector"], layout: { "line-cap": "round" }, paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.8, 17, 2], "line-opacity": 0.5, "line-dasharray": [1, 2] } },
        antes,
      );
      map.addLayer(
        {
          id: "ctx-infra",
          type: "circle",
          source: "ctx",
          filter: ["==", ["get", "capa"], "infra"],
          paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3, 17, 7], "circle-stroke-width": 1.5, "circle-opacity": 0.9 },
        },
        antes,
      );
      map.addLayer(
        {
          id: "ctx-critico",
          type: "circle",
          source: "ctx",
          filter: ["==", ["get", "capa"], "critico"],
          paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 7, 17, 14], "circle-opacity": 0.3, "circle-stroke-width": 3 },
        },
        antes,
      );
      pintar(map);
      aplicar();

      // Globo con el nombre y el tipo al pasar el mouse
      const globo = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "globo", maxWidth: "260px" });
      const mueve = (e: MapLibre) => {
        const f = e.features?.[0];
        if (!f) return;
        map.getCanvas().style.cursor = "default";
        const p = f.properties ?? {};
        const el = document.createElement("div");
        const b = document.createElement("b");
        b.textContent = p.capa === "infra" ? (p.nombre ?? TIPO_INFRA[p.tipo] ?? "Infraestructura") : p.capa === "critico" ? (p.nombre ?? "Anegamiento registrado") : `Colector ${p.tipo === "CERRADA" ? "cerrado" : "abierto"}`;
        const sub = document.createElement("span");
        sub.textContent = p.capa === "infra" ? `${TIPO_INFRA[p.tipo] ?? p.tipo} · ${p.fuente}` : p.capa === "critico" ? `Riesgo ${String(p.tipo ?? "sin dato").toLowerCase()} · ${p.causa ?? "causa sin dato"} · ${p.fuente}` : p.fuente;
        el.append(b, sub);
        globo.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
      };
      const sale = () => {
        map.getCanvas().style.cursor = "";
        globo.remove();
      };
      const capasHover = ["ctx-infra", "ctx-critico", "ctx-colector"];
      for (const id of capasHover) {
        map.on("mousemove", id, mueve);
        map.on("mouseleave", id, sale);
      }
      const repintar = () => pintar(map);
      window.addEventListener(EVENTO_PALETA, repintar);
      return () => {
        window.removeEventListener(EVENTO_PALETA, repintar);
        for (const id of capasHover) {
          map.off("mousemove", id, mueve);
          map.off("mouseleave", id, sale);
        }
        globo.remove();
        mapa.current = null;
      };
    },
    [aplicar],
  );

  return { onMapReady };
}

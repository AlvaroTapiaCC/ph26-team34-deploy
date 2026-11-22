import { useCallback, useEffect, useMemo, useState } from "react";
import { capaCadenas, cargarCadenas, type Tramo } from "@/lib/cadenas";
import type { ObservacionPublica } from "@/lib/central";
import type { Prioridad } from "@/lib/data";
import type { EvidenciaAgua } from "@/lib/transporte";
import type { MapLibre } from "../map/maplibre";
import { colorDe } from "@/lib/paleta";

/** Colores desde la paleta (lib/paleta.json): getters, así siguen lo editado con ?paleta=1. */
export const COLORES_CADENAS = {
  get prioridad() { return colorDe("prio-alta"); },
  get media() { return colorDe("prio-media"); },
  get red() { return colorDe("contexto"); },
  get agua() { return colorDe("agua"); },
};
const FUENTE = "cadenas-mut";
const FLECHA = "cadenas-sentido";
const VACIA = { type: "FeatureCollection", features: [] };

function instalarCapas(mapa: MapLibre) {
  const { prioridad, media, red, agua } = COLORES_CADENAS;
  const lienzo = document.createElement("canvas");
  lienzo.width = lienzo.height = 24;
  const ctx = lienzo.getContext("2d");
  if (ctx) {
    ctx.beginPath();
    ctx.moveTo(6, 4);
    ctx.lineTo(20, 12);
    ctx.lineTo(6, 20);
    ctx.closePath();
    ctx.strokeStyle = colorDe("surface");
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = colorDe("secundario");
    ctx.fill();
    mapa.addImage(FLECHA, ctx.getImageData(0, 0, 24, 24), { pixelRatio: 2 });
  }
  mapa.addSource(FUENTE, { type: "geojson", data: VACIA });
  const antesDeRuta = mapa.getLayer("esc-halo") ? "esc-halo" : undefined;
  const base = ["in", ["get", "tipo"], ["literal", ["alta", "media", "baja", "sin_prioridad"]]];
  mapa.addLayer({
    id: "cadenas-prioridad", type: "line", source: FUENTE, filter: base,
    paint: {
      "line-color": ["match", ["get", "tipo"], "alta", prioridad, "media", media, red],
      "line-width": ["match", ["get", "tipo"], "alta", 4, "media", 3, 2],
    },
  }, antesDeRuta);
  for (const [id, tipo, color, ancho, desplazamiento] of [
    ["cadenas-revisar", "obstruccion_abajo", prioridad, 4, -2],
    ["cadenas-exposicion", "agua_abajo", agua, 5, 2],
  ] as const) {
    mapa.addLayer({
      id, type: "line", source: FUENTE, filter: ["==", ["get", "tipo"], tipo],
      paint: { "line-color": color, "line-width": ancho, "line-offset": desplazamiento, "line-dasharray": [1, 1.4] },
    }, antesDeRuta);
  }
  if (ctx) {
    mapa.addLayer({
      id: "cadenas-flechas", type: "symbol", source: FUENTE, filter: base,
      layout: {
        "symbol-placement": "line-center",
        "icon-image": FLECHA,
        "icon-rotation-alignment": "map",
        "icon-keep-upright": false,
        "icon-allow-overlap": false,
      },
    });
  }
  mapa.addLayer({
    id: "cadenas-observaciones", type: "circle", source: FUENTE,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": ["match", ["get", "tipo"], "agua_observada", 17, 14],
      "circle-color": ["match", ["get", "tipo"], "agua_observada", agua, prioridad],
      "circle-opacity": 0.35,
      "circle-stroke-color": ["match", ["get", "tipo"], "agua_observada", agua, prioridad],
      "circle-stroke-width": 2.5,
    },
  });
}

export function useCapaCadenas(
  prioridades: ReadonlyMap<string, Prioridad>,
  observaciones: ObservacionPublica[],
  evidenciaAgua: readonly EvidenciaAgua[],
  visible: boolean,
  vigenciaAguaH: number,
  alcanceAguaM: number,
) {
  const [mapa, setMapa] = useState<MapLibre>(null);
  const [tramos, setTramos] = useState<Tramo[] | null>(null);
  const [estado, setEstado] = useState<"cargando" | "ok" | "error">("cargando");
  const [ahora, setAhora] = useState(Date.now);
  const datos = useMemo(
    () => visible && tramos
      ? capaCadenas(tramos, prioridades, observaciones, evidenciaAgua, Math.max(ahora, Date.now()), vigenciaAguaH, alcanceAguaM)
      : null,
    [visible, tramos, prioridades, observaciones, evidenciaAgua, ahora, vigenciaAguaH, alcanceAguaM],
  );

  const onMapReady = useCallback((mapaListo: MapLibre) => {
    instalarCapas(mapaListo);
    setMapa(mapaListo);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let vigente = true;
    cargarCadenas().then((tramos) => {
      if (!vigente) return;
      setTramos(tramos);
      setEstado("ok");
    }).catch(() => {
      if (vigente) setEstado("error");
    });
    return () => { vigente = false; };
  }, [visible]);

  useEffect(() => {
    if (!datos) return;
    // Mantiene la revisión de obstrucciones cada 30 s y retira el agua justo al vencer.
    const hastaVencimiento = Math.ceil(datos.proximoVencimientoAgua - Date.now());
    const espera = Math.min(30_000, Math.max(0, hastaVencimiento));
    const reloj = setTimeout(() => setAhora(Date.now()), espera);
    return () => clearTimeout(reloj);
  }, [datos]);

  useEffect(() => {
    mapa?.getSource(FUENTE)?.setData(datos?.geojson ?? VACIA);
  }, [mapa, datos]);

  return { estado, onMapReady, haySimulados: datos?.haySimulados ?? false };
}

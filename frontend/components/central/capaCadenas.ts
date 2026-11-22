import { useCallback, useEffect, useMemo, useState } from "react";
import { capaCadenas, cargarCadenas, type Tramo } from "@/lib/cadenas";
import type { ObservacionPublica } from "@/lib/central";
import type { Prioridad } from "@/lib/data";
import type { EvidenciaAgua } from "@/lib/transporte";
import type { MapLibre } from "../map/maplibre";
import { colorDe, EVENTO_PALETA } from "@/lib/paleta";

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

/** Flecha de sentido de la cadena, con los colores vigentes de la paleta. */
function flechaImagen(): ImageData | null {
  const lienzo = document.createElement("canvas");
  lienzo.width = lienzo.height = 24;
  const ctx = lienzo.getContext("2d");
  if (!ctx) return null;
  // Chevrón fino (›), no un triángulo: indica sentido sin competir con los puntos del ranking
  ctx.beginPath();
  ctx.moveTo(8, 6);
  ctx.lineTo(16, 12);
  ctx.lineTo(8, 18);
  ctx.strokeStyle = colorDe("secundario");
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  return ctx.getImageData(0, 0, 24, 24);
}

/**
 * Colores de las capas de cadenas desde la paleta. Se llama al instalarlas y cada vez que cambia la
 * paleta (EVENTO_PALETA), así líneas, observaciones y flecha cambian sin recargar.
 */
function pintarCadenas(mapa: MapLibre) {
  const { prioridad, media, red, agua } = COLORES_CADENAS;
  const set = (id: string, prop: string, valor: unknown) => mapa.getLayer(id) && mapa.setPaintProperty(id, prop, valor);
  set("cadenas-prioridad", "line-color", ["match", ["get", "tipo"], "alta", prioridad, "media", media, red]);
  set("cadenas-revisar", "line-color", prioridad);
  set("cadenas-exposicion", "line-color", agua);
  set("cadenas-observaciones", "circle-color", ["match", ["get", "tipo"], "agua_observada", agua, prioridad]);
  set("cadenas-observaciones", "circle-stroke-color", ["match", ["get", "tipo"], "agua_observada", agua, prioridad]);
  const flecha = flechaImagen();
  if (flecha && mapa.hasImage(FLECHA)) mapa.updateImage(FLECHA, flecha);
}

function instalarCapas(mapa: MapLibre) {
  const flecha = flechaImagen();
  if (flecha) mapa.addImage(FLECHA, flecha, { pixelRatio: 2 });
  mapa.addSource(FUENTE, { type: "geojson", data: VACIA });
  const antesDeRuta = mapa.getLayer("esc-halo") ? "esc-halo" : undefined;
  const base = ["in", ["get", "tipo"], ["literal", ["alta", "media", "baja", "sin_prioridad"]]];
  mapa.addLayer({
    id: "cadenas-prioridad", type: "line", source: FUENTE, filter: base,
    paint: {
      "line-width": ["match", ["get", "tipo"], "alta", 4, "media", 3, 2],
    },
  }, antesDeRuta);
  for (const [id, tipo, ancho, desplazamiento] of [
    ["cadenas-revisar", "obstruccion_abajo", 4, -2],
    ["cadenas-exposicion", "agua_abajo", 5, 2],
  ] as const) {
    mapa.addLayer({
      id, type: "line", source: FUENTE, filter: ["==", ["get", "tipo"], tipo],
      paint: { "line-width": ancho, "line-offset": desplazamiento, "line-dasharray": [1, 1.4] },
    }, antesDeRuta);
  }
  // Flechas y observaciones van por debajo de los puntos del ranking (si existen) para no taparlos
  const bajoPuntos = mapa.getLayer("puntos-brillo") ? "puntos-brillo" : undefined;
  if (flecha) {
    mapa.addLayer({
      id: "cadenas-flechas", type: "symbol", source: FUENTE, filter: base,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 70,
        "icon-image": FLECHA,
        "icon-size": 0.85,
        "icon-rotation-alignment": "map",
        "icon-keep-upright": false,
        "icon-allow-overlap": false,
      },
      paint: { "icon-opacity": 0.6 },
    }, bajoPuntos);
  }
  mapa.addLayer({
    id: "cadenas-observaciones", type: "circle", source: FUENTE,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": ["match", ["get", "tipo"], "agua_observada", 17, 14],
      "circle-opacity": 0.35,
      "circle-stroke-width": 2.5,
    },
  }, bajoPuntos);
  pintarCadenas(mapa);
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

  // Paleta editable (#131): repinta las cadenas sin recrear las capas
  useEffect(() => {
    if (!mapa) return;
    const repintar = () => pintarCadenas(mapa);
    window.addEventListener(EVENTO_PALETA, repintar);
    return () => window.removeEventListener(EVENTO_PALETA, repintar);
  }, [mapa]);

  return { estado, onMapReady, haySimulados: datos?.haySimulados ?? false };
}

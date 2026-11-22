"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LngLat, Prioridad } from "@/lib/data";
import { BASE_STYLE, loadMapLibre, type MapLibre } from "./maplibre";

export interface MapPin {
  id: string;
  coord: LngLat;
  rank: number | string;
  prio: Prioridad | "anegado";
  faded?: boolean;
  ring?: "dashed" | "flood";
  realRing?: "ok" | "miss";
  onClick?: () => void;
}

export interface MapLabel {
  coord: LngLat;
  text: string;
  sub?: string;
  tone: "card" | "pill" | "danger" | "dark" | "area";
  offset?: [number, number];
  anchor?: "left" | "right" | "top" | "bottom" | "center" | "top-left" | "bottom-left";
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
  chain?: LngLat[] | null;
  limites?: LngLat[][] | null;
  area?: LngLat[] | null;
  celda?: { poly: LngLat[]; rayos: LngLat[]; link: [LngLat, LngLat] } | null;
  gore?: LngLat[] | null;
  comunas?: boolean; // límites comunales reales (public/data/comunas.geojson)
  rejillas?: boolean; // catastro de rejillas MOP, agrupadas en zoom bajo (public/data/rejillas.geojson)
  reales?: { coord: LngLat; conTop: boolean }[] | null;
  paraderos?: MapParadero[] | null; // transporte: expuestos, en riesgo y alternativos (#92)
  recorridos?: LngLat[][] | null; // trazado de los servicios afectados
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

const HEX = "M20 3 L34.7 11.5 L34.7 28.5 L20 37 L5.3 28.5 L5.3 11.5 Z";
const COLORS: Record<string, string> = {
  alta: "var(--prio-alta)",
  media: "var(--prio-media)",
  baja: "var(--prio-baja)",
  anegado: "var(--danger)",
};

function pinEl(p: MapPin, size: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "pin" + (p.faded ? " pin--faded" : "") + (p.onClick ? " pin--click" : "");
  el.style.width = el.style.height = `${size}px`;
  const fill = COLORS[p.prio];
  let shape = "";
  if (p.prio === "alta") shape = `<path d="${HEX}" fill="${fill}" stroke="var(--bg)" stroke-width="3" stroke-linejoin="round"/>`;
  else if (p.prio === "media")
    shape = `<rect x="7" y="7" width="26" height="26" rx="4" transform="rotate(45 20 20)" fill="${fill}" stroke="var(--bg)" stroke-width="3"/>`;
  else shape = `<circle cx="20" cy="20" r="17" fill="${fill}" stroke="var(--bg)" stroke-width="3"/>`;
  const txt = p.prio === "anegado" ? "≋" : String(p.rank);
  el.innerHTML = `<svg viewBox="0 0 40 40" width="${size}" height="${size}">${shape}</svg><span class="pin__n">${txt}</span>`;
  if (p.ring === "dashed") {
    const r = document.createElement("span");
    r.className = "pin__ring";
    el.appendChild(r);
  }
  if (p.ring === "flood") {
    el.insertAdjacentHTML("afterbegin", `<span class="pin__flood pin__flood--1"></span><span class="pin__flood pin__flood--2"></span><span class="pin__flood pin__flood--3"></span>`);
  }
  if (p.realRing) {
    const r = document.createElement("span");
    r.className = "pin__real";
    el.appendChild(r);
  }
  if (p.onClick) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      p.onClick!();
    });
  }
  return el;
}

const PARADERO_SIGNO = { expuesto: "≋", en_riesgo: "!", alternativo: "↪" } as const;

function paraderoEl(p: MapParadero): HTMLElement {
  const el = document.createElement("div");
  el.className = `paradero paradero--${p.nivel}` + (p.activo ? " is-active" : "") + (p.onClick ? " pin--click" : "");
  el.title = p.titulo;
  el.setAttribute("aria-label", p.titulo);
  el.innerHTML = `<span class="paradero__bus">BUS</span><span class="paradero__signo">${PARADERO_SIGNO[p.nivel]}</span>`;
  if (p.onClick) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      p.onClick!();
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

const fc = (features: unknown[]) => ({ type: "FeatureCollection", features });
const line = (c: LngLat[]) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: c } });
const poly = (c: LngLat[]) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...c, c[0]]] } });

export default function DrenaMap(props: DrenaMapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre>(null);
  const libRef = useRef<MapLibre>(null);
  const markers = useRef<MapLibre[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const size = props.pinSize ?? 40;

  // Capas extra de quien usa el mapa (p. ej. las cadenas de la central).
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
          dragRotate: false,
          pitchWithRotate: false,
        });
        map.touchZoomRotate.disableRotation();
        mapRef.current = map;
        map.once("style.load", () => {
          const add = (id: string) => map.addSource(id, { type: "geojson", data: fc([]) });
          ["esc", "chain", "lim", "area", "celda", "celda-link", "gore", "rec", "caminata"].forEach(add);
          map.addSource("comunas", { type: "geojson", data: "/data/comunas.geojson" });
          map.addSource("rejillas", { type: "geojson", data: "/data/rejillas.geojson", cluster: true, clusterMaxZoom: 15, clusterRadius: 40 });
          map.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": "#FF3D0A", "fill-opacity": 0.16 } });
          map.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": "#FF3D0A", "line-width": 2, "line-opacity": 0.9, "line-dasharray": [3, 2] } });
          map.addLayer({ id: "celda-fill", type: "fill", source: "celda", paint: { "fill-color": "#1B1B1B", "fill-opacity": 0.14 } });
          map.addLayer({ id: "celda-line", type: "line", source: "celda", paint: { "line-color": "#1B1B1B", "line-width": 2, "line-dasharray": [3, 2] } });
          map.addLayer({ id: "celda-link", type: "line", source: "celda-link", paint: { "line-color": "#1B1B1B", "line-width": 3, "line-opacity": 0.8, "line-dasharray": [1.5, 1.5] } });
          map.addLayer({ id: "lim", type: "line", source: "lim", paint: { "line-color": "#5A5A57", "line-width": 2, "line-opacity": 0.8, "line-dasharray": [4, 3] } });
          // Colores = tokens de globals.css (--text-2, --prio-baja, --surface-3, --surface); MapLibre no lee variables CSS.
          const hidden = { visibility: "none" };
          map.addLayer({ id: "comunas-line", type: "line", source: "comunas", layout: hidden, paint: { "line-color": "#5A5A57", "line-width": 1.75, "line-opacity": 0.9 } });
          map.addLayer({
            id: "rej-cluster",
            type: "circle",
            source: "rejillas",
            filter: ["has", "point_count"],
            layout: hidden,
            // Anillo hueco: no se confunde con los pines de prioridad, que son figuras rellenas con número.
            paint: {
              "circle-color": "#FFFFFF",
              "circle-opacity": 0.25,
              "circle-stroke-color": "#5A5A57",
              "circle-stroke-width": 2,
              "circle-radius": ["step", ["get", "point_count"], 9, 10, 12, 50, 16, 200, 21],
            },
          });
          map.addLayer({
            id: "rej-point",
            type: "circle",
            source: "rejillas",
            filter: ["!", ["has", "point_count"]],
            layout: hidden,
            paint: { "circle-radius": 2.5, "circle-color": "#767672", "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 0.75 },
          });
          // Transporte: azul fuera de la paleta de prioridad para no confundir un recorrido con escurrimiento.
          map.addLayer({ id: "rec-line", type: "line", source: "rec", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#1F5FBF", "line-width": 3, "line-opacity": 0.55 } });
          map.addLayer({ id: "caminata", type: "line", source: "caminata", layout: { "line-cap": "round" }, paint: { "line-color": "#1F5FBF", "line-width": 2.5, "line-dasharray": [0.5, 2] } });
          map.addLayer({ id: "esc-halo", type: "line", source: "esc", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#FF3D0A", "line-width": 9, "line-opacity": 0.14 } });
          map.addLayer({ id: "esc-line", type: "line", source: "esc", paint: { "line-color": "#FF3D0A", "line-width": 2, "line-opacity": 0.85, "line-dasharray": [2.5, 2.5] } });
          map.addLayer({ id: "chain-halo", type: "line", source: "chain", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#FF3D0A", "line-width": 14, "line-opacity": 0.2 } });
          map.addLayer({ id: "chain-line", type: "line", source: "chain", paint: { "line-color": "#FF3D0A", "line-width": 3, "line-dasharray": [1.5, 1.5] } });
          map.addLayer({ id: "gore", type: "circle", source: "gore", paint: { "circle-radius": 4, "circle-color": "#5A5A57", "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 1.5 } });
          setReady(true);
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      markers.current.forEach((m) => m.remove());
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Encuadre
  useEffect(() => {
    if (!ready) return;
    mapRef.current.fitBounds(props.bounds, { padding: props.padding ?? 40, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, JSON.stringify(props.bounds)]);

  // Capas vectoriales
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const set = (id: string, data: unknown) => map.getSource(id)?.setData(data);
    set("esc", fc((props.lines ?? []).map(line)));
    set("chain", fc(props.chain ? [line(props.chain)] : []));
    set("lim", fc((props.limites ?? []).map(line)));
    set("area", fc(props.area ? [poly(props.area)] : []));
    set("celda", fc(props.celda ? [poly(props.celda.poly)] : []));
    set("celda-link", fc(props.celda ? [line(props.celda.link)] : []));
    set("rec", fc((props.recorridos ?? []).map(line)));
    set("caminata", fc((props.caminatas ?? []).map(line)));
    set("gore", fc((props.gore ?? []).map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }))));
  }, [ready, props.lines, props.chain, props.limites, props.area, props.celda, props.gore, props.recorridos, props.caminatas]);

  // Visibilidad de las capas de datos reales
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const vis = (ids: string[], on?: boolean) => ids.forEach((id) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
    vis(["comunas-line"], props.comunas);
    vis(["rej-cluster", "rej-point"], props.rejillas);
  }, [ready, props.comunas, props.rejillas]);

  // Marcadores HTML
  useEffect(() => {
    if (!ready) return;
    const ml = libRef.current;
    const map = mapRef.current;
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    const add = (el: HTMLElement, coord: LngLat, anchor = "center", offset: [number, number] = [0, 0]) => {
      markers.current.push(new ml.Marker({ element: el, anchor, offset }).setLngLat(coord).addTo(map));
    };
    (props.reales ?? []).forEach((r) => {
      const el = document.createElement("div");
      el.className = `real-ring real-ring--${r.conTop ? "ok" : "miss"}`;
      if (!r.conTop) el.innerHTML = "<span>✕</span>";
      add(el, r.coord);
    });
    (props.celda?.rayos ?? []).forEach((c) => {
      const el = document.createElement("div");
      el.className = "rayo";
      el.textContent = "ϟ";
      add(el, c);
    });
    // Paraderos bajo los pines de prioridad; el activo al final para que quede encima
    [...(props.paraderos ?? [])].sort((a, b) => Number(!!a.activo) - Number(!!b.activo)).forEach((p) => add(paraderoEl(p), p.coord));
    // pins: los atenuados primero para que queden debajo
    [...(props.pins ?? [])].sort((a, b) => Number(!!b.faded) - Number(!!a.faded)).forEach((p) => add(pinEl(p, size), p.coord));
    (props.labels ?? []).forEach((l) => add(labelEl(l), l.coord, l.anchor ?? "left", l.offset ?? [size / 2 + 6, 0]));
  }, [ready, props.pins, props.labels, props.reales, props.celda, props.paraderos, size]);

  return (
    <div className={`map ${props.className ?? ""}`}>
      <div ref={ref} className="map__canvas" />
      {failed && <div className="map__fallback">Mapa no disponible sin conexión</div>}
      {props.children}
      {props.attribution && <div className={`map__attr map__attr--${props.attributionSide ?? "left"}`}>{props.attribution}</div>}
    </div>
  );
}

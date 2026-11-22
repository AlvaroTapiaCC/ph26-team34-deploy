import { useCallback, useEffect, useRef } from "react";
import type { ReporteMapa } from "@/lib/reportesMapa";
import { colorDe, EVENTO_PALETA } from "@/lib/paleta";
import { horaSantiago } from "@/lib/transporte";
import type { MapLibre } from "../map/maplibre";

const SOURCE = "reportes-mapa";
const VACIA = { type: "FeatureCollection", features: [] };
const TIPOS = ["agua", "obstruccion", "reporte", "despejada"] as const;

function icono(tipo: ReporteMapa["tipo"], simulado: boolean) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.scale(2, 2);
  g.fillStyle = colorDe("surface");
  g.beginPath();
  g.arc(16, 16, 11, 0, 2 * Math.PI);
  g.fill();
  g.strokeStyle = colorDe(tipo === "agua" ? "agua" : tipo === "obstruccion" ? "danger" : tipo === "despejada" ? "prio-baja" : "text-2");
  g.lineWidth = 2;
  g.lineCap = "round";
  g.beginPath();
  if (tipo === "agua") {
    for (const y of [12, 16, 20]) {
      g.moveTo(10, y);
      g.bezierCurveTo(13, y - 3, 19, y + 3, 22, y);
    }
  } else if (tipo === "obstruccion") {
    g.rect(10, 10, 12, 12);
    g.moveTo(11, 11); g.lineTo(21, 21);
    g.moveTo(21, 11); g.lineTo(11, 21);
  } else if (tipo === "despejada") {
    g.moveTo(10, 16); g.lineTo(14, 20); g.lineTo(22, 11);
  } else {
    g.moveTo(16, 10); g.lineTo(16, 17);
    g.moveTo(16, 21); g.lineTo(16, 21.2);
  }
  g.stroke();
  if (simulado) {
    g.fillStyle = colorDe("surface");
    g.fillRect(20, 0, 12, 12);
    g.fillStyle = colorDe("secundario");
    g.font = "bold 11px sans-serif";
    g.fillText("S", 22, 10);
  }
  return g.getImageData(0, 0, 64, 64);
}

/** Evidencia separada del ranking: anillos y símbolos estáticos, sin animación por cuadro. */
export function useCapaReportes(reportes: ReporteMapa[], visible: boolean, onSelect: (id: string) => void) {
  const mapa = useRef<MapLibre>(null);
  const refs = useRef({ reportes, visible, onSelect });
  refs.current = { reportes, visible, onSelect };
  const popup = useRef<MapLibre>(null);
  const ultimaFirma = useRef<string | null>(null);
  const actualizar = useCallback(() => {
    const map = mapa.current;
    if (!map?.getSource(SOURCE)) return;
    const { reportes, visible } = refs.current;
    const firma = JSON.stringify({ reportes, visible });
    if (firma === ultimaFirma.current) return;
    ultimaFirma.current = firma;
    map.getSource(SOURCE).setData(visible ? {
      type: "FeatureCollection",
      features: reportes.map((r) => ({ type: "Feature", geometry: { type: "Point", coordinates: r.coord }, properties: { id: r.id, tipo: r.tipo, icono: `reporte-${r.tipo}-${r.simulado}` } })),
    } : VACIA);
    // No dejar en pantalla un reporte sustituido, vencido o de una capa que se ocultó.
    popup.current?.remove();
  }, []);
  useEffect(actualizar, [reportes, visible, actualizar]);

  const onMapReady = useCallback((map: MapLibre, ml: MapLibre) => {
    mapa.current = map;
    ultimaFirma.current = null;
    map.addSource(SOURCE, { type: "geojson", data: VACIA });
    map.addLayer({
      id: SOURCE, type: "circle", source: SOURCE,
      paint: { "circle-radius": 12, "circle-opacity": 0.18, "circle-stroke-width": 2.5 },
    });
    const pintar = () => {
      const color = ["match", ["get", "tipo"], "agua", colorDe("agua"), "obstruccion", colorDe("danger"), "despejada", colorDe("prio-baja"), colorDe("text-2")];
      map.setPaintProperty(SOURCE, "circle-color", color);
      map.setPaintProperty(SOURCE, "circle-stroke-color", color);
      for (const tipo of TIPOS) for (const simulado of [false, true]) {
        const id = `reporte-${tipo}-${simulado}`;
        if (map.hasImage(id)) map.updateImage(id, icono(tipo, simulado));
        else map.addImage(id, icono(tipo, simulado), { pixelRatio: 2 });
      }
    };
    pintar();
    map.addLayer({ id: "reportes-iconos", type: "symbol", source: SOURCE, layout: { "icon-image": ["get", "icono"], "icon-allow-overlap": true } });
    actualizar();
    popup.current = new ml.Popup({ closeButton: true, closeOnClick: true, offset: 16, className: "globo", maxWidth: "290px" });
    const abrir = (e: MapLibre) => {
      const r = refs.current.reportes.find((r) => r.id === e.features?.[0]?.properties?.id);
      if (!r) return;
      const el = document.createElement("div");
      const titulo = document.createElement("b");
      titulo.textContent = `${r.simulado ? "SIMULADO · " : ""}${r.titulo}`;
      const captura = document.createElement("span");
      captura.textContent = `${r.fuente} · ${new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", day: "numeric", month: "short" }).format(new Date(r.ts))}, ${horaSantiago(r.ts)}`;
      const nota = document.createElement("span");
      nota.textContent = `${r.ubicacion}. Último reporte recibido, no confirma cierre del cruce.`;
      el.append(titulo, captura, nota);
      if (r.sumideroId && r.rankeado) {
        const boton = document.createElement("button");
        boton.type = "button";
        boton.textContent = "Ver prioridad de la rejilla →";
        boton.style.cssText = "margin-top:8px;text-decoration:underline;text-align:left;color:inherit";
        boton.onclick = () => refs.current.onSelect(r.sumideroId!);
        el.append(boton);
      }
      popup.current.setLngLat(r.coord).setDOMContent(el).addTo(map);
    };
    const entrar = () => { map.getCanvas().style.cursor = "pointer"; };
    const salir = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", SOURCE, abrir);
    map.on("mouseenter", SOURCE, entrar);
    map.on("mouseleave", SOURCE, salir);
    window.addEventListener(EVENTO_PALETA, pintar);
    return () => {
      map.off("click", SOURCE, abrir);
      map.off("mouseenter", SOURCE, entrar);
      map.off("mouseleave", SOURCE, salir);
      window.removeEventListener(EVENTO_PALETA, pintar);
      popup.current?.remove();
      mapa.current = null;
    };
  }, [actualizar]);
  return { onMapReady };
}

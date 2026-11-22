"use client";

// Recorrido guiado "¿Cómo leer esto?": 4 pasos con la cámara animada (easeTo). No arranca solo (tapaba el mapa al abrir):
// se abre desde el botón "?" de la barra del mapa. Se sigue marcando como visto en localStorage.
import { useEffect, useRef, useState } from "react";
import type { LngLat } from "@/lib/data";
import { FLUJO_CONFIG, LLUVIA_RECORRIDO } from "@/lib/flujo/config";
import type { Flujo } from "@/lib/flujo/useFlujo";
import { useStore } from "@/lib/store";

const CLAVE = "drena.recorrido.visto";
const CENTRO_ZONA: LngLat = [-70.6014, -33.4177]; // centro del MUT (zona de la red de calles)

export function recorridoVisto(): boolean {
  try {
    return window.localStorage.getItem(CLAVE) === "1";
  } catch {
    return false; // sin acceso al almacenamiento: se muestra, pero no rompe nada
  }
}

function marcarVisto() {
  try {
    window.localStorage.setItem(CLAVE, "1");
  } catch {
    /* sin almacenamiento: se volverá a mostrar la próxima vez */
  }
}

type Candidata = NonNullable<Awaited<ReturnType<Flujo["candidataRecorrido"]>>>;

export default function Recorrido({ flujo, cerca, onTresD, onFin }: { flujo: Flujo; cerca: LngLat[]; onTresD: (v: boolean) => void; onFin: () => void }) {
  const { setRejillas } = useStore();
  const [paso, setPaso] = useState(0);
  const [cand, setCand] = useState<Candidata | null>(null);
  const flujoRef = useRef(flujo);
  flujoRef.current = flujo;
  const ter = FLUJO_CONFIG.terreno;

  useEffect(() => {
    const f = flujoRef.current;
    const map = f.mapa();
    if (!map) return;
    let destino: { center: LngLat; zoom: number; pitch: number } | null = null;
    if (paso === 0) {
      onTresD(true);
      f.seleccionar(null);
      f.setLluvia(LLUVIA_RECORRIDO);
      f.reiniciar();
      f.reproducir(60);
      destino = { center: CENTRO_ZONA, zoom: 13.9, pitch: ter.pitch };
    } else if (paso === 1) {
      destino = { center: [-70.588, -33.421], zoom: 12.7, pitch: 62 };
    } else if (paso === 3 && cand) {
      destino = { center: [(cand.coord[0] + 2 * cand.destino[0]) / 3, (cand.coord[1] + 2 * cand.destino[1]) / 3], zoom: 16, pitch: 58 };
    }
    const ir = (d: { center: LngLat; zoom: number; pitch: number }) => {
      // Relieve 3D solo en las vistas amplias (pasos 1 y 2, donde se ve la cordillera). En los primeros planos, MapLibre 4.7
      // deja la cámara bajo el relieve si sus teselas no alcanzaron a cargar: ahí se sigue en perspectiva, sin terreno.
      // La cámara se detiene antes de cambiar el terreno: cambiarlo en medio de una animación congela el render.
      map.stop();
      map.setTerrain(paso <= 1 ? { source: "dem-terreno", exaggeration: ter.exageracion } : null);
      map.easeTo({ ...d, bearing: ter.bearing, duration: 2400, essential: true });
    };
    if (paso === 2) {
      // La rejilla la elige el motor (corre en un worker): llega un instante después
      let vivo = true;
      f.candidataRecorrido(cerca).then((c) => {
        if (!vivo) return;
        setCand(c);
        if (!c) return;
        setRejillas({ [c.id]: "tapada" });
        f.seleccionar(c.id);
        f.pulsar(c.id);
        ir({ center: c.coord, zoom: 16.3, pitch: ter.pitch });
      });
      return () => {
        vivo = false;
      };
    }
    if (destino) ir(destino);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paso]);

  const terminar = () => {
    // Vuelve el relieve 3D (el recorrido lo apaga en los primeros planos)
    const map = flujoRef.current.mapa();
    if (map) {
      map.stop();
      map.setTerrain({ source: "dem-terreno", exaggeration: ter.exageracion });
    }
    marcarVisto();
    onFin();
  };
  const pasos = [
    { t: `Llueve ${LLUVIA_RECORRIDO} mm/h en la zona`, d: "Lluvia supuesta de la demo. El azul es el agua que escurre por las calles." },
    { t: "El agua baja por la pendiente hacia el poniente", d: "La cordillera queda arriba. Más grueso y más oscuro: más agua junta en la calle." },
    { t: "Esta rejilla está tapada", d: "Tapada, traga casi nada: el agua que le llega sigue de largo por la calle." },
    {
      t: `El agua no cabe en la calle y llega a ${cand?.calle ?? "la calle de abajo"}`,
      d: "En el color principal, el agua que ya no cabe (estimado). La columna marca dónde se acumula (estimado) y la flecha muestra hacia dónde se va. Por eso esta rejilla se limpia primero.",
    },
  ];
  const p = pasos[paso];
  const ultimo = paso === pasos.length - 1;
  return (
    <div className="recorrido" role="dialog" aria-label="¿Cómo leer esto?">
      <div className="recorrido__top">
        <span className="recorrido__n">
          {paso + 1} de {pasos.length}
        </span>
        <span className="recorrido__puntos" aria-hidden>
          {pasos.map((_, i) => (
            <i key={i} className={i <= paso ? "is-on" : ""} />
          ))}
        </span>
      </div>
      <h3 className="recorrido__t">{p.t}</h3>
      <p className="recorrido__d">{p.d}</p>
      {paso === 2 && !cand && <p className="recorrido__d">No encontré una rejilla que acumule agua (estimado) al taparla con esta lluvia.</p>}
      <div className="recorrido__btns">
        <button className="recorrido__saltar" onClick={terminar}>
          Saltar
        </button>
        <button className="recorrido__sig" onClick={() => (ultimo ? terminar() : setPaso(paso + 1))}>
          {ultimo ? "Listo" : "Siguiente"}
        </button>
      </div>
    </div>
  );
}

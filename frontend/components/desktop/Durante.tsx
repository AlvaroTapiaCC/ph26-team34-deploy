"use client";

import { useMemo } from "react";
import { CELDA, ESCURRIMIENTO, MAP_BOUNDS, PUNTOS, RAYOS, type LngLat } from "@/lib/data";
import { useStore } from "@/lib/store";
import DrenaMap, { type MapLabel, type MapPin } from "../map/DrenaMap";
import { Button, Check, EstadoChip, Kicker, PrioChip, Toast } from "../ui";

export function SensorCard() {
  const { s, set, dispararReporte } = useStore();
  const anegado = s.sensor === "anegado" && s.anegado ? PUNTOS[s.anegado] : null;
  if (s.sensor === "caido") {
    return (
      <section className="sensor sensor--down">
        <div className="sensor__top">
          <span className="sensor__dot" />
          <Kicker tone="danger">Sensor ESP32 · sin señal</Kicker>
          <span className="sensor__ago">{s.sensorAgo || "hace 5 min"}</span>
        </div>
        <h2 className="sensor__title">No llegan datos del sensor</h2>
        <p className="sensor__body">“Simular reporte” solo cambia la pantalla; “Disparar reporte” pasa por el simulador del backend. Firebase no responde.</p>
        <div className="row-btns">
          <Button variant="danger" onClick={() => set({ markMode: !s.markMode })}>
            {s.markMode ? "Toca un punto del mapa" : "Marcar anegado"}
          </Button>
          <Button variant="primary" onClick={() => set({ modal: "simular" })}>
            Simular reporte
          </Button>
          <Button onClick={() => void dispararReporte()}>Disparar reporte</Button>
        </div>
      </section>
    );
  }
  return (
    <section className={`sensor ${s.markMode ? "is-marking" : ""}`}>
      <div className="sensor__top">
        <span className={`sensor__dot ${anegado ? "is-live" : ""}`} />
        <Kicker tone="accent">En vivo · sensor ESP32</Kicker>
        <span className="sensor__ago">{anegado ? s.sensorAgo : "escuchando"}</span>
      </div>
      <h2 className="sensor__title">{anegado ? `Anegado en ${anegado.nombre}` : "Sin anegamientos reportados"}</h2>
      <p className="sensor__body">
        {anegado ? "El sensor marcó el punto. Se iluminan los puntos que reciben su agua." : "Marca un punto en el mapa o espera el sensor para ver qué viene aguas abajo."}
      </p>
      <div className="row-btns">
        <Button variant="danger" onClick={() => set({ markMode: !s.markMode })}>
          {s.markMode ? "Toca un punto del mapa" : "Marcar anegado"}
        </Button>
        <Button onClick={() => set({ modal: "simular" })}>Simular reporte</Button>
        <Button variant="primary" onClick={() => void dispararReporte()}>
          Disparar reporte
        </Button>
      </div>
    </section>
  );
}

function Feed() {
  const { s } = useStore();
  return (
    <section className="card feed">
      <Kicker>Reportes</Kicker>
      {s.reportes.map((r) =>
        r.foto ? (
          <div key={r.id} className="feed__photo">
            <div className="photo" style={{ backgroundImage: "url(/img/sumidero-thumb.jpg)" }} />
            <div>
              <span className="feed__name">{r.nombre}</span>
              <span className="feed__meta">{r.fuente}</span>
              <EstadoChip estado={r.estado} />
            </div>
          </div>
        ) : (
          <div key={r.id} className="feed__row">
            <div>
              <span className="feed__name">{r.nombre}</span>
              <span className="feed__meta">{r.fuente}</span>
            </div>
            <EstadoChip estado={r.estado} />
          </div>
        ),
      )}
    </section>
  );
}

function Cadena() {
  const { cadena, set } = useStore();
  if (!cadena.length) {
    return (
      <section className="card chain">
        <Kicker tone="accent">Aguas abajo · en orden de recorrido</Kicker>
        <div className="empty">
          <div className="empty__icon">≋</div>
          <div className="empty__title">Aún no hay cadena que mostrar</div>
          <div className="empty__body">Aparece al marcar un punto anegado.</div>
        </div>
      </section>
    );
  }
  return (
    <section className="card chain is-active">
      <Kicker tone="accent">Aguas abajo · en orden de recorrido</Kicker>
      {cadena.map((p, i) => (
        <div key={p.id} className="crow">
          <span className="ord">{i + 1}°</span>
          <div>
            <span className="crow__name">{p.nombre}</span>
            <span className="crow__meta">
              Ranking #{p.rank} · {p.comuna}
            </span>
          </div>
          <PrioChip prio={p.prio} />
        </div>
      ))}
      <p className="chain__note">Muestra el orden del recorrido, no minutos de llegada: el modelo de 30 m no los calcula con precisión.</p>
      <Button variant="primary" className="btn--block" onClick={() => set({ toast: `Simulación: no se envió ningún aviso real · ${cadena.length} puntos` })}>
        Simular aviso a cuadrillas de estos {cadena.length} puntos
      </Button>
    </section>
  );
}

function DuranteMap() {
  const { s, ranking, cadena, toggleLayer, flood } = useStore();
  const L = s.layers;
  const an = s.anegado ? PUNTOS[s.anegado] : null;
  const chainIds = cadena.map((p) => p.id);

  // Sin anegamiento: top 6 de la lista visibles (como en el diseño)
  const pins: MapPin[] = useMemo(() => {
    const base: MapPin[] = ranking
      .filter((p) => (an ? true : [1, 2, 5, 6, 10].includes(p.rank)))
      .filter((p) => p.id !== s.anegado)
      .map((p) => ({
        id: p.id,
        coord: p.coord,
        rank: p.rank,
        prio: p.prio,
        faded: !!an && !chainIds.includes(p.id),
        onClick: s.markMode ? () => flood(p.id, "manual") : undefined,
      }));
    if (an) base.push({ id: "flood", coord: an.coord, rank: "≋", prio: "anegado", ring: "flood" } as MapPin);
    return base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranking, s.anegado, s.markMode, chainIds.join()]);

  const labels: MapLabel[] = [];
  if (an) {
    labels.push({ coord: an.coord, text: `Anegado · ${an.nombre}`, tone: "danger", offset: [30, 0] });
    if (L.cadena) cadena.forEach((p, i) => labels.push({ coord: p.coord, text: `${i + 1}° ${p.nombre}`, tone: "pill", anchor: "top-left", offset: [10, 14] }));
  }
  const chain: LngLat[] | null = an && L.cadena ? [an.coord, ...cadena.map((p) => p.coord)] : null;
  const lines = an ? [] : ESCURRIMIENTO.slice(0, 2);
  const celda = L.rayos ? { poly: CELDA, rayos: RAYOS, link: [CELDA[5], an ? an.coord : [-70.5935, -33.4335]] as [LngLat, LngLat] } : null;
  const celdaLabel: MapLabel[] = L.rayos ? [{ coord: CELDA[0], text: "Celda convectiva · GOES-19 · 17:40", tone: "dark", anchor: "left", offset: [-30, 0] }] : [];

  return (
    <DrenaMap
      className="map--durante"
      bounds={MAP_BOUNDS}
      padding={{ top: 40, bottom: 40, left: 40, right: 40 }}
      pins={L.prioridad ? pins : pins.filter((p) => p.id === "flood")}
      labels={[...labels, ...celdaLabel]}
      lines={lines}
      chain={chain}
      celda={celda}
      attribution={`Base: Esri, HERE, Garmin, © OpenStreetMap${L.rayos ? " · rayos: NOAA GOES-19 GLM (ilustrativo)" : ""} · ubicaciones aproximadas`}
    >
      {s.markMode && <div className="marking-hint">Toca el punto anegado en el mapa</div>}
      {an && L.feed && <Toast className="map-toast" text={`Reporte del sensor · ${an.nombre}`} />}
      <div className="legend">
        <Kicker>Capas</Kicker>
        <Check on={L.prioridad} label="Puntos por prioridad" onClick={() => toggleLayer("prioridad")} />
        <Check on={L.cadena && !!an} label="Cadena aguas abajo" onClick={() => toggleLayer("cadena")} />
        <Check on={L.rayos} label="Rayos GOES-19 (casi tiempo real)" onClick={() => toggleLayer("rayos")} />
        <Check on={L.feed} label="Reportes del feed" onClick={() => toggleLayer("feed")} />
      </div>
    </DrenaMap>
  );
}

export default function Durante() {
  return (
    <main className="bento">
      <div className="col col--l is-narrow">
        <SensorCard />
        <Feed />
        <Cadena />
      </div>
      <div className="col col--r">
        <DuranteMap />
      </div>
    </main>
  );
}

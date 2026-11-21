"use client";

import { useMemo } from "react";
import { cita, ESCURRIMIENTO, fmt, GORE, MAP_BOUNDS, motivo, pad2, SCENARIOS, TOTAL_INTERSECCIONES, type RankedPunto } from "@/lib/data";
import { useStore } from "@/lib/store";
import DrenaMap, { type MapLabel, type MapPin } from "../map/DrenaMap";
import { Button, Check, Kicker, PrioChip, Stat } from "../ui";

export function Hero({ p }: { p: RankedPunto }) {
  const { set, addRuta, scenarioLabel } = useStore();
  return (
    <section className="card hero">
      <div className="hero__head">
        <div className="rank-big">{pad2(p.rank)}</div>
        <div className="hero__txt">
          <Kicker tone="accent">▲ Atender primero · {scenarioLabel}</Kicker>
          <h1 className="hero__title">{p.nombre}</h1>
          <p className="hero__sub">
            {p.comuna} · {p.cerca}
          </p>
        </div>
      </div>
      <div className="stats3">
        <Stat value={`${p.pctExterno} %`} label={`del agua viene de ${p.origen ?? p.comuna}`} accent />
        <Stat value={`${fmt(p.area)} km²`} label="área de aporte" />
        <Stat value={fmt(p.score)} label="puntaje" />
      </div>
      <p className="hero__quote">{cita(p)}</p>
      <div className="row-btns">
        <Button variant="primary" onClick={() => addRuta(p.id)}>
          Agregar a la ruta
        </Button>
        <Button onClick={() => set({ ficha: p.id })}>Ver ficha</Button>
      </div>
    </section>
  );
}

export function RankRow({ p, onClick }: { p: RankedPunto; onClick: () => void }) {
  return (
    <button className="rrow" onClick={onClick}>
      <span className="rrow__rank">{pad2(p.rank)}</span>
      <span className="rrow__txt">
        <span className="rrow__name">{p.nombre}</span>
        <span className="rrow__why">{motivo(p)}</span>
      </span>
      <span className="rrow__num rrow__pct">
        <b>{p.pctExterno} %</b>
        <small>externo</small>
      </span>
      <span className="rrow__num rrow__score">
        <b className="is-accent">{fmt(p.score)}</b>
        <small>puntaje</small>
      </span>
      <PrioChip prio={p.prio} />
    </button>
  );
}

function Table({ rows }: { rows: RankedPunto[] }) {
  const { s, set } = useStore();
  const cut = s.cuadrillas * 2;
  const meta = s.comuna === "Todas" ? `${rows.length + 1} de ${TOTAL_INTERSECCIONES.toLocaleString("es-CL")} intersecciones` : `${rows.length + 1} puntos en ${s.comuna}`;
  return (
    <section className="card table">
      <div className="table__head">
        <Kicker>Tabla de prioridades</Kicker>
        <span className="meta">{meta}</span>
      </div>
      <div className="table__rows">
        {rows.map((p, i) => (
          <div key={p.id} style={{ display: "contents" }}>
            <RankRow p={p} onClick={() => set({ ficha: p.id })} />
            {s.comuna !== "Todas" && i + 2 === cut && i < rows.length - 1 && (
              <div className="cutline">
                Alcanza para {s.cuadrillas} cuadrillas · {cut} puntos
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Bottom() {
  const { s, set, ruta } = useStore();
  const sc = SCENARIOS.find((x) => x.id === s.scenario)!;
  return (
    <div className="bottom">
      <div className="tile tile--accent">
        <Kicker tone="light">Agua que viene de otra comuna</Kicker>
        <div className="tile__big">{sc.aguaExterna} %</div>
        <p className="tile__p">promedio del top 30</p>
      </div>
      <div className="tile tile--dark">
        <Kicker tone="accent">Puntos críticos en el top 30</Kicker>
        <div className="tile__big">{sc.criticosTop30}</div>
        <p className="tile__p">metro · pasos bajo nivel · hospitales o colegios</p>
      </div>
      <div className="tile tile--plain">
        <Kicker>Lo que no hace</Kicker>
        <p className="tile__body">No recomienda cerrar calles ni desviar agua, ni muestra profundidades o minutos de llegada.</p>
      </div>
      <div className="tile tile--grey">
        <Kicker>Ruta de cuadrilla</Kicker>
        <p className="tile__body">{ruta.paradas.length} {ruta.paradas.length === 1 ? "punto" : "puntos"} de {s.comuna === "Todas" ? "todas las comunas" : s.comuna} ({s.cuadrillas} {s.cuadrillas === 1 ? "cuadrilla" : "cuadrillas"}), en orden.</p>
        <Button variant="primary" className="btn--block" onClick={() => set({ modal: "ruta" })}>
          Generar ruta · {ruta.paradas.length} {ruta.paradas.length === 1 ? "punto" : "puntos"}
        </Button>
      </div>
    </div>
  );
}

export function usePins(opts: { labelsTop?: number; ring?: boolean; onPin?: (id: string) => void } = {}) {
  const { s, ranking, set } = useStore();
  return useMemo(() => {
    const top = opts.labelsTop ?? 3;
    const inComuna = (p: RankedPunto) => s.comuna === "Todas" || p.comuna === s.comuna;
    const visible = ranking.filter(inComuna);
    const pins: MapPin[] = ranking.map((p) => ({
      id: p.id,
      coord: p.coord,
      rank: p.rank,
      prio: p.prio,
      faded: !inComuna(p),
      ring: opts.ring !== false && p.id === visible[0]?.id ? "dashed" : undefined,
      onClick: () => (opts.onPin ? opts.onPin(p.id) : set({ ficha: p.id })),
    }));
    const labels: MapLabel[] = visible.slice(0, top).map((p) => ({ coord: p.coord, text: p.nombre, tone: "card" }));
    return { pins, labels };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranking, s.comuna, opts.labelsTop, opts.ring]);
}

function MainMap() {
  const { s, toggleLayer } = useStore();
  const { pins, labels } = usePins();
  const L = s.layers;
  return (
    <DrenaMap
      className="map--main"
      bounds={MAP_BOUNDS}
      padding={{ top: 30, bottom: 30, left: 60, right: 60 }}
      pins={L.prioridad ? pins : []}
      labels={L.prioridad ? labels : []}
      lines={L.escurrimiento ? ESCURRIMIENTO : []}
      comunas={L.limites}
      rejillas={L.rejillas}
      gore={L.gore ? GORE : null}
      attribution="Base: Esri, HERE, Garmin, © OpenStreetMap · ubicaciones aproximadas"
    >
      <div className="legend">
        <Kicker>Capas</Kicker>
        <Check on={L.prioridad} label="Puntos por prioridad" onClick={() => toggleLayer("prioridad")} />
        <Check on={L.escurrimiento} label="Líneas de escurrimiento" onClick={() => toggleLayer("escurrimiento")} />
        <Check on={L.limites} label="Límites comunales" onClick={() => toggleLayer("limites")} />
        <Check on={L.gore} label="175 puntos críticos GORE" onClick={() => toggleLayer("gore")} />
        <Check on={L.rejillas} label="Rejillas (catastro MOP)" onClick={() => toggleLayer("rejillas")} />
        <div className="legend__chips">
          <PrioChip prio="alta" />
          <PrioChip prio="media" />
          <PrioChip prio="baja" />
        </div>
      </div>
    </DrenaMap>
  );
}

export default function Antes({ vacio }: { vacio: React.ReactNode }) {
  const { filtered } = useStore();
  const hasAlta = filtered.some((p) => p.prio === "alta");
  if (!hasAlta) {
    return (
      <main className="bento">
        <div className="col col--l">{vacio}</div>
        <div className="col col--r">
          <DrenaMap className="map--main" bounds={MAP_BOUNDS} attribution="Base: Esri, HERE, Garmin, © OpenStreetMap" />
        </div>
      </main>
    );
  }
  const [hero, ...rest] = filtered;
  return (
    <main className="bento">
      <div className="col col--l">
        <Hero p={hero} />
        <Table rows={rest} />
      </div>
      <div className="col col--r">
        <MainMap />
        <Bottom />
      </div>
    </main>
  );
}

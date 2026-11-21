"use client";

import { useMemo } from "react";
import { areaAporte, ESCURRIMIENTO, fmt, instruccion, LIMITES, MAP_BOUNDS, pad2, statsPunto, type LngLat } from "@/lib/data";
import { NOMBRE_VARIABLE } from "@/lib/real";
import { useStore } from "@/lib/store";
import DrenaMap, { type MapLabel, type MapPin } from "../map/DrenaMap";
import { Button, Kicker, Stat } from "../ui";

export function CriticidadPill({ text }: { text: string }) {
  const metro = text.startsWith("Ⓜ");
  return (
    <span className="pill">
      {metro && <span className="metro">M</span>}
      {metro ? text.slice(2) : text}
    </span>
  );
}

/** Variables de la fórmula de un punto real (GET /sumideros/{id}): qué pesa en el puntaje. */
export function VariablesReales() {
  const { fichaReal, fichaEstado } = useStore();
  return (
    <div>
      <Kicker>Qué pesa en el puntaje</Kicker>
      {fichaEstado === "cargando" && <p className="downstream">Cargando variables…</p>}
      {fichaEstado === "error" && <p className="downstream">No se pudo cargar el detalle de este punto.</p>}
      {fichaReal && fichaReal.variables.length === 0 && <p className="downstream">Sin variables cargadas para este sumidero todavía.</p>}
      {fichaReal && fichaReal.variables.length > 0 && (
        <div className="vars">
          {fichaReal.variables.map((v) => (
            <div key={v.clave} className="vars__row">
              <span>{NOMBRE_VARIABLE[v.clave] ?? v.clave}</span>
              <span className="vars__bar">
                <span style={{ width: `${Math.min(100, v.valor * 200)}%` }} />
              </span>
              <b>{fmt(v.valor)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Ficha() {
  const { s, set, ranking, scenarioLabel, addRuta, totalPuntos, fichaReal } = useStore();
  const p = ranking.find((x) => x.id === s.ficha)!;
  const real = !!p.real;
  // Los datos reales aún no traen el polígono del área de aporte: no se dibuja uno inventado
  const area = useMemo(() => (real ? [] : areaAporte(p)), [p, real]);

  const pins: MapPin[] = useMemo(
    () =>
      (ranking.length > 100 ? [...ranking.slice(0, 100), ...(p.rank > 100 ? [p] : [])] : ranking).map((x) => ({
        id: x.id,
        coord: x.coord,
        rank: x.rank,
        prio: x.prio,
        faded: x.id !== p.id,
        onClick: () => set({ ficha: x.id }),
      })),
    [ranking, p.id, set],
  );
  const areaCallout: LngLat = useMemo(() => {
    if (area.length === 0) return p.coord;
    const xs = area.map((c) => c[0]);
    const ys = area.map((c) => c[1]);
    return [Math.max(...xs) - (Math.max(...xs) - Math.min(...xs)) * 0.32, (Math.max(...ys) + Math.min(...ys)) / 2 + (Math.max(...ys) - Math.min(...ys)) * 0.05];
  }, [area, p.coord]);
  const labels: MapLabel[] = real
    ? [{ coord: p.coord, text: `${pad2(p.rank)} · ${p.nombre}`, tone: "card" }]
    : [
        { coord: p.coord, text: `${pad2(p.rank)} · ${p.nombre}`, tone: "card" },
        { coord: areaCallout, text: `Área de aporte · ${fmt(p.area)} km²`, sub: `${p.pctExterno} % viene de ${p.origen ?? p.comuna}`, tone: "area", anchor: "center", offset: [0, 0] },
        { coord: [-70.5985, -33.4262], text: "Límite comunal (aprox.)", tone: "dark", anchor: "center", offset: [0, 0] },
      ];
  const bounds: [LngLat, LngLat] = real
    ? [
        [p.coord[0] - 0.006, p.coord[1] - 0.004],
        [p.coord[0] + 0.006, p.coord[1] + 0.004],
      ]
    : [
        [Math.min(p.coord[0], ...area.map((c) => c[0])) - 0.02, Math.min(...area.map((c) => c[1])) - 0.012],
        [Math.max(...area.map((c) => c[0])) + 0.012, Math.max(...area.map((c) => c[1])) + 0.012],
      ];
  const local = 100 - p.pctExterno;
  const criticidad = real ? (fichaReal?.criticidad ?? []) : p.criticidad;
  const textoIa = real ? (fichaReal?.explicacion ?? p.real?.explicacion ?? null) : "ejemplo";

  return (
    <main className="bento">
      <div className="col col--l">
        <section className="card ficha">
          <div className="ficha__head">
            <div className="rank-md">{pad2(p.rank)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 className="ficha__title">{p.nombre}</h1>
              <p className="ficha__sub">
                {p.comuna} · {real ? p.cerca : `id ${p.nodeId}`} · escenario {scenarioLabel}
              </p>
            </div>
            <Button className="btn--icon" onClick={() => set({ ficha: null })} aria-label="Cerrar ficha">
              ✕
            </Button>
          </div>
          <div className="photo" style={{ height: 250, backgroundImage: "url(/img/sumidero-ficha.jpg)" }}>
            <span className="photo__tag">Foto referencial · Unsplash</span>
          </div>
          <div className="stats3">
            {real ? (
              statsPunto(p).map((st, i) => <Stat key={st.label} inset="soft" value={st.value} label={st.label} accent={i === 2} />)
            ) : (
              <>
                <Stat inset="soft" value={`${fmt(p.area)} km²`} label="área de aporte" />
                <Stat inset="soft" value={fmt(p.score)} label="puntaje" accent />
                <Stat inset="soft" value={`#${p.rank}`} label={`de ${totalPuntos.toLocaleString("es-CL")}`} />
              </>
            )}
          </div>
          {real ? (
            <VariablesReales />
          ) : (
            <div>
              <div className="origin__head">
                <Kicker>Origen del agua</Kicker>
                <span className="origin__pct">{p.pctExterno} % externa</span>
              </div>
              <div className="origin__bar">
                <span style={{ width: `${p.pctExterno}%` }} />
              </div>
              <div className="origin__legend">
                <span className="is-accent">■ {p.origen ?? "Otras comunas"} {p.pctExterno} %</span>
                <span>
                  ■ {p.comuna} {local} %
                </span>
              </div>
            </div>
          )}
          <div>
            <Kicker>Criticidad cerca</Kicker>
            <div className="pills">
              {criticidad.map((c) => (
                <CriticidadPill key={c} text={c} />
              ))}
              {real && fichaReal && criticidad.length === 0 && <span className="downstream">Sin datos de criticidad</span>}
            </div>
          </div>
          <div className="instr">
            <Kicker tone="accent">Instrucción</Kicker>
            <p>{instruccion(p)}</p>
            {textoIa && <small>Explicación basada en los datos del ranking.</small>}
          </div>
          <div>
            <Kicker>Aguas abajo (en orden)</Kicker>
            <p className="downstream">
              {real ? (fichaReal ? (fichaReal.aguasAbajo.length ? fichaReal.aguasAbajo.join("  →  ") : "Sin cadena aguas abajo registrada") : "…") : p.aguasAbajo.join("  →  ")}
            </p>
          </div>
          <div className="ficha__spacer" />
          <div className="row-btns">
            <Button variant="primary" onClick={() => addRuta(p.id)}>
              Agregar a la ruta
            </Button>
            <Button onClick={() => set({ ficha: null, selected: p.id })}>Ver en mapa</Button>
          </div>
        </section>
      </div>
      <div className="col col--r">
        <DrenaMap
          className="map--main"
          bounds={bounds ?? MAP_BOUNDS}
          padding={40}
          pins={pins}
          labels={labels}
          lines={real ? [] : ESCURRIMIENTO}
          area={real ? null : area}
          limites={real ? [] : [LIMITES[0]]}
          attribution="Base: Esri, HERE, Garmin, © OpenStreetMap · ubicaciones y área aproximadas"
          attributionSide="right"
        />
      </div>
    </main>
  );
}

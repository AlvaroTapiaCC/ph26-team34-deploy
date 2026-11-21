"use client";

import { useEffect, useMemo, useState } from "react";
import { cajasComunas } from "@/lib/comunas";
import { cita, GORE, MAP_BOUNDS, motivo, pad2, PUNTOS, statsPunto, type LngLat, type RankedPunto } from "@/lib/data";
import { ESTADOS, type EstadoRejilla } from "@/lib/flujo/config";
import { useFlujo, type Flujo } from "@/lib/flujo/useFlujo";
import { boundsDe } from "@/lib/real";
import { useStore } from "@/lib/store";
import DrenaMap, { type MapLabel, type MapPin } from "../map/DrenaMap";
import { Button, Check, Chevron, Kicker, PrioChip, Stat } from "../ui";
import SimPanel, { SimAviso } from "./SimPanel";

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
        {statsPunto(p).map((st, i) => (
          <Stat key={st.label} value={st.value} label={st.label} accent={i === 0} />
        ))}
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
        {p.real ? (
          <>
            <b>{p.real.sumideros.length}</b>
            <small>{p.real.sumideros.length === 1 ? "sumidero" : "sumideros"}</small>
          </>
        ) : (
          <>
            <b>{p.pctExterno} %</b>
            <small>externo</small>
          </>
        )}
      </span>
      <PrioChip prio={p.prio} />
    </button>
  );
}

const FILAS_MAX = 100; // con datos reales hay ~2.000 intersecciones: la tabla muestra las primeras

function Table({ rows: todas }: { rows: RankedPunto[] }) {
  const { s, set, totalPuntos } = useStore();
  const cut = s.cuadrillas * 2;
  const rows = todas.slice(0, FILAS_MAX);
  const total = todas.length + 1;
  const mostradas = total > FILAS_MAX ? ` · primeras ${FILAS_MAX}` : "";
  const meta = (s.comuna === "Todas" ? `${total} de ${totalPuntos.toLocaleString("es-CL")} intersecciones` : `${total} puntos en ${s.comuna}`) + mostradas;
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
                Alcanza para {s.cuadrillas} {s.cuadrillas === 1 ? "cuadrilla" : "cuadrillas"} · {cut} puntos
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// Infraestructura crítica que cuenta en la tarjeta "Puntos críticos"
const CRITICA = /metro|paso bajo nivel|hospital|colegio/i;
const TOP = 30;

function Tile({ tone, titulo, cifra, unidad, children, accion }: { tone: string; titulo: string; cifra: string; unidad?: string; children: React.ReactNode; accion?: React.ReactNode }) {
  return (
    <div className={`tile tile--${tone}`}>
      <div className="tile__head">
        <span className="tile__t">{titulo}</span>
        {accion}
      </div>
      <div className="tile__row">
        <span className="tile__big">
          {cifra}
          {unidad && <small>{unidad}</small>}
        </span>
        <span className="tile__p">{children}</span>
      </div>
    </div>
  );
}

function Bottom({ flujo }: { flujo: Flujo }) {
  const { s, set, ruta, filtered } = useStore();
  const real = filtered[0]?.real ? filtered : null;
  const nSumideros = real ? real.reduce((a, p) => a + p.real!.sumideros.length, 0) : 0;
  const top = filtered.slice(0, TOP);
  const aguaExterna = top.length ? Math.round(top.reduce((a, p) => a + p.pctExterno, 0) / top.length) : 0;
  const criticos = top.filter((p) => p.criticidad.some((c) => CRITICA.test(c)));
  const { tapadas, total, lecturas } = flujo.ui;
  const c = s.comuna;
  const nTap = tapadas[c] ?? 0;
  const nTot = total[c] ?? 0;
  const nDesb = c === "Todas" ? lecturas.desbordados : (lecturas.desbordadosPorComuna[c] ?? 0);
  const n = ruta.paradas.length;
  return (
    <div className="bottom">
      {real ? (
        <>
          <Tile tone="accent" titulo="Sumideros evaluados" cifra={nSumideros.toLocaleString("es-CL")}>
            en {real.length.toLocaleString("es-CL")} intersecciones
          </Tile>
          <Tile tone="dark" titulo="Prioridad alta" cifra={String(real.filter((p) => p.prio === "alta").length)}>
            intersecciones: el 10 % más alto del ranking
          </Tile>
        </>
      ) : (
        <>
          <Tile tone="accent" titulo="Agua de otra comuna" cifra={String(aguaExterna)} unidad="%">
            promedio del top {TOP}
          </Tile>
          <Tile tone="dark" titulo="Puntos críticos" cifra={String(criticos.length)} >
            con metro, paso bajo nivel, hospital o colegio cerca
          </Tile>
        </>
      )}
      <Tile tone="plain" titulo="Rejillas tapadas" cifra={nTot ? String(nTap) : "—"}>
        {nTot ? (
          <>
            de {nTot.toLocaleString("es-CL")} · <b className={nDesb ? "is-accent" : ""}>{nDesb} con agua ahora (estimado)</b>
          </>
        ) : (
          `sin rejillas simuladas en ${c}`
        )}
      </Tile>
      <Tile
        tone="grey"
        titulo="Ruta de cuadrilla"
        cifra={String(n)}
        accion={
          <Button variant="primary" className="tile__btn" onClick={() => set({ modal: "ruta" })}>
            Generar ruta
          </Button>
        }
      >
        {n === 1 ? "punto" : "puntos"} · {s.cuadrillas} {s.cuadrillas === 1 ? "cuadrilla" : "cuadrillas"}
      </Tile>
    </div>
  );
}

function usePins() {
  const { s, ranking, set } = useStore();
  return useMemo(() => {
    const visible = ranking.filter((p) => s.comuna === "Todas" || p.comuna === s.comuna);
    const pins: MapPin[] = visible.map((p, i) => ({
      id: p.id,
      coord: p.coord,
      rank: p.rank,
      prio: p.prio,
      ring: i === 0 ? "dashed" : undefined,
      onClick: () => set({ ficha: p.id }),
    }));
    const labels: MapLabel[] = visible.slice(0, 3).map((p) => ({ coord: p.coord, text: p.nombre, tone: "card" }));
    return { pins, labels };
  }, [ranking, s.comuna, set]);
}

/** Encuadre del mapa: toda la zona o la comuna elegida (caja de comunas_rm.geojson). */
const TOP_ENCUADRE = 30; // con datos reales el mapa se ajusta a las primeras intersecciones de la lista

function useEncuadre(): [LngLat, LngLat] {
  const { s, filtered } = useStore();
  const real = !!filtered[0]?.real;
  const cajaReal = useMemo(() => (real ? boundsDe(filtered.slice(0, TOP_ENCUADRE)) : null), [real, filtered]);
  const [cajas, setCajas] = useState<Record<string, [LngLat, LngLat]>>({});
  useEffect(() => {
    let vivo = true;
    cajasComunas().then((c) => vivo && setCajas(c));
    return () => {
      vivo = false;
    };
  }, []);
  return cajaReal ?? ((s.comuna !== "Todas" && cajas[s.comuna]) || MAP_BOUNDS);
}

/** Capas del mapa. Plegable: en pantallas angostas parte cerrada para no tapar el mapa. */
function Capas() {
  const { s, toggleLayer, ranking } = useStore();
  const real = !!ranking[0]?.real;
  const [abierta, setAbierta] = useState(() => window.innerWidth > 1400);
  const L = s.layers;
  return (
    <div className={`legend legend--capas ${abierta ? "" : "is-closed"}`}>
      <button className="legend__toggle" onClick={() => setAbierta(!abierta)} aria-expanded={abierta}>
        <Kicker>Capas</Kicker>
        <Chevron open={abierta} />
      </button>
      {abierta && (
        <>
          <Check on={L.prioridad} label="Puntos por prioridad" onClick={() => toggleLayer("prioridad")} />
          <Check on={L.escurrimiento} label="Flujo de agua (estimado)" onClick={() => toggleLayer("escurrimiento")} />
          <Check on={L.limites} label="Límites comunales" onClick={() => toggleLayer("limites")} />
          {!real && <Check on={L.gore} label="175 puntos críticos GORE" onClick={() => toggleLayer("gore")} />}
          <Check on={L.rejillas} label="Catastro MOP completo" onClick={() => toggleLayer("rejillas")} />
          <div className="legend__chips">
            <PrioChip prio="alta" />
            <PrioChip prio="media" />
            <PrioChip prio="baja" />
          </div>
        </>
      )}
    </div>
  );
}

function MainMap({ flujo }: { flujo: Flujo }) {
  const { s, ranking } = useStore();
  const real = !!ranking[0]?.real;
  const { pins, labels } = usePins();
  const bounds = useEncuadre();
  const L = s.layers;
  // El panel de simulación ocupa ~290 px a la derecha: el encuadre lo deja libre
  const ancho = window.innerWidth > 1400;
  return (
    <DrenaMap
      className="map--main"
      bounds={bounds}
      padding={{ top: 40, bottom: 40, left: ancho ? 240 : 40, right: 300 }}
      pins={L.prioridad ? pins : []}
      labels={L.prioridad ? labels : []}
      comunas={L.limites}
      rejillas={L.rejillas}
      gore={L.gore && !real ? GORE : null}
      attribution="Base: Esri, HERE, Garmin, © OpenStreetMap · ubicaciones aproximadas"
      attributionSide="right"
      onMapReady={flujo.alMapaListo}
    >
      <Capas />
      <SimPanel flujo={flujo} />
      <SimAviso />
    </DrenaMap>
  );
}

// Puntos de ejemplo con su nombre y posición, para asociarlos con las rejillas de la red de flujo
const PUNTOS_EJEMPLO = Object.values(PUNTOS).map((p) => ({ id: p.id, nombre: p.nombre, coord: p.coord }));
const PUNTOS_FLUJO_MAX = 200; // intersecciones reales que se asocian con la red (las más prioritarias)

export default function Principal({ vacio }: { vacio: React.ReactNode }) {
  const { s, setRejillas, filtered, ranking } = useStore();
  const real = !!ranking[0]?.real;
  const puntosFlujo = useMemo(() => (real ? ranking.slice(0, PUNTOS_FLUJO_MAX).map((p) => ({ id: p.id, nombre: p.nombre, coord: p.coord })) : PUNTOS_EJEMPLO), [real, ranking]);
  const flujo = useFlujo({
    scenario: s.scenario,
    puntos: puntosFlujo,
    estados: s.rejillas,
    visible: s.layers.escurrimiento,
    // Clic en una rejilla: limpia → parcial → tapada → limpia
    onClickRejilla: (id) => {
      const actual: EstadoRejilla = flujo.estadoDe(id) ?? "limpia";
      setRejillas({ [id]: ESTADOS[(ESTADOS.indexOf(actual) + 1) % ESTADOS.length] });
    },
  });
  // Con datos reales siempre hay lista (aunque todavía no haya prioridades altas)
  const hasAlta = filtered.length > 0 && (!!filtered[0].real || filtered.some((p) => p.prio === "alta"));
  const [hero, ...rest] = filtered;
  return (
    <main className="bento">
      <div className="col col--l">
        {hasAlta ? (
          <>
            <Hero p={hero} />
            <Table rows={rest} />
          </>
        ) : (
          vacio
        )}
      </div>
      <div className="col col--r">
        <MainMap flujo={flujo} />
        <Bottom flujo={flujo} />
      </div>
    </main>
  );
}

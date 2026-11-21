"use client";

import { useState } from "react";
import { ANEGAMIENTOS_REALES, MAP_BOUNDS, SCENARIOS } from "@/lib/data";
import { useStore } from "@/lib/store";
import DrenaMap from "../map/DrenaMap";
import { Button, Kicker } from "../ui";
import { usePins } from "./Antes";

export function Validacion() {
  const [on, setOn] = useState(true);
  const { pins } = usePins({ labelsTop: 0, ring: false });
  return (
    <main className="bento">
      <div className="col col--l is-narrow">
        <section className="result">
          <Kicker tone="accent">Validación · Temporal de octubre de 2026</Kicker>
          <div className="result__big">
            <span className="result__x">[X]</span>
            <span className="result__y">de [Y]</span>
          </div>
          <p className="result__lead">anegamientos reales tienen una intersección del top 30 a menos de 150 m.</p>
          <p className="result__note">La fórmula se fijó antes de mirar estos datos. Las cifras se completan al correr el pipeline.</p>
        </section>
        <section className="card cmp">
          <Kicker>Contra qué se compara</Kicker>
          <div className="cmp__row">
            <span>Drena · top 30</span>
            <span className="mono is-accent">[X] de [Y]</span>
          </div>
          <div className="cmp__row">
            <span>Mapa de riesgo estático 2026</span>
            <span className="mono">[X] de [Y]</span>
          </div>
          <div className="cmp__row">
            <span>Orden por llamadas</span>
            <span className="mono">[X] de [Y]</span>
          </div>
        </section>
        <section className="card sources">
          <Kicker>Anegamientos reales · fuentes</Kicker>
          <ul>
            <li>· Prensa de octubre de 2026</li>
            <li>· @TTISantiago</li>
            <li>· 175 puntos críticos · Gobierno de Santiago (secundaria)</li>
          </ul>
          <p className="risk">La comparación es preliminar y depende de cuántos reportes se puedan ubicar.</p>
        </section>
      </div>
      <div className="col col--r">
        <DrenaMap
          className="map--main map--valid"
          bounds={MAP_BOUNDS}
          padding={{ top: 40, bottom: 40, left: 40, right: 40 }}
          pins={pins.map((p) => ({ ...p, faded: false }))}
          reales={on ? ANEGAMIENTOS_REALES : null}
          attribution="Base: Esri, HERE, Garmin, © OpenStreetMap"
          attributionSide="right"
        >
          <div className="legend">
            <button className="lg-row" onClick={() => setOn(!on)} aria-pressed={on}>
              <span className={`toggle ${on ? "is-on" : ""}`} />
              <b>Capa de anegamientos reales</b>
            </button>
            <div className="lg-row">
              <span className="lg-ring" />
              Real con punto del top 30 a &lt; 150 m
            </div>
            <div className="lg-row">
              <span className="lg-ring lg-ring--miss" />
              Real sin punto del top 30 cerca
            </div>
            <p className="lg-note">Posiciones de reportes ilustrativas hasta cargar el GeoJSON</p>
          </div>
        </DrenaMap>
      </div>
    </main>
  );
}

export function Metodologia() {
  const datos = [
    ["Catastro de sumideros", "DOH · SIALL"],
    ["Elevación y calles", "DEM de 12,5 m · OpenStreetMap y OSMnx"],
    ["Infraestructura crítica", "OpenStreetMap · Gobierno de Santiago"],
    ["Cobertura de suelo", "Sentinel-2 · ESA WorldCover"],
    ["Lluvia y viento", "Open-Meteo (pronóstico) · DMC (lluvia observada)"],
    ["Ferias de Ñuñoa", "Calendario de ferias"],
    ["Anegamientos de octubre de 2026", "Prensa y @TTISantiago · validación histórica"],
  ];
  return (
    <main className="method">
      <div className="method__row method__row--a">
        <section className="formula">
          <Kicker tone="accent">Puntaje de prioridad</Kicker>
          <div className="formula__eq">Prioridad = P<sub>ef</sub> × C</div>
          <div className="formula__term">
            <b>P<sub>ef</sub></b>Probabilidad efectiva de obstrucción. Considera las observaciones y el arrastre desde aguas arriba.
          </div>
          <div className="formula__term">
            <b>C</b>Consecuencia estimada según el área que aporta agua al sumidero y la infraestructura crítica cercana.
          </div>
          <p className="formula__ia">
            <strong>La fórmula decide. Claude ve, lee y explica.</strong>{" "}
            Claude interpreta fotos de vecinos y cuadrillas, reportes escritos e imágenes de la cámara de la demo. Con esa evidencia explica por qué se prioriza cada sumidero.
          </p>
        </section>
        <section className="nots">
          <Kicker tone="ink">Lo que no hace, a propósito</Kicker>
          <p className="nots__item"><span aria-hidden="true">✕</span>No recomienda cerrar calles ni mantenerlas abiertas.</p>
          <p className="nots__item"><span aria-hidden="true">✕</span>No recomienda desviar agua.</p>
        </section>
      </div>
      <div className="method__row method__row--b">
        <section className="card pipeline">
          <Kicker>Fases del evento</Kicker>
          <p className="step">
            <span><strong>Antes.</strong> Priorizar los sumideros que conviene limpiar y preparar las rutas de las cuadrillas.</span>
          </p>
          <p className="step">
            <span><strong>Durante.</strong> Recalcular prioridades y rutas a partir de las observaciones.</span>
          </p>
          <p className="step">
            <span>
              <strong>Nivel de agua observado.</strong> Ajusta la consecuencia estimada. Las categorías son sin agua,
              en la cuneta, hasta la vereda, sobre la vereda y no evaluable.
            </span>
          </p>
          <p className="step">
            <span><strong>Después.</strong> Verificar los cierres con fotos y resumir qué funcionó durante el evento.</span>
          </p>
        </section>
        <section className="card datos">
          <Kicker>Datos públicos</Kicker>
          {datos.map(([k, v]) => (
            <div key={k} className="datos__row">
              <b>{k}</b>
              <span>{v}</span>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

export function Cargando() {
  return (
    <main className="bento">
      <div className="col col--l">
        <section className="card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14, flex: "none" }}>
          <div style={{ display: "flex", gap: 16 }}>
            <div className="skel" style={{ width: 72, height: 72, borderRadius: 18 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 10, justifyContent: "center" }}>
              <div className="skel" style={{ width: 180, height: 12 }} />
              <div className="skel" style={{ width: 320, height: 28 }} />
              <div className="skel" style={{ width: 220, height: 12 }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skel" style={{ width: 170, height: 72, borderRadius: 14 }} />
            ))}
          </div>
          <div className="skel" style={{ width: 540, maxWidth: "100%", height: 14 }} />
          <div className="skel" style={{ width: 420, height: 14 }} />
          <div className="skel" style={{ width: 540, maxWidth: "100%", height: 44, borderRadius: 10 }} />
        </section>
        <section className="card" style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="skel" style={{ width: 200, height: 12 }} />
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="skel" style={{ width: 536, maxWidth: "100%", height: 56, borderRadius: 14 }} />
          ))}
        </section>
      </div>
      <div className="col col--r">
        <div className="loading-map">
          <div className="spinner" />
          <h3>Cargando prioridades del escenario…</h3>
          <p>Leyendo puntos.geojson y escurrimiento.geojson</p>
        </div>
      </div>
    </main>
  );
}

export function ErrorDatos() {
  const { reload } = useStore();
  return (
    <main className="bento">
      <section className="error">
        <div className="error__icon">!</div>
        <h2>No se pudieron leer los datos</h2>
        <p>El archivo puntos.geojson no respondió. La última lista guardada es de las 13:40.</p>
        <div className="row-btns">
          <Button variant="primary" onClick={reload}>
            Reintentar
          </Button>
          <Button onClick={reload}>Ver última lista (13:40)</Button>
        </div>
      </section>
    </main>
  );
}

export function Vacio() {
  const { s, set } = useStore();
  const sc = SCENARIOS.find((x) => x.id === s.scenario)!;
  return (
    <section className="card vacio">
      <div className="vacio__icon">○</div>
      <h2>Sin puntos de prioridad alta</h2>
      <p>
        En {s.comuna} no hay intersecciones sobre el umbral para “{sc.label}”.
      </p>
      <Button variant="primary" onClick={() => set({ comuna: "Todas" })}>
        Ver todas las comunas
      </Button>
    </section>
  );
}

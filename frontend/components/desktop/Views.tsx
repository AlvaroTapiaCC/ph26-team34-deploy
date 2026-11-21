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
          <Kicker tone="accent">Validación · 13 de octubre de 2026</Kicker>
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
            <li>· Prensa del 13 y 14 de octubre</li>
            <li>· @TTISantiago</li>
            <li>· 175 puntos críticos · Gobierno de Santiago (secundaria)</li>
          </ul>
          <p className="risk">Riesgo: si son menos de 10 puntos ubicables, la validación pierde fuerza. Se muestra igual, con el límite del DEM de 30 m.</p>
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
  const pasos = [
    "Recortar DEM GLO-30 con margen hacia la precordillera",
    "Rebajar 2–3 m las celdas que son calle en OSM",
    "pysheds: rellenar depresiones, dirección D8, acumulación C × lluvia",
    "Repetir solo con celdas fuera de la comuna → % de agua externa",
    "Máximo de acumulación en 40 m por intersección OSMnx",
    "Seguir el flujo 3 km → cadena aguas abajo",
  ];
  const datos = [
    ["Elevación", "Copernicus DEM GLO-30"],
    ["Calles y límites", "OpenStreetMap · OSMnx"],
    ["Puntos críticos", "OSM: metro, hospitales, colegios, pasos bajo nivel"],
    ["Cobertura de suelo", "ESA WorldCover 10 m"],
    ["Lluvia 13-oct", "DMC · Tobalaba, Quinta Normal, La Reina, Pudahuel"],
    ["Anegamientos reales", "Prensa y @TTISantiago, armado a mano"],
  ];
  return (
    <main className="method">
      <div className="method__row method__row--a">
        <section className="formula">
          <Kicker tone="accent">Cómo se decide la prioridad</Kicker>
          <div className="formula__eq">
            de dónde viene el agua · cuánta área drena · qué hay cerca · si la rejilla está tapada → prioridad
          </div>
          <div className="formula__term">
            <b>Si la rejilla está tapada</b>
            Lo confirmado manda: una foto reciente fija el estado y se recalcula todo lo que está aguas abajo. <em>Más importante.</em>
          </div>
          <div className="formula__term">
            <b>Cuánta área drena</b>
            El agua que le llega al sumidero según las calles y la pendiente. <em>Más importante.</em>
          </div>
          <div className="formula__term">
            <b>De dónde viene el agua</b>
            Qué parte baja desde otras comunas o desde más arriba en la misma calle. <em>Importante.</em>
          </div>
          <div className="formula__term">
            <b>Qué hay cerca</b>
            Metro, pasos bajo nivel, hospitales y colegios: pesan más si fallan. <em>Menos importante.</em>
          </div>
          <p className="formula__ia">La fórmula decide; Claude ve, lee y explica. Claude convierte fotos y textos en datos y redacta la explicación, pero no cambia el orden.</p>
        </section>
        <section className="nots">
          <Kicker tone="ink">Lo que no hace, a propósito</Kicker>
          <p className="nots__item">
            <span>✕</span>No recomienda cerrar o mantener abiertas calles. Un error ahí puede costar una vida.
          </p>
          <p className="nots__item">
            <span>✕</span>No recomienda desviar agua: traslada la inundación a otro barrio.
          </p>
          <p className="nots__item">
            <span>✕</span>No muestra profundidades ni minutos de llegada: un modelo de 30 m no los calcula con precisión.
          </p>
        </section>
      </div>
      <div className="method__row method__row--b">
        <section className="card pipeline">
          <Kicker>Pipeline · se calcula una vez antes de la demo</Kicker>
          {pasos.map((t, i) => (
            <div key={i} className="step">
              <b>{i + 1}</b>
              {t}
            </div>
          ))}
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

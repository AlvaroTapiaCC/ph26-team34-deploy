"use client";

import { useStore } from "@/lib/store";
import { Button } from "../ui";

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
  const { s, set, scenarioLabel } = useStore();
  const sc = { label: scenarioLabel };
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

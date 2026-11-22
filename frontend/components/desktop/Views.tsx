"use client";

import { useStore } from "@/lib/store";
import { Button } from "../ui";

/** Esqueleto fluido (porcentajes, no px fijos) mientras llega el ranking. */
export function Cargando() {
  return (
    <main className="bento" aria-busy="true">
      <div className="col col--l">
        <section className="card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14, flex: "none" }}>
          <div style={{ display: "flex", gap: 16 }}>
            <div className="skel" style={{ width: 72, height: 72, borderRadius: 18, flex: "none" }} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, justifyContent: "center" }}>
              <div className="skel" style={{ width: "40%", height: 12 }} />
              <div className="skel" style={{ width: "75%", height: 28 }} />
              <div className="skel" style={{ width: "50%", height: 12 }} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skel" style={{ height: 72, borderRadius: 14 }} />
            ))}
          </div>
          <div className="skel" style={{ width: "100%", height: 14 }} />
          <div className="skel" style={{ width: "70%", height: 14 }} />
          <div className="skel" style={{ width: "100%", height: 44, borderRadius: 10 }} />
        </section>
        <section className="card" style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 10, overflow: "hidden" }}>
          <div className="skel" style={{ width: "35%", height: 12 }} />
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="skel" style={{ width: "100%", height: 56, borderRadius: 14, flex: "none" }} />
          ))}
        </section>
      </div>
      <div className="col col--r">
        <div className="loading-map" role="status">
          <div className="spinner" />
          <h3>Cargando prioridades del escenario…</h3>
          <p>Leyendo el ranking desde el servidor.</p>
        </div>
      </div>
    </main>
  );
}

export function ErrorDatos() {
  const { reload } = useStore();
  return (
    <main className="bento">
      <section className="error" role="alert">
        <div className="error__icon">!</div>
        <h2>No se pudieron leer los datos</h2>
        <p>El servidor no respondió con la lista de prioridades. Revisa la conexión y vuelve a intentar.</p>
        <div className="row-btns">
          <Button variant="primary" onClick={reload}>
            Reintentar
          </Button>
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

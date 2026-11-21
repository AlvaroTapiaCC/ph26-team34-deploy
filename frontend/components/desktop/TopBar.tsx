"use client";

import type { ScenarioId } from "@/lib/data";
import { CUADRILLAS_MAX, useStore } from "@/lib/store";
import { BarSegment, Dropdown, Logo } from "../ui";

export default function TopBar() {
  const { s, set, escenarios, comunas } = useStore();
  return (
    <header className="topbar">
      <button onClick={() => set({ ficha: null })} aria-label="Inicio">
        <Logo />
      </button>
      <div className="topbar__ctrls">
        <BarSegment<ScenarioId>
          label="Escenario de lluvia"
          options={escenarios.map((x) => ({ id: x.id, label: x.label }))}
          value={s.scenario}
          onChange={(scenario) => set({ scenario, ficha: null })}
        />
        <Dropdown
          label={`Comuna: ${s.comuna}`}
          value={s.comuna}
          options={comunas.map((c) => ({ id: c.id, label: c.id, meta: c.total.toLocaleString("es-CL") }))}
          onChange={(comuna) => set({ comuna, ficha: null })}
          footer="intersecciones evaluadas"
        />
        <Dropdown
          label={`Cuadrillas: ${s.cuadrillas}`}
          value={s.cuadrillas}
          options={Array.from({ length: CUADRILLAS_MAX }, (_, i) => i + 1).map((n) => ({ id: n, label: `${n} cuadrilla${n > 1 ? "s" : ""}`, meta: `${n * 2} puntos` }))}
          onChange={(cuadrillas) => set({ cuadrillas })}
        />
      </div>
    </header>
  );
}

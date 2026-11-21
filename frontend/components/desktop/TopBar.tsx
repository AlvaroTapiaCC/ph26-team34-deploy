"use client";

import type { ScenarioId } from "@/lib/data";
import { useStore, type Modo } from "@/lib/store";
import { Button, Logo, Segmented, Selector } from "../ui";

export default function TopBar() {
  const { s, set, escenarios, comunas } = useStore();
  const go = (vista: "validacion" | "metodologia") => set({ vista: s.vista === vista ? "main" : vista, ficha: null });
  return (
    <header className="topbar">
      <button onClick={() => set({ vista: "main", ficha: null })} aria-label="Inicio">
        <Logo />
      </button>
      <div className="topbar__esc">
        <span className="kicker">Escenario</span>
        <Segmented<ScenarioId>
          options={escenarios.map((x) => ({ id: x.id, label: x.label }))}
          value={s.scenario}
          onChange={(scenario) => set({ scenario, ficha: null })}
        />
      </div>
      <Selector
        label={`Comuna: ${s.comuna}`}
        value={s.comuna}
        active={s.comuna !== "Todas"}
        options={comunas.map((c) => ({ id: c.id, label: c.id, meta: c.total.toLocaleString("es-CL") }))}
        onChange={(comuna) => set({ comuna, ficha: null })}
        footer="intersecciones evaluadas"
      />
      <Selector
        label={`Cuadrillas: ${s.cuadrillas}`}
        value={s.cuadrillas}
        options={[1, 2, 3, 4, 5].map((n) => ({ id: n, label: `${n} cuadrilla${n > 1 ? "s" : ""}`, meta: `${n * 2} puntos` }))}
        onChange={(cuadrillas) => set({ cuadrillas })}
      />
      <div className="topbar__spacer" />
      <Segmented<Modo>
        options={[
          { id: "antes", label: "Antes" },
          { id: "durante", label: "Durante" },
        ]}
        value={s.modo}
        onChange={(modo) => set({ modo, vista: "main", ficha: null })}
      />
      <Button variant={s.vista === "validacion" ? "primary" : "secondary"} onClick={() => go("validacion")}>
        Validación histórica
      </Button>
      <Button variant={s.vista === "metodologia" ? "primary" : "secondary"} onClick={() => go("metodologia")}>
        Metodología
      </Button>
    </header>
  );
}

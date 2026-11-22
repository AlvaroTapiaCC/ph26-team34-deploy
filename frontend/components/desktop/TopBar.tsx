"use client";

import { useRouter } from "next/navigation";
import type { ScenarioId } from "@/lib/data";
import { useStore, type Modo } from "@/lib/store";
import Link from "next/link";
import { Button, Logo, Segmented, Selector } from "../ui";

export default function TopBar() {
  const router = useRouter();
  const { s, set, escenarios, comunas } = useStore();
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
        onChange={(comuna) => set({ comuna, ficha: null, layers: { ...s.layers, limites: comuna !== "Todas" } })}
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
        onChange={(modo) => {
          if (modo === "durante") router.push("/central/durante");
          else set({ modo, vista: "main", ficha: null });
        }}
      />
      <Link href="/central/validacion" className="btn btn--secondary btn--md">
        Validación histórica
      </Link>
      <Button
        variant={s.vista === "metodologia" ? "primary" : "secondary"}
        onClick={() => set({ vista: s.vista === "metodologia" ? "main" : "metodologia", ficha: null })}
      >
        Metodología
      </Button>
    </header>
  );
}

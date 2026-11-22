"use client";

import Link from "next/link";
import type { ScenarioId } from "@/lib/data";
import { CUADRILLAS_MAX, useStore } from "@/lib/store";
import { BarSegment, Dropdown, Logo } from "../ui";
import nav from "../central/central.module.css";

/** Barra de Antes: logo, las tres vistas (mismo patrón que Durante) y, a la derecha, el contexto de la lista. */
export default function TopBar() {
  const { s, set, escenarios, comunas } = useStore();
  return (
    <header className="topbar">
      <button onClick={() => set({ ficha: null })} aria-label="Drena, inicio">
        <Logo />
      </button>
      <nav className={nav.nav} aria-label="Vistas de la central">
        <Link href="/" aria-current="page">
          Antes
        </Link>
        <Link href="/central/durante">Durante</Link>
        <Link href="/central/validacion">Validación</Link>
      </nav>
      <div className="topbar__spacer" />
      <div className="topbar__ctrls">
        <BarSegment<ScenarioId>
          label="Escenario de lluvia"
          options={escenarios.map((x) => ({ id: x.id, label: x.label }))}
          value={s.scenario}
          onChange={(scenario) => set({ scenario, ficha: null })}
        />
        <span className="topbar__sep" aria-hidden />
        <Dropdown
          label={s.comuna === "Todas" ? "Todas las comunas" : s.comuna}
          value={s.comuna}
          options={comunas.map((c) => ({ id: c.id, label: c.id, meta: c.total.toLocaleString("es-CL") }))}
          onChange={(comuna) => set({ comuna, ficha: null })}
          footer="intersecciones evaluadas"
        />
        <Dropdown
          label={`${s.cuadrillas} ${s.cuadrillas === 1 ? "cuadrilla" : "cuadrillas"}`}
          value={s.cuadrillas}
          options={Array.from({ length: CUADRILLAS_MAX }, (_, i) => i + 1).map((n) => ({ id: n, label: `${n} cuadrilla${n > 1 ? "s" : ""}`, meta: `${n * 2} puntos` }))}
          onChange={(cuadrillas) => set({ cuadrillas })}
        />
      </div>
    </header>
  );
}

"use client";

import { useMemo } from "react";
import { AVISO_MODELO, FLUJO_CONFIG } from "@/lib/flujo/config";
import type { Flujo, UiFlujo, Velocidad } from "@/lib/flujo/useFlujo";
import { useStore } from "@/lib/store";
import { Kicker, Segmented } from "../ui";

const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
const ls = (n: number) => `${Math.round(n).toLocaleString("es-CL")} L/s`;
const metros = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString("es-CL", { maximumFractionDigits: 1 })} km` : `${Math.round(m)} m`);

/** Tiempo simulado desde el inicio de la lluvia (+HH:MM:SS). */
export function formatoReloj(t: number): string {
  return `+${pad(t / 3600)}:${pad((t % 3600) / 60)}:${pad(t % 60)}`;
}

/** Gráfico pequeño del caudal que llega a una rejilla en el tiempo. */
function Grafico({ serie }: { serie: [number, number][] }) {
  const W = 236;
  const H = 52;
  const path = useMemo(() => {
    if (serie.length < 2) return null;
    const t0 = serie[0][0];
    const t1 = serie[serie.length - 1][0];
    const qMax = Math.max(1, ...serie.map((p) => p[1]));
    const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const y = (q: number) => H - 2 - (q / qMax) * (H - 6);
    const d = serie.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    return { linea: d, area: `${d}L${W},${H}L0,${H}Z`, qMax };
  }, [serie]);
  return (
    <svg className="sim__chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Caudal en el tiempo">
      <line x1="0" x2={W} y1={H - 1} y2={H - 1} stroke="var(--line)" />
      {path ? (
        <>
          <path d={path.area} fill="var(--lime)" opacity="0.12" />
          <path d={path.linea} fill="none" stroke="var(--lime)" strokeWidth="1.8" strokeLinejoin="round" />
          <text x="2" y="10" className="sim__chart-max">
            {ls(path.qMax)}
          </text>
        </>
      ) : (
        <text x={W / 2} y={H / 2 + 4} textAnchor="middle" className="sim__chart-max">
          Dale ▶ para ver el caudal
        </text>
      )}
    </svg>
  );
}

function Lectura({ v, l, accent }: { v: string; l: string; accent?: boolean }) {
  return (
    <div className="sim__lec">
      <b className={accent ? "is-accent" : ""}>{v}</b>
      <small>{l}</small>
    </div>
  );
}

/** Acciones sobre las rejillas de la red: tapar al azar, limpiar todas y tapar las de la comuna elegida. */
function AccionesRejillas({ flujo }: { flujo: Flujo }) {
  const { s, setRejillas } = useStore();
  const enComuna = s.comuna === "Todas" ? [] : flujo.rejillas().filter((r) => r.comuna === s.comuna);
  const tapar20 = () => {
    const todas = flujo.rejillas().filter((r) => s.comuna === "Todas" || r.comuna === s.comuna);
    const n = Math.round(todas.length * 0.2);
    const elegidas = [...todas].sort(() => Math.random() - 0.5).slice(0, n);
    setRejillas(Object.fromEntries(elegidas.map((r) => [r.id, "tapada"])), `${n} rejillas tapadas al azar (20 %)`);
  };
  const limpiar = () => setRejillas(Object.fromEntries(flujo.rejillas().map((r) => [r.id, "limpia"])), "Todas las rejillas limpias");
  const taparComuna = () => setRejillas(Object.fromEntries(enComuna.map((r) => [r.id, "tapada"])), `${enComuna.length} rejillas tapadas en ${s.comuna}`);
  const motivo = s.comuna === "Todas" ? "Elige una comuna arriba" : enComuna.length === 0 ? `La red simulada no llega a ${s.comuna}` : undefined;
  return (
    <div className="sim__acc">
      <button className="sim__btn" onClick={tapar20} disabled={!flujo.ui.cargado}>
        Tapar al azar 20 %
      </button>
      <button className="sim__btn" onClick={limpiar} disabled={!flujo.ui.cargado}>
        Limpiar todas
      </button>
      <button className="sim__btn" onClick={taparComuna} disabled={!flujo.ui.cargado || !!motivo} title={motivo}>
        Tapar las de la comuna
      </button>
    </div>
  );
}

export default function SimPanel({ flujo }: { flujo: Flujo }) {
  const ui: UiFlujo = flujo.ui;
  const l = ui.lecturas;
  return (
    <section className="sim" aria-label="Simulación">
      <div className="sim__head">
        <Kicker>Simulación</Kicker>
        <span className="sim__reloj" title="Tiempo simulado desde el inicio de la lluvia">
          {formatoReloj(ui.t)}
        </span>
      </div>
      <div className="sim__ctrls">
        <button className="sim__play" onClick={flujo.alternar} disabled={!ui.cargado} aria-label={ui.corriendo ? "Pausar" : "Reproducir"}>
          {ui.corriendo ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <rect x="2.5" y="2" width="3" height="10" rx="1" fill="currentColor" />
              <rect x="8.5" y="2" width="3" height="10" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M3.5 2.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L4.4 1.7a.6.6 0 0 0-.9.5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <Segmented<string>
          soft
          className="sim__vel"
          options={FLUJO_CONFIG.velocidades.map((v) => ({ id: String(v), label: `${v}×` }))}
          value={String(ui.velocidad)}
          onChange={(v) => flujo.setVelocidad(Number(v) as Velocidad)}
        />
        <button className="sim__btn sim__reiniciar" onClick={flujo.reiniciar} disabled={!ui.cargado}>
          Reiniciar
        </button>
      </div>
      <label className="sim__lluvia">
        <span>
          Lluvia máxima <b>{ui.lluviaPico} mm/h</b>
          <small>{ui.terminado ? "terminó" : `ahora ${ui.lluviaMmH.toFixed(0)} mm/h`}</small>
        </span>
        <input
          type="range"
          min={0}
          max={FLUJO_CONFIG.lluviaMaxMmH}
          step={1}
          value={ui.lluviaPico}
          onChange={(e) => flujo.setLluviaPico(Number(e.target.value))}
          aria-label="Intensidad máxima de lluvia (mm/h)"
        />
      </label>
      <div className="sim__lecs">
        <Lectura v={ls(l.caudalTransito)} l="caudal en tránsito" />
        <Lectura v={String(l.desbordados)} l="rejillas desbordadas" accent={l.desbordados > 0} />
        <Lectura v={metros(l.metrosSobreCuneta)} l="de calle sobre la cuneta" />
        <Lectura v={ls(l.maxCaudal)} l="en el punto con más caudal" />
      </div>
      {ui.grafico && (
        <div className="sim__graf">
          <div className="sim__graf-t">
            <span title={ui.grafico.id}>{ui.grafico.nombre}</span>
            <b>{ls(ui.grafico.caudal)}</b>
          </div>
          <Grafico serie={ui.grafico.serie} />
          {!ui.grafico.elegida && <small className="sim__hint">El punto con más caudal. Haz clic en una rejilla para seguirla.</small>}
        </div>
      )}
      <div className="sim__rej">
        <span className="sim__ico sim__ico--limpia" /> limpia
        <span className="sim__ico sim__ico--parcial" /> parcial
        <span className="sim__ico sim__ico--tapada" /> tapada
        <small>clic en una rejilla para cambiarla</small>
      </div>
      <AccionesRejillas flujo={flujo} />
      {ui.error && <p className="sim__error">No se pudo leer flujo.geojson</p>}
    </section>
  );
}

export function SimAviso() {
  return <div className="flujo-aviso">{AVISO_MODELO}</div>;
}

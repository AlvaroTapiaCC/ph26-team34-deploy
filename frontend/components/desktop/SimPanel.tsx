"use client";

import { useMemo, useState } from "react";
import { AVISO_MODELO, AVISO_NO_HACE, FLUJO_CONFIG, type EstadoRejilla } from "@/lib/flujo/config";
import type { Flujo, UiFlujo, Velocidad } from "@/lib/flujo/useFlujo";
import { useStore } from "@/lib/store";
import { Chevron, Segmented } from "../ui";

/** Caudal abreviado en palabras simples: "93 mil L/s". */
export function caudalCorto(ls: number): string {
  if (ls >= 1_000_000) return `${(ls / 1_000_000).toLocaleString("es-CL", { maximumFractionDigits: 1 })} millones de L/s`;
  if (ls >= 10_000) return `${Math.round(ls / 1000).toLocaleString("es-CL")} mil L/s`;
  if (ls >= 1000) return `${(ls / 1000).toLocaleString("es-CL", { maximumFractionDigits: 1 })} mil L/s`;
  return `${Math.round(ls)} L/s`;
}
const km = (m: number) => `${(m / 1000).toLocaleString("es-CL", { maximumFractionDigits: 1 })} km`;
const ESTADO_TXT: Record<EstadoRejilla, string> = { limpia: "limpia", parcial: "parcialmente tapada", tapada: "tapada" };

/** Redondea hacia arriba a 1, 2 o 5 × 10^n, para el eje. */
function tope(x: number) {
  const e = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1))));
  return [1, 2, 5, 10].map((k) => k * e).find((v) => v >= x) ?? x;
}

/** Caudal que llega a la rejilla elegida, en el tiempo, con eje y unidades legibles. */
function Grafico({ serie }: { serie: [number, number][] }) {
  const W = 288;
  const H = 96;
  const m = { l: 40, r: 8, t: 8, b: 20 };
  const g = useMemo(() => {
    if (serie.length < 2) return null;
    const t0 = serie[0][0];
    const t1 = Math.max(serie[serie.length - 1][0], t0 + 1);
    const yMax = tope(Math.max(...serie.map((p) => p[1])));
    const x = (t: number) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
    const y = (q: number) => H - m.b - (q / yMax) * (H - m.t - m.b);
    const d = serie.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    return { d, area: `${d}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`, yMax, t0, t1, y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serie]);
  return (
    <svg className="sim__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Caudal que llega a la rejilla, en el tiempo">
      {g ? (
        <>
          <line x1={m.l} x2={W - m.r} y1={g.y(g.yMax)} y2={g.y(g.yMax)} className="sim__grid" />
          <line x1={m.l} x2={W - m.r} y1={g.y(0)} y2={g.y(0)} className="sim__eje" />
          <text x={m.l - 6} y={g.y(g.yMax) + 4} textAnchor="end" className="sim__tick">
            {g.yMax.toLocaleString("es-CL")}
          </text>
          <text x={m.l - 6} y={g.y(0) + 4} textAnchor="end" className="sim__tick">
            0
          </text>
          <text x={4} y={(H - m.b) / 2 + 4} className="sim__tick">
            L/s
          </text>
          <text x={m.l} y={H - 4} className="sim__tick">
            {Math.floor(g.t0)} min
          </text>
          <text x={W - m.r} y={H - 4} textAnchor="end" className="sim__tick">
            {Math.floor(g.t1)} min
          </text>
          <path d={g.area} fill="var(--agua)" opacity="0.14" />
          <path d={g.d} fill="none" stroke="var(--agua)" strokeWidth="2" strokeLinejoin="round" />
        </>
      ) : (
        <text x={W / 2} y={H / 2 + 4} textAnchor="middle" className="sim__tick">
          Dale ▶ para ver cómo cambia el caudal
        </text>
      )}
    </svg>
  );
}

function Lectura({ v, l, accent }: { v: string; l: string; accent?: boolean }) {
  return (
    <div className="sim__lec">
      <span>{l}</span>
      <b className={accent ? "is-accent" : ""}>{v}</b>
    </div>
  );
}

/** Acciones sobre las rejillas: tapar al azar, limpiar todas y, si hay una comuna elegida, tapar las de esa comuna. */
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
  return (
    <div className="sim__acc">
      <button className="sim__btn" onClick={tapar20} disabled={!flujo.ui.cargado}>
        Tapar al azar 20 %
      </button>
      <button className="sim__btn" onClick={limpiar} disabled={!flujo.ui.cargado}>
        Limpiar todas
      </button>
      {s.comuna !== "Todas" && (
        <button className="sim__btn" onClick={taparComuna} disabled={!flujo.ui.cargado || enComuna.length === 0} title={enComuna.length === 0 ? `La red de calles no llega a ${s.comuna}` : undefined}>
          Tapar las de {s.comuna}
        </button>
      )}
    </div>
  );
}

/** Panel del flujo estimado: 320 px, plegable, siempre dentro del mapa. */
export default function SimPanel({ flujo }: { flujo: Flujo }) {
  const ui: UiFlujo = flujo.ui;
  const l = ui.lecturas;
  const [abierto, setAbierto] = useState(true);
  return (
    <section className={`sim ${abierto ? "" : "is-closed"}`} aria-label="Flujo estimado">
      <button className="sim__head" onClick={() => setAbierto(!abierto)} aria-expanded={abierto}>
        <span className="sim__titulo">Flujo estimado</span>
        <Chevron open={abierto} />
      </button>
      {abierto && (
        <>
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
          </div>
          <label className="sim__lluvia">
            <span>
              Lluvia (supuesta) <b>{ui.lluviaMmH} mm/h</b>
            </span>
            <input type="range" min={0} max={FLUJO_CONFIG.lluviaMaxMmH} step={1} value={ui.lluviaMmH} onChange={(e) => flujo.setLluvia(Number(e.target.value))} aria-label="Lluvia supuesta (mm/h)" />
          </label>
          <div className="sim__lecs">
            <Lectura l="Agua en las calles" v={caudalCorto(l.caudalTransito)} />
            <Lectura l="Puntos con agua (estimado)" v={String(l.desbordados)} accent={l.desbordados > 0} />
            <Lectura l="Calles con agua sobre la cuneta" v={km(l.metrosSobreCuneta)} />
          </div>
          <AccionesRejillas flujo={flujo} />
          {ui.grafico && (
            <div className="sim__graf">
              <div className="sim__graf-t">
                <span>
                  Rejilla {ESTADO_TXT[ui.grafico.estado]} · <b>{ui.grafico.nombre}</b>
                </span>
                <button className="sim__cerrar" onClick={() => flujo.seleccionar(null)} aria-label="Quitar la rejilla elegida">
                  ✕
                </button>
              </div>
              <small>Agua que le llega: {caudalCorto(ui.grafico.caudal)}</small>
              <Grafico serie={ui.grafico.serie} />
            </div>
          )}
          {!ui.grafico && <p className="sim__hint">Haz clic en una rejilla del mapa para taparla o limpiarla y ver su caudal.</p>}
          {ui.error && <p className="sim__error">No se pudo leer flujo.geojson</p>}
        </>
      )}
    </section>
  );
}

/** Leyenda fija abajo a la izquierda, con el aviso. */
export function Leyenda() {
  return (
    <div className="leyenda">
      <div className="leyenda__fila">
        <svg width="34" height="12" aria-hidden>
          <path d="M2 6 L13 6" stroke="var(--agua)" strokeWidth="2" strokeLinecap="round" />
          <path d="M19 6 L32 6" stroke="var(--agua-hondo)" strokeWidth="5" strokeLinecap="round" />
        </svg>
        <span>
          <b>Azul:</b> agua por la calle (más grueso, más caudal)
        </span>
      </div>
      <div className="leyenda__fila">
        <svg width="34" height="12" aria-hidden>
          <path d="M2 6 L32 6" stroke="var(--lime)" strokeWidth="4" strokeLinecap="round" />
        </svg>
        <span>
          <b>Naranjo:</b> el agua no cabe en la calle (estimado)
        </span>
      </div>
      <div className="leyenda__fila">
        <svg width="34" height="12" aria-hidden>
          <circle cx="9" cy="6" r="4" fill="#fff" stroke="var(--agua)" strokeWidth="1.5" />
          <circle cx="25" cy="6" r="4" fill="var(--lime)" stroke="#fff" strokeWidth="1.5" />
        </svg>
        <span>
          <b>Círculo:</b> rejilla (rellena: tapada)
        </span>
      </div>
      <p className="leyenda__aviso">
        {AVISO_MODELO} {AVISO_NO_HACE}
      </p>
    </div>
  );
}

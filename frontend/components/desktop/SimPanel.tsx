"use client";

import { AVISO_MODELO, AVISO_NO_HACE, FLUJO_CONFIG, type EstadoRejilla } from "@/lib/flujo/config";
import type { Flujo, UiFlujo, Velocidad } from "@/lib/flujo/useFlujo";
import { useStore } from "@/lib/store";
import { Chevron, Segmented } from "../ui";

const ESTADO_TXT: Record<EstadoRejilla, string> = { limpia: "limpia", parcial: "parcialmente tapada", tapada: "tapada" };

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

/** Simulación del flujo: plegada por defecto (una píldora). Al abrirla se pide la red de calles y se enciende la capa de agua. */
export default function SimPanel({ flujo, abierto, onAbierto }: { flujo: Flujo; abierto: boolean; onAbierto: (v: boolean) => void }) {
  const ui: UiFlujo = flujo.ui;
  const l = ui.lecturas;
  return (
    <section className={`sim ${abierto ? "" : "is-closed"}`} aria-label="Simulación de flujo (estimado)">
      <button className="sim__head" onClick={() => onAbierto(!abierto)} aria-expanded={abierto}>
        <span className="sim__titulo">Simulación de flujo <span className="sim__est">(estimado)</span></span>
        <Chevron open={abierto} />
      </button>
      {abierto && !ui.cargado && !ui.error && <p className="sim__hint sim__cuerpo">Cargando la red de calles…</p>}
      {abierto && ui.cargado && (
        <div className="sim__cuerpo">
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
            <Lectura l="Puntos con agua (estimado)" v={String(l.desbordados)} accent={l.desbordados > 0} />
            <Lectura l="Rejillas tapadas" v={`${ui.tapadas.Todas ?? 0} de ${(ui.total.Todas ?? 0).toLocaleString("es-CL")}`} />
          </div>
          <AccionesRejillas flujo={flujo} />
          {ui.elegida ? (
            <div className="sim__graf">
              <div className="sim__graf-t">
                <span>
                  Rejilla {ESTADO_TXT[ui.elegida.estado]} · <b>{ui.elegida.nombre}</b>
                </span>
                <button className="sim__cerrar" onClick={() => flujo.seleccionar(null)} aria-label="Quitar la rejilla elegida">
                  ✕
                </button>
              </div>
              <small className={ui.elegida.conAgua ? "is-accent" : ""}>{ui.elegida.conAgua ? "Acumula agua (estimado)" : "Sin agua acumulada (estimado)"}</small>
            </div>
          ) : (
            <p className="sim__hint">Haz clic en una rejilla del mapa para taparla o limpiarla.</p>
          )}
        </div>
      )}
      {abierto && ui.error && <p className="sim__error">No se pudo cargar la red de calles. Recarga la página para reintentar.</p>}
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
          <b>Azul:</b> agua por la calle (más grueso, más agua; estimado)
        </span>
      </div>
      <div className="leyenda__fila">
        <svg width="34" height="12" aria-hidden>
          <path d="M2 6 L32 6" stroke="var(--principal)" strokeWidth="4" strokeLinecap="round" />
        </svg>
        <span>
          <b>Color principal:</b> el agua no cabe en la calle (estimado)
        </span>
      </div>
      <div className="leyenda__fila">
        <svg width="34" height="12" aria-hidden>
          <circle cx="9" cy="6" r="4" fill="var(--surface)" stroke="var(--agua)" strokeWidth="1.5" />
          <circle cx="25" cy="6" r="4" fill="var(--principal)" stroke="var(--surface)" strokeWidth="1.5" />
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

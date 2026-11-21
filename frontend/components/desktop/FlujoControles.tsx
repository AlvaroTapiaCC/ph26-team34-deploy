"use client";

import { FLUJO_CONFIG } from "@/lib/flujo/config";
import type { UiFlujo, Velocidad } from "@/lib/flujo/useFlujo";
import { Segmented } from "../ui";

const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");

/** Reloj simulado (+HH:MM:SS desde el inicio del escenario) o la hora real en el modo tiempo real. */
export function formatoReloj(ui: Pick<UiFlujo, "t" | "modo" | "inicioMs">): string {
  if (ui.modo === "tiempo_real") {
    const d = new Date(ui.inicioMs + ui.t * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return `+${pad(ui.t / 3600)}:${pad((ui.t % 3600) / 60)}:${pad(ui.t % 60)}`;
}

export default function FlujoControles({
  ui,
  onAlternar,
  onVelocidad,
  onReiniciar,
}: {
  ui: UiFlujo;
  onAlternar: () => void;
  onVelocidad: (v: Velocidad) => void;
  onReiniciar: () => void;
}) {
  // Sin opción "Tiempo real": no hay datos en vivo detrás (la lluvia es la del escenario).
  const real = ui.modo === "tiempo_real";
  return (
    <div className="flujo" role="group" aria-label="Flujo estimado por las calles">
      <button className="flujo__play" onClick={onAlternar} disabled={!ui.cargado} aria-label={ui.corriendo ? "Pausar" : "Reproducir"}>
        {ui.corriendo ? "❚❚" : "▶"}
      </button>
      <Segmented<string>
        soft
        options={FLUJO_CONFIG.velocidades.map((v) => ({ id: String(v), label: `${v}×` }))}
        value={real ? "1" : String(ui.velocidad)}
        onChange={(v) => !real && onVelocidad(Number(v) as Velocidad)}
        className={real ? "is-locked" : ""}
      />
      <div className="flujo__reloj" title={real ? "Hora real" : "Tiempo desde el inicio de la lluvia supuesta del escenario"}>
        <b>{formatoReloj(ui)}</b>
        <small>{ui.terminado ? "fin" : `${ui.lluviaMmH.toFixed(0)} mm/h`}</small>
      </div>
      <button className="flujo__reiniciar" onClick={onReiniciar} disabled={!ui.cargado}>
        Reiniciar
      </button>
      {ui.error && <span className="flujo__error">Sin datos de flujo</span>}
    </div>
  );
}

export function FlujoAviso({ desbordados, corriendo }: { desbordados: number; corriendo: boolean }) {
  return (
    <div className="flujo-aviso">
      {corriendo && desbordados > 0 && <b>{desbordados} {desbordados === 1 ? "punto con agua (estimado)" : "puntos con agua (estimado)"} · </b>}
      Flujo estimado por las calles según la pendiente; no es una simulación hidráulica ni una medición. Lluvia y estado de las rejillas: supuestos de la demo.
    </div>
  );
}

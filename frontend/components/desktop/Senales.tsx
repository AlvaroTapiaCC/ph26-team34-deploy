"use client";

import type { ApiSenal } from "@/lib/api";
import { fmt } from "@/lib/data";
import { useStore } from "@/lib/store";
import { Kicker } from "../ui";

const SENAL: Record<ApiSenal["senal"], string> = { rejilla: "Foto de rejilla", texto: "Reporte de texto", agua: "Agua" };
const FUENTE: Record<string, string> = { vecino: "vecino", cuadrilla: "cuadrilla", camara: "cámara" };
const HORA = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function hora(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : HORA.format(d);
}

/** Señales vigentes de un punto real (GET /sumideros/{id}, #124): fuente, hora y confianza de Claude. */
export function SenalesReales() {
  const { fichaReal } = useStore();
  const senales = fichaReal?.senales ?? [];
  if (!fichaReal) return null;
  return (
    <div>
      <Kicker>Señales observadas</Kicker>
      {senales.length === 0 ? (
        <p className="downstream">Sin observaciones vigentes para este sumidero.</p>
      ) : (
        <div className="vars">
          {senales.map((s) => (
            <div
              key={`${s.senal}-${s.observation_id}`}
              className="vars__row"
              style={s.usada ? undefined : { opacity: 0.55 }}
              title={s.usada ? "La fórmula usa esta señal" : "Vigente, pero la fórmula usa otra señal"}
            >
              <span>
                {SENAL[s.senal] ?? s.senal}: {s.valor.replaceAll("_", " ")} · {FUENTE[s.fuente] ?? s.fuente} · {hora(s.ts)}
                {s.aplica_en.length === 1 && s.aplica_en[0] === "durante" ? " · solo Durante" : ""}
                {s.is_simulated ? " · simulado" : ""}
              </span>
              <span>{s.confianza ? `confianza ${s.confianza}` : "sin confianza"}</span>
              <b>×{fmt(s.factor_confianza, 1)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

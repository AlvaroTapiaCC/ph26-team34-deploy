"use client";

import { useEffect, useState } from "react";
import { getClima, type ApiClima, type ModoClima } from "@/lib/api";
import { useStore } from "@/lib/store";

const ETIQUETA: Record<ModoClima, string> = {
  seco: "Seco",
  tormenta_inminente: "Tormenta inminente",
  durante: "Lloviendo",
  despues: "Después de la lluvia",
  sin_dato: "Sin dato de clima",
};

const REFRESCO_MS = 15 * 60_000; // el backend cachea 1 h; refrescar más seguido solo toma la caché

const horaSantiago = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" }) : "—";

const mm = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("es-CL", { maximumFractionDigits: 1 })} mm`);

/** Banda bajo la barra superior: modo y plazo con el clima real de Open-Meteo (issue #13). */
export default function BandaClima() {
  const { s } = useStore();
  const [c, setC] = useState<ApiClima | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let vivo = true;
    const cargar = () =>
      getClima()
        .then((r) => vivo && (setC(r), setError(false)))
        .catch(() => vivo && setError(true));
    cargar();
    const t = setInterval(cargar, REFRESCO_MS);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);

  if (!c && !error) return null;
  const escenario = s.modo === "durante";
  const modo: ModoClima = c?.modo ?? "sin_dato";
  const alerta = modo === "durante" || modo === "tormenta_inminente";

  return (
    <div className={`banda-clima ${alerta ? "banda-clima--alerta" : ""}`} role="status">
      {escenario && <span className="banda-clima__esc">Escenario reproducido · Durante</span>}
      <span className="banda-clima__modo">
        {escenario ? "Clima real ahora: " : ""}
        <strong>{ETIQUETA[modo]}</strong>
        {c?.plazo && <> · {c.plazo}</>}
      </span>
      {c && modo !== "sin_dato" && (
        <span className="banda-clima__dato">
          Últimas 24 h {mm(c.lluvia_acum_24h_mm)} · próximas 48 h {mm(c.lluvia_pronosticada_48h_mm)}
        </span>
      )}
      <span className="banda-clima__fuente">
        {error && !c
          ? "Open-Meteo sin respuesta"
          : `Open-Meteo · ${c?.vigente ? "dato de las" : "último dato de las"} ${horaSantiago(c?.hora_dato_utc ?? null)}`}
      </span>
    </div>
  );
}

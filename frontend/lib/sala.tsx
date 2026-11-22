"use client";

// Datos compartidos de la sala (inicio + central Antes/Durante). Viven en el layout del grupo (sala):
// al pasar del inicio al mapa, o de Antes a Durante, nada se vuelve a pedir ni a montar.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { getClima, type ApiClima, type ApiRankingItem } from "./api";
import { ESCENARIO_CENTRAL, getObservaciones, getRankingDurante, getRankingInicial, useConsultaPeriodica, type ObservacionPublica } from "./central";
import { getCuadrillas, getRuta, type Cuadrilla, type RutaCuadrilla } from "./cuadrilla";
import type { Prioridad } from "./data";
import { prioDe } from "./real";
import { useExpuestos, type EstadoConsulta, type Expuestos } from "./transporte";

export type Fila = ApiRankingItem & { puesto: number; prio: Prioridad };

function aFilas(items: ApiRankingItem[] | undefined): Fila[] {
  const lista = items ?? [];
  const distintos = new Set(lista.flatMap((p) => (p.prioridad == null ? [] : [p.prioridad]))).size > 1;
  return lista.map((p, i) => ({ ...p, puesto: i + 1, prio: prioDe(i + 1, lista.length, distintos) }));
}

const getClimaSala = () => getClima({ reintentos: 0 });

interface Sala {
  antes: { filas: Fila[]; estado: EstadoConsulta };
  durante: { filas: Fila[]; estado: EstadoConsulta; esInicial: boolean };
  observaciones: { datos: ObservacionPublica[]; estado: EstadoConsulta };
  cuadrillas: Cuadrilla[];
  estadoCuadrillas: EstadoConsulta;
  cuadrilla: Cuadrilla | null;
  elegirCuadrilla: (id: string) => void;
  ruta: RutaCuadrilla | null;
  estadoRuta: EstadoConsulta;
  transporte: { datos: Expuestos | null; calculadoAt: string | null; estado: EstadoConsulta };
  clima: { datos: ApiClima | null; estado: EstadoConsulta };
}

const Ctx = createContext<Sala | null>(null);

export function SalaProvider({ children }: { children: ReactNode }) {
  const rAntes = useConsultaPeriodica(getRankingInicial, "ranking");
  const rDurante = useConsultaPeriodica(getRankingDurante, "ranking");
  const obs = useConsultaPeriodica(getObservaciones, "reportes");
  const crews = useConsultaPeriodica(getCuadrillas, "cuadrillas");
  const clima = useConsultaPeriodica(getClimaSala);
  const tp = useExpuestos(ESCENARIO_CENTRAL, true);
  const [eleccion, setEleccion] = useState("");
  const equipos = useMemo(() => crews.datos ?? [], [crews.datos]);
  // Por defecto, la cuadrilla simulada de la zona MUT (la de la demo); si no, la primera simulada
  const cuadrilla = equipos.find((c) => c.id === eleccion) ?? equipos.find((c) => c.id === "sim-c4") ?? equipos.find((c) => c.is_simulated) ?? equipos[0] ?? null;
  const idCuadrilla = cuadrilla?.id;
  const consultarRuta = useCallback(() => getRuta(idCuadrilla ?? ""), [idCuadrilla]);
  const cRuta = useConsultaPeriodica(cuadrilla ? consultarRuta : null, "ruta");
  const ruta = cRuta.datos?.crew_id === idCuadrilla ? cRuta.datos : null;
  const estadoRuta: EstadoConsulta = cRuta.datos && !ruta && cRuta.estado !== "error" ? "cargando" : cRuta.estado;

  const filasAntes = useMemo(() => aFilas(rAntes.datos?.items), [rAntes.datos]);
  const durItems = rDurante.datos?.items;
  const esInicial = rDurante.estado === "ok" && !durItems?.length;
  const filasDurante = useMemo(() => (esInicial ? filasAntes : aFilas(durItems)), [esInicial, filasAntes, durItems]);

  const valor = useMemo<Sala>(
    () => ({
      antes: { filas: filasAntes, estado: rAntes.estado },
      durante: { filas: filasDurante, estado: esInicial ? rAntes.estado : rDurante.estado, esInicial },
      observaciones: { datos: obs.datos ?? [], estado: obs.estado },
      cuadrillas: equipos,
      estadoCuadrillas: crews.estado,
      cuadrilla,
      elegirCuadrilla: setEleccion,
      ruta,
      estadoRuta,
      transporte: tp,
      clima: { datos: clima.datos, estado: clima.estado },
    }),
    [filasAntes, rAntes.estado, filasDurante, esInicial, rDurante.estado, obs.datos, obs.estado, equipos, crews.estado, cuadrilla, ruta, estadoRuta, tp, clima.datos, clima.estado],
  );
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useSala(): Sala {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSala fuera de SalaProvider");
  return v;
}

// ── Formato común ──
const F3 = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const F2 = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const puntaje = (v: number | null | undefined) => (v == null ? "Sin dato" : F3.format(v));
export const dos = (v: number | null | undefined) => (v == null ? "Sin dato" : F2.format(v));
export const nombreFila = (p: Pick<ApiRankingItem, "intersection_nombre" | "sumidero_id">) => p.intersection_nombre ?? `Sumidero ${p.sumidero_id}`;

/** Aportes de la fórmula con nombres para personas. `simulado`: el dato de entrada es simulado. */
export const APORTES: Record<string, { nombre: string; simulado?: boolean }> = {
  pendiente: { nombre: "Pendiente del terreno" },
  arboles: { nombre: "Árboles cerca" },
  dias_sin_limpieza: { nombre: "Días sin limpieza", simulado: true },
  clima: { nombre: "Lluvia pronosticada" },
  suelo: { nombre: "Suelo impermeable" },
  feria: { nombre: "Feria libre cerca" },
  obras: { nombre: "Obras cerca" },
  camara: { nombre: "Cámara" },
};

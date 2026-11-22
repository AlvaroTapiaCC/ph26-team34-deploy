"use client";

// Datos compartidos de la sala (inicio + central Antes/Durante). Viven en el layout del grupo (sala):
// al pasar del inicio al mapa, o de Antes a Durante, nada se vuelve a pedir ni a montar.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getClima, type ApiClima, type ApiRankingItem } from "./api";
import { ESCENARIO_CENTRAL, getObservaciones, getRankingDurante, getRankingInicial, useConsultaPeriodica, type ObservacionPublica } from "./central";
import { getCuadrillas, getRuta, type Cuadrilla, type RutaCuadrilla } from "./cuadrilla";
import type { Prioridad } from "./data";
import { prioDe } from "./real";
import { useExpuestos, type EstadoConsulta, type Expuestos } from "./transporte";
import { datosDemo, PASOS_DEMO } from "./demo";
import { cargarTransporteDemo, type CargaTransporteDemo } from "./transporteDemo";

export type Fila = ApiRankingItem & { puesto: number; prio: Prioridad };

function aFilas(items: ApiRankingItem[] | undefined): Fila[] {
  const lista = items ?? [];
  const distintos = new Set(lista.flatMap((p) => (p.prioridad == null ? [] : [p.prioridad]))).size > 1;
  return lista.map((p, i) => ({ ...p, puesto: i + 1, prio: prioDe(i + 1, lista.length, distintos) }));
}

const getClimaSala = () => getClima({ reintentos: 0 });

interface Sala {
  demo: { activo: boolean; paso: number; iniciar: () => void; anterior: () => void; siguiente: () => void; salir: () => void };
  antes: { filas: Fila[]; estado: EstadoConsulta };
  durante: { filas: Fila[]; estado: EstadoConsulta; esInicial: boolean };
  observaciones: { datos: ObservacionPublica[]; estado: EstadoConsulta };
  cuadrillas: Cuadrilla[];
  estadoCuadrillas: EstadoConsulta;
  cuadrilla: Cuadrilla | null;
  elegirCuadrilla: (id: string) => void;
  ruta: RutaCuadrilla | null;
  estadoRuta: EstadoConsulta;
  transporte: { datos: Expuestos | null; calculadoAt: string | null; estado: EstadoConsulta; reintentar?: () => void };
  clima: { datos: ApiClima | null; estado: EstadoConsulta };
}

const Ctx = createContext<Sala | null>(null);

export function SalaProvider({ children }: { children: ReactNode }) {
  const [activo, setActivo] = useState(false);
  const [paso, setPaso] = useState(0);
  const [intentoTransporte, setIntentoTransporte] = useState(0);
  const [transporteDemo, setTransporteDemo] = useState<CargaTransporteDemo>({ datos: null, estado: "cargando" });
  const reintentarTransporte = useCallback(() => {
    setTransporteDemo({ datos: null, estado: "cargando" });
    setIntentoTransporte((i) => i + 1);
  }, []);
  const iniciar = useCallback(() => { setPaso(0); setActivo(true); reintentarTransporte(); }, [reintentarTransporte]);
  const anterior = useCallback(() => setPaso((p) => Math.max(0, p - 1)), []);
  const siguiente = useCallback(() => setPaso((p) => Math.min(PASOS_DEMO.length - 1, p + 1)), []);
  const salir = useCallback(() => { setActivo(false); setPaso(0); }, []);
  const demo = useMemo(() => ({ activo, paso, iniciar, anterior, siguiente, salir }), [activo, paso, iniciar, anterior, siguiente, salir]);
  useEffect(() => {
    if (!activo) return;
    let vigente = true;
    void cargarTransporteDemo((carga) => { if (vigente) setTransporteDemo(carga); });
    return () => { vigente = false; };
  }, [activo, intentoTransporte]);
  const simulado = useMemo(() => datosDemo(paso, transporteDemo.datos), [paso, transporteDemo.datos]);
  const simAntes = useMemo(() => aFilas(simulado.inicial), [simulado.inicial]);
  const simDurante = useMemo(() => aFilas(simulado.durante), [simulado.durante]);
  const rAntes = useConsultaPeriodica(activo ? null : getRankingInicial, "ranking");
  const rDurante = useConsultaPeriodica(activo ? null : getRankingDurante, "ranking");
  const obs = useConsultaPeriodica(activo ? null : getObservaciones, "reportes");
  const crews = useConsultaPeriodica(activo ? null : getCuadrillas, "cuadrillas");
  const clima = useConsultaPeriodica(activo ? null : getClimaSala);
  const tp = useExpuestos(ESCENARIO_CENTRAL, !activo);
  const [eleccion, setEleccion] = useState("");
  const equipos = useMemo(() => crews.datos ?? [], [crews.datos]);
  // Por defecto, la cuadrilla simulada de la zona MUT (la de la demo); si no, la primera simulada
  const cuadrilla = equipos.find((c) => c.id === eleccion) ?? equipos.find((c) => c.id === "sim-c4") ?? equipos.find((c) => c.is_simulated) ?? equipos[0] ?? null;
  const idCuadrilla = cuadrilla?.id;
  const consultarRuta = useCallback(() => getRuta(idCuadrilla ?? ""), [idCuadrilla]);
  const cRuta = useConsultaPeriodica(!activo && cuadrilla ? consultarRuta : null, "ruta");
  const ruta = cRuta.datos?.crew_id === idCuadrilla ? cRuta.datos : null;
  const estadoRuta: EstadoConsulta = cRuta.datos && !ruta && cRuta.estado !== "error" ? "cargando" : cRuta.estado;

  const filasAntes = useMemo(() => aFilas(rAntes.datos?.items), [rAntes.datos]);
  const durItems = rDurante.datos?.items;
  const esInicial = rDurante.estado === "ok" && !durItems?.length;
  const filasDurante = useMemo(() => (esInicial ? filasAntes : aFilas(durItems)), [esInicial, filasAntes, durItems]);

  const valor = useMemo<Sala>(
    () => activo ? {
      demo,
      antes: { filas: simAntes, estado: "ok" },
      durante: { filas: simDurante, estado: "ok", esInicial: paso === 0 },
      observaciones: { datos: simulado.observaciones, estado: "ok" },
      cuadrillas: [simulado.cuadrilla], estadoCuadrillas: "ok", cuadrilla: simulado.cuadrilla,
      elegirCuadrilla: () => {}, ruta: simulado.ruta, estadoRuta: "ok",
      transporte: { datos: transporteDemo.estado === "ok" ? simulado.transporte : null, calculadoAt: transporteDemo.estado === "ok" ? simulado.transporte.calculado_at : null, estado: transporteDemo.estado, reintentar: reintentarTransporte },
      clima: { datos: {
        modo: simulado.hora.modo as ApiClima["modo"], plazo: null,
        inicio_lluvia_pronosticado_utc: simulado.hora.inicio_lluvia_pronosticado_utc,
        clima: simulado.hora.clima, lluvia_acum_24h_mm: simulado.hora.lluvia_acum_24h_mm,
        racha_max_6h_kmh: simulado.hora.racha_max_6h_kmh,
        lluvia_pronosticada_prox_24h_mm: simulado.hora.lluvia_pronosticada_prox_24h_mm,
        lluvia_pronosticada_48h_mm: null, racha_max_pronosticada_48h_kmh: null,
        hora_dato_utc: simulado.hora.hora_utc, vigente: false, consultado_utc: null,
        fuente: { nombre: "Open-Meteo · reconstrucción histórica", url: "https://open-meteo.com/en/docs/previous-runs-api", celda_latlon: [-33.418, -70.541], licencia: "CC BY 4.0" },
      }, estado: "ok" },
    } : ({
      demo,
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
    [activo, demo, simulado, simAntes, simDurante, paso, filasAntes, rAntes.estado, filasDurante, esInicial, rDurante.estado, obs.datos, obs.estado, equipos, crews.estado, cuadrilla, ruta, estadoRuta, tp, clima.datos, clima.estado, transporteDemo.estado, reintentarTransporte],
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

/** Catastro de rejillas por comuna. Fuente: public/data/rejillas.geojson (copia de data/rejillas.geojson,
 *  pipeline/02_rejillas.py, catastro SIALL de la DOH, parcial). Si se regenera el catastro, actualizar aquí. */
export const CATASTRO = {
  total: 3002,
  comunas: [
    { nombre: "Las Condes", n: 1201 },
    { nombre: "Ñuñoa", n: 1055 },
    { nombre: "Providencia", n: 746 },
  ],
};

// Paraderos expuestos al agua (issue #92). Contrato: GET /transporte/expuestos (backend #91).
// Se calcula en cada consulta; el tablero la repite cada pocos segundos, sin Realtime.

import { useEffect, useRef, useState } from "react";
import { apiGet } from "./api";
import type { LngLat } from "./data";

export interface CausaAgua {
  observation_id: string;
  sumidero_observado: string;
  sumidero_id: string;
  nivel: "cuneta" | "hasta_vereda" | "sobre_vereda";
  ts: string;
  tipo: string;
  fuente: string;
  is_simulated: boolean;
  via: "observado" | "calle_abajo";
  calle_abajo_m: number;
  distancia_m: number;
}

export interface CausaRiesgo {
  sumidero_id: string;
  prioridad: number;
  puesto_en_zona: number;
  distancia_m: number;
}

export interface ServicioExpuesto {
  servicio: string;
  sentido: string;
  destino: string | null;
  motivo: string | null;
  alternativo: {
    id: string;
    nombre: string;
    lat: number;
    lon: number;
    en_secuencia: "anterior" | "siguiente";
    distancia_m: number;
    en_riesgo: boolean;
  } | null;
}

interface ParaderoBase {
  id: string;
  nombre: string;
  lat: number;
  lon: number;
}

export interface ParaderoExpuesto extends ParaderoBase {
  nivel: "expuesto";
  causa: CausaAgua;
  servicios: ServicioExpuesto[];
}

export interface ParaderoEnRiesgo extends ParaderoBase {
  nivel: "en_riesgo";
  causa: CausaRiesgo;
  servicios: { servicio: string; sentido: string; destino: string | null }[];
}

export interface Expuestos {
  scenario_id: string;
  calculado_at: string;
  nota: string;
  aviso: string | null;
  fuente: { nombre: string; url: string | null; fecha_descarga: string | null } | null;
  parametros: { radio_m: number; aguas_abajo_m: number; riesgo_top_n: number; vigencia_agua_horas: number };
  expuestos: ParaderoExpuesto[];
  en_riesgo: ParaderoEnRiesgo[];
}

export const getExpuestos = (escenario: string) =>
  apiGet<Expuestos>(`/transporte/expuestos?scenario=${encodeURIComponent(escenario)}`, { timeoutMs: 10_000, reintentos: 0 });

export const INTERVALO_MS = 3_000;

export type EstadoConsulta = "cargando" | "ok" | "error";

/** Consulta periódica. Conserva la última respuesta buena si una consulta falla.
 * `datos` solo cambia de identidad si cambia el contenido (el mapa no rehace sus capas cada 3 s);
 * la hora del último cálculo va aparte en `calculadoAt`. */
export function useExpuestos(escenario: string, activo: boolean) {
  const [datos, setDatos] = useState<Expuestos | null>(null);
  const [calculadoAt, setCalculadoAt] = useState<string | null>(null);
  const [estado, setEstado] = useState<EstadoConsulta>("cargando");
  const enCurso = useRef(false);
  const ultimaClave = useRef("");

  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    setDatos(null);
    setCalculadoAt(null);
    setEstado("cargando");
    ultimaClave.current = "";
    const consultar = async () => {
      if (enCurso.current) return; // no se encolan consultas si el servidor está lento
      enCurso.current = true;
      try {
        const d = await getExpuestos(escenario);
        if (!vivo) return;
        const clave = JSON.stringify({ ...d, calculado_at: null });
        if (clave !== ultimaClave.current) {
          ultimaClave.current = clave;
          setDatos(d);
        }
        setCalculadoAt(d.calculado_at);
        setEstado("ok");
      } catch {
        if (vivo) setEstado("error");
      } finally {
        enCurso.current = false;
      }
    };
    void consultar();
    const t = setInterval(consultar, INTERVALO_MS);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [escenario, activo]);

  return { datos, calculadoAt, estado };
}

// --- Trazados de los servicios (public/data/recorridos.geojson, pipeline/publicar_front.py) ---

export interface Recorrido {
  servicio: string;
  sentido: string;
  destino: string | null;
  tramos: LngLat[][];
}

let recorridosCache: Promise<Recorrido[]> | null = null;

export function cargarRecorridos(): Promise<Recorrido[]> {
  recorridosCache ??= fetch("/data/recorridos.geojson")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((fc: { features: { properties: { servicio: string; sentido: string; destino: string | null }; geometry: { coordinates: LngLat[][] } }[] }) =>
      fc.features.map((f) => ({ ...f.properties, tramos: f.geometry.coordinates })),
    )
    .catch(() => {
      recorridosCache = null; // se reintenta en la próxima llamada
      return [];
    });
  return recorridosCache;
}

export function useRecorridos(activo: boolean) {
  const [r, setR] = useState<Recorrido[]>([]);
  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    void cargarRecorridos().then((x) => vivo && setR(x));
    return () => {
      vivo = false;
    };
  }, [activo]);
  return r;
}

export const claveServicio = (s: { servicio: string; sentido: string }) => `${s.servicio}|${s.sentido}`;

// --- Formato ---

const HORA = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const HORA_S = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
/** Los tiempos llegan en UTC; se muestran en hora de Santiago. */
export const horaSantiago = (iso: string | null | undefined, segundos = false) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : (segundos ? HORA_S : HORA).format(d);
};

export const NIVEL_AGUA: Record<CausaAgua["nivel"], string> = {
  cuneta: "agua en la cuneta",
  hasta_vereda: "agua hasta la vereda",
  sobre_vereda: "agua sobre la vereda",
};

export const sentidoTexto = (s: { sentido: string; destino: string | null }) =>
  s.destino ? `hacia ${s.destino}` : s.sentido === "0" ? "ida" : "regreso";

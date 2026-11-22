import { useEffect, useState, useSyncExternalStore } from "react";
import { apiGet, getRanking, type GetOpts } from "./api";
import { INTERVALO_MS, type EstadoConsulta } from "./transporte";

interface Puntaje {
  scenario_id: string;
  rank: number | null;
  prioridad: number | null;
}

interface ClasificacionPublica {
  evaluable?: boolean;
  rejilla?: string;
  material?: string[];
  nivel_agua?: string;
  confianza?: string;
  tipo?: string;
  gravedad?: string;
  personas_en_riesgo?: boolean;
}

interface CambioDespacho {
  crew_id: string;
  cuadrilla: string;
  is_simulated: boolean | null;
  hora: string;
  siguiente_antes: string | null;
  siguiente_despues: string | null;
}

export interface ObservacionPublica {
  id: string;
  sumidero_id: string | null;
  caso_id: string | null;
  caso_publico?: { estado: string; lat: number; lon: number } | null;
  ts: string;
  fuente: string;
  tipo: string;
  is_simulated: boolean;
  urgente: boolean | null;
  clasificacion: ClasificacionPublica | null;
  prioridad?: { antes: Puntaje | null; despues: Puntaje | null } | null;
  despachos?: CambioDespacho[];
}

export const ESCENARIO_CENTRAL = "base";
const opciones: GetOpts = { reintentos: 0, cache: "no-store" };

export const getRankingDurante = () => getRanking(ESCENARIO_CENTRAL, opciones, "durante", "zona_mut");

export async function getObservaciones() {
  const { items } = await apiGet<{ items: ObservacionPublica[] }>("/observations?limit=100", opciones);
  return items;
}

export const getRankingInicial = () => getRanking(ESCENARIO_CENTRAL, opciones, "antes", "zona_mut");

type Resultado<T> = { datos: T | null; estado: EstadoConsulta };

// ── Pulso de la central: cuándo respondió por última vez cada fuente y cuáles están fallando. ──
// Vive fuera de React para que solo el indicador "Actualizado hace N s" se vuelva a pintar cada segundo.
type Pulso = { ultimaOk: number | null; fallando: string[] };
let pulso: Pulso = { ultimaOk: null, fallando: [] };
const oyentes = new Set<() => void>();
function avisar(siguiente: Pulso) {
  pulso = siguiente;
  oyentes.forEach((o) => o());
}
export function marcarPulso(fuente: string, ok: boolean) {
  const fallando = ok ? pulso.fallando.filter((f) => f !== fuente) : pulso.fallando.includes(fuente) ? pulso.fallando : [...pulso.fallando, fuente];
  avisar({ ultimaOk: ok ? Date.now() : pulso.ultimaOk, fallando });
}
export function usePulso(): Pulso {
  return useSyncExternalStore(
    (o) => {
      oyentes.add(o);
      return () => oyentes.delete(o);
    },
    () => pulso,
    () => pulso,
  );
}

/** Cada fuente se refresca por separado. Una respuesta tardía nunca pisa una selección nueva. */
export function useConsultaPeriodica<T>(consultar: (() => Promise<T>) | null, fuente?: string): Resultado<T> {
  const [resultado, setResultado] = useState<Resultado<T>>({ datos: null, estado: "cargando" });

  useEffect(() => {
    if (!consultar) return;
    let vigente = true;
    let enCurso = false;
    let claveAnterior: string | undefined;
    setResultado({ datos: null, estado: "cargando" });

    async function actualizar() {
      if (!consultar || enCurso) return;
      enCurso = true;
      try {
        const datos = await consultar();
        if (fuente) marcarPulso(fuente, true);
        if (vigente) {
          const clave = JSON.stringify(datos);
          const sinCambios = clave === claveAnterior;
          claveAnterior = clave;
          setResultado((prev) => sinCambios && prev.estado === "ok" ? prev : {
            datos: sinCambios ? prev.datos : datos,
            estado: "ok",
          });
        }
      } catch {
        if (fuente) marcarPulso(fuente, false);
        if (vigente) setResultado((prev) => ({ ...prev, estado: "error" }));
      } finally {
        enCurso = false;
      }
    }

    void actualizar();
    const intervalo = setInterval(actualizar, INTERVALO_MS);
    return () => {
      vigente = false;
      clearInterval(intervalo);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consultar]);

  return resultado;
}

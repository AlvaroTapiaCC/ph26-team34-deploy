import { useEffect, useState } from "react";
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

/** Cada fuente se refresca por separado. Una respuesta tardía nunca pisa una selección nueva. */
export function useConsultaPeriodica<T>(consultar: (() => Promise<T>) | null): Resultado<T> {
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
  }, [consultar]);

  return resultado;
}

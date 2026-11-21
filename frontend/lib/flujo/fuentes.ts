// De dónde salen las observaciones que corrigen la simulación. El motor no sabe de dónde vienen:
// solo recibe, por sumidero, el nivel de agua observado y/o el estado de la rejilla.
import type { ScenarioId } from "../data";
import type { EstadoRejilla, NivelAgua } from "./config";

export interface ObservacionPunto {
  sumideroId: string; // ID_IDE del catastro
  nivelAgua?: NivelAgua;
  rejilla?: EstadoRejilla;
  ts: number; // ms
  fuente: string;
}

export interface ContextoFuente {
  scenario: ScenarioId;
  /** Rejillas del catastro que rodean a cada punto del ranking. */
  sumideroIdsPorPunto: Record<string, string[]>;
  /** Estado supuesto por el escenario para cada punto del ranking. */
  estadosEscenario: Record<string, EstadoRejilla>;
}

export interface FuenteObservaciones {
  id: "simulada" | "reportes" | "uoct" | "externa";
  nombre: string;
  /** Observaciones vigentes. Nunca lanza: si la fuente no responde, devuelve []. */
  obtener(ctx: ContextoFuente): Promise<ObservacionPunto[]>;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Simulada (la de ahora): el escenario supone el estado de las rejillas cercanas a cada punto del ranking. No hay niveles de agua observados. */
export const fuenteSimulada: FuenteObservaciones = {
  id: "simulada",
  nombre: "Simulada",
  async obtener({ sumideroIdsPorPunto, estadosEscenario }) {
    const ahora = Date.now();
    const out: ObservacionPunto[] = [];
    for (const [punto, estado] of Object.entries(estadosEscenario)) {
      for (const sumideroId of sumideroIdsPorPunto[punto] ?? []) out.push({ sumideroId, rejilla: estado, ts: ahora, fuente: "escenario" });
    }
    return out;
  },
};

interface ItemObservacion {
  sumidero_id: string | null;
  ts: string;
  tipo: string;
  clasificacion: { rejilla?: string; evaluable?: boolean; nivel_agua?: string } | null;
}

/** Reportes de vecinos y cuadrillas: GET /observations (#28). Cae a [] si el backend no responde. */
export const fuenteReportes: FuenteObservaciones = {
  id: "reportes",
  nombre: "Reportes",
  async obtener() {
    try {
      const desde = new Date(Date.now() - 6 * 3600_000).toISOString();
      const r = await fetch(`${API}/observations?desde=${encodeURIComponent(desde)}`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return [];
      const { items } = (await r.json()) as { items: ItemObservacion[] };
      const vistos = new Set<string>();
      const out: ObservacionPunto[] = [];
      for (const it of items) {
        // `items` viene de la más nueva a la más antigua: manda la última observación de cada sumidero
        if (!it.sumidero_id || vistos.has(it.sumidero_id) || !it.clasificacion) continue;
        vistos.add(it.sumidero_id);
        const c = it.clasificacion;
        const rejilla = c.evaluable && (c.rejilla === "limpia" || c.rejilla === "parcial" || c.rejilla === "tapada") ? c.rejilla : undefined;
        const nivel = c.nivel_agua as NivelAgua | undefined;
        out.push({ sumideroId: it.sumidero_id, rejilla, nivelAgua: nivel && nivel !== "no_evaluable" ? nivel : undefined, ts: Date.parse(it.ts), fuente: "reportes" });
      }
      return out;
    } catch {
      return [];
    }
  },
};

/** UOCT / cámaras de tránsito. TODO: requiere un convenio con el municipio o la UOCT (plan §4, "cámaras municipales en vivo"). Sin datos falsos. */
export const fuenteUoct: FuenteObservaciones = {
  id: "uoct",
  nombre: "UOCT / Cámaras",
  async obtener() {
    // TODO: leer cuadros de las cámaras, clasificarlos con POST /clasificar/camara y devolver el nivel de agua por punto.
    return [];
  },
};

/** API externa (p. ej. estaciones de la DMC o sensores). TODO: definir proveedor y formato. Sin datos falsos. */
export const fuenteExterna: FuenteObservaciones = {
  id: "externa",
  nombre: "API externa",
  async obtener() {
    // TODO: consultar la API externa y mapear sus estaciones o sensores al sumidero más cercano.
    return [];
  },
};

export const FUENTES: FuenteObservaciones[] = [fuenteSimulada, fuenteReportes, fuenteUoct, fuenteExterna];

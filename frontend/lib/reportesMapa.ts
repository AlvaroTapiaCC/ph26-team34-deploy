import type { ObservacionPublica } from "./central";
import type { LngLat } from "./data";

export interface ReporteMapa {
  id: string;
  sumideroId: string | null;
  rankeado: boolean;
  coord: LngLat;
  titulo: string;
  tipo: "agua" | "obstruccion" | "reporte" | "despejada";
  fuente: string;
  ts: string;
  simulado: boolean;
  ubicacion: string;
}

/** Último reporte por lugar, no un diagnóstico de cierre vial ni una medición de profundidad. */
export function reportesParaMapa(
  observaciones: readonly ObservacionPublica[],
  rejillas: readonly { sumidero_id: string; lon: number; lat: number }[],
  ahora: number,
): ReporteMapa[] {
  const coordenadas = new Map(rejillas.map((r) => [r.sumidero_id, [r.lon, r.lat] as LngLat]));
  const vistos = new Set<string>();
  const salida: ReporteMapa[] = [];
  const ordenadas = [...observaciones].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  for (const o of ordenadas) {
    const ts = Date.parse(o.ts);
    // El mapa muestra evidencia reciente; el sello de captura sigue visible en el globo.
    if (!Number.isFinite(ts) || ts > ahora || ahora - ts >= 72 * 3600_000) continue;
    const caso = o.caso_publico;
    if (caso && ["cerrado", "descartado"].includes(caso.estado)) continue;
    const clave = o.sumidero_id ?? o.caso_id ?? o.id;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const coord: LngLat | undefined = caso ? [caso.lon, caso.lat] : o.sumidero_id ? coordenadas.get(o.sumidero_id) : undefined;
    if (!coord || !coord.every(Number.isFinite) || Math.abs(coord[0]) > 180 || Math.abs(coord[1]) > 90) continue;
    const c = o.clasificacion;
    let titulo = "Reporte por verificar";
    let tipo: ReporteMapa["tipo"] = "reporte";
    if (c && c.evaluable !== false) {
      const agua: Record<string, string> = { cuneta: "Agua en la cuneta", hasta_vereda: "Agua hasta la vereda", sobre_vereda: "Agua sobre la vereda" };
      if (c.nivel_agua && agua[c.nivel_agua]) {
        titulo = agua[c.nivel_agua];
        tipo = "agua";
      } else if (c.rejilla === "tapada" || c.rejilla === "parcial" || c.tipo === "rejilla_tapada") {
        titulo = c.rejilla === "parcial" ? "Obstrucción parcial" : "Obstrucción reportada";
        tipo = "obstruccion";
      } else if (c.rejilla === "limpia") {
        titulo = "Rejilla despejada en foto";
        tipo = "despejada";
      } else if (c.nivel_agua === "sin_agua") {
        titulo = "Sin agua en el reporte";
      }
    }
    if (c?.evaluable === false) titulo = "Foto no evaluable";
    salida.push({ id: o.id, sumideroId: o.sumidero_id, rankeado: !!o.sumidero_id && coordenadas.has(o.sumidero_id), coord, titulo, tipo, fuente: o.fuente, ts: o.ts, simulado: o.is_simulated, ubicacion: caso ? "Ubicación del reporte" : "Ubicado en la rejilla asociada" });
  }
  return salida;
}

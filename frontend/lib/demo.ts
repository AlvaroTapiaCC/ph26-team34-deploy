// Reconstrucción local: lluvia histórica y fórmula congelada; foto/agua simuladas.
// Regenerar con backend/.venv/bin/python pipeline/16_demo_san_carlos.py.
import historico from "./demo-san-carlos.json" with { type: "json" };
import type { ApiRankingItem } from "./api";
import type { ObservacionPublica } from "./central";
import type { Cuadrilla, RutaCuadrilla } from "./cuadrilla";
import type { Expuestos } from "./transporte";

export const DEMO_SUMIDERO = "AL13SU012988";
export const DEMO_CENTRO: [number, number] = [-70.544252, -33.406522];
export const PASOS_DEMO = [
  { corte: 0, titulo: "Anticipar la lluvia", texto: "7 de octubre, 18:00. El pronóstico anuncia lluvia para las próximas 24 horas. La fórmula prioriza rejillas de San Carlos y su entorno antes del pulso más intenso." },
  { corte: 1, titulo: "Ver cómo cambia el escenario", texto: "8 de octubre, 17:00. La lluvia histórica llega a 6,4 mm/h. El ranking se recalcula con la lluvia y el viento disponibles a esta hora; compara la prioridad inicial con la actual." },
  { corte: 2, titulo: "Incorporar evidencia de calle", texto: "Añadimos una foto de ejemplo de una rejilla tapada en Camino El Alba. Su clasificación está simulada: la fórmula usa esa evidencia en vez de inferir la obstrucción." },
  { corte: 2, titulo: "Cambiar la siguiente parada", texto: "La propuesta de limpieza incorpora la rejilla reportada. Abre las paradas en Google Maps para calcular la conducción por calles; la central sigue decidiendo el despacho." },
  { corte: 3, titulo: "Revisar el transporte expuesto", texto: "Añadimos agua simulada hasta la vereda. Revisa los servicios afectados en el sector y selecciona un recorrido para examinar su trazado y paraderos. Un aviso de desvío lo confirma Red." },
  { corte: 3, titulo: "Dos decisiones, una misma evidencia", texto: "La central puede priorizar la limpieza y revisar el transporte expuesto. Esta reconstrucción no demuestra que limpiar rejillas hubiera evitado el aluvión. No se envió ningún despacho ni aviso." },
] as const;

export const HORAS_DEMO = historico.horas;
export function capasDemo(paso: number) {
  return { agua: paso === 1, calor: paso <= 1, cadenas: false, transporte: paso >= 4, limites: false,
    catastro: paso < 4, infra: false, colectores: false, criticos: false,
    reportes: paso >= 2, ruta: paso === 3 };
}

function ranking(corte: number): ApiRankingItem[] {
  return historico.cortes[corte].ranking.map((p) => ({ ...p,
    ...historico.puntos[p.sumidero_id as keyof typeof historico.puntos],
    detalle: p.detalle as ApiRankingItem["detalle"],
    computed_at: historico.cortes[corte].hora.hora_utc,
    intersection_id: null, street_id: null, is_simulated: true,
    explicacion: "Reconstrucción de octubre: fórmula congelada, no predicción operativa previa.",
  }));
}

export function datosDemo(paso: number, transporteLocal?: Expuestos | null) {
  const corte = PASOS_DEMO[paso]?.corte ?? 0;
  const hora = historico.cortes[corte].hora;
  const inicial = ranking(0);
  const durante = ranking(corte);
  const foto = paso >= 2;
  const agua = paso >= 4;
  const punto = durante.find((p) => p.sumidero_id === DEMO_SUMIDERO)!;
  const antesFoto = ranking(1).find((p) => p.sumidero_id === DEMO_SUMIDERO)!;
  const cuadrilla: Cuadrilla = { id: "demo-san-carlos", nombre: "San Carlos · simulada", equipamiento: ["herramientas manuales"], estado: "disponible", is_simulated: true, carga: 3, lon: -70.551, lat: -33.416 };
  const base = paso === 0 ? inicial : ranking(1);
  const orden = paso >= 3 ? [punto, ...durante.filter((p) => p.sumidero_id !== DEMO_SUMIDERO).slice(0, 2)] : base.slice(0, 3);
  const ruta: RutaCuadrilla = { crew_id: cuadrilla.id, origen: "calculada", version: paso >= 3 ? 2 : 1,
    misiones: orden.map((p, i) => ({ mission_id: `demo-${p.sumidero_id}`, orden: i + 1, estado: "pendiente", sumidero_id: p.sumidero_id, case_id: null, nombre: p.intersection_nombre!, lat: p.lat, lon: p.lon })),
    // Sin línea recta engañosa: Google Maps calcula la ruta vial al abrir el enlace.
    geojson: null,
  };
  const observaciones: ObservacionPublica[] = foto ? [{ id: "demo-san-carlos-foto", sumidero_id: DEMO_SUMIDERO, caso_id: null, ts: hora.hora_utc, fuente: "vecino", tipo: "foto_rejilla", is_simulated: true, urgente: false,
    clasificacion: { evaluable: true, rejilla: "tapada", material: ["hojas"], confianza: "alta" },
    prioridad: { antes: { scenario_id: "demo-local", rank: antesFoto.rank, prioridad: antesFoto.prioridad }, despues: { scenario_id: "demo-local", rank: punto.rank, prioridad: punto.prioridad } },
    despachos: paso >= 3 ? [{ crew_id: cuadrilla.id, cuadrilla: cuadrilla.nombre, is_simulated: true, hora: hora.hora_utc, siguiente_antes: base[0].intersection_nombre, siguiente_despues: punto.intersection_nombre }] : [],
  }] : [];
  const transporte: Expuestos = agua && transporteLocal ? transporteLocal : {
    scenario_id: "demo-local", calculado_at: hora.hora_utc, nota: "Reconstrucción San Carlos · incidente simulado", aviso: "Sin avisos ni despachos reales. Los desvíos requieren confirmación de Red.", fuente: null,
    parametros: { radio_m: 80, aguas_abajo_m: 150, riesgo_top_n: 5, vigencia_agua_horas: 6 },
    evidencia_agua: agua ? [{ sumidero_id: DEMO_SUMIDERO, nivel: "hasta_vereda", ts: hora.hora_utc, is_simulated: true }] : [], expuestos: [], en_riesgo: [],
  };
  return { inicial, durante, hora, cuadrilla, ruta, observaciones, transporte };
}

import type { ObservacionPublica } from "./central";
import type { LngLat, Prioridad } from "./data";

type Feature<Geometry, Properties> = { type: "Feature"; geometry: Geometry; properties: Properties };
type Linea = { type: "LineString"; coordinates: [LngLat, LngLat] };
type Punto = { type: "Point"; coordinates: LngLat };
export type Tramo = Feature<Linea, { desde: string; hasta: string; distancia_m: number }>;
type Cadena = Feature<Linea | Punto, { tipo: string; simulado?: boolean }>;

const HORA_MS = 60 * 60_000;
const VIGENCIA_FOTO_H = 72; // observado.vigencia_horas en backend/config/formula.yaml
const NIVELES_AGUA = new Set(["cuneta", "hasta_vereda", "sobre_vereda"]);

let carga: Promise<Tramo[]> | undefined;

export function cargarCadenas() {
  carga ??= fetch("/data/cadenas_mut.geojson")
    .then(async (r) => {
      if (!r.ok) throw new Error("No se pudo cargar la red de cadenas");
      const { features } = await r.json() as { features: Tramo[] };
      return features;
    })
    .catch((error) => {
      carga = undefined;
      throw error;
    });
  return carga;
}

type Evidencia = { ts: number; simulado: boolean; activa: boolean };

function incorporar(mapa: Map<string, Evidencia>, id: string, evidencia: Evidencia) {
  if ((mapa.get(id)?.ts ?? -Infinity) < evidencia.ts) mapa.set(id, evidencia);
}

function evidenciaVigente(observaciones: ObservacionPublica[], ahora: number, vigenciaAguaH: number) {
  const agua = new Map<string, Evidencia>();
  const obstruccion = new Map<string, Evidencia>();
  for (const o of observaciones) {
    const c = o.clasificacion;
    const id = o.sumidero_id;
    const ts = Date.parse(o.ts);
    if (!c || !id || c.evaluable === false || !Number.isFinite(ts) || ts > ahora) continue;
    const h = (ahora - ts) / HORA_MS;
    const simulado = o.is_simulated;
    if (o.tipo === "foto_rejilla" && h < VIGENCIA_FOTO_H && (c.rejilla === "tapada" || c.rejilla === "parcial" || c.rejilla === "limpia")) {
      incorporar(obstruccion, id, { ts, simulado, activa: c.rejilla !== "limpia" });
    }
    const nivel = c.nivel_agua ?? "";
    const mojada = NIVELES_AGUA.has(nivel);
    // Un acercamiento a la rejilla sin agua no describe el estado de la calle (#91).
    if (h < vigenciaAguaH && (mojada || (nivel === "sin_agua" && o.tipo !== "foto_rejilla"))) {
      incorporar(agua, id, { ts, simulado, activa: mojada });
    }
  }
  return { obstruccion, agua };
}

function tramosAguasAbajo(
  origenes: Map<string, Evidencia>,
  salidas: Map<string, Tramo[]>,
  limite: number,
  ignoraTramo: (tramo: Tramo) => boolean = () => false,
) {
  const activos = new Map<Tramo, boolean>(); // true si el tramo solo se vincula a observaciones simuladas
  for (const [id, informe] of origenes) {
    if (!informe.activa) continue;
    const distancias = new Map([[id, 0]]);
    const pendientes: Array<{ id: string; distancia: number }> = [{ id, distancia: 0 }];
    while (pendientes.length) {
      const nodo = pendientes.pop()!;
      for (const tramo of salidas.get(nodo.id) ?? []) {
        const { hasta, distancia_m } = tramo.properties;
        const distancia = nodo.distancia + distancia_m;
        if (distancia > limite || ignoraTramo(tramo)) continue;
        activos.set(tramo, (activos.get(tramo) ?? true) && informe.simulado);
        if (distancia >= (distancias.get(hasta) ?? Infinity)) continue;
        distancias.set(hasta, distancia);
        pendientes.push({ id: hasta, distancia });
      }
    }
  }
  return activos;
}

export function capaCadenas(
  tramos: Tramo[],
  prioridades: ReadonlyMap<string, Prioridad>,
  observaciones: ObservacionPublica[],
  ahora: number,
  vigenciaAguaH: number,
  alcanceAguaM: number,
) {
  const salidas = new Map<string, Tramo[]>();
  const coordenadas = new Map<string, LngLat>();
  for (const tramo of tramos) {
    const { desde, hasta } = tramo.properties;
    const [a, b] = tramo.geometry.coordinates;
    const grupo = salidas.get(desde) ?? [];
    grupo.push(tramo);
    salidas.set(desde, grupo);
    coordenadas.set(desde, a);
    coordenadas.set(hasta, b);
  }

  const { obstruccion, agua } = evidenciaVigente(observaciones, ahora, vigenciaAguaH);
  const bajoObstruccion = tramosAguasAbajo(obstruccion, salidas, Infinity);
  const bajoAgua = tramosAguasAbajo(
    agua, salidas, alcanceAguaM,
    ({ properties }) => agua.get(properties.hasta)?.activa === false,
  );
  const features: Cadena[] = tramos.map((tramo) => {
    const { desde, hasta } = tramo.properties;
    const prioridad = prioridades.get(hasta) ?? prioridades.get(desde);
    return { type: "Feature", geometry: tramo.geometry, properties: { tipo: prioridad ?? "sin_prioridad" } };
  });
  for (const [tipo, mapa] of [["obstruccion_abajo", bajoObstruccion], ["agua_abajo", bajoAgua]] as const) {
    for (const [tramo, simulado] of mapa) {
      features.push({ type: "Feature", geometry: tramo.geometry, properties: { tipo, simulado } });
    }
  }
  for (const [tipo, informes] of [["obstruccion_observada", obstruccion], ["agua_observada", agua]] as const) {
    for (const [id, informe] of informes) {
      const coord = coordenadas.get(id);
      if (!coord || !informe.activa) continue;
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: coord }, properties: { tipo, simulado: informe.simulado } });
    }
  }
  return {
    geojson: { type: "FeatureCollection" as const, features },
    haySimulados: features.some(({ properties }) => properties.simulado),
  };
}

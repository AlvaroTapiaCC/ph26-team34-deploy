// Cliente del backend. Usa NEXT_PUBLIC_API_URL (la misma que lib/store.tsx).
// Render (plan gratuito) tarda ~50 s en despertar: timeout largo, reintento y aviso "despertando".

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(
    msg: string,
    readonly estado?: number,
  ) {
    super(msg);
  }
}

export interface GetOpts {
  timeoutMs?: number;
  reintentos?: number;
  /** Se llama una vez si la respuesta tarda más de `lentoMs`: el servidor probablemente está despertando. */
  onLento?: () => void;
  lentoMs?: number;
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function apiGet<T>(ruta: string, o: GetOpts = {}): Promise<T> {
  const { timeoutMs = 70_000, reintentos = 2, onLento, lentoMs = 5_000 } = o;
  let ultimo: unknown;
  const aviso = onLento ? setTimeout(onLento, lentoMs) : null;
  try {
    for (let i = 0; i <= reintentos; i++) {
      try {
        const r = await fetch(`${API_URL}${ruta}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) return (await r.json()) as T;
        // 4xx (salvo 408/429) no mejora reintentando
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new ApiError(`El servidor respondió ${r.status}`, r.status);
        ultimo = new ApiError(`El servidor respondió ${r.status}`, r.status);
      } catch (e) {
        if (e instanceof ApiError && e.estado && e.estado < 500 && e.estado !== 408 && e.estado !== 429) throw e;
        ultimo = e;
      }
      if (i < reintentos) await espera(1500 * (i + 1));
    }
  } finally {
    if (aviso) clearTimeout(aviso);
  }
  throw ultimo instanceof Error ? ultimo : new ApiError("No se pudo conectar con el servidor");
}

// --- Contrato real (backend/app/routers/{scenarios,sumideros}.py) ---

export interface ApiEscenario {
  id: string;
  nombre: string;
  descripcion: string | null;
  parametros: Record<string, unknown>;
}

export interface ApiDetalle {
  p?: number;
  urgente?: boolean;
  aportes?: Record<string, number>;
  fuente_p?: string;
  area_norm?: number;
  criticidad?: number;
  area_faltante?: boolean;
  [k: string]: unknown;
}

export interface ApiRankingItem {
  rank: number;
  sumidero_id: string;
  p_pred: number | null;
  p_obs: number | null;
  p_ef: number | null;
  c: number | null;
  prioridad: number | null;
  explicacion: string | null;
  detalle: ApiDetalle | null;
  computed_at: string | null;
  intersection_id: string | null;
  intersection_nombre: string | null;
  street_id: string | null;
  is_simulated: boolean;
  lat: number;
  lon: number;
}

export interface ApiRanking {
  scenario_id: string;
  modo: "antes" | "durante";
  items: ApiRankingItem[];
}

export interface ApiScore {
  modo: "antes" | "durante";
  rank: number;
  p_pred: number | null;
  p_obs: number | null;
  p_ef: number | null;
  c: number | null;
  prioridad: number | null;
  explicacion: string | null;
  detalle: ApiDetalle | null;
  computed_at: string | null;
}

export interface ApiFicha {
  id: string;
  fuente: string;
  features: Record<string, unknown>;
  elevacion: number | null;
  street_id: string | null;
  orden_en_calle: number | null;
  intersection_id: string | null;
  intersection_nombre: string | null;
  is_simulated: boolean;
  lat: number;
  lon: number;
  cadena: { street_id: string; nombre: string | null; posicion: number; aguas_arriba: string[]; aguas_abajo: string[] } | null;
  scores: Partial<Record<"antes" | "durante", ApiScore>>;
  observaciones: {
    id: string;
    fuente: string;
    tipo: string;
    tiene_foto: boolean;
    tiene_texto: boolean;
    ts: string;
    clasificacion: unknown;
  }[];
  ultima_limpieza: { fecha: string; is_simulated: boolean } | null;
}

export const getEscenarios = (o?: GetOpts) => apiGet<ApiEscenario[]>("/scenarios", o);
export const getRanking = (id: string, o?: GetOpts) => apiGet<ApiRanking>(`/scenarios/${encodeURIComponent(id)}/ranking?modo=antes&limit=5000`, o);
export const getFicha = (id: string, escenario: string, o?: GetOpts) => apiGet<ApiFicha>(`/sumideros/${encodeURIComponent(id)}?scenario_id=${encodeURIComponent(escenario)}`, o);

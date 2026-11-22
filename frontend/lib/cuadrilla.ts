// Cliente de la app de cuadrilla (/cuadrilla, issue #38). Endpoints de #80:
// GET /crews, GET /crews/{id}/route, POST /missions/{id}/status y POST /missions/{id}/close.
// Los POST llevan X-Crew-Token (NEXT_PUBLIC_CREW_TOKEN): es casi público, nunca el ADMIN_TOKEN.
import { API_URL, ApiError } from "./api";

const CREW_TOKEN = process.env.NEXT_PUBLIC_CREW_TOKEN ?? "";

export type EstadoMision = "pendiente" | "en_camino" | "en_sitio" | "cerrada" | "cancelada";

export interface Cuadrilla {
  id: string;
  nombre: string;
  equipamiento: string[];
  estado: string;
  is_simulated: boolean;
  carga: number;
}

export interface Mision {
  mission_id: string;
  orden: number | null;
  estado: EstadoMision;
  sumidero_id: string | null;
  case_id: string | null;
  nombre: string;
  lat: number | null;
  lon: number | null;
}

export interface ResumenParada {
  mission_id: string | null;
  sumidero_id: string | null;
  case_id: string | null;
  nombre: string;
}

export interface UltimoCambio {
  hora: string;
  motivo: string | null;
  ruta_version: number | null;
  siguiente_antes: ResumenParada | null;
  siguiente_despues: ResumenParada | null;
  observacion: {
    tipo: string;
    fuente: string;
    is_simulated: boolean;
    rejilla: string | null;
    nivel_agua: string | null;
    material: string[];
  } | null;
}

export interface RutaCuadrilla {
  crew_id: string;
  origen: "despacho" | "calculada" | "sin_misiones";
  version: number | null;
  misiones: Mision[];
  ultimo_cambio?: UltimoCambio | null;
  posicion_oculta?: boolean;
}

/** Respuesta de POST /missions/{id}/close. `resultado`, `cerrada` y `motivo` llegan con #42;
 * antes de eso solo viene `cierre.verificado` (siempre false) y la misión queda cerrada. */
export interface RespCierre {
  mision: { id: string; estado: EstadoMision; sumidero_id: string | null };
  cierre?: { verificado: boolean } | null;
  cerrada?: boolean;
  verificado?: boolean;
  resultado?: "verificado" | "sin_verificar" | "rechazado";
  motivo?: string | null;
}

export type ResultadoCierre = "verificado" | "sin_verificar" | "rechazado";

export function resultadoCierre(r: RespCierre): ResultadoCierre {
  if (r.resultado) return r.resultado;
  if (r.cerrada === false) return "rechazado";
  return (r.verificado ?? r.cierre?.verificado) ? "verificado" : "sin_verificar";
}

async function pedir<T>(ruta: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_URL}${ruta}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ApiError("No se pudo conectar con el servidor");
  }
  if (!r.ok) {
    let detalle = "";
    try {
      detalle = ((await r.json()) as { detail?: unknown }).detail as string;
    } catch {}
    throw new ApiError(typeof detalle === "string" && detalle ? detalle : `El servidor respondió ${r.status}`, r.status);
  }
  return (await r.json()) as T;
}

const conToken = (h: Record<string, string> = {}) => (CREW_TOKEN ? { ...h, "X-Crew-Token": CREW_TOKEN } : h);

export const getCuadrillas = () => pedir<Cuadrilla[]>("/crews", {}, 70_000);
export const getRuta = (crewId: string) => pedir<RutaCuadrilla>(`/crews/${encodeURIComponent(crewId)}/route`);

export const cambiarEstado = (missionId: string, estado: Exclude<EstadoMision, "cerrada">) =>
  pedir<{ estado: EstadoMision }>(`/missions/${encodeURIComponent(missionId)}/status`, {
    method: "POST",
    headers: conToken({ "Content-Type": "application/json" }),
    body: JSON.stringify({ estado }),
  });

export function cerrarMision(missionId: string, foto: Blob, nombre: string) {
  const fd = new FormData();
  fd.append("foto", foto, nombre);
  // Con #42 el cierre espera a Claude: margen amplio
  return pedir<RespCierre>(`/missions/${encodeURIComponent(missionId)}/close`, { method: "POST", headers: conToken(), body: fd }, 90_000);
}

export function urlGoogleMaps(paradas: { lat: number; lon: number }[]): string {
  const pts = paradas.map((p) => `${p.lat},${p.lon}`);
  if (!pts.length) return "https://www.google.com/maps";
  const base = "https://www.google.com/maps/dir/?api=1&travelmode=driving";
  // Sin origen: Google Maps parte en la ubicación del celular. Máximo 3 paradas intermedias en móvil.
  const destino = pts[Math.min(pts.length, 4) - 1];
  const way = pts.slice(0, Math.min(pts.length, 4) - 1).join("|");
  return `${base}&destination=${destino}${way ? `&waypoints=${encodeURIComponent(way)}` : ""}`;
}

const REJILLA: Record<string, string> = { tapada: "rejilla tapada", parcial: "rejilla parcialmente tapada", limpia: "rejilla limpia" };
const AGUA: Record<string, string> = { cuneta: "agua en la cuneta", hasta_vereda: "agua hasta la vereda", sobre_vereda: "agua sobre la vereda" };
const FUENTE: Record<string, string> = { vecino: "foto de vecino", cuadrilla: "foto de cuadrilla", camara: "cámara" };

/** "foto de vecino: rejilla tapada", "cierre de otra misión", etc. */
export function textoMotivo(c: UltimoCambio): string {
  const o = c.observacion;
  if (o) {
    const origen = o.tipo === "texto" ? "reporte de texto" : (FUENTE[o.fuente] ?? "reporte");
    const que = (o.rejilla && REJILLA[o.rejilla]) || (o.nivel_agua && AGUA[o.nivel_agua]) || null;
    return `${origen}${que ? `: ${que}` : ""}${o.is_simulated ? " (simulado)" : ""}`;
  }
  if (c.motivo === "cierre") return "se cerró una misión";
  if (c.motivo === "plan_inicial") return "plan inicial de la central";
  return "la central recalculó el plan";
}

export const horaSantiago = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" });

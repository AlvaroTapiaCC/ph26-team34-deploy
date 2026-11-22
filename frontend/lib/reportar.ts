// Utilidades de /reportar: compresión de foto, GPS y llamadas a /clasificar.
import { API, type ClasificacionAgua, type ClasificacionRejilla, type LecturaTexto } from "./observations";

const MAX_LADO = 1600;

export const NIVEL_AGUA_TXT = {
  sin_agua: "Sin agua",
  cuneta: "Agua en la cuneta",
  hasta_vereda: "Agua hasta la vereda",
  sobre_vereda: "Agua sobre la vereda",
  no_evaluable: "No se puede evaluar",
} as const;

export async function imagenJpeg(origen: CanvasImageSource, ancho: number, alto: number): Promise<Blob | null> {
  if (!ancho || !alto) return null;
  const escala = Math.min(1, MAX_LADO / Math.max(ancho, alto));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(ancho * escala);
  canvas.height = Math.round(alto * escala);
  const contexto = canvas.getContext("2d");
  if (!contexto) return null;
  contexto.drawImage(origen, 0, 0, canvas.width, canvas.height);
  return new Promise((resolver) => canvas.toBlob(resolver, "image/jpeg", 0.8));
}

/** Redimensiona a ≤1600 px de lado y recodifica a JPEG ~0,8. Si el navegador no puede leerla, devuelve la original. */
export async function comprimirFoto(file: File): Promise<Blob> {
  try {
    const imagen = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      return (await imagenJpeg(imagen, imagen.width, imagen.height)) ?? file;
    } finally {
      imagen.close();
    }
  } catch {
    return file;
  }
}

export type Gps = { lat: number; lon: number; precision_m: number; t: number };

export function pedirGps(): Promise<Gps> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("Este navegador no tiene GPS"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, precision_m: Math.round(p.coords.accuracy), t: p.timestamp }),
      (e) => reject(new Error(e.code === 1 ? "Permiso de ubicación denegado" : e.code === 3 ? "El GPS tardó demasiado" : "No se pudo obtener la ubicación")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

export function distM(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export class ErrorApi extends Error {
  constructor(msg: string, readonly estado?: number) {
    super(msg);
  }
}

async function post<T>(ruta: string, init: RequestInit): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000); // Render puede tardar ~50 s en despertar
  try {
    const r = await fetch(`${API}${ruta}`, { ...init, signal: ctl.signal });
    if (!r.ok) {
      let detalle = "";
      try {
        detalle = ((await r.json()) as { detail?: string }).detail ?? "";
      } catch {}
      throw new ErrorApi(detalle || `El servidor respondió ${r.status}`, r.status);
    }
    return (await r.json()) as T;
  } catch (e) {
    if (e instanceof ErrorApi) throw e;
    throw new ErrorApi("No se pudo conectar con el servidor");
  } finally {
    clearTimeout(timer);
  }
}

export type RespRejilla = { clasificacion: ClasificacionRejilla; claude_disponible: boolean; fallo?: string | null };
export type RespAgua = { clasificacion: ClasificacionAgua; senal_camara: number; claude_disponible: boolean; fallo?: string | null };
export type RespTexto = { lectura: LecturaTexto; urgente: boolean; numeros_emergencia: unknown[]; claude_disponible: boolean; fallo?: string | null };

export function clasificarRejilla(foto: Blob, nombre: string) {
  const fd = new FormData();
  fd.append("foto", foto, nombre);
  return post<RespRejilla>("/clasificar/rejilla", { method: "POST", body: fd });
}

/** Foto del agua: criterio de cuadro de calle (no exige ver una rejilla). */
export function clasificarAgua(foto: Blob, nombre: string) {
  const fd = new FormData();
  fd.append("foto", foto, nombre);
  return post<RespAgua>("/clasificar/camara", { method: "POST", body: fd });
}

export function clasificarTexto(texto: string) {
  return post<RespTexto>("/clasificar/texto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto }) });
}

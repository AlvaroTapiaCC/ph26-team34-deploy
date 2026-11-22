// Reportes de /reportar. Intenta POST /observations (backend, #28); si responde 501 o falla,
// el reporte queda en una cola local (localStorage) para no perder nada en terreno.

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type TipoReporte = "rejilla" | "agua" | "texto";

export type ClasificacionRejilla = {
  evaluable: boolean;
  rejilla: "limpia" | "parcial" | "tapada" | "no_evaluable";
  material: string[];
  hojas_calzada: "pocas" | "muchas";
  agua_visible: boolean;
  nivel_agua: "sin_agua" | "cuneta" | "hasta_vereda" | "sobre_vereda" | "no_evaluable";
  confianza: "alta" | "media" | "baja";
  nota: string;
};

/** /clasificar/camara (foto del agua): mismo esquema sin `rejilla`, más `basura_calzada`. */
export type ClasificacionAgua = Omit<ClasificacionRejilla, "rejilla"> & { basura_calzada: "poca" | "mucha" };

export type LecturaTexto = {
  tipo: string;
  gravedad: "baja" | "media" | "alta";
  personas_en_riesgo: boolean;
  ubicacion_texto: string | null;
  desde_cuando: string | null;
  nivel_agua: ClasificacionRejilla["nivel_agua"];
};

export type Observacion = {
  id: string;
  tipo: TipoReporte;
  lat: number | null;
  lon: number | null;
  precision_m: number | null;
  sin_gps: boolean;
  hora: string; // ISO
  clasificacion: ClasificacionRejilla | ClasificacionAgua | LecturaTexto | null;
  archivo: string | null;
  texto?: string;
  urgente?: boolean;
  // Solo modo prueba de campo
  rejilla_num?: number;
  id_ide?: string | null;
  enviado: boolean;
};

const KEY = "drena.observaciones.v1";

export function leerCola(): Observacion[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Observacion[];
  } catch {
    return [];
  }
}

function guardarCola(lista: Observacion[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lista));
  } catch {
    // Sin espacio o almacenamiento bloqueado: el envío al servidor sigue.
  }
}

export function nuevoId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Guarda en la cola local y luego intenta enviarlo al backend. Nunca lanza.
 *  Si la observación ya está en la cola (reintento), la reemplaza en vez de duplicarla. */
export async function registrar(obs: Observacion, foto?: Blob | null): Promise<Observacion> {
  guardarCola([...leerCola().filter((o) => o.id !== obs.id), obs]);
  const enviado = await intentarEnviar(obs, foto);
  if (enviado) {
    guardarCola(leerCola().map((o) => (o.id === obs.id ? { ...o, enviado: true } : o)));
    return { ...obs, enviado: true };
  }
  return obs;
}

const ESPERA_ENVIO_MS = 60_000; // Render puede tardar ~50 s en despertar

type DatosEnvio = Pick<Observacion, "id" | "tipo" | "lat" | "lon" | "hora" | "archivo"> & { fuente?: "camara_fija" };

export async function enviarObservacion(datos: DatosEnvio, foto?: Blob | null, signal?: AbortSignal): Promise<Response> {
  const ctl = new AbortController();
  const cancelar = () => ctl.abort();
  if (signal?.aborted) cancelar();
  signal?.addEventListener("abort", cancelar, { once: true });
  const timer = setTimeout(() => ctl.abort(), ESPERA_ENVIO_MS);
  try {
    const fd = new FormData();
    fd.append("datos", JSON.stringify(datos));
    if (foto && datos.archivo) fd.append("foto", foto, datos.archivo);
    return await fetch(`${API}/observations`, { method: "POST", body: fd, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancelar);
  }
}

async function intentarEnviar(obs: Observacion, foto?: Blob | null): Promise<boolean> {
  try {
    return (await enviarObservacion(obs, foto)).ok;
  } catch {
    return false;
  }
}

// --- Exportación (prueba de campo) ---

export function esDeHoy(o: Observacion): boolean {
  return new Date(o.hora).toDateString() === new Date().toDateString();
}

/** Solo las capturas hechas en modo prueba de campo (llevan número de rejilla). */
export function esCapturaCampo(o: Observacion): boolean {
  return o.rejilla_num !== undefined && o.rejilla_num !== null;
}

function clasifRejilla(o: Observacion): ClasificacionRejilla | null {
  return o.clasificacion && "rejilla" in o.clasificacion ? o.clasificacion : null;
}

export function aCsv(lista: Observacion[]): string {
  const cab = ["rejilla", "ID_IDE", "lat", "lon", "hora", "rejilla_claude", "confianza"];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const filas = lista.map((o) => {
    const c = clasifRejilla(o);
    return [o.rejilla_num, o.id_ide, o.lat, o.lon, o.hora, c?.rejilla, c?.confianza].map(esc).join(",");
  });
  return [cab.join(","), ...filas].join("\n");
}

export function descargar(nombre: string, contenido: Blob | string, mime = "text/plain") {
  const blob = typeof contenido === "string" ? new Blob([contenido], { type: `${mime};charset=utf-8` }) : contenido;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function exportarDia(lista: Observacion[]) {
  const dia = new Date().toISOString().slice(0, 10);
  descargar(`prueba-campo-${dia}.json`, JSON.stringify(lista, null, 2), "application/json");
  setTimeout(() => descargar(`prueba-campo-${dia}.csv`, aCsv(lista), "text/csv"), 300);
}

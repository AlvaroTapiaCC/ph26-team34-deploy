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
  clasificacion: ClasificacionRejilla | LecturaTexto | null;
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
  localStorage.setItem(KEY, JSON.stringify(lista));
}

export function nuevoId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Guarda en la cola local y luego intenta enviarlo al backend. Nunca lanza. */
export async function registrar(obs: Observacion, foto?: Blob | null): Promise<Observacion> {
  const lista = leerCola();
  lista.push(obs);
  guardarCola(lista);
  const enviado = await intentarEnviar(obs, foto);
  if (enviado) {
    guardarCola(leerCola().map((o) => (o.id === obs.id ? { ...o, enviado: true } : o)));
    return { ...obs, enviado: true };
  }
  return obs;
}

async function intentarEnviar(obs: Observacion, foto?: Blob | null): Promise<boolean> {
  try {
    const fd = new FormData();
    fd.append("datos", JSON.stringify(obs));
    if (foto && obs.archivo) fd.append("foto", foto, obs.archivo);
    const r = await fetch(`${API}/observations`, { method: "POST", body: fd });
    return r.ok; // 501 (aún no implementado) u otro error: queda en la cola local
  } catch {
    return false;
  }
}

// --- Exportación (prueba de campo) ---

export function esDeHoy(o: Observacion): boolean {
  return new Date(o.hora).toDateString() === new Date().toDateString();
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

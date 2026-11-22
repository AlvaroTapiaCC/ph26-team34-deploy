// Paleta de colores del front (#131). Una sola fuente de verdad: `paleta.json`.
// - globals.css define los mismos valores por defecto en :root (entre `paleta:inicio` y `paleta:fin`);
//   `scripts/verificar-paleta.mjs` corre antes del build y falla si no coinciden.
// - Cada color es una variable CSS `--<id>`. Los derivados (versiones tenues, sombras con
//   transparencia) se calculan en el CSS con color-mix(), así que no se editan por separado.
// - El mapa (MapLibre) no lee variables CSS: lee los colores con `colorDe()` y se repinta al
//   escuchar el evento `EVENTO_PALETA`.
// - Lo editado con el editor (?paleta=1) se guarda en localStorage de este navegador.
import DEFINICION from "./paleta.json";

export type ColorPaleta = { id: string; grupo: string; nombre: string; uso: string; defecto: string };
export type Paleta = Record<string, string>;

export const PALETA: ColorPaleta[] = DEFINICION;
export const CLAVE_PALETA = "drena.paleta.v1";
export const EVENTO_PALETA = "drena:paleta";

const HEX = /^#[0-9a-f]{6}$/i;
const IDS = new Set(PALETA.map((c) => c.id));

export const paletaPorDefecto = (): Paleta => Object.fromEntries(PALETA.map((c) => [c.id, c.defecto]));

/** Deja solo ids conocidos con colores #rrggbb válidos (para lo leído de localStorage o de un JSON importado). */
export function limpiarPaleta(x: unknown): Paleta {
  if (!x || typeof x !== "object") return {};
  return Object.fromEntries(
    Object.entries(x as Record<string, unknown>)
      .filter(([id, v]) => IDS.has(id) && typeof v === "string" && HEX.test(v))
      .map(([id, v]) => [id, (v as string).toLowerCase()]),
  );
}

/** Colores editados guardados en este navegador (solo los que difieren del valor por defecto). */
export function leerPaletaGuardada(): Paleta {
  try {
    return limpiarPaleta(JSON.parse(localStorage.getItem(CLAVE_PALETA) ?? "{}"));
  } catch {
    return {};
  }
}

function guardar(cambios: Paleta) {
  try {
    if (Object.keys(cambios).length) localStorage.setItem(CLAVE_PALETA, JSON.stringify(cambios));
    else localStorage.removeItem(CLAVE_PALETA);
  } catch {
    // Almacenamiento bloqueado: la paleta se aplica igual, solo no se recuerda al recargar.
  }
}

/** Valor actual de un color de la paleta (lo editado o el de :root). Para quien no puede usar var(--x), como MapLibre. */
export function colorDe(id: string): string {
  const def = PALETA.find((c) => c.id === id)?.defecto ?? "#000000";
  if (typeof window === "undefined") return def;
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${id}`).trim();
  return HEX.test(v) ? v : def;
}

/** Aplica una paleta completa o parcial: variables en :root, color de la barra del navegador, aviso al mapa y guardado. */
export function aplicarPaleta(paleta: Paleta) {
  const def = paletaPorDefecto();
  const cambios = Object.fromEntries(Object.entries(limpiarPaleta(paleta)).filter(([id, v]) => v !== def[id]));
  const raiz = document.documentElement.style;
  for (const c of PALETA) {
    if (cambios[c.id]) raiz.setProperty(`--${c.id}`, cambios[c.id]);
    else raiz.removeProperty(`--${c.id}`);
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", cambios.bg ?? def.bg);
  guardar(cambios);
  window.dispatchEvent(new Event(EVENTO_PALETA));
}

/** Bloque :root listo para pegar en globals.css (reemplaza lo que hay entre `paleta:inicio` y `paleta:fin`). */
export function aCssRoot(paleta: Paleta): string {
  const p = { ...paletaPorDefecto(), ...limpiarPaleta(paleta) };
  const filas = PALETA.map((c) => `  --${c.id}: ${p[c.id]}; /* ${c.nombre} */`);
  return [":root {", "  /* paleta:inicio — generado por el editor de paleta (?paleta=1) */", ...filas, "  /* paleta:fin */", "}"].join("\n");
}

/**
 * Script en línea para <head>: aplica la paleta guardada antes del primer pintado (sin parpadeo).
 * Se genera con los ids conocidos para no aplicar claves ajenas.
 */
export function scriptInicialPaleta(): string {
  const ids = JSON.stringify(PALETA.map((c) => c.id));
  return `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(CLAVE_PALETA)})||"{}"),ids=${ids},s=document.documentElement.style;ids.forEach(function(i){var v=p[i];if(typeof v==="string"&&/^#[0-9a-f]{6}$/i.test(v))s.setProperty("--"+i,v)})}catch(e){}`;
}

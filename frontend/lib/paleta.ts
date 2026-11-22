// Paleta de colores del front (#131). Una sola fuente de verdad: `paleta.json`. Guía: docs/colores.md.
// - 3 colores editables: principal, secundario y fondo. El resto se deriva de ellos con mezclas
//   (`derivados`) o es fijo porque tiene significado propio (`fijos`: peligro, correcto,
//   advertencia, transporte).
// - globals.css declara todo en :root entre `paleta:inicio` y `paleta:fin`; ese bloque lo genera
//   `scripts/paleta.mjs`, que también corre antes del build y falla si no coincide.
// - En CSS los derivados son color-mix(): cambian solos al cambiar un color editable.
// - El mapa (MapLibre) no lee variables CSS: usa `colorDe()`, que hace la misma mezcla en JS,
//   y se repinta al escuchar el evento `EVENTO_PALETA`.
// - Lo editado con el editor (?paleta=1) se guarda en localStorage de este navegador.
import DEFINICION from "./paleta.json";

export type ColorEditable = { id: string; nombre: string; uso: string; defecto: string };
export type ColorDerivado = { id: string; nombre: string; mezcla: [string, number, string] };
export type ColorFijo = { id: string; nombre: string; valor: string };
export type Paleta = Record<string, string>;

export const EDITABLES: ColorEditable[] = DEFINICION.editables;
export const DERIVADOS: ColorDerivado[] = DEFINICION.derivados as ColorDerivado[];
export const FIJOS: ColorFijo[] = DEFINICION.fijos;
export const CLAVE_PALETA = "drena.paleta.v3";
export const EVENTO_PALETA = "drena:paleta";

const HEX = /^#[0-9a-f]{6}$/i;
const IDS = new Set(EDITABLES.map((c) => c.id));

export const paletaPorDefecto = (): Paleta => Object.fromEntries(EDITABLES.map((c) => [c.id, c.defecto]));

/** Deja solo los 3 ids editables con colores #rrggbb válidos (para localStorage o un JSON importado). */
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

const aRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const aHex = (rgb: number[]) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Mezcla como color-mix(in srgb, a p%, b): canal a canal sobre los valores sRGB. */
export function mezclar(a: string, pct: number, b: string): string {
  const [x, y] = [aRgb(a), aRgb(b)];
  return aHex(x.map((v, i) => (v * pct + y[i] * (100 - pct)) / 100));
}

/** Resuelve cualquier color de la paleta a #rrggbb a partir de los 3 editables dados. */
export function resolver(id: string, base: Paleta): string {
  if (HEX.test(id)) return id.toLowerCase();
  if (base[id]) return base[id];
  const fijo = FIJOS.find((c) => c.id === id);
  if (fijo) return fijo.valor;
  const d = DERIVADOS.find((c) => c.id === id);
  if (d) return mezclar(resolver(d.mezcla[0], base), d.mezcla[1], resolver(d.mezcla[2], base));
  return "#000000"; // paleta-ok: id desconocido
}

/** Los 3 colores editables vigentes en la página (lo editado o el valor de :root). */
export function paletaActual(): Paleta {
  const def = paletaPorDefecto();
  if (typeof window === "undefined") return def;
  const st = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    EDITABLES.map((c) => {
      const v = st.getPropertyValue(`--${c.id}`).trim();
      return [c.id, HEX.test(v) ? v.toLowerCase() : def[c.id]];
    }),
  );
}

/** Valor actual de un color de la paleta como #rrggbb. Para quien no puede usar var(--x), como MapLibre. */
export const colorDe = (id: string): string => resolver(id, paletaActual());

/** Aplica los colores editables: variables en :root, barra del navegador, aviso al mapa y guardado. */
export function aplicarPaleta(paleta: Paleta) {
  const def = paletaPorDefecto();
  const p = { ...def, ...limpiarPaleta(paleta) };
  const cambios = Object.fromEntries(Object.entries(p).filter(([id, v]) => v !== def[id]));
  const raiz = document.documentElement.style;
  for (const c of EDITABLES) {
    if (cambios[c.id]) raiz.setProperty(`--${c.id}`, cambios[c.id]);
    else raiz.removeProperty(`--${c.id}`);
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", p.fondo);
  guardar(cambios);
  window.dispatchEvent(new Event(EVENTO_PALETA));
}

/**
 * Bloque :root completo con la paleta dada (los 3 base con su valor, derivados y fijos), en el mismo
 * formato que genera scripts/paleta.mjs. Reproduce la vista previa del editor al pegarlo en un CSS.
 */
export function aCssRoot(paleta: Paleta): string {
  const p = { ...paletaPorDefecto(), ...limpiarPaleta(paleta) };
  const ref = (x: string) => (HEX.test(x) ? x : `var(--${x})`);
  const l = [":root {", "  /* paleta:inicio — exportado desde el editor de paleta (?paleta=1) */", "  /* Editables (?paleta=1) */"];
  for (const c of EDITABLES) l.push(`  --${c.id}: ${p[c.id]}; /* ${c.nombre} */`);
  l.push("  /* Derivados de los editables */");
  for (const c of DERIVADOS) {
    const [a, pct, b] = c.mezcla;
    l.push(`  --${c.id}: ${a === b || pct === 100 ? ref(a) : `color-mix(in srgb, ${ref(a)} ${pct}%, ${ref(b)})`}; /* ${c.nombre} */`);
  }
  l.push("  /* Fijos: tienen significado propio (peligro, correcto, advertencia, agua, transporte) */");
  for (const c of FIJOS) l.push(`  --${c.id}: ${c.valor}; /* ${c.nombre} */`);
  l.push("  /* paleta:fin */", "}");
  return l.join("\n") + "\n";
}

/** Script en línea para <head>: aplica los colores guardados antes del primer pintado (sin parpadeo). */
export function scriptInicialPaleta(): string {
  const ids = JSON.stringify(EDITABLES.map((c) => c.id));
  return `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(CLAVE_PALETA)})||"{}"),ids=${ids},s=document.documentElement.style;ids.forEach(function(i){var v=p[i];if(typeof v==="string"&&/^#[0-9a-f]{6}$/i.test(v))s.setProperty("--"+i,v)})}catch(e){}`;
}

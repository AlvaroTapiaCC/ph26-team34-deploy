// Paleta de colores (#131): mantiene lib/paleta.json y el bloque `paleta:inicio … paleta:fin` de
// app/globals.css iguales.
//
//   node scripts/paleta.mjs                  verifica que coincidan (corre solo antes de `npm run build`)
//   node scripts/paleta.mjs <paleta.json>    aplica la paleta exportada desde el editor (?paleta=1):
//                                            actualiza los valores por defecto en ambos archivos
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUTA_JSON = join(raiz, "lib", "paleta.json");
const RUTA_CSS = join(raiz, "app", "globals.css");
const BLOQUE = /( *\/\* paleta:inicio[^\n]*\n)([\s\S]*?)( *\/\* paleta:fin \*\/)/;
const HEX = /^#[0-9a-f]{6}$/i;

const paleta = JSON.parse(readFileSync(RUTA_JSON, "utf8"));
const css = readFileSync(RUTA_CSS, "utf8");
const m = css.match(BLOQUE);
if (!m) {
  console.error("paleta: no se encontró el bloque `paleta:inicio … paleta:fin` en app/globals.css");
  process.exit(1);
}

const lineas = (p) => p.map((c) => `  --${c.id}: ${c.defecto}; /* ${c.nombre} */`).join("\n") + "\n";
const eol = css.includes("\r\n") ? "\r\n" : "\n";

const entrada = process.argv[2];
if (entrada) {
  const nueva = JSON.parse(readFileSync(entrada, "utf8"));
  // Solo se reemplaza el valor `defecto` de cada color cambiado, en el texto: el formato de
  // paleta.json (una línea por color) se conserva y el diff muestra solo lo que cambió.
  let texto = readFileSync(RUTA_JSON, "utf8");
  let cambiados = 0;
  for (const c of paleta) {
    const v = nueva[c.id];
    if (typeof v === "string" && HEX.test(v) && v.toLowerCase() !== c.defecto) {
      c.defecto = v.toLowerCase();
      texto = texto.replace(new RegExp(`("id": "${c.id}"[^\\n]*"defecto": ")#[0-9a-fA-F]{6}"`), `$1${c.defecto}"`);
      cambiados++;
    }
  }
  writeFileSync(RUTA_JSON, texto);
  writeFileSync(RUTA_CSS, css.replace(BLOQUE, (_, ini, __, fin) => ini + lineas(paleta).replace(/\n/g, eol) + fin));
  console.log(`paleta: ${cambiados} colores actualizados en lib/paleta.json y app/globals.css`);
  process.exit(0);
}

// Verificación
const enCss = Object.fromEntries([...m[2].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(([, id, v]) => [id, v.toLowerCase()]));
const errores = [];
for (const c of paleta) {
  if (!HEX.test(c.defecto)) errores.push(`--${c.id}: "${c.defecto}" no es un color #rrggbb`);
  else if (enCss[c.id] !== c.defecto.toLowerCase()) errores.push(`--${c.id}: paleta.json dice ${c.defecto}, globals.css dice ${enCss[c.id] ?? "(falta)"}`);
}
for (const id of Object.keys(enCss)) if (!paleta.some((c) => c.id === id)) errores.push(`--${id} está en globals.css pero no en paleta.json`);
if (errores.length) {
  console.error("paleta: lib/paleta.json y app/globals.css no coinciden:\n  " + errores.join("\n  "));
  console.error("Arreglo: node scripts/paleta.mjs lib/paleta-exportada.json, o corrige a mano uno de los dos.");
  process.exit(1);
}
console.log(`paleta: ${paleta.length} colores, globals.css coincide`);

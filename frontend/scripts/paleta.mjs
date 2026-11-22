// Paleta de colores (#131): el bloque `paleta:inicio … paleta:fin` de app/globals.css se genera
// desde lib/paleta.json (3 colores editables, derivados con color-mix() y fijos).
//
//   node scripts/paleta.mjs                  verifica que globals.css esté al día (corre antes de `npm run build`)
//   node scripts/paleta.mjs --escribir       regenera el bloque en globals.css desde paleta.json
//   node scripts/paleta.mjs <paleta.json>    aplica la paleta exportada desde el editor (?paleta=1):
//                                            cambia los valores por defecto y regenera el bloque
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUTA_JSON = join(raiz, "lib", "paleta.json");
const RUTA_CSS = join(raiz, "app", "globals.css");
const BLOQUE = / *\/\* paleta:inicio[\s\S]*?paleta:fin \*\/\r?\n?/;
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * En Vercel el chequeo solo avisa: un desajuste de la paleta no debe tumbar un deploy. Bloquea en local
 * y en el CI de GitHub (build del PR), donde se ve antes de llegar a producción.
 */
let conAvisos = false;
function fallar() {
  conAvisos = true;
  if (process.env.VERCEL) {
    console.warn("paleta: aviso en Vercel; el build sigue. Corrígelo en el repo antes del próximo deploy.");
    return;
  }
  process.exit(1);
}

const ref = (x) => (HEX.test(x) ? x : `var(--${x})`);

function generar(p) {
  const l = ["  /* paleta:inicio — generado por scripts/paleta.mjs desde lib/paleta.json (#131). No editar a mano. */", "  /* Editables (?paleta=1) */"];
  for (const c of p.editables) l.push(`  --${c.id}: ${c.defecto}; /* ${c.nombre} */`);
  l.push("  /* Derivados de los editables */");
  for (const c of p.derivados) {
    const [a, pct, b] = c.mezcla;
    const valor = a === b || pct === 100 ? ref(a) : `color-mix(in srgb, ${ref(a)} ${pct}%, ${ref(b)})`;
    l.push(`  --${c.id}: ${valor}; /* ${c.nombre} */`);
  }
  l.push("  /* Fijos: tienen significado propio (peligro, correcto, advertencia, transporte) */");
  for (const c of p.fijos) l.push(`  --${c.id}: ${c.valor}; /* ${c.nombre} */`);
  l.push("  /* paleta:fin */");
  return l.join("\n") + "\n";
}

const texto = readFileSync(RUTA_JSON, "utf8");
const paleta = JSON.parse(texto);
const css = readFileSync(RUTA_CSS, "utf8");
if (!BLOQUE.test(css)) {
  console.error("paleta: no se encontró el bloque `paleta:inicio … paleta:fin` en app/globals.css");
  process.exit(1);
}
const eol = css.includes("\r\n") ? "\r\n" : "\n";
const escribirCss = () => writeFileSync(RUTA_CSS, css.replace(BLOQUE, generar(paleta).replace(/\n/g, eol)));

const arg = process.argv[2];
if (arg === "--escribir") {
  escribirCss();
  console.log("paleta: bloque de globals.css regenerado");
} else if (arg) {
  // Solo se reemplaza el `defecto` de cada editable cambiado, en el texto: se conserva el formato.
  const nueva = JSON.parse(readFileSync(arg, "utf8"));
  let json = texto;
  let cambiados = 0;
  for (const c of paleta.editables) {
    const v = nueva[c.id];
    if (typeof v === "string" && HEX.test(v) && v.toLowerCase() !== c.defecto) {
      c.defecto = v.toLowerCase();
      json = json.replace(new RegExp(`("id": "${c.id}"[^\\n]*"defecto": ")#[0-9a-fA-F]{6}"`), `$1${c.defecto}"`);
      cambiados++;
    }
  }
  writeFileSync(RUTA_JSON, json);
  escribirCss();
  console.log(`paleta: ${cambiados} de ${paleta.editables.length} colores actualizados en lib/paleta.json y app/globals.css`);
} else {
  const actual = css.match(BLOQUE)[0].replace(/\r\n/g, "\n");
  if (actual.trimEnd() !== generar(paleta).trimEnd()) {
    console.error("paleta: app/globals.css no coincide con lib/paleta.json. Arreglo: npm run paleta -- --escribir");
    fallar();
  }
  const fijos = buscarColoresFijos();
  if (fijos.length) {
    console.error("paleta: hay colores escritos a mano fuera de la paleta. Usa var(--…) en CSS o colorDe(\"…\") en TS:");
    for (const f of fijos) console.error("  " + f);
    console.error("Si un caso lo necesita a propósito, agrega el comentario `paleta-ok` en esa línea.");
    fallar();
  }
  if (!conAvisos) console.log(`paleta: ${paleta.editables.length} editables, ${paleta.derivados.length} derivados, ${paleta.fijos.length} fijos; globals.css al día; sin colores fijos fuera de la paleta`);
}

/**
 * Colores escritos a mano en app/, components/ y lib/ (fuera del bloque de la paleta).
 * - Hex: #rgb o #rrggbb con alguna letra, o entre comillas / después de ":" (así no confunde "#124", un issue).
 * - rgb()/rgba()/hsl(): salvo negro y blanco con transparencia en sombras y filtros (no como fondo ni color).
 */
function buscarColoresFijos() {
  const HEXRE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  const FUNC = /\b(?:rgba?|hsla?)\(\s*([^)]*)\)/g;
  const NEUTRO = /^(?:0,\s*0,\s*0|255,\s*255,\s*255)\s*,/;
  const encontrados = [];
  const recorrer = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const ruta = join(dir, e.name);
      if (e.isDirectory()) recorrer(ruta);
      else if (/\.(css|tsx?)$/.test(e.name)) revisar(ruta);
    }
  };
  const revisar = (ruta) => {
    let enBloque = false;
    readFileSync(ruta, "utf8").split(/\r?\n/).forEach((linea, i) => {
      if (linea.includes("paleta:inicio")) enBloque = true;
      if (linea.includes("paleta:fin")) enBloque = false;
      if (enBloque || linea.includes("paleta-ok")) return;
      const malos = [];
      for (const m of linea.matchAll(HEXRE)) {
        const antes = linea.slice(Math.max(0, m.index - 2), m.index);
        if (/[a-fA-F]/.test(m[0]) || /["'`]$|:\s?$/.test(antes)) malos.push(m[0]);
      }
      // Negro/blanco con transparencia solo como sombra o filtro; como fondo o color debe salir de la paleta
      const esSombra = /shadow|filter|--sh-/.test(linea);
      for (const m of linea.matchAll(FUNC)) if (!(esSombra && NEUTRO.test(m[1].trim()))) malos.push(m[0]);
      if (malos.length) encontrados.push(`${relative(raiz, ruta).replace(/\\/g, "/")}:${i + 1}  ${malos.join(" ")}`);
    });
  };
  for (const d of ["app", "components", "lib"]) recorrer(join(raiz, d));
  return encontrados;
}

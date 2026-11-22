import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const RAIZ = resolve(process.cwd(), "..");
const CARPETA = "data/validacion";

// Commit que introdujo el CSV y su ficha en el repositorio oficial (#81).
const PUBLICACION_H2 = {
  commit: "de4557b8a9642ba79bb24417e26191dc2025ce22",
  fecha: "2026-11-21T19:15:17Z",
  sha256: "584029a89d8a7aabbc3b14ec73ffefef05b145246fb57619e258635971f9637f",
};

type Registro = Record<string, unknown>;
const objeto = (v: unknown): v is Registro => typeof v === "object" && v !== null && !Array.isArray(v);
const numero = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const natural = (v: unknown): v is number => numero(v) && Number.isInteger(v) && v >= 0;
const texto = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

async function leer(ruta: string) {
  try {
    return await readFile(resolve(RAIZ, ruta));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function leerResultado(ruta: string): Promise<unknown> {
  const bytes = await leer(`${CARPETA}/${ruta}`);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    console.warn(`Archivo de validación ilegible: ${ruta}`);
    return null;
  }
}

async function sha256(ruta: string) {
  const bytes = await leer(ruta);
  return bytes ? createHash("sha256").update(bytes).digest("hex") : null;
}

function cobertura(v: unknown) {
  if (!objeto(v)) return null;
  const { aciertos, total, porcentaje } = v;
  if (!natural(total) || total < 1 || !numero(aciertos) || aciertos < 0 || aciertos > total
    || !numero(porcentaje) || porcentaje < 0 || porcentaje > 100) return null;
  return { aciertos, total, porcentaje };
}

function corte(v: unknown) {
  if (!objeto(v)) return null;
  const top = v.top_porcentaje;
  const distancia = v.distancia_m_menor_que;
  const formula = cobertura(v.formula_sin_clima);
  const area = cobertura(v.solo_area_aporte);
  const azar = cobertura(v.azar);
  if (!natural(top) || top === 0 || top > 100 || !numero(distancia) || distancia <= 0
    || !formula || !area || !azar) return null;
  return { top, distancia, formula, area, azar, horaria: cobertura(v.formula_horaria_al_registro) };
}

function replay(v: unknown) {
  if (!objeto(v) || !texto(v.evento) || !natural(v.lugares_evaluados) || v.lugares_evaluados === 0 || !Array.isArray(v.cobertura)) return null;
  const cortes = v.cobertura.map(corte).filter((c) => c !== null);
  if (!cortes.length) return null;
  const horas = objeto(v.tiempo) ? v.tiempo.horas_entre_alerta_y_registro : null;
  return {
    evento: v.evento,
    lugares: v.lugares_evaluados,
    puntosCriticos: v.tipo_evidencia === "puntos-criticos",
    adelanto: numero(horas) ? horas : null,
    cortes,
  };
}

function claude(v: unknown) {
  if (!objeto(v) || !objeto(v.acuerdo_humano)) return null;
  const { imagenes_total: imagenes, coincidencias, comparables, no_evaluables: noEvaluables, acuerdo_humano: humanos } = v;
  const acuerdo = cobertura({ aciertos: humanos.coincidencias, total: humanos.total, porcentaje: humanos.porcentaje });
  if (!natural(imagenes) || !natural(comparables) || !natural(coincidencias) || !natural(noEvaluables)
    || comparables > imagenes || coincidencias > comparables || noEvaluables > imagenes || !acuerdo || acuerdo.total !== imagenes) return null;
  return { imagenes, coincidencias, comparables, noEvaluables, acuerdo };
}

function congelamiento(v: unknown, csv: string | null, config: string | null, codigo: string | null) {
  if (!objeto(v) || !objeto(v.salida) || !objeto(v.formula)) return null;
  return {
    generado: texto(v.generado_utc) && !Number.isNaN(Date.parse(v.generado_utc)) ? v.generado_utc : null,
    publicacion: v.salida.sha256 === PUBLICACION_H2.sha256 ? PUBLICACION_H2 : null,
    csvVerificado: csv ? csv === v.salida.sha256 : null,
    configAjustada: config ? config !== v.formula.sha256_config : null,
    codigoAjustado: codigo ? codigo !== v.formula.sha256_codigo : null,
  };
}

export async function leerEvidencia() {
  const [reproduccion, medidaClaude, prediccion, csv, config, codigo] = await Promise.all([
    leerResultado("replay/resultado.json"),
    leerResultado("claude/resultado.json"),
    leerResultado("prediccion_congelada.meta.json"),
    sha256(`${CARPETA}/prediccion_congelada.csv`),
    sha256("backend/config/formula_validacion.yaml"),
    sha256("backend/app/services/formula.py"),
  ]);
  return { replay: replay(reproduccion), claude: claude(medidaClaude), congelamiento: congelamiento(prediccion, csv, config, codigo) };
}

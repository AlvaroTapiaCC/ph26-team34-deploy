import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type Caso = {
  etiqueta: string;
  adelanto_horas: number;
  adelanto_primera_tormenta_ventana_horas: number;
  primera_tormenta_7_8_utc: string;
  lluvia_8_oct: { pronostico_mm: number; observado_mm: number; centro_latlon: number[] };
  referencia_otro_centro: { pronostico_mm: number; observado_mm: number; nota: string; fuente_url: string };
  lluvia_6_8_mm: number;
  horas: { hora_utc: string; hora_santiago: string; lluvia_mm: number; lluvia_pronosticada_mm: number; modo: string }[];
  antecedentes: { fecha: string; titulo: string; detalle: string; fuente_url: string }[];
  misiones: { rank: number; ID_IDE: string; calle: string; lon: number; lat: number; prioridad: number; en_flujo: boolean }[];
  cobertura_flujo: { total_sumideros: number; total_flujo: number; corte_top_20: number; flujo_en_top_20: number; esperado_azar: number; metodo: string };
  puntos_criticos: { properties: { fid: number; lugar: string; causa: string; fuente_url: string } }[];
  limites: string[];
};

export async function leerCaso(): Promise<Caso | null> {
  try {
    const carpeta = resolve(process.cwd(), "../data/validacion/san_carlos");
    const [bytes, meta] = await Promise.all([
      readFile(resolve(carpeta, "caso.json")), readFile(resolve(carpeta, "caso.meta.json"), "utf8"),
    ]);
    if (createHash("sha256").update(bytes).digest("hex") !== JSON.parse(meta).salida.sha256) {
      console.warn("Caso San Carlos: la huella del resultado no coincide.");
      return null;
    }
    const caso: Caso = JSON.parse(bytes.toString("utf8"));
    if (!Number.isFinite(caso.adelanto_horas) || caso.horas?.length !== 72 || caso.misiones?.length !== 10) return null;
    return caso;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

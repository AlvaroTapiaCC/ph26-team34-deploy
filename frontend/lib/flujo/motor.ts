// Motor de la simulación del flujo: el agua avanza por los tramos aguas abajo.
//
// - Caudal: cada nodo aporta lluvia × área propia × coeficiente de escorrentía; se acumula aguas abajo.
// - Velocidad: proporcional a la pendiente del tramo (grafo.ts). El caudal de cada tramo se acerca a su valor
//   de régimen con una constante de tiempo = largo / velocidad, así la onda viaja por la calle.
// - Sumideros: tragan hasta su capacidad según el estado de la rejilla (limpia, parcial, tapada). El exceso
//   sigue por la calle hacia el siguiente punto aguas abajo.
// - Observaciones: lo observado manda sobre lo simulado (FuenteObservaciones).
//
// Es una simulación según pendiente y área de aporte; no es una medición. Módulo puro: no toca el DOM ni el mapa.
import type { LngLat, ScenarioId } from "../data";
import { distM, type Grafo } from "./grafo";
import { ESTADOS_ESCENARIO, FLUJO_CONFIG, LLUVIA_ESCENARIO, RADIO_PUNTO_M, type EstadoRejilla, type NivelAgua } from "./config";
import type { ObservacionPunto } from "./fuentes";

export const NIVELES: NivelAgua[] = ["sin_agua", "cuneta", "hasta_vereda", "sobre_vereda"];
const rango = (n: NivelAgua) => Math.max(0, NIVELES.indexOf(n));

export class MotorFlujo {
  readonly grafo: Grafo;
  private cfg: typeof FLUJO_CONFIG;
  scenario: ScenarioId = "13oct";
  /** Segundos simulados desde el inicio del escenario. */
  t = 0;

  // Por tramo
  readonly q: Float32Array; // caudal que llega al final del tramo (L/s)
  readonly qExc: Float32Array; // parte de ese caudal que ya se desbordó aguas arriba (L/s)
  readonly qSal: Float32Array; // caudal que sigue al siguiente tramo, tras los sumideros del tramo
  private readonly qExcSal: Float32Array;
  // Por sumidero
  readonly llega: Float32Array;
  readonly captado: Float32Array;
  readonly exceso: Float32Array;
  readonly nivel: Uint8Array; // índice en NIVELES (simulado, corregido con lo observado)
  private local: Float32Array; // sumideros sin tramo: caudal local suavizado

  private estadoEscenario = new Map<string, EstadoRejilla>();
  private obs = new Map<string, ObservacionPunto>();
  private idx = new Map<string, number>();
  /** Rejillas del catastro que rodean a cada punto del ranking. */
  sumideroIdsPorPunto: Record<string, string[]> = {};

  constructor(grafo: Grafo, cfg = FLUJO_CONFIG) {
    this.grafo = grafo;
    this.cfg = cfg;
    const nt = grafo.tramos.length;
    const ns = grafo.sumideros.length;
    this.q = new Float32Array(nt);
    this.qExc = new Float32Array(nt);
    this.qSal = new Float32Array(nt);
    this.qExcSal = new Float32Array(nt);
    this.llega = new Float32Array(ns);
    this.captado = new Float32Array(ns);
    this.exceso = new Float32Array(ns);
    this.nivel = new Uint8Array(ns);
    this.local = new Float32Array(ns);
    grafo.sumideros.forEach((s, i) => this.idx.set(s.id, i));
  }

  // ---- Escenario y observaciones ----
  /** Asocia los puntos del ranking con las rejillas del catastro a menos de RADIO_PUNTO_M. */
  asociarPuntos(puntos: { id: string; coord: LngLat }[]) {
    this.sumideroIdsPorPunto = {};
    for (const p of puntos) {
      const cerca = this.grafo.sumideros.filter((s) => distM(s.coord, p.coord) <= RADIO_PUNTO_M).map((s) => s.id);
      if (cerca.length) this.sumideroIdsPorPunto[p.id] = cerca;
    }
  }

  get estadosEscenario(): Record<string, EstadoRejilla> {
    return ESTADOS_ESCENARIO[this.scenario];
  }

  setEscenario(id: ScenarioId) {
    this.scenario = id;
    this.reiniciar();
  }

  /** Estado supuesto por el escenario para cada rejilla (a partir de los puntos del ranking). */
  private aplicarEstadosEscenario() {
    this.estadoEscenario.clear();
    for (const [punto, estado] of Object.entries(this.estadosEscenario)) {
      for (const id of this.sumideroIdsPorPunto[punto] ?? []) this.estadoEscenario.set(id, estado);
    }
  }

  setObservaciones(lista: ObservacionPunto[]) {
    this.obs.clear();
    for (const o of lista) if (this.idx.has(o.sumideroId)) this.obs.set(o.sumideroId, { ...this.obs.get(o.sumideroId), ...o });
  }

  reiniciar() {
    this.t = 0;
    for (const a of [this.q, this.qExc, this.qSal, this.qExcSal, this.llega, this.captado, this.exceso, this.local]) a.fill(0);
    this.nivel.fill(0);
    this.aplicarEstadosEscenario();
  }

  // ---- Lluvia ----
  duracionS(): number {
    return LLUVIA_ESCENARIO[this.scenario].perfilMmH.length * 3600;
  }

  /** Intensidad de lluvia (mm/h) en un punto y en el instante `t`. */
  lluviaMmH(coord: LngLat, t = this.t): number {
    const l = LLUVIA_ESCENARIO[this.scenario];
    const h = t / 3600;
    const i = Math.floor(h);
    if (i < 0 || i >= l.perfilMmH.length) return 0;
    const a = l.perfilMmH[i];
    const b = l.perfilMmH[i + 1] ?? 0;
    const base = a + (b - a) * (h - i);
    if (!l.celda) return base;
    return base * (distM(coord, l.celda.centro) <= l.celda.radioM ? l.celda.dentro : l.celda.fuera);
  }

  // ---- Sumideros ----
  estadoRejilla(i: number): EstadoRejilla {
    const id = this.grafo.sumideros[i].id;
    return this.obs.get(id)?.rejilla ?? this.estadoEscenario.get(id) ?? this.cfg.estadoPorDefecto;
  }

  private capacidad(i: number): number {
    let f = this.cfg.factorEstado[this.estadoRejilla(i)];
    // Lo observado corrige la simulación: con agua sobre la vereda la rejilla no está tragando; sin agua, sí.
    const n = this.obs.get(this.grafo.sumideros[i].id)?.nivelAgua;
    if (n === "hasta_vereda" || n === "sobre_vereda") f = Math.min(f, this.cfg.factorEstado.tapada);
    // Sin agua observada: la rejilla está tragando todo lo que le llega, sea cual sea su capacidad supuesta.
    else if (n === "sin_agua") return Number.POSITIVE_INFINITY;
    return this.cfg.capacidadRejillaLs * f;
  }

  private nivelDeExceso(ex: number): number {
    const u = this.cfg.umbralesExcesoLs;
    return ex >= u.sobre_vereda ? 3 : ex >= u.hasta_vereda ? 2 : ex >= u.cuneta ? 1 : 0;
  }

  /** Nivel de agua que se muestra en un sumidero: lo observado manda sobre lo simulado. */
  nivelMostrado(i: number): NivelAgua {
    const o = this.obs.get(this.grafo.sumideros[i].id)?.nivelAgua;
    if (o && o !== "no_evaluable") return o;
    return NIVELES[this.nivel[i]];
  }

  desborda(i: number): boolean {
    return rango(this.nivelMostrado(i)) >= rango(this.cfg.nivelDesborde);
  }

  // ---- Paso de simulación ----
  avanzar(dtS: number) {
    let resto = dtS;
    while (resto > 1e-6) {
      const dt = Math.min(resto, this.cfg.pasoMaxSimS);
      this.paso(dt);
      resto -= dt;
    }
  }

  private paso(dt: number) {
    const { tramos, sumideros, orden, sumPorTramo } = this.grafo;
    const coef = this.cfg.coefEscorrentia / 3600;
    this.t += dt;
    for (const i of orden) {
      const tr = tramos[i];
      let entra = 0;
      let entraExc = 0;
      for (const j of tr.entrantes) {
        entra += this.qSal[j];
        entraExc += this.qExcSal[j];
      }
      const objetivo = tr.ap * coef * this.lluviaMmH(tr.mid) + entra;
      const k = 1 - Math.exp(-dt / Math.max(2, tr.L / tr.v));
      this.q[i] += (objetivo - this.q[i]) * k;
      this.qExc[i] += (entraExc - this.qExc[i]) * k;
      if (this.qExc[i] > this.q[i]) this.qExc[i] = this.q[i];

      // Sumideros del tramo, de aguas arriba a aguas abajo
      let flujo = this.q[i];
      let desb = this.qExc[i];
      for (const s of sumPorTramo.get(i) ?? []) {
        const cap = this.capacidad(s);
        const traga = Math.min(flujo, cap);
        const ex = flujo - traga;
        this.llega[s] = flujo;
        this.captado[s] = traga;
        this.exceso[s] = ex;
        this.nivel[s] = this.nivelDeExceso(ex);
        desb = ex > 0 ? ex : flujo > 0 ? (desb * (flujo - traga)) / flujo : 0;
        flujo -= traga;
      }
      this.qSal[i] = flujo;
      this.qExcSal[i] = Math.min(desb, flujo);
    }
    // Sumideros sin tramo: solo reciben su área local y no sueltan agua a ningún lado
    sumideros.forEach((s, i) => {
      if (s.tramo !== null) return;
      const k = 1 - Math.exp(-dt / 30);
      this.local[i] += (s.ap * coef * this.lluviaMmH(s.coord) - this.local[i]) * k;
      const traga = Math.min(this.local[i], this.capacidad(i));
      this.llega[i] = this.local[i];
      this.captado[i] = traga;
      this.exceso[i] = this.local[i] - traga;
      this.nivel[i] = this.nivelDeExceso(this.exceso[i]);
    });
  }

  // ---- Resumen para la interfaz ----
  /** Peor nivel de agua entre las rejillas que rodean a cada punto del ranking (solo los que tienen alguna). */
  nivelesPorPunto(): Record<string, NivelAgua> {
    const out: Record<string, NivelAgua> = {};
    for (const [punto, ids] of Object.entries(this.sumideroIdsPorPunto)) {
      let peor: NivelAgua = "sin_agua";
      for (const id of ids) {
        const n = this.nivelMostrado(this.idx.get(id)!);
        if (rango(n) > rango(peor)) peor = n;
      }
      out[punto] = peor;
    }
    return out;
  }

  desbordados(): number {
    let n = 0;
    for (let i = 0; i < this.grafo.sumideros.length; i++) if (this.desborda(i)) n++;
    return n;
  }
}

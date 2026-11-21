// Motor de la simulación hidráulica: el agua avanza por los tramos de la calle, de aguas arriba a aguas abajo.
//
// - Caudal de entrada por tramo (método racional): Q = C · i · A, con C de escorrentía urbana, i la lluvia del
//   escenario en esa hora (escalada por el slider) y A el área de aporte propia del tramo. Se acumula aguas abajo.
// - Velocidad por tramo: Manning simplificado según la pendiente (grafo.ts). El caudal de cada tramo se acerca a su
//   valor de régimen con una constante de tiempo = largo / velocidad, así la onda viaja por la calle.
// - Rejillas: tragan hasta su capacidad según el estado (limpia 100 %, parcial 50 %, tapada 5 %). El excedente sigue
//   aguas abajo y se acumula; si lo que no traga ya no cabe en la calzada (sube a la vereda), la rejilla se desborda.
// - Estado de cada rejilla: lo que marcó el operador manda; después lo observado (FuenteObservaciones); después el
//   supuesto del escenario; si no hay nada, limpia.
//
// Modelo simplificado; es una simulación, no una medición. Módulo puro: no toca el DOM ni el mapa.
import type { LngLat, ScenarioId } from "../data";
import { capacidadCalzada, capacidadCuneta, distM, type Grafo } from "./grafo";
import { ESTADOS_ESCENARIO, FLUJO_CONFIG, LLUVIA_ESCENARIO, RADIO_PUNTO_M, type EstadoRejilla, type NivelAgua } from "./config";
import type { ObservacionPunto } from "./fuentes";

export const NIVELES: NivelAgua[] = ["sin_agua", "cuneta", "hasta_vereda", "sobre_vereda"];
const rango = (n: NivelAgua) => Math.max(0, NIVELES.indexOf(n));

export interface Lecturas {
  /** Lluvia que escurre ahora por las calles de la red: Σ C · i · A (L/s). */
  caudalTransito: number;
  /** Rejillas desbordadas. */
  desbordados: number;
  desbordadosPorComuna: Record<string, number>;
  /** Metros de calle con más agua de la que cabe en la cuneta. */
  metrosSobreCuneta: number;
  /** Rejilla a la que le llega más agua ahora (índice en grafo.sumideros) y su caudal (L/s). */
  maxSumidero: number | null;
  maxCaudal: number;
}

export class MotorFlujo {
  readonly grafo: Grafo;
  private cfg: typeof FLUJO_CONFIG;
  scenario: ScenarioId = "13oct";
  /** Segundos simulados desde el inicio del escenario. */
  t = 0;
  /** Escala la intensidad del escenario (slider de lluvia): 1 = la del escenario. */
  factorLluvia = 1;

  // Por tramo
  readonly q: Float32Array; // caudal que llega al final del tramo (L/s)
  readonly qExc: Float32Array; // parte del caudal que viene de un desborde en este tramo o en el anterior (L/s), para dibujar
  readonly qSal: Float32Array; // caudal que sigue al siguiente tramo, tras las rejillas del tramo
  private readonly qExcSal: Float32Array;
  // Por rejilla
  readonly llega: Float32Array;
  readonly captado: Float32Array;
  readonly exceso: Float32Array;
  readonly nivel: Uint8Array; // índice en NIVELES (simulado)
  private local: Float32Array; // rejillas sin tramo: caudal local suavizado
  private readonly capCunetaSum: Float32Array;
  private readonly capCalzadaSum: Float32Array;

  private estadoEscenario = new Map<string, EstadoRejilla>();
  private manual = new Map<string, EstadoRejilla>();
  private obs = new Map<string, ObservacionPunto>();
  readonly idx = new Map<string, number>();
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
    this.capCunetaSum = new Float32Array(ns);
    this.capCalzadaSum = new Float32Array(ns);
    grafo.sumideros.forEach((s, i) => {
      this.idx.set(s.id, i);
      const t = s.tramo !== null ? grafo.tramos[s.tramo] : null;
      this.capCunetaSum[i] = t ? t.capCuneta : capacidadCuneta(s.s, cfg);
      this.capCalzadaSum[i] = t ? t.capCalzada : capacidadCalzada(s.s, cfg);
    });
  }

  // ---- Escenario, estados y observaciones ----
  /** Asocia los puntos del ranking con las rejillas del catastro a menos de RADIO_PUNTO_M. */
  asociarPuntos(puntos: { id: string; coord: LngLat }[]) {
    this.sumideroIdsPorPunto = {};
    for (const p of puntos) {
      const cerca = this.grafo.sumideros.filter((s) => distM(s.coord, p.coord) <= RADIO_PUNTO_M).map((s) => s.id);
      if (cerca.length) this.sumideroIdsPorPunto[p.id] = cerca;
    }
    this.aplicarEstadosEscenario();
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

  /** Estados que marcó el operador (clic en el mapa o botones del panel). Se aplican al instante. */
  setEstadosManuales(estados: Record<string, EstadoRejilla>) {
    this.manual = new Map(Object.entries(estados));
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

  /** Intensidad de lluvia (mm/h) del escenario, sin celda, en el instante `t` y con el factor del slider. */
  lluviaBaseMmH(t = this.t): number {
    const l = LLUVIA_ESCENARIO[this.scenario];
    const h = t / 3600;
    const i = Math.floor(h);
    if (i < 0 || i >= l.perfilMmH.length) return 0;
    const a = l.perfilMmH[i];
    const b = l.perfilMmH[i + 1] ?? 0;
    return (a + (b - a) * (h - i)) * this.factorLluvia;
  }

  /** Intensidad de lluvia (mm/h) en un punto y en el instante `t`. */
  lluviaMmH(coord: LngLat, t = this.t): number {
    const base = this.lluviaBaseMmH(t);
    const c = LLUVIA_ESCENARIO[this.scenario].celda;
    if (!c) return base;
    return base * (distM(coord, c.centro) <= c.radioM ? c.dentro : c.fuera);
  }

  // ---- Rejillas ----
  estadoRejilla(i: number): EstadoRejilla {
    const id = this.grafo.sumideros[i].id;
    return this.manual.get(id) ?? this.obs.get(id)?.rejilla ?? this.estadoEscenario.get(id) ?? this.cfg.estadoPorDefecto;
  }

  private capacidad(i: number): number {
    let f = this.cfg.factorEstado[this.estadoRejilla(i)];
    if (!this.manual.has(this.grafo.sumideros[i].id)) {
      // Lo observado corrige la simulación: con agua sobre la vereda la rejilla no está tragando; sin agua, sí.
      const n = this.obs.get(this.grafo.sumideros[i].id)?.nivelAgua;
      if (n === "hasta_vereda" || n === "sobre_vereda") f = Math.min(f, this.cfg.factorEstado.tapada);
      else if (n === "sin_agua") return Number.POSITIVE_INFINITY;
    }
    return this.cfg.capacidadRejillaLs * f;
  }

  /** Nivel de agua en la rejilla `i` según lo que no traga: comparado con la calzada (desborde) y con la cuneta. */
  private nivelDeExceso(ex: number, i: number): number {
    const u = this.cfg.umbralesExceso;
    const calzada = ex / Math.max(this.capCalzadaSum[i], 1e-6);
    if (calzada >= u.sobre_vereda) return 3;
    if (calzada >= u.hasta_vereda) return 2;
    return ex / Math.max(this.capCunetaSum[i], 1e-6) >= u.cuneta ? 1 : 0;
  }

  /** Nivel de agua que se muestra en una rejilla: lo observado manda sobre lo simulado (salvo que el operador la haya marcado). */
  nivelMostrado(i: number): NivelAgua {
    if (!this.manual.has(this.grafo.sumideros[i].id)) {
      const o = this.obs.get(this.grafo.sumideros[i].id)?.nivelAgua;
      if (o && o !== "no_evaluable") return o;
    }
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

  /** Recalcula lo que tragan las rejillas sin avanzar el reloj (tras cambiar un estado con la simulación en pausa). */
  recalcular() {
    this.paso(0);
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
      const objetivo = tr.ap * coef * this.lluviaMmH(tr.mid) + entra; // Q = C · i · A + lo que viene de aguas arriba
      const k = 1 - Math.exp(-dt / Math.max(2, tr.L / tr.v));
      this.q[i] += (objetivo - this.q[i]) * k;
      this.qExc[i] += (entraExc - this.qExc[i]) * k;
      if (this.qExc[i] > this.q[i]) this.qExc[i] = this.q[i];

      // Rejillas del tramo, de aguas arriba a aguas abajo
      let flujo = this.q[i];
      let desbLocal = 0; // lo que se desborda en este tramo: se marca aquí y en el tramo siguiente, no más allá
      for (const s of sumPorTramo.get(i) ?? []) {
        const traga = Math.min(flujo, this.capacidad(s));
        const ex = flujo - traga;
        this.llega[s] = flujo;
        this.captado[s] = traga;
        this.exceso[s] = ex;
        this.nivel[s] = this.nivelDeExceso(ex, s);
        desbLocal = this.nivel[s] >= 2 ? ex : flujo > 0 ? (desbLocal * ex) / flujo : 0;
        flujo = ex;
      }
      this.qSal[i] = flujo;
      this.qExcSal[i] = Math.min(desbLocal, flujo);
      if (desbLocal > this.qExc[i]) this.qExc[i] = Math.min(desbLocal, this.q[i]);
    }
    // Rejillas sin tramo: solo reciben su área local y no sueltan agua a ningún lado
    sumideros.forEach((s, i) => {
      if (s.tramo !== null) return;
      const k = 1 - Math.exp(-dt / 30);
      this.local[i] += (s.ap * coef * this.lluviaMmH(s.coord) - this.local[i]) * k;
      const traga = Math.min(this.local[i], this.capacidad(i));
      this.llega[i] = this.local[i];
      this.captado[i] = traga;
      this.exceso[i] = this.local[i] - traga;
      this.nivel[i] = this.nivelDeExceso(this.exceso[i], i);
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

  lecturas(): Lecturas {
    const { tramos, sumideros } = this.grafo;
    const coef = this.cfg.coefEscorrentia / 3600;
    let caudalTransito = 0;
    let metrosSobreCuneta = 0;
    for (const t of tramos) {
      caudalTransito += t.ap * coef * this.lluviaMmH(t.mid);
      if (this.q[t.id] > t.capCuneta) metrosSobreCuneta += t.L;
    }
    let desbordados = 0;
    const desbordadosPorComuna: Record<string, number> = {};
    let maxSumidero: number | null = null;
    let maxCaudal = 0;
    sumideros.forEach((s, i) => {
      if (s.tramo === null) caudalTransito += s.ap * coef * this.lluviaMmH(s.coord);
      if (this.desborda(i)) {
        desbordados++;
        if (s.comuna) desbordadosPorComuna[s.comuna] = (desbordadosPorComuna[s.comuna] ?? 0) + 1;
      }
      if (this.llega[i] > maxCaudal) {
        maxCaudal = this.llega[i];
        maxSumidero = i;
      }
    });
    return { caudalTransito, desbordados, desbordadosPorComuna, metrosSobreCuneta, maxSumidero, maxCaudal };
  }
}

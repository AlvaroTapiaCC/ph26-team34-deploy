// Motor del flujo estimado: el agua avanza por los tramos de la calle, de aguas arriba a aguas abajo.
//
// - Caudal de entrada por tramo (método racional): Q = C · i · A, con C de escorrentía urbana, i la lluvia supuesta
//   (slider, en mm/h) y A el área de aporte propia del tramo. Se acumula aguas abajo.
// - Velocidad por tramo: Manning simplificado según la pendiente (grafo.ts). El caudal de cada tramo se acerca a su
//   valor de régimen con una constante de tiempo = largo / velocidad, así la onda viaja por la calle.
// - Rejillas: tragan hasta su capacidad según el estado (limpia 100 %, parcial 50 %, tapada 5 %). El excedente sigue
//   aguas abajo y se acumula; si lo que no traga ya no cabe en la calzada, el punto queda "con agua" (se pinta en accent)
//   y ese volumen se acumula para dibujar su columna.
// - Estado de cada rejilla: lo que marcó el operador manda; después lo observado (FuenteObservaciones); después el
//   supuesto del escenario; si no hay nada, limpia.
//
// - La red crece por teselas (agregar): los arreglos tienen el tamaño de la red completa y se indexan por el id global
//   del tramo y por el índice de carga del sumidero, así el estado no se pierde al cargar más.
//
// Flujo estimado; no es una simulación hidráulica ni una medición. Módulo puro: no toca el DOM ni el mapa (corre en
// el worker de motor.worker.ts, o en el hilo principal si el navegador no tiene workers).
import type { LngLat, ScenarioId } from "../data";
import { capacidadCalzada, capacidadCuneta, distM, type Grafo } from "./grafo";
import { estadosDe, FLUJO_CONFIG, lluviaDe, picoEscenario, RADIO_PUNTO_M, type EstadoRejilla, type NivelAgua } from "./config";
import type { ObservacionPunto } from "./fuentes";

export const NIVELES: NivelAgua[] = ["sin_agua", "cuneta", "hasta_vereda", "sobre_vereda"];
const rango = (n: NivelAgua) => Math.max(0, NIVELES.indexOf(n));

/** Lecturas para la interfaz: solo cualitativas (el caudal se usa por dentro para dibujar, no se muestra). */
export interface Lecturas {
  /** Puntos con agua (estimado): rejillas donde lo que no traga ya no cabe en la calzada. */
  desbordados: number;
  desbordadosPorComuna: Record<string, number>;
}

export class MotorFlujo {
  readonly grafo: Grafo;
  private cfg: typeof FLUJO_CONFIG;
  scenario: ScenarioId = "13oct";
  /** Segundos de cálculo desde el último reinicio. */
  t = 0;
  /** Lluvia supuesta (mm/h), pareja en el tiempo; la celda del escenario la reparte en el espacio. */
  intensidadMmH: number;

  // Por tramo
  readonly q: Float32Array; // caudal que llega al final del tramo (L/s)
  readonly qExc: Float32Array; // parte del caudal que viene de un punto con agua en este tramo o en el anterior (L/s), para dibujar
  readonly qSal: Float32Array; // caudal que sigue al siguiente tramo, tras las rejillas del tramo
  private readonly qExcSal: Float32Array;
  // Por rejilla
  readonly llega: Float32Array;
  readonly captado: Float32Array;
  readonly exceso: Float32Array;
  readonly volumen: Float32Array; // m³ que no entraron a la rejilla mientras el punto estuvo con agua (para la columna)
  readonly nivel: Uint8Array; // índice en NIVELES (estimado)
  private local: Float32Array; // rejillas sin tramo: caudal local suavizado
  private readonly capCunetaSum: Float32Array;
  private readonly capCalzadaSum: Float32Array;

  private estadoEscenario = new Map<string, EstadoRejilla>();
  private manual = new Map<string, EstadoRejilla>();
  private obs = new Map<string, ObservacionPunto>();
  readonly idx = new Map<string, number>();
  /** Rejillas del catastro que rodean a cada punto del ranking. */
  sumideroIdsPorPunto: Record<string, string[]> = {};
  private puntos: { id: string; coord: LngLat }[] = [];
  /** Sube cada vez que puede cambiar el estado efectivo de alguna rejilla (para no redibujarlas en cada ciclo). */
  versionEstados = 0;

  constructor(grafo: Grafo, cfg = FLUJO_CONFIG) {
    this.grafo = grafo;
    this.cfg = cfg;
    this.intensidadMmH = picoEscenario(this.scenario);
    const nt = Math.max(grafo.totalTramos, grafo.tramos.length);
    const ns = Math.max(grafo.totalSumideros, grafo.sumideros.length);
    this.q = new Float32Array(nt);
    this.qExc = new Float32Array(nt);
    this.qSal = new Float32Array(nt);
    this.qExcSal = new Float32Array(nt);
    this.llega = new Float32Array(ns);
    this.captado = new Float32Array(ns);
    this.exceso = new Float32Array(ns);
    this.volumen = new Float32Array(ns);
    this.nivel = new Uint8Array(ns);
    this.local = new Float32Array(ns);
    this.capCunetaSum = new Float32Array(ns);
    this.capCalzadaSum = new Float32Array(ns);
    this.agregar(grafo.sumideros.map((_, i) => i));
  }

  /** Tras sumar teselas al grafo: capacidades de las rejillas nuevas y puntos del ranking que ahora tienen rejillas cerca. */
  agregar(nuevos: number[]) {
    const { sumideros, tramos } = this.grafo;
    for (const i of nuevos) {
      const s = sumideros[i];
      this.idx.set(s.id, i);
      const t = s.tramo !== null ? tramos[s.tramo] : null;
      this.capCunetaSum[i] = t ? t.capCuneta : capacidadCuneta(s.s, this.cfg);
      this.capCalzadaSum[i] = t ? t.capCalzada : capacidadCalzada(s.s, this.cfg);
    }
    if (nuevos.length && this.puntos.length) this.asociarPuntos(this.puntos);
    this.versionEstados++;
  }

  // ---- Escenario, estados y observaciones ----
  /** Asocia los puntos del ranking con las rejillas del catastro a menos de RADIO_PUNTO_M. */
  asociarPuntos(puntos: { id: string; coord: LngLat }[]) {
    this.puntos = puntos;
    this.sumideroIdsPorPunto = {};
    for (const p of puntos) {
      const cerca = this.grafo.sumideros.filter((s) => distM(s.coord, p.coord) <= RADIO_PUNTO_M).map((s) => s.id);
      if (cerca.length) this.sumideroIdsPorPunto[p.id] = cerca;
    }
    this.aplicarEstadosEscenario();
  }

  get estadosEscenario(): Record<string, EstadoRejilla> {
    return estadosDe(this.scenario);
  }

  setEscenario(id: ScenarioId) {
    this.scenario = id;
    this.reiniciar();
  }

  /** Estado supuesto por el escenario para cada rejilla (a partir de los puntos del ranking). */
  private aplicarEstadosEscenario() {
    this.estadoEscenario.clear();
    this.versionEstados++;
    for (const [punto, estado] of Object.entries(this.estadosEscenario)) {
      for (const id of this.sumideroIdsPorPunto[punto] ?? []) this.estadoEscenario.set(id, estado);
    }
  }

  /** Estados que marcó el operador (clic en el mapa o botones del panel). Se aplican al instante. */
  setEstadosManuales(estados: Record<string, EstadoRejilla>) {
    this.manual = new Map(Object.entries(estados));
    this.versionEstados++;
  }

  setObservaciones(lista: ObservacionPunto[]) {
    this.obs.clear();
    for (const o of lista) if (this.idx.has(o.sumideroId)) this.obs.set(o.sumideroId, { ...this.obs.get(o.sumideroId), ...o });
    this.versionEstados++;
  }

  reiniciar() {
    this.t = 0;
    for (const a of [this.q, this.qExc, this.qSal, this.qExcSal, this.llega, this.captado, this.exceso, this.volumen, this.local]) a.fill(0);
    this.nivel.fill(0);
    this.aplicarEstadosEscenario();
  }

  // ---- Lluvia ----
  /** Intensidad de lluvia (mm/h) en un punto: la del slider, repartida por la celda del escenario si la hay. */
  lluviaMmH(coord: LngLat): number {
    const c = lluviaDe(this.scenario).celda;
    if (!c) return this.intensidadMmH;
    return this.intensidadMmH * (distM(coord, c.centro) <= c.radioM ? c.dentro : c.fuera);
  }

  // ---- Rejillas ----
  estadoRejilla(i: number): EstadoRejilla {
    const id = this.grafo.sumideros[i].id;
    return this.manual.get(id) ?? this.obs.get(id)?.rejilla ?? this.estadoEscenario.get(id) ?? this.cfg.estadoPorDefecto;
  }

  private capacidad(i: number, estado = this.estadoRejilla(i)): number {
    let f = this.cfg.factorEstado[estado];
    if (!this.manual.has(this.grafo.sumideros[i].id)) {
      // Lo observado corrige la estimación: con agua sobre la vereda la rejilla no está tragando; sin agua, sí.
      const n = this.obs.get(this.grafo.sumideros[i].id)?.nivelAgua;
      if (n === "hasta_vereda" || n === "sobre_vereda") f = Math.min(f, this.cfg.factorEstado.tapada);
      else if (n === "sin_agua") return Number.POSITIVE_INFINITY;
    }
    return this.cfg.capacidadRejillaLs * f;
  }

  /** Nivel de agua en la rejilla `i` según lo que no traga: comparado con la calzada (punto con agua) y con la cuneta. */
  private nivelDeExceso(ex: number, i: number): number {
    const u = this.cfg.umbralesExceso;
    const calzada = ex / Math.max(this.capCalzadaSum[i], 1e-6);
    if (calzada >= u.sobre_vereda) return 3;
    if (calzada >= u.hasta_vereda) return 2;
    return ex / Math.max(this.capCunetaSum[i], 1e-6) >= u.cuneta ? 1 : 0;
  }

  /** Nivel de agua que se muestra en una rejilla: lo observado manda sobre lo estimado (salvo que el operador la haya marcado). */
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

  // ---- Paso de cálculo ----
  avanzar(dtS: number) {
    let resto = dtS;
    while (resto > 1e-6) {
      const dt = Math.min(resto, this.cfg.pasoMaxSimS);
      this.paso(dt);
      resto -= dt;
    }
  }

  /** Recalcula lo que tragan las rejillas sin avanzar el reloj (tras cambiar un estado con el flujo en pausa). */
  recalcular() {
    this.paso(0);
  }

  private paso(dt: number) {
    const { tramos, sumideros, orden, sumPorTramo } = this.grafo;
    const coef = this.cfg.coefEscorrentia / 3600;
    const vaciado = Math.exp(-dt / this.cfg.vaciadoS);
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
      let desbLocal = 0; // lo que no cabe en la calle en este tramo: se marca aquí y en el tramo siguiente, no más allá
      for (const s of sumPorTramo.get(i) ?? []) {
        const traga = Math.min(flujo, this.capacidad(s));
        const ex = flujo - traga;
        this.llega[s] = flujo;
        this.captado[s] = traga;
        this.exceso[s] = ex;
        this.nivel[s] = this.nivelDeExceso(ex, s);
        this.acumular(s, ex, dt, vaciado);
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
      this.acumular(i, this.exceso[i], dt, vaciado);
    });
  }

  /** Volumen (m³) que no entra a la rejilla mientras el punto está con agua; se vacía cuando deja de estarlo. */
  private acumular(i: number, ex: number, dt: number, vaciado: number) {
    if (this.desborda(i)) this.volumen[i] += (ex * dt) / 1000;
    else this.volumen[i] *= vaciado;
  }

  // ---- Resumen para la interfaz ----
  lecturas(): Lecturas {
    let desbordados = 0;
    const desbordadosPorComuna: Record<string, number> = {};
    this.grafo.sumideros.forEach((s, i) => {
      if (!this.desborda(i)) return;
      desbordados++;
      if (s.comuna) desbordadosPorComuna[s.comuna] = (desbordadosPorComuna[s.comuna] ?? 0) + 1;
    });
    return { desbordados, desbordadosPorComuna };
  }

  /**
   * Rejilla para el recorrido guiado: limpia hoy no deja agua fuera de la calle, pero tapada sí. Entre esas, la que
   * recibe más agua cerca de los puntos `cerca` (los primeros del ranking). Si ninguna cumple, la que más se acerca.
   */
  candidataRecorrido(cerca: LngLat[]): number | null {
    const { sumideros } = this.grafo;
    let mejor: number | null = null;
    let puntaje = -Infinity;
    sumideros.forEach((s, i) => {
      if (s.tramo === null || this.desborda(i)) return;
      const exTapada = this.llega[i] - this.capacidad(i, "tapada");
      const margen = exTapada / Math.max(this.capCalzadaSum[i], 1e-6); // ≥ 1: tapada deja agua fuera de la calle
      const d = cerca.length ? Math.min(...cerca.map((c) => distM(c, s.coord))) : 0;
      const p = (margen >= 1.1 ? 10 : margen) - d / 2000;
      if (p > puntaje) {
        puntaje = p;
        mejor = i;
      }
    });
    return mejor;
  }
}

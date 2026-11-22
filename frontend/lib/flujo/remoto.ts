// Lado "mapa" del motor del flujo estimado. El cálculo corre en un Web Worker (motor.worker.ts); aquí queda la red con
// su geometría (para dibujar) y la última foto del estado. Si el navegador no tiene workers, el mismo simulador corre
// en este hilo. Flujo estimado; no es una simulación hidráulica ni una medición.
import type { LngLat, ScenarioId } from "../data";
import { ESTADOS, estadosDe, FLUJO_CONFIG, type EstadoRejilla } from "./config";
import type { FuenteObservaciones, ObservacionPunto } from "./fuentes";
import { agregarAlGrafo, grafoVacio, leerTesela, type Grafo, type TeselaCruda } from "./grafo";
import type { Lecturas } from "./motor";
import { crearSimulador, type Foto, type MensajeAlMotor, type MensajeDelMotor } from "./simulador";

const LECTURAS0: Lecturas = { desbordados: 0, desbordadosPorComuna: {} };

export class MotorRemoto {
  readonly grafo: Grafo;
  readonly idx = new Map<string, number>();
  readonly enWorker: boolean;
  scenario: ScenarioId = "13oct";
  t = 0;
  intensidadMmH = 0;
  /** Por tramo (id global): nivel de caudal y bit de agua que no cabe (ver simulador.ts). */
  agua: Uint8Array<ArrayBufferLike>;
  volumen: Float32Array<ArrayBufferLike> = new Float32Array(0);
  versionEstados = -1;
  /** Sube con cada cambio del operador (se ve antes de que llegue la foto del motor). */
  versionManual = 0;
  sumideroIdsPorPunto: Record<string, string[]> = {};
  private est: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private desb: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private lect: Lecturas = LECTURAS0;
  private manual = new Map<string, EstadoRejilla>();
  private enviar: (m: MensajeAlMotor) => void;
  private cerrar: () => void;
  private pedidos = new Map<number, (i: number | null) => void>();
  private nPedido = 0;
  /** Llega una foto nueva del motor (unas 4 veces por segundo con el flujo corriendo, y tras cada cambio). */
  onFoto: (() => void) | null = null;

  constructor(totalTramos: number, totalSumideros: number) {
    this.grafo = grafoVacio(totalTramos, totalSumideros);
    this.agua = new Uint8Array(totalTramos);
    const recibir = (m: MensajeDelMotor) => this.recibir(m);
    let worker: Worker | null = null;
    try {
      if (typeof Worker !== "undefined") worker = new Worker(new URL("./motor.worker.ts", import.meta.url));
    } catch {
      worker = null;
    }
    this.enWorker = !!worker;
    if (worker) {
      worker.onmessage = (e: MessageEvent<MensajeDelMotor>) => recibir(e.data);
      this.enviar = (m) => worker!.postMessage(m);
      this.cerrar = () => worker!.terminate();
    } else {
      // Respaldo sin worker: el mismo simulador en este hilo (los mensajes se entregan en otra vuelta del bucle)
      const sim = crearSimulador((m) => queueMicrotask(() => recibir(m)));
      this.enviar = (m) => sim.manejar(m);
      this.cerrar = () => sim.detener();
    }
    this.enviar({ tipo: "red", totalTramos, totalSumideros });
  }

  /** Suma una tesela (texto de public/data/flujo/t_*.json): la dibuja este hilo y la calcula el worker. */
  agregarTesela(clave: string, texto: string): number[] {
    const parte = leerTesela(clave, JSON.parse(texto) as TeselaCruda, FLUJO_CONFIG);
    const nuevos = agregarAlGrafo(this.grafo, clave, parte);
    for (const i of nuevos) this.idx.set(this.grafo.sumideros[i].id, i);
    this.enviar({ tipo: "tesela", clave, texto });
    return nuevos;
  }

  private recibir(m: MensajeDelMotor) {
    if (m.tipo === "candidata") {
      this.pedidos.get(m.pedido)?.(m.i);
      this.pedidos.delete(m.pedido);
      return;
    }
    if (m.tipo !== "foto") return;
    this.aplicar(m);
    this.onFoto?.();
  }

  private aplicar(f: Foto) {
    this.t = f.t;
    this.intensidadMmH = f.intensidadMmH;
    this.agua = f.agua;
    this.est = f.est;
    this.desb = f.desb;
    this.volumen = f.volumen;
    this.versionEstados = f.versionEstados;
    this.lect = f.lecturas;
    if (f.sumideroIdsPorPunto) this.sumideroIdsPorPunto = f.sumideroIdsPorPunto;
  }

  // ---- Lecturas (de la última foto) ----
  get estadosEscenario(): Record<string, EstadoRejilla> {
    return estadosDe(this.scenario);
  }

  /** Estado efectivo: lo que marcó el operador se ve al instante, aunque la foto del motor todavía no lo traiga. */
  estadoRejilla(i: number): EstadoRejilla {
    return this.manual.get(this.grafo.sumideros[i]?.id) ?? ESTADOS[this.est[i]] ?? FLUJO_CONFIG.estadoPorDefecto;
  }

  desborda(i: number): boolean {
    return this.desb[i] === 1;
  }

  lecturas(): Lecturas {
    return this.lect;
  }

  // ---- Órdenes al motor ----
  setFuente(id: FuenteObservaciones["id"]) {
    this.enviar({ tipo: "fuente", id });
  }

  asociarPuntos(puntos: { id: string; coord: LngLat }[]) {
    this.enviar({ tipo: "puntos", puntos });
  }

  setEscenario(id: ScenarioId, intensidadMmH: number) {
    this.scenario = id;
    this.intensidadMmH = intensidadMmH;
    this.enviar({ tipo: "escenario", scenario: id, intensidadMmH });
  }

  setEstadosManuales(estados: Record<string, EstadoRejilla>) {
    this.manual = new Map(Object.entries(estados));
    this.versionManual++;
    this.enviar({ tipo: "estados", estados });
  }

  setObservaciones(lista: ObservacionPunto[]) {
    this.enviar({ tipo: "observaciones", lista });
  }

  setLluvia(mmh: number) {
    this.intensidadMmH = mmh;
    this.enviar({ tipo: "lluvia", mmh });
  }

  setReloj(corriendo: boolean, velocidad: number) {
    this.enviar({ tipo: "reloj", corriendo, velocidad });
  }

  setOculto(oculto: boolean) {
    this.enviar({ tipo: "oculto", oculto });
  }

  reiniciar() {
    this.enviar({ tipo: "reiniciar" });
  }

  /** Rejilla del recorrido guiado (la calcula el motor con su estado actual). */
  candidataRecorrido(cerca: LngLat[]): Promise<number | null> {
    const pedido = ++this.nPedido;
    return new Promise((res) => {
      this.pedidos.set(pedido, res);
      this.enviar({ tipo: "candidata", pedido, cerca });
    });
  }

  destruir() {
    this.cerrar();
    this.onFoto = null;
  }
}

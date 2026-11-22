// Lado "motor" del flujo estimado: guarda la red cargada y el MotorFlujo, avanza el reloj y manda una foto del estado
// unas 4 veces por segundo. Corre en un Web Worker (motor.worker.ts); si el navegador no tiene workers, el mismo código
// corre en el hilo principal (remoto.ts). El mapa solo recibe la foto: el caudal ya viene en niveles y el estado de las
// rejillas, como códigos.
//
// Flujo estimado; no es una simulación hidráulica ni una medición.
import type { LngLat, ScenarioId } from "../data";
import { ESTADOS, FLUJO_CONFIG, type EstadoRejilla } from "./config";
import type { ObservacionPunto } from "./fuentes";
import { agregarAlGrafo, grafoVacio, leerTesela, type TeselaCruda } from "./grafo";
import { MotorFlujo, type Lecturas } from "./motor";

export type MensajeAlMotor =
  | { tipo: "red"; totalTramos: number; totalSumideros: number }
  | { tipo: "tesela"; clave: string; texto: string }
  | { tipo: "escenario"; scenario: ScenarioId; intensidadMmH: number }
  | { tipo: "puntos"; puntos: { id: string; coord: LngLat }[] }
  | { tipo: "estados"; estados: Record<string, EstadoRejilla> }
  | { tipo: "observaciones"; lista: ObservacionPunto[] }
  | { tipo: "lluvia"; mmh: number }
  | { tipo: "reloj"; corriendo: boolean; velocidad: number }
  | { tipo: "oculto"; oculto: boolean }
  | { tipo: "reiniciar" }
  | { tipo: "candidata"; pedido: number; cerca: LngLat[] };

export interface Foto {
  tipo: "foto";
  t: number;
  intensidadMmH: number;
  /** Por tramo (id global): nivel de caudal 0..nivelesCaudal (0: no se pinta) en los bits 0-3; bit 4: agua que no cabe en la calle. */
  agua: Uint8Array;
  /** Por sumidero (índice de carga): estado efectivo, índice en ESTADOS. */
  est: Uint8Array;
  /** Por sumidero: 1 si el punto está con agua (estimado u observado). */
  desb: Uint8Array;
  /** Por sumidero: m³ que no entraron a la rejilla mientras estuvo con agua (columna 3D). */
  volumen: Float32Array;
  versionEstados: number;
  lecturas: Lecturas;
  /** Solo cuando cambió (puntos del ranking o teselas nuevas). */
  sumideroIdsPorPunto?: Record<string, string[]>;
}

export type MensajeDelMotor = Foto | { tipo: "tesela"; clave: string } | { tipo: "candidata"; pedido: number; i: number | null };

export const AGUA_NIVEL = 0x0f;
export const AGUA_DESBORDE = 0x10;

/** Nivel de caudal del dibujo (0: bajo el mínimo, no se pinta; 1..niveles: escala logarítmica hasta caudalGrosorMaxLs). */
export function nivelCaudal(q: number, cfg = FLUJO_CONFIG): number {
  if (!(q >= cfg.caudalMinimoLs)) return 0;
  const lmin = Math.log1p(cfg.caudalMinimoLs);
  const x = (Math.log1p(q) - lmin) / (Math.log1p(cfg.caudalGrosorMaxLs) - lmin);
  return Math.max(1, Math.min(cfg.nivelesCaudal, Math.ceil(x * cfg.nivelesCaudal)));
}

export function crearSimulador(enviar: (m: MensajeDelMotor, transferir?: Transferable[]) => void) {
  const cfg = FLUJO_CONFIG;
  let motor: MotorFlujo | null = null;
  let corriendo = false;
  let velocidad = 10;
  let oculto = false;
  let asociacionCambio = true;
  let ultimo = performance.now();
  let ultimaFoto = 0;
  let reloj: ReturnType<typeof setInterval> | null = null;
  // Lo que llega antes que la primera tesela se guarda y se aplica al crear el motor
  let pendiente: { scenario?: ScenarioId; intensidad?: number; puntos?: { id: string; coord: LngLat }[]; estados?: Record<string, EstadoRejilla> } = {};
  const grafo = { actual: grafoVacio(0, 0) };

  function foto() {
    const m = motor;
    if (!m) return;
    ultimaFoto = performance.now();
    const { lista, sumideros } = m.grafo;
    const agua = new Uint8Array(m.grafo.totalTramos);
    for (const t of lista) {
      const q = m.q[t.id];
      const n = nivelCaudal(q, cfg);
      agua[t.id] = n | (n > 0 && m.qExc[t.id] / q > 0.05 ? AGUA_DESBORDE : 0);
    }
    const ns = sumideros.length;
    const est = new Uint8Array(ns);
    const desb = new Uint8Array(ns);
    const volumen = m.volumen.slice(0, ns);
    for (let i = 0; i < ns; i++) {
      est[i] = ESTADOS.indexOf(m.estadoRejilla(i));
      desb[i] = m.desborda(i) ? 1 : 0;
    }
    const f: Foto = { tipo: "foto", t: m.t, intensidadMmH: m.intensidadMmH, agua, est, desb, volumen, versionEstados: m.versionEstados, lecturas: m.lecturas() };
    if (asociacionCambio) {
      f.sumideroIdsPorPunto = m.sumideroIdsPorPunto;
      asociacionCambio = false;
    }
    enviar(f, [agua.buffer, est.buffer, desb.buffer, volumen.buffer]);
  }

  function tic() {
    const ahora = performance.now();
    const dt = Math.min(0.1, (ahora - ultimo) / 1000);
    ultimo = ahora;
    if (!motor || oculto) return;
    if (corriendo) motor.avanzar(dt * velocidad);
    if (corriendo && ahora - ultimaFoto >= cfg.fotoMs) foto();
  }

  function manejar(msg: MensajeAlMotor) {
    switch (msg.tipo) {
      case "red":
        grafo.actual = grafoVacio(msg.totalTramos, msg.totalSumideros);
        motor = null;
        reloj ??= setInterval(tic, cfg.pasoRelojMs);
        return;
      case "tesela": {
        const parte = leerTesela(msg.clave, JSON.parse(msg.texto) as TeselaCruda, cfg);
        const nuevos = agregarAlGrafo(grafo.actual, msg.clave, parte);
        if (!motor) {
          motor = new MotorFlujo(grafo.actual);
          if (pendiente.puntos) motor.asociarPuntos(pendiente.puntos);
          if (pendiente.scenario) motor.setEscenario(pendiente.scenario);
          if (pendiente.intensidad !== undefined) motor.intensidadMmH = pendiente.intensidad;
          if (pendiente.estados) motor.setEstadosManuales(pendiente.estados);
          pendiente = {};
        } else motor.agregar(nuevos);
        asociacionCambio = true;
        motor.recalcular();
        enviar({ tipo: "tesela", clave: msg.clave });
        foto();
        return;
      }
      case "escenario":
        if (!motor) {
          pendiente.scenario = msg.scenario;
          pendiente.intensidad = msg.intensidadMmH;
          return;
        }
        motor.setEscenario(msg.scenario);
        motor.intensidadMmH = msg.intensidadMmH;
        break;
      case "puntos":
        if (!motor) {
          pendiente.puntos = msg.puntos;
          return;
        }
        motor.asociarPuntos(msg.puntos);
        asociacionCambio = true;
        break;
      case "estados":
        if (!motor) {
          pendiente.estados = msg.estados;
          return;
        }
        motor.setEstadosManuales(msg.estados);
        motor.recalcular();
        break;
      case "observaciones":
        motor?.setObservaciones(msg.lista);
        break;
      case "lluvia":
        if (!motor) pendiente.intensidad = msg.mmh;
        else motor.intensidadMmH = msg.mmh;
        break;
      case "reloj":
        corriendo = msg.corriendo;
        velocidad = msg.velocidad;
        ultimo = performance.now();
        return;
      case "oculto":
        oculto = msg.oculto;
        ultimo = performance.now();
        return;
      case "reiniciar":
        motor?.reiniciar();
        break;
      case "candidata":
        enviar({ tipo: "candidata", pedido: msg.pedido, i: motor ? motor.candidataRecorrido(msg.cerca) : null });
        return;
    }
    foto();
  }

  return {
    manejar,
    detener() {
      if (reloj) clearInterval(reloj);
      reloj = null;
    },
  };
}

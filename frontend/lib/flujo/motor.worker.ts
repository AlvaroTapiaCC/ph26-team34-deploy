// Web Worker del motor del flujo estimado: el cálculo de toda la red cargada corre fuera del hilo del mapa.
// remoto.ts lo crea con `new Worker(new URL("./motor.worker.ts", import.meta.url))`.
import { crearSimulador, type MensajeAlMotor, type MensajeDelMotor } from "./simulador";

const ctx = self as unknown as { postMessage(m: MensajeDelMotor, t?: Transferable[]): void; onmessage: ((e: MessageEvent<MensajeAlMotor>) => void) | null };
const sim = crearSimulador((m, t) => ctx.postMessage(m, t ?? []));
ctx.onmessage = (e) => sim.manejar(e.data);

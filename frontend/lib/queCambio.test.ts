import assert from "node:assert/strict";
import { test } from "node:test";
import type { ObservacionPublica } from "./central.ts";
import { puestosReporte, SIN_DATO } from "./queCambio.ts";

function obs(prioridad: ObservacionPublica["prioridad"]): ObservacionPublica {
  return { id: "foto", sumidero_id: "B", caso_id: null, ts: "2026-11-22T11:00:00Z", fuente: "vecino", tipo: "foto_rejilla", is_simulated: false, urgente: false, clasificacion: null, prioridad };
}

test("usa los puestos registrados aunque reconstruirlos desde el puntaje dé otro (empates y urgencia)", () => {
  // Orden de formula.py: urgentes primero, luego prioridad desc, luego id. U es urgente con menos puntaje;
  // A y B empatan en 0.6 y B sigue detrás de A. Antes del reporte B también tenía 0.6 y era #3.
  const ranking = [
    { sumidero_id: "U", prioridad: 0.4 },
    { sumidero_id: "A", prioridad: 0.6 },
    { sumidero_id: "B", prioridad: 0.6 },
  ];
  const o = obs({ antes: { scenario_id: "base", rank: 3, prioridad: 0.6 }, despues: { scenario_id: "base", rank: 3, prioridad: 0.6 } });
  const reconstruido = 1 + ranking.filter((r) => r.sumidero_id !== "B" && r.prioridad > o.prioridad!.antes!.prioridad!).length;
  assert.equal(reconstruido, 1);

  const p = puestosReporte(o, false);
  assert.equal(p.antes, "#3");
  assert.equal(p.despues, "#3");
  assert.equal(p.alcance, "escenario base, todas las rejillas");
  assert.equal(p.zonaMut, SIN_DATO);
});

test("un puesto no registrado dice «Sin dato» en lugar de inventarse", () => {
  const p = puestosReporte(obs({ antes: null, despues: { scenario_id: "base", rank: 7, prioridad: 0.5 } }), false);
  assert.equal(p.antes, SIN_DATO);
  assert.equal(p.despues, "#7");
  const vacio = puestosReporte(obs(null), false);
  assert.deepEqual([vacio.antes, vacio.despues], [SIN_DATO, SIN_DATO]);
});

test("en la demo los puestos se rotulan como San Carlos y entorno, sin zona MUT", () => {
  const p = puestosReporte(obs({ antes: { scenario_id: "demo-local", rank: 9, prioridad: 0.3 }, despues: { scenario_id: "demo-local", rank: 2, prioridad: 0.7 } }), true);
  assert.deepEqual(p, { alcance: "San Carlos y entorno", antes: "#9", despues: "#2", zonaMut: null });
});

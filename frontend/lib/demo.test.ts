import assert from "node:assert/strict";
import test from "node:test";
import { capasDemo, datosDemo, DEMO_SUMIDERO, HORAS_DEMO, PASOS_DEMO } from "./demo.ts";

test("la reconstrucción usa 562 rejillas y dos cortes horarios reales de octubre", () => {
  const antes = datosDemo(0), lluvia = datosDemo(1);
  assert.equal(antes.inicial.length, 562);
  assert.equal(antes.hora.hora_utc, "2026-10-07T21:00:00Z");
  assert.equal(lluvia.hora.hora_utc, "2026-10-08T20:00:00Z");
  assert.equal(lluvia.hora.lluvia_mm, 6.4);
  assert.equal(HORAS_DEMO.length, 72);
  assert.notDeepEqual(antes.durante, lluvia.durante);
  assert.equal(antes.durante.find((p) => p.sumidero_id === DEMO_SUMIDERO)?.rank, 12);
  assert.equal(lluvia.durante.find((p) => p.sumidero_id === DEMO_SUMIDERO)?.rank, 18);
});

test("la foto simulada cambia #18 a #1 usando la fórmula y después la siguiente parada", () => {
  const lluvia = datosDemo(1), foto = datosDemo(2), ruta = datosDemo(3);
  const p = foto.durante[0];
  assert.equal(p.sumidero_id, DEMO_SUMIDERO);
  assert.equal(p.detalle?.fuente_p, "foto");
  assert.equal(p.p_obs, .95);
  assert.equal(p.prioridad, p.p_ef! * p.c!);
  assert.equal(foto.observaciones[0].prioridad?.antes?.rank, 18);
  assert.equal(foto.observaciones[0].prioridad?.despues?.rank, 1);
  assert.deepEqual(foto.ruta.misiones, lluvia.ruta.misiones);
  assert.equal(ruta.ruta.misiones[0].sumidero_id, DEMO_SUMIDERO);
  assert.equal(ruta.ruta.geojson, null); // No línea recta presentada como ruta vial.
});

test("cada paso restablece solo las capas útiles, sin contaminar el estado inicial", () => {
  const inicial = JSON.stringify(datosDemo(0));
  for (let i = 0; i < PASOS_DEMO.length; i++) {
    const d = datosDemo(i), capas = capasDemo(i);
    assert.ok(d.durante.every((p) => p.is_simulated));
    assert.equal(capas.transporte, i >= 4);
    assert.equal(capas.reportes, i >= 2);
    assert.equal(capas.infra, false);
    assert.equal(capas.agua, i === 1);
  }
  assert.equal(datosDemo(3).transporte.evidencia_agua?.length, 0);
  assert.equal(datosDemo(4).transporte.evidencia_agua?.length, 1);
  assert.equal(JSON.stringify(datosDemo(0)), inicial);
});

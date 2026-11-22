import assert from "node:assert/strict";
import { test } from "node:test";
import type { ObservacionPublica } from "./central.ts";
import { reportesParaMapa } from "./reportesMapa.ts";

const AHORA = Date.parse("2026-11-22T12:00:00Z");
const REJILLAS = [{ sumidero_id: "A", lon: -70.6, lat: -33.4 }];
function obs(cambios: Partial<ObservacionPublica> = {}): ObservacionPublica {
  return { id: "foto", sumidero_id: "A", caso_id: null, ts: "2026-11-22T11:00:00Z", fuente: "vecino", tipo: "foto_rejilla", is_simulated: false, urgente: false, clasificacion: { evaluable: true, rejilla: "tapada" }, ...cambios };
}

test("un reporte reciente ubica la obstrucción en la rejilla sin inventar agua", () => {
  const [r] = reportesParaMapa([obs()], REJILLAS, AHORA);
  assert.equal(r.tipo, "obstruccion");
  assert.equal(r.titulo, "Obstrucción reportada");
  assert.deepEqual(r.coord, [-70.6, -33.4]);
  assert.equal(r.fuente, "vecino");
});

test("la última foto limpia sustituye la obstrucción aunque lleguen desordenadas", () => {
  const limpia = obs({ id: "limpia", ts: "2026-11-22T11:30:00Z", clasificacion: { evaluable: true, rejilla: "limpia" } });
  const r = reportesParaMapa([obs(), limpia], REJILLAS, AHORA);
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, "despejada");
});

test("una foto no evaluable nunca se presenta como obstrucción confirmada", () => {
  const [r] = reportesParaMapa([obs({ clasificacion: { evaluable: false, rejilla: "tapada", nivel_agua: "sobre_vereda" } })], REJILLAS, AHORA);
  assert.equal(r.tipo, "reporte");
  assert.equal(r.titulo, "Foto no evaluable");
});

test("la ubicación pública permite ver problemas fuera del ranking sin fabricar coordenadas", () => {
  const [r] = reportesParaMapa([obs({ sumidero_id: null, caso_publico: { estado: "nuevo", lat: -33.42, lon: -70.62 } })], [], AHORA);
  assert.deepEqual(r.coord, [-70.62, -33.42]);
  assert.equal(r.rankeado, false);
  assert.deepEqual(reportesParaMapa([obs()], [], AHORA), []);
});

test("agua y evidencia simulada conservan nivel, fuente y hora", () => {
  const [r] = reportesParaMapa([obs({ is_simulated: true, clasificacion: { nivel_agua: "hasta_vereda" } })], REJILLAS, AHORA);
  assert.equal(r.tipo, "agua");
  assert.equal(r.titulo, "Agua hasta la vereda");
  assert.equal(r.simulado, true);
  assert.equal(r.ts, "2026-11-22T11:00:00Z");
});

test("sin agua no se representa como inundación y no se infiere cierre vial", () => {
  const [r] = reportesParaMapa([obs({ clasificacion: { nivel_agua: "sin_agua" } })], REJILLAS, AHORA);
  assert.equal(r.tipo, "reporte");
  assert.equal(r.titulo, "Sin agua en el reporte");
});

test("no muestra evidencia futura, vencida, sin ubicación o de casos cerrados", () => {
  for (const cambios of [
    { ts: "2026-11-22T13:00:00Z" },
    { ts: "2026-11-19T12:00:00Z" },
    { ts: "inválido" },
    { caso_publico: { estado: "cerrado", lat: -33.4, lon: -70.6 } },
    { caso_publico: { estado: "nuevo", lat: NaN, lon: -70.6 } },
  ]) assert.deepEqual(reportesParaMapa([obs(cambios)], REJILLAS, AHORA), []);
});

// Prueba de la regla de agua calle abajo (#93). Es la misma regla de
// backend/app/services/transporte.py::puntos_con_agua y el mismo caso de
// backend/tests/test_transporte.py. Se ejecuta con `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ObservacionPublica } from "./central.ts";
import { capaCadenas, type Tramo } from "./cadenas.ts";

const AHORA = Date.parse("2026-11-22T12:00:00Z");
const COORD: Record<string, [number, number]> = { A: [-70.6, -33.418], B: [-70.6, -33.4185], C: [-70.6, -33.419] };

function tramo(desde: string, hasta: string, distancia_m: number): Tramo {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [COORD[desde], COORD[hasta]] },
    properties: { desde, hasta, distancia_m },
  };
}

function obs(sumidero_id: string, nivel_agua: string): ObservacionPublica {
  return {
    id: `o-${sumidero_id}`, sumidero_id, caso_id: null, ts: new Date(AHORA - 60_000).toISOString(),
    fuente: "vecino", tipo: "foto_agua", is_simulated: false, urgente: false,
    clasificacion: { evaluable: true, nivel_agua },
  };
}

// A → B → C dentro de 150 m
const CADENA = [tramo("A", "B", 50), tramo("B", "C", 70)];

function tramosConAgua(tramos: Tramo[], observaciones: ObservacionPublica[]) {
  const { geojson } = capaCadenas(tramos, new Map(), observaciones, AHORA, 6, 150);
  return geojson.features
    .filter(({ properties }) => properties.tipo === "agua_abajo")
    .map(({ geometry }) => {
      const [a, b] = geometry.coordinates as [number, number][];
      const id = (c: [number, number]) => Object.keys(COORD).find((k) => COORD[k][1] === c[1]);
      return `${id(a)}→${id(b)}`;
    })
    .sort();
}

test("sin observación en B ni C, el agua de A se extiende por la cadena", () => {
  assert.deepEqual(tramosConAgua(CADENA, [obs("A", "cuneta")]), ["A→B", "B→C"]);
});

test("B observada seca corta el agua de A: ni B ni C quedan con agua inferida", () => {
  assert.deepEqual(tramosConAgua(CADENA, [obs("A", "cuneta"), obs("B", "sin_agua")]), []);
});

test("C se marca si llega agua por otra cadena que no pasa por B", () => {
  const conAtajo = [...CADENA, tramo("A", "C", 100)];
  assert.deepEqual(tramosConAgua(conAtajo, [obs("A", "cuneta"), obs("B", "sin_agua")]), ["A→C"]);
});

test("el alcance de 150 m también corta el recorrido", () => {
  assert.deepEqual(tramosConAgua([tramo("A", "B", 50), tramo("B", "C", 120)], [obs("A", "cuneta")]), ["A→B"]);
});

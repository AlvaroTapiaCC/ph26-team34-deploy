// Prueba de la regla de agua calle abajo (#93). Es la misma regla de
// backend/app/services/transporte.py::puntos_con_agua y el mismo caso de
// backend/tests/test_transporte.py. Se ejecuta con `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ObservacionPublica } from "./central.ts";
import { capaCadenas, type Tramo } from "./cadenas.ts";
import type { EvidenciaAgua } from "./transporte.ts";

const HORA_MS = 60 * 60_000;
const AHORA = Date.parse("2026-11-22T12:00:00Z");
const COORD: Record<string, [number, number]> = { A: [-70.6, -33.418], B: [-70.6, -33.4185], C: [-70.6, -33.419] };

function tramo(desde: string, hasta: string, distancia_m: number): Tramo {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [COORD[desde], COORD[hasta]] },
    properties: { desde, hasta, distancia_m },
  };
}

function obs(sumidero_id: string, nivel: EvidenciaAgua["nivel"]): EvidenciaAgua {
  return { sumidero_id, nivel, ts: new Date(AHORA - HORA_MS).toISOString(), is_simulated: false };
}

// A → B → C dentro de 150 m
const CADENA = [tramo("A", "B", 50), tramo("B", "C", 70)];

function tramosConAgua(tramos: Tramo[], evidenciaAgua: EvidenciaAgua[], observaciones: ObservacionPublica[] = []) {
  const { geojson } = capaCadenas(tramos, new Map(), observaciones, evidenciaAgua, AHORA, 6, 150);
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

test("el agua de transporte sigue visible después de 100 reportes de texto", () => {
  const textos: ObservacionPublica[] = Array.from({ length: 100 }, (_, i) => ({
    id: `texto-${i}`, sumidero_id: "A", caso_id: null, ts: new Date(AHORA - i * 1000).toISOString(),
    fuente: "vecino", tipo: "texto", is_simulated: false, urgente: false,
    clasificacion: { nivel_agua: "no_evaluable" },
  }));
  assert.deepEqual(tramosConAgua(CADENA, [obs("A", "cuneta")], textos), ["A→B", "B→C"]);
});

test("la misma respuesta de transporte pierde el agua observada y la inferida al vencer", () => {
  const captura = AHORA - 5 * HORA_MS;
  const evidencia = [{ ...obs("A", "cuneta"), ts: new Date(captura).toISOString() }];
  const prioridades = new Map([["A", "alta"]] as const);
  const capaEn = (ahora: number, vigenciaH = 6) =>
    capaCadenas(CADENA, prioridades, [], evidencia, ahora, vigenciaH, 150);
  const tiposAgua = (datos: ReturnType<typeof capaCadenas>) => datos.geojson.features
    .map(({ properties }) => properties.tipo)
    .filter((tipo) => tipo.startsWith("agua_"));

  const alRecibir = capaEn(AHORA);
  assert.deepEqual(tiposAgua(alRecibir), ["agua_abajo", "agua_abajo", "agua_observada"]);
  assert.equal(alRecibir.proximoVencimientoAgua, captura + 6 * HORA_MS);
  assert.equal(tiposAgua(capaEn(captura + 6 * HORA_MS - 1)).length, 3);
  for (const edadH of [6, 7, 24]) {
    const datos = capaEn(captura + edadH * HORA_MS);
    assert.deepEqual(tiposAgua(datos), []);
    assert.ok(datos.geojson.features.some(({ properties }) => properties.tipo === "alta"));
  }
  assert.deepEqual(tiposAgua(capaEn(AHORA, 4)), []);
});

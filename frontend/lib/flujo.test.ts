// Pruebas de la red del flujo estimado por teselas (pipeline/04_flujo.py -> public/data/flujo/, lib/flujo/grafo.ts).
// Se ejecutan con `npm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { agregarAlGrafo, grafoVacio, leerTesela, teselasNecesarias, type IndiceFlujo, type TeselaCruda } from "./flujo/grafo.ts";

// Los mismos valores de FLUJO_CONFIG que usa la lectura (config.ts importa la paleta, que node no lee sin bundler)
const CFG = { manningN: 0.016, radioHidraulicoM: 0.04, velocidadMin: 0.15, velocidadMax: 3, areaCunetaM2: 0.03, areaCalzadaM2: 0.25, trazoLimitesV: [0.7, 1.3] };
const DIR = new URL("../public/data/flujo/", import.meta.url);
const indice = JSON.parse(readFileSync(new URL("indice.json", DIR), "utf8")) as IndiceFlujo;
const tesela = (k: string) => JSON.parse(readFileSync(new URL(indice.teselas[k].archivo, DIR), "utf8")) as TeselaCruda;

test("lee coordenadas por diferencias, calle, comuna y caja", () => {
  const cruda: TeselaCruda = {
    t: [[7, 120, 0.02, 2400, 5000, null, 0, [-7060000, -3341000, 100, 0, 0, -50]]],
    s: [[3, "S-1", -7059950, -3341000, 7, 0.5, 1200, 0.02, 1]],
    calles: ["Av. Apoquindo"],
    comunas: ["Las Condes", "Providencia"],
  };
  const { tramos, sumideros } = leerTesela("1_3", cruda, CFG);
  assert.deepEqual(tramos[0].coords, [
    [-70.6, -33.41],
    [-70.599, -33.41],
    [-70.599, -33.4105],
  ]);
  assert.equal(tramos[0].nombre, "Av. Apoquindo");
  assert.equal(tramos[0].tesela, "1_3");
  assert.deepEqual(tramos[0].caja, [-70.6, -33.4105, -70.599, -33.41]);
  assert.ok(Math.abs(tramos[0].cum[2] - (93 + 55.3)) < 1, `largo ${tramos[0].cum[2]}`);
  assert.deepEqual(sumideros[0].coord, [-70.5995, -33.41]);
  assert.equal(sumideros[0].comuna, "Providencia");
});

test("la red crece por teselas: entrantes y orden de aguas arriba a aguas abajo", () => {
  const A: TeselaCruda = { t: [[0, 100, 0.02, 2000, 2000, 1, null, [0, 0, 10, 0]]], s: [], calles: [], comunas: [] };
  const B: TeselaCruda = {
    t: [[1, 100, 0.02, 2000, 4000, null, null, [10, 0, 10, 0]]],
    s: [
      [1, "B2", 15, 0, 1, 0.8, 0, 0.02, null],
      [0, "B1", 12, 0, 1, 0.2, 0, 0.02, null],
    ],
    calles: [],
    comunas: [],
  };
  const g = grafoVacio(2, 2);
  agregarAlGrafo(g, "B", leerTesela("B", B, CFG)); // primero lo de aguas abajo
  assert.deepEqual(g.orden, [1]);
  assert.equal(agregarAlGrafo(g, "B", leerTesela("B", B, CFG)).length, 0, "una tesela no se suma dos veces");
  agregarAlGrafo(g, "A", leerTesela("A", A, CFG));
  assert.deepEqual(g.tramos[1].entrantes, [0]);
  assert.deepEqual(g.orden, [0, 1]);
  assert.deepEqual(
    g.sumPorTramo.get(1)!.map((i) => g.sumideros[i].id),
    ["B1", "B2"],
  );
});

test("lo visible trae todo lo que está aguas arriba", () => {
  // Red completa, para conocer los entrantes reales de cada tramo
  const completa = grafoVacio(indice.tramos, indice.sumideros);
  for (const k of Object.keys(indice.teselas)) agregarAlGrafo(completa, k, leerTesela(k, tesela(k), CFG));
  assert.equal(completa.lista.length, indice.tramos);
  assert.equal(completa.sumideros.length, indice.sumideros);
  assert.equal(completa.orden.length, indice.tramos, "la red no tiene ciclos");

  const caja = indice.caja_inicial;
  const necesarias = teselasNecesarias(indice, caja);
  assert.ok(necesarias.length < Object.keys(indice.teselas).length, "no carga todas las teselas");
  const parcial = grafoVacio(indice.tramos, indice.sumideros);
  for (const k of necesarias) agregarAlGrafo(parcial, k, leerTesela(k, tesela(k), CFG));
  const visibles = parcial.lista.filter((t) => t.caja[2] >= caja[0][0] && t.caja[0] <= caja[1][0] && t.caja[3] >= caja[0][1] && t.caja[1] <= caja[1][1]);
  assert.ok(visibles.length > 500);
  const pila = visibles.map((t) => t.id);
  const vistos = new Set(pila);
  while (pila.length) {
    for (const e of completa.tramos[pila.pop()!].entrantes) {
      assert.ok(parcial.tramos[e], `falta el tramo ${e}, aguas arriba de lo visible`);
      if (!vistos.has(e)) {
        vistos.add(e);
        pila.push(e);
      }
    }
  }
});

test("área acumulada = área propia (con lo que entra del margen) + lo que llega de aguas arriba", () => {
  const g = grafoVacio(indice.tramos, indice.sumideros);
  for (const k of Object.keys(indice.teselas)) agregarAlGrafo(g, k, leerTesela(k, tesela(k), CFG));
  let calzan = 0;
  for (const t of g.lista) {
    const suma = t.ap + t.entrantes.reduce((s, e) => s + g.tramos[e].acc, 0);
    if (Math.abs(suma - t.acc) <= 100 * (t.entrantes.length + 1)) calzan++; // acc va redondeada a 100 m²
  }
  assert.ok(calzan / g.lista.length > 0.99, `${calzan} de ${g.lista.length}`);
});

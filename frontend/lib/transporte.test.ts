import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const codigo = ts.transpileModule(readFileSync(new URL("./transporte.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function cargar(fetch: typeof globalThis.fetch, completo = false) {
  const exports: Record<string, (zona?: string) => Promise<unknown[]>> = {};
  runInNewContext(codigo, { exports, fetch, require: (id: string) => id === "react" ? require("react") : {} });
  return completo ? exports.cargarRecorridosCompletos : exports.cargarRecorridos;
}

test("recorridos: MUT por defecto, caché independiente por zona", async () => {
  const urls: string[] = [];
  const loader = cargar((async (url: string) => {
    urls.push(url);
    return { ok: true, json: async () => ({ features: [{ properties: { servicio: url }, geometry: { coordinates: [] } }] }) };
  }) as typeof fetch);
  const mut = await loader();
  const sanCarlos = await loader("san-carlos");
  assert.equal(await loader("mut"), mut);
  assert.equal(await loader("san-carlos"), sanCarlos);
  assert.notEqual(mut, sanCarlos);
  assert.deepEqual(urls, ["/data/recorridos.geojson", "/data/recorridos_san_carlos.geojson"]);
});

test("recorridos: colecciones vacías quedan cacheadas", async () => {
  let consultas = 0;
  const loader = cargar((async () => {
    consultas++;
    return { ok: true, json: async () => ({ features: [] }) };
  }) as typeof fetch);
  const vacio = await loader("san-carlos");
  assert.equal(vacio.length, 0);
  assert.equal(await loader("san-carlos"), vacio);
  assert.equal(consultas, 1);
});

test("recorridos: un error permite reintentar sin invalidar otra zona", async () => {
  let fallar = true;
  const loader = cargar((async (url: string) => {
    if (url.includes("san_carlos") && fallar) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ features: [] }) };
  }) as typeof fetch);
  const mut = await loader();
  await assert.rejects(loader("san-carlos"), /503/);
  fallar = false;
  assert.equal((await loader("san-carlos")).length, 0);
  assert.equal(await loader(), mut);
});

test("completos: carga diferida, caché por zona y paraderos de todo el viaje", async () => {
  const urls: string[] = [];
  const loader = cargar((async (url: string) => {
    urls.push(url);
    return { ok: true, json: async () => [{ servicio: "1", sentido: "0", geometria: [[-70.63, -33.418]], paraderos: [{ id: "fuera" }] }] };
  }) as typeof fetch, true);
  assert.equal(urls.length, 0);
  const mut = await loader();
  const sc = await loader("san-carlos");
  assert.equal(await loader(), mut);
  assert.equal(await loader("san-carlos"), sc);
  assert.deepEqual(urls, ["/data/recorridos_completos_mut.json", "/data/recorridos_completos_san_carlos.json"]);
  assert.equal(mut.length, 1);
});

test("completos: vacío válido y reintento tras error", async () => {
  let consultas = 0;
  const loader = cargar((async () => {
    consultas++;
    if (consultas === 1) throw new Error("sin red");
    return { ok: true, json: async () => [] };
  }) as typeof fetch, true);
  await assert.rejects(loader(), /sin red/);
  const vacio = await loader();
  assert.equal(vacio.length, 0);
  assert.equal(await loader(), vacio);
  assert.equal(consultas, 2);
});

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

function cargar(fetch: typeof globalThis.fetch) {
  const exports: Record<string, (zona?: string) => Promise<unknown[]>> = {};
  runInNewContext(codigo, { exports, fetch, require: (id: string) => id === "react" ? require("react") : {} });
  return exports.cargarRecorridos;
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

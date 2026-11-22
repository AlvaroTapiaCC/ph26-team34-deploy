import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { cargarTransporteDemo, type CargaTransporteDemo } from "./transporteDemo.ts";
import type { Expuestos } from "./transporte.ts";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const exports: { default?: React.ComponentType<Record<string, unknown>> } = {};
const codigo = ts.transpileModule(readFileSync(new URL("../components/desktop/Transporte.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
runInNewContext(codigo, { exports, require: (id: string) => {
  if (id === "@/lib/transporte") return { horaSantiago: () => "", sentidoTexto: () => "", claveServicio: (s: { servicio: string }) => s.servicio, NIVEL_AGUA: {}, INTERVALO_MS: 3000 };
  if (id === "../ui") return { Kicker: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children) };
  return require(id);
} });

const fixture: Expuestos = JSON.parse(readFileSync(new URL("../public/data/demo-san-carlos-transporte.json", import.meta.url), "utf8"));
const pintar = (carga: CargaTransporteDemo) => renderToStaticMarkup(React.createElement(exports.default, {
  ...carga, calculadoAt: null, activo: null, onSelect: () => {}, servicioActivo: null, onServicio: () => {}, reintentar: () => {},
}));

test("carga lenta muestra Cargando transporte y no un resultado vacío", async (t) => {
  let resolver!: (r: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { resolver = resolve; }));
  let carga: CargaTransporteDemo = { datos: null, estado: "error" };
  const pendiente = cargarTransporteDemo((c) => { carga = c; });
  assert.equal(carga.estado, "cargando");
  assert.match(pintar(carga), /Cargando transporte/);
  assert.doesNotMatch(pintar(carga), /Sin paraderos expuestos/);
  resolver(Response.json(fixture));
  await pendiente;
  assert.equal(carga.estado, "ok");
});

test("fallo permite reintentar y una nueva sesión vuelve a solicitar el archivo", async (t) => {
  const respuestas = [new Response(null, { status: 503 }), Response.json(fixture), Response.json(fixture)];
  const fetch = t.mock.method(globalThis, "fetch", async () => respuestas.shift()!);
  let carga: CargaTransporteDemo = { datos: null, estado: "cargando" };
  const publicar = (c: CargaTransporteDemo) => { carga = c; };
  await cargarTransporteDemo(publicar);
  assert.equal(carga.estado, "error");
  assert.match(pintar(carga), /No se pudo consultar/);
  assert.match(pintar(carga), /Reintentar/);
  assert.doesNotMatch(pintar(carga), /Sin paraderos expuestos/);
  await cargarTransporteDemo(publicar);
  assert.equal(carga.estado, "ok");
  assert.equal(carga.datos?.expuestos.length, 1);
  assert.match(pintar(carga), /PC1064/);
  await cargarTransporteDemo(publicar);
  assert.equal(fetch.mock.callCount(), 3);
});

test("solo una respuesta válida vacía muestra Sin paraderos expuestos", async (t) => {
  const vacio = { ...fixture, expuestos: [], en_riesgo: [] };
  t.mock.method(globalThis, "fetch", async () => Response.json(vacio));
  let carga: CargaTransporteDemo = { datos: null, estado: "cargando" };
  await cargarTransporteDemo((c) => { carga = c; });
  assert.equal(carga.estado, "ok");
  assert.match(pintar(carga), /Sin paraderos expuestos/);
});

test("errores de red, JSON y respuesta inválida no se presentan como vacíos", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (): Promise<Response> => { throw new Error("sin red"); });
  for (const respuesta of [null, new Response("no JSON"), Response.json({})]) {
    if (respuesta) fetch.mock.mockImplementation(async () => respuesta);
    let carga: CargaTransporteDemo = { datos: null, estado: "cargando" };
    await cargarTransporteDemo((c) => { carga = c; });
    assert.equal(carga.estado, "error");
    assert.doesNotMatch(pintar(carga), /Sin paraderos expuestos/);
  }
});

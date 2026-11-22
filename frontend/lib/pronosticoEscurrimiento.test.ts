import assert from "node:assert/strict";
import { test } from "node:test";
import { pronosticoEscurrimiento } from "./flujo/pronostico.ts";

const climaCon = (lluvia: number | null, vigente = true) => ({ lluvia_pronosticada_prox_24h_mm: lluvia, vigente });

test("sin datos de pronóstico no se afirma que no hay lluvia", () => {
  for (const datos of [null, climaCon(null)]) {
    const pronostico = pronosticoEscurrimiento({ datos, estado: "ok" });
    assert.equal(pronostico.mmh, null);
    assert.match(pronostico.texto, /Pronóstico no disponible/);
    assert.doesNotMatch(pronostico.texto, /Sin lluvia/);
  }
});

test("un error no presenta el pronóstico anterior como vigente", () => {
  for (const clima of [
    { datos: climaCon(0), estado: "error" },
    { datos: climaCon(12, false), estado: "ok" },
  ] as const) {
    const pronostico = pronosticoEscurrimiento(clima);
    assert.equal(pronostico.mmh, null);
    assert.match(pronostico.texto, /Pronóstico no disponible/);
  }
});

test("mientras se consulta el pronóstico aún no hay un valor de lluvia", () => {
  const pronostico = pronosticoEscurrimiento({ datos: null, estado: "cargando" });
  assert.equal(pronostico.mmh, null);
  assert.match(pronostico.texto, /Consultando pronóstico/);
});

test("un pronóstico vigente se describe como promedio de las próximas 24 h", () => {
  const pronostico = pronosticoEscurrimiento({ datos: climaCon(12), estado: "ok" });
  assert.equal(pronostico.mmh, 0.5);
  assert.match(pronostico.texto, /promedio pronosticado para las próximas 24 h/);
});

test("solo un pronóstico de cero indica que no se espera lluvia", () => {
  const seco = pronosticoEscurrimiento({ datos: climaCon(0), estado: "ok" });
  assert.equal(seco.mmh, 0);
  assert.match(seco.texto, /Sin lluvia pronosticada para las próximas 24 h/);
  const leve = pronosticoEscurrimiento({ datos: climaCon(1.2), estado: "ok" });
  assert.doesNotMatch(leve.texto, /Sin lluvia/);
});

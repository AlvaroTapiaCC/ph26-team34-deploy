import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { datosDemo, DEMO_SUMIDERO, DURACION_DEMO, PASOS_DEMO, pasoDemo } from "./demo.ts";

test("el guion pasa de #4 a #1 antes de cambiar la propuesta de ruta", () => {
  const antes = datosDemo(0);
  const foto = datosDemo(1);
  const despacho = datosDemo(2);
  assert.equal(antes.durante[3].sumidero_id, DEMO_SUMIDERO);
  assert.equal(foto.durante[0].sumidero_id, DEMO_SUMIDERO);
  assert.equal(foto.observaciones[0].prioridad?.antes?.rank, 4);
  assert.equal(foto.observaciones[0].prioridad?.despues?.rank, 1);
  assert.deepEqual(foto.ruta, antes.ruta);
  assert.equal(despacho.ruta.misiones[0].sumidero_id, DEMO_SUMIDERO);
  assert.equal(despacho.observaciones[0].despachos?.[0].siguiente_despues, despacho.ruta.misiones[0].nombre);
});

test("la exposición aparece con el agua y el alternativo sigue al expuesto en el mismo servicio/sentido GTFS", () => {
  assert.equal(datosDemo(2).transporte.expuestos.length, 0);
  const { transporte } = datosDemo(3);
  const p = transporte.expuestos[0];
  assert.equal(transporte.evidencia_agua?.[0].sumidero_id, p.causa.sumidero_id);
  const s = p.servicios[0];
  const gtfs = JSON.parse(readFileSync(new URL("../../backend/data/transporte_mut.json", import.meta.url), "utf8"));
  const recorrido = gtfs.recorridos.find((r: { servicio: string; sentido: string }) => r.servicio === s.servicio && r.sentido === s.sentido);
  assert.equal(recorrido.paraderos[recorrido.paraderos.indexOf(p.id) + 1], s.alternativo?.id);
  const alternativo = gtfs.paraderos.find((a: { id: string }) => a.id === s.alternativo?.id);
  assert.ok(Math.abs(alternativo.lon - s.alternativo!.lon) < 0.000001);
  assert.ok(Math.abs(alternativo.lat - s.alternativo!.lat) < 0.000001);
});

test("el detalle de la foto conserva su evidencia y la descomposición del puntaje", () => {
  const { durante, observaciones } = datosDemo(1);
  const p = durante.find((r) => r.sumidero_id === DEMO_SUMIDERO)!;
  assert.equal(p.detalle?.fuente_p, "foto");
  assert.equal(p.p_ef, p.p_obs);
  assert.ok(p.c != null);
  assert.equal(p.prioridad, p.p_ef! * p.c!);
  assert.equal(observaciones[0].prioridad?.despues?.prioridad, p.prioridad);
});

test("repetir produce el mismo escenario sin contaminar el ranking inicial", () => {
  const inicial = JSON.stringify(datosDemo(0));
  for (let i = 0; i < PASOS_DEMO.length; i++) {
    const d = datosDemo(i);
    assert.ok(d.durante.every((p) => p.is_simulated));
    assert.ok(d.observaciones.every((o) => o.is_simulated));
    assert.equal(pasoDemo(PASOS_DEMO[i].segundo), i);
  }
  assert.equal(JSON.stringify(datosDemo(0)), inicial);
  assert.equal(pasoDemo(DURACION_DEMO), PASOS_DEMO.length - 1);
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Los módulos del worker usan la resolución de Next (extensiones implícitas y JSON).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (existsSync(new URL(url.href + ".ts"))) specifier += ".ts";
      if (specifier.endsWith(".json")) return { ...next(specifier, context), importAttributes: { type: "json" } };
    }
    return next(specifier, context);
  },
});

const { crearSimulador } = await import("./flujo/simulador.ts");
type Foto = import("./flujo/simulador.ts").Foto;

test("conserva el flujo de cada fuente y descarta la caché al cambiar escenario o puntos", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let ahora = 0;
  t.mock.method(performance, "now", () => ahora);
  let foto: Foto | undefined;
  const sim = crearSimulador((m) => { if (m.tipo === "foto") foto = m; });
  const ultima = () => { assert.ok(foto); return foto; };
  const avanzar = () => { ahora += 1000; t.mock.timers.tick(1000); };
  try {
    sim.manejar({ tipo: "red", totalTramos: 1, totalSumideros: 0 });
    sim.manejar({ tipo: "fuente", id: "reportes" });
    assert.equal(foto, undefined, "sin teselas no hay foto");
    sim.manejar({ tipo: "tesela", clave: "0", texto: JSON.stringify({ t: [[0, 100, 0.02, 2000, 2000, null, null, [0, 0, 10, 0]]], s: [], calles: [], comunas: [] }) });
    sim.manejar({ tipo: "reloj", corriendo: true, velocidad: 10 });
    avanzar();
    const real = ultima();
    sim.manejar({ tipo: "fuente", id: "simulada" });
    assert.equal(ultima().t, 0);
    avanzar();
    avanzar();
    const simulada = ultima();
    assert.ok(simulada.t > real.t);
    sim.manejar({ tipo: "fuente", id: "reportes" });
    assert.equal(ultima().t, real.t);
    assert.deepEqual(ultima().agua, real.agua);
    sim.manejar({ tipo: "fuente", id: "simulada" });
    assert.equal(ultima().t, simulada.t);
    assert.deepEqual(ultima().agua, simulada.agua);
    sim.manejar({ tipo: "escenario", scenario: "base", intensidadMmH: 20 });
    sim.manejar({ tipo: "fuente", id: "reportes" });
    assert.equal(ultima().t, 0, "otro escenario no reutiliza el flujo anterior");
    avanzar();
    sim.manejar({ tipo: "puntos", puntos: [] });
    sim.manejar({ tipo: "fuente", id: "simulada" });
    assert.equal(ultima().t, 0, "otra asociación no reutiliza el flujo anterior");
  } finally {
    sim.detener();
  }
});

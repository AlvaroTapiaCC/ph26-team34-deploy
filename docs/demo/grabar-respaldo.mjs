// Graba el video de respaldo de la demo (issue #48) con respuestas de API controladas.
//
// Uso, desde la raíz del repositorio:
//   cd frontend && NEXT_PUBLIC_API_URL=http://localhost:8799 npx next build && npx next start -p 3138
//   # en otra terminal, con Playwright disponible (`npm i --no-save playwright@1.62.1`):
//   node docs/demo/grabar-respaldo.mjs
//
// La web no habla con ninguna API real: Playwright intercepta cada llamada a localhost:8799 y
// responde con un escenario de ensayo que avanza por fases (antes → foto → agua → cierre). Los
// nombres, puntajes y horas son ilustrativos y cada escena lleva el rótulo «Secuencia reproducida».
// Los puntajes siguen la lógica del backend: el cierre verificado entra como foto de rejilla
// limpia, resuelve el caso y recalcula, pero el agua vigente del tramo se mantiene.
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB = process.env.DRENA_WEB ?? "http://localhost:3138";
const API = process.env.DRENA_API ?? "http://localhost:8799";
const AQUI = dirname(fileURLToPath(import.meta.url));
const SALIDA = join(AQUI, "drena-demo-reproducida.webm");
const TAMANO = { width: 1280, height: 800 };

// --- Escenario de ensayo -------------------------------------------------------------------
// Hora de Santiago (UTC−3 en noviembre) del 21 de noviembre de 2026, guardada en UTC.
const hora = (hhmmss) => new Date(`2026-11-21T${hhmmss}-03:00`).toISOString();
const UNO = { id: "a", interseccion: "providencia-calle-uno", nombre: "Calle Uno", lat: -33.4183, lon: -70.6043 };
const DOS = { id: "b", interseccion: "las-condes-calle-dos", nombre: "Calle Dos", lat: -33.4168, lon: -70.6002 };
const CUADRILLA = { id: "c1", nombre: "Cuadrilla 1", equipamiento: ["hidrojet", "manual"], estado: "activa", is_simulated: true, carga: 2, lat: -33.4197, lon: -70.6082 };
const PARADERO = { id: "PC-ENSAYO", nombre: "Paradero MUT", lat: -33.4172, lon: -70.6006 };
const ALTERNATIVO = { id: "PC-ALT", nombre: "Parada Los Leones", lat: -33.4182, lon: -70.6029 };

let fase = "antes"; // antes | foto | agua | cierre

function fila(p, rank, prioridad) {
  return {
    rank, sumidero_id: p.id, p_pred: null, p_obs: null, p_ef: null, c: null, prioridad,
    explicacion: null, detalle: {}, computed_at: hora("21:20:00"),
    intersection_id: p.interseccion, intersection_nombre: p.nombre, street_id: null, is_simulated: true, lat: p.lat, lon: p.lon,
  };
}

function ranking(modo) {
  if (modo === "antes" || fase === "antes") return [fila(UNO, 1, 0.5), fila(DOS, 2, 0.2)];
  if (fase === "cierre") return [fila(UNO, 1, 0.5), fila(DOS, 2, 0.3)];
  return [fila(DOS, 1, 0.8), fila(UNO, 2, 0.5)];
}

const puntaje = (prioridad) => ({ scenario_id: "base", rank: null, prioridad });

// El backend arma `caso_publico` y `urgente` en vivo desde el caso. Solo un texto con personas en
// riesgo lo vuelve urgente, así que estas fotos no lo son. El cierre resuelve el caso, y la foto de
// cierre, que llega después, ya no queda asociada a él.
const caso = () => ({ estado: fase === "cierre" ? "resuelto" : "abierto", lat: DOS.lat, lon: DOS.lon });
const OBS_FOTO = {
  id: "obs-foto", sumidero_id: DOS.id, caso_id: "caso-1",
  ts: hora("21:20:00"), fuente: "vecino", tipo: "foto_rejilla", is_simulated: true, urgente: false,
  clasificacion: { evaluable: true, rejilla: "tapada", material: ["hojas"], nivel_agua: "sin_agua", confianza: "alta" },
  prioridad: { antes: puntaje(0.2), despues: puntaje(0.8) },
  despachos: [{ crew_id: CUADRILLA.id, cuadrilla: CUADRILLA.nombre, is_simulated: true, hora: hora("21:20:14"), siguiente_antes: UNO.nombre, siguiente_despues: DOS.nombre }],
};
const OBS_AGUA = {
  id: "obs-agua", sumidero_id: DOS.id, caso_id: "caso-1",
  ts: hora("21:21:00"), fuente: "vecino", tipo: "foto_agua", is_simulated: true, urgente: false,
  clasificacion: { evaluable: true, nivel_agua: "cuneta", confianza: "media" },
  prioridad: { antes: puntaje(0.8), despues: puntaje(0.8) }, despachos: [],
};
const OBS_CIERRE = {
  id: "obs-cierre", sumidero_id: DOS.id, caso_id: null, caso_publico: null,
  ts: hora("21:22:00"), fuente: "cuadrilla", tipo: "foto_rejilla", is_simulated: true, urgente: null,
  clasificacion: { evaluable: true, rejilla: "limpia", material: [], nivel_agua: "sin_agua", confianza: "alta" },
  prioridad: { antes: puntaje(0.8), despues: puntaje(0.3) },
  despachos: [{ crew_id: CUADRILLA.id, cuadrilla: CUADRILLA.nombre, is_simulated: true, hora: hora("21:22:05"), siguiente_antes: DOS.nombre, siguiente_despues: UNO.nombre }],
};

function observaciones() {
  const delCaso = (o) => ({ ...o, caso_publico: caso() });
  return { antes: [], foto: [delCaso(OBS_FOTO)], agua: [OBS_AGUA, OBS_FOTO].map(delCaso), cierre: [OBS_CIERRE, ...[OBS_AGUA, OBS_FOTO].map(delCaso)] }[fase];
}

function mision(p, estado = "pendiente") {
  return { mission_id: `m-${p.id}`, orden: null, estado, sumidero_id: p.id, case_id: null, nombre: p.nombre, lat: p.lat, lon: p.lon };
}

function ruta() {
  const orden = fase === "antes" || fase === "cierre" ? [UNO, DOS] : [DOS, UNO];
  const paradas = fase === "cierre" ? [UNO] : orden;
  return {
    crew_id: CUADRILLA.id, origen: "despacho", version: 1,
    misiones: paradas.map((p) => mision(p)),
    geojson: { type: "LineString", coordinates: [[CUADRILLA.lon, CUADRILLA.lat], ...paradas.map((p) => [p.lon, p.lat])] },
    ultimo_cierre: fase === "cierre"
      ? { mission_id: `m-${DOS.id}`, sumidero_id: DOS.id, nombre: DOS.nombre, hora: hora("21:22:00"), verificado: true, rejilla: "limpia", confianza: "alta" }
      : null,
  };
}

function expuestos() {
  const base = {
    scenario_id: "base", calculado_at: hora({ antes: "21:19:30", foto: "21:20:15", agua: "21:21:05", cierre: "21:22:05" }[fase]), nota: "Escenario de ensayo · datos simulados", aviso: null,
    fuente: { nombre: "GTFS DTPM", url: null, fecha_descarga: null },
    parametros: { radio_m: 50, aguas_abajo_m: 150, riesgo_top_n: 5, vigencia_agua_horas: 6 },
    expuestos: [], en_riesgo: [],
  };
  if (fase === "agua" || fase === "cierre") {
    base.expuestos = [{
      ...PARADERO, nivel: "expuesto",
      causa: { observation_id: OBS_AGUA.id, sumidero_observado: DOS.id, sumidero_id: DOS.id, nivel: "cuneta", ts: OBS_AGUA.ts, tipo: "foto_agua", fuente: "vecino", is_simulated: true, via: "observado", calle_abajo_m: 0, distancia_m: 34 },
      servicios: [{ servicio: "401", sentido: "I", destino: "Centro", motivo: null,
        alternativo: { ...ALTERNATIVO, en_secuencia: "siguiente", distancia_m: 240, en_riesgo: false } }],
    }];
  }
  return base;
}

async function responder(route) {
  const req = route.request();
  const url = new URL(req.url());
  const ruta_ = url.pathname;
  const json = (cuerpo, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(cuerpo) });
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  if (ruta_ === "/scenarios") return json([{ id: "base", nombre: "Escenario de ensayo", descripcion: "Datos simulados para la grabación de respaldo", parametros: {} }]);
  if (ruta_ === "/scenarios/base/ranking") {
    const modo = url.searchParams.get("modo") ?? "antes";
    return json({ scenario_id: "base", modo, items: ranking(modo) });
  }
  if (ruta_ === "/observations" && req.method() === "GET") return json({ items: observaciones() });
  if (ruta_ === "/observations" && req.method() === "POST") return json({ id: "obs-foto", duplicada: false });
  if (ruta_ === "/crews") return json([CUADRILLA]);
  if (ruta_ === `/crews/${CUADRILLA.id}/route`) return json(ruta());
  if (ruta_ === "/transporte/expuestos") return json(expuestos());
  if (ruta_ === "/clasificar/rejilla") {
    await new Promise((r) => setTimeout(r, 1200));
    return json({ claude_disponible: true, clasificacion: { evaluable: true, rejilla: "tapada", material: ["hojas"], hojas_calzada: "muchas", agua_visible: false, nivel_agua: "sin_agua", confianza: "alta", nota: "Hojas cubren la mayor parte de las ranuras." } });
  }
  return json({ detail: "Sin dato en la grabación de ensayo" }, 404);
}

// --- Rótulos en pantalla -------------------------------------------------------------------
async function rotulo(page, texto) {
  await page.evaluate((t) => {
    let el = document.getElementById("rotulo-ensayo");
    if (!el) {
      el = document.createElement("div");
      el.id = "rotulo-ensayo";
      Object.assign(el.style, {
        position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", zIndex: "99999", maxWidth: "640px",
        padding: "8px 16px", borderRadius: "6px", background: "#162236", color: "#fff", textAlign: "center",
        font: "500 16px/1.35 system-ui, sans-serif", boxShadow: "0 4px 14px rgba(0,0,0,.25)", pointerEvents: "none",
      });
      document.body.appendChild(el);
    }
    el.textContent = `Secuencia reproducida · ${t}`;
  }, texto);
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// Maqueta de la foto (rejilla con hojas), rotulada como material preparado.
async function maqueta(browser, archivo) {
  const p = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const barras = Array.from({ length: 9 }, (_, i) => `<rect x="${170 + i * 64}" y="250" width="30" height="430" rx="6" fill="#1d1d1d"/>`).join("");
  const hojas = Array.from({ length: 60 }, (_, i) => {
    const x = 160 + ((i * 97) % 600), y = 270 + ((i * 61) % 400), r = (i * 37) % 180;
    const c = ["#8a5a24", "#a8742c", "#6f7a2a", "#9b4f1d"][i % 4];
    return `<ellipse cx="${x}" cy="${y}" rx="46" ry="20" fill="${c}" transform="rotate(${r} ${x} ${y})" opacity=".95"/>`;
  }).join("");
  await p.setContent(`<body style="margin:0;background:#6f6a64"><svg width="900" height="900">
    <rect x="140" y="230" width="620" height="470" rx="14" fill="#3b3b3b"/>${barras}${hojas}
    <rect x="285" y="160" width="330" height="44" rx="8" fill="rgba(0,0,0,.6)"/>
    <text x="301" y="190" fill="#fff" font-family="system-ui" font-size="22">Maqueta · foto preparada</text></svg></body>`);
  await p.screenshot({ path: archivo });
  await p.close();
}

// --- Secuencia -----------------------------------------------------------------------------
async function main() {
  const tmp = join(AQUI, ".grabacion");
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.DRENA_CHROME || undefined });
  const foto = join(tmp, "maqueta-rejilla.png");
  await maqueta(browser, foto);

  const context = await browser.newContext({
    viewport: TAMANO, deviceScaleFactor: 1, locale: "es-CL", timezoneId: "America/Santiago",
    geolocation: { latitude: DOS.lat, longitude: DOS.lon, accuracy: 8 }, permissions: ["geolocation"],
    recordVideo: { dir: tmp, size: TAMANO },
  });
  await context.route(`${API}/**`, responder);
  const page = await context.newPage();

  // Antes: ranking inicial
  await page.goto(`${WEB}/`);
  await page.getByText("Calle Uno").first().waitFor();
  const saltar = page.getByRole("button", { name: "Saltar" });
  if (await saltar.isVisible({ timeout: 3000 }).catch(() => false)) await saltar.click();
  await rotulo(page, "Antes · ranking inicial de ensayo");
  await pausa(5000);

  // Durante: la cuadrilla parte por Calle Uno
  await page.goto(`${WEB}/central/durante`);
  await page.getByRole("list", { name: "Paradas propuestas" }).getByText("Calle Uno").waitFor();
  await rotulo(page, "Durante · recorrido de la cuadrilla antes del reporte");
  await pausa(5000);

  // Durante: un vecino envía la foto de la rejilla
  await page.goto(`${WEB}/reportar`);
  await rotulo(page, "Durante · un vecino envía la foto de una rejilla");
  await page.getByRole("button", { name: "Foto de la rejilla" }).click();
  await pausa(1200);
  await page.locator('input[type="file"]').setInputFiles(foto);
  await page.getByRole("button", { name: "Enviar reporte" }).waitFor();
  await pausa(1500);
  await page.getByRole("button", { name: "Enviar reporte" }).click();
  await page.getByText("Listo, esto vimos").waitFor();
  fase = "foto";
  await pausa(3500);

  // Durante: la clasificación cambia la prioridad y la siguiente parada
  await page.goto(`${WEB}/central/durante`);
  await page.getByText(`${UNO.nombre} → ${DOS.nombre}`).waitFor();
  await page.getByRole("list", { name: "Paradas propuestas" }).locator("li").first().getByText(DOS.nombre).waitFor();
  await rotulo(page, "Durante · la clasificación cambia la prioridad y la próxima parada. Tiempo ilustrativo.");
  await pausa(6000);

  // Durante: el agua expone un paradero (actualización automática del tablero)
  fase = "agua";
  await page.getByRole("button", { name: /Paradero MUT/ }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: /Paradero MUT/ }).click();
  await page.getByText(`Alternativo · ${ALTERNATIVO.nombre}`).first().waitFor();
  await rotulo(page, "Durante · el agua expone un paradero. Drena muestra una alternativa.");
  await page.evaluate(() => window.scrollTo({ top: 260, behavior: "smooth" }));
  await pausa(1500);
  // La tarjeta de paraderos tiene alto máximo: bajar dentro de ella hasta el alternativo
  await page.evaluate(() => {
    const tarjeta = document.querySelector(".tp");
    const item = tarjeta?.querySelector(".tp__item");
    if (tarjeta && item) tarjeta.scrollTo({ top: item.offsetTop - tarjeta.offsetTop - 8, behavior: "smooth" });
  });
  await pausa(5000);

  // Después: cierre verificado y baja del puntaje de Calle Dos
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  fase = "cierre";
  await page.getByText("Cerrada y verificada").waitFor({ timeout: 15000 });
  await page.getByRole("region", { name: "Ranking de prioridad" }).getByText("0,3").waitFor();
  await rotulo(page, "Después · la foto de cierre confirma la rejilla limpia y baja el puntaje de Calle Dos");
  await pausa(3500);
  await page.evaluate(() => {
    const ranking = document.querySelector('[aria-label="Ranking de prioridad"]');
    // El fondo del ranking queda cerca del borde inferior; el cierre de la misión queda a la vista
    const y = ranking.getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 24;
    window.scrollTo({ top: y, behavior: "smooth" });
  });
  await pausa(7000);

  const video = page.video();
  await context.close();
  await browser.close();
  await copyFile(await video.path(), SALIDA);
  await rm(tmp, { recursive: true, force: true });
  console.log(`Video guardado en ${SALIDA}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

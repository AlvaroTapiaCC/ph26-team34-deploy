import type { Metadata } from "next";
import { leerCaso, type Caso } from "./evidencia";
import s from "../validacion/validacion.module.css";
import c from "./san-carlos.module.css";

export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Drena · Caso San Carlos",
  description: "Reconstrucción ilustrativa del 8 de octubre de 2026: antecedentes, pronóstico y prioridades de limpieza. No es validación de aluviones.",
};
const num = (n: number) => n.toLocaleString("es-CL", { maximumFractionDigits: 2 });
const fecha = (iso: string) => new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(new Date(iso));
const MODOS: Record<string, { nombre: string; color: string }> = {
  seco: { nombre: "Seco", color: "var(--text-3)" },
  tormenta_inminente: { nombre: "Tormenta inminente", color: "var(--aviso)" },
  durante: { nombre: "Durante", color: "var(--agua)" },
  despues: { nombre: "Después", color: "var(--principal)" },
  sin_dato: { nombre: "Sin dato", color: "var(--surface-3)" },
};

function Lluvia({ horas }: { horas: Caso["horas"] }) {
  const max = Math.max(1, ...horas.flatMap((h) => [h.lluvia_mm, h.lluvia_pronosticada_mm]));
  const x = (i: number) => 52 + i * 12;
  const y = (lluvia: number) => 238 - lluvia / max * 170;
  const evento = horas.findIndex((h) => h.hora_santiago.startsWith("2026-10-08T17:00"));
  return <>
    <div className={c.chartScroll} tabIndex={0} role="region" aria-label="Lluvia horaria y modos; desplazar para ver los tres días">
      <svg className={c.chart} viewBox="0 0 950 310" role="img" aria-labelledby="lluvia-titulo lluvia-desc">
        <title id="lluvia-titulo">Lluvia del 6 al 8 de octubre, hora de Santiago</title>
        <desc id="lluvia-desc">Barras de lluvia observada, línea discontinua del pronóstico emitido un día antes y banda de modo. El aluvión está marcado el 8 a las 17:00. Escala de cero a {num(max)} milímetros por hora.</desc>
        {[0, max / 2, max].map((v) => <g key={v}><line x1="48" x2="918" y1={y(v)} y2={y(v)} stroke="currentColor" opacity=".15" /><text x="42" y={y(v) + 4} textAnchor="end">{num(v)}</text></g>)}
        <text x="16" y="35">mm/h</text>
        {horas.map((h, i) => <g key={h.hora_utc}>
          <title>{fecha(h.hora_utc)}: {num(h.lluvia_mm)} mm; pronóstico {num(h.lluvia_pronosticada_mm)} mm; {MODOS[h.modo].nombre}</title>
          <rect x={x(i)} y="251" width="12" height="14" fill={MODOS[h.modo].color} />
          <rect x={x(i) + 2} y={y(h.lluvia_mm)} width="8" height={238 - y(h.lluvia_mm)} fill="var(--agua)" />
          {i % 12 === 0 && <text x={x(i)} y="289">{h.hora_santiago.slice(8, 10)} oct · {h.hora_santiago.slice(11, 16)}</text>}
        </g>)}
        <polyline points={horas.map((h, i) => `${x(i) + 6},${y(h.lluvia_pronosticada_mm)}`).join(" ")} fill="none" stroke="var(--aviso)" strokeWidth="2" strokeDasharray="5 3" />
        <line x1={x(evento) + 6} x2={x(evento) + 6} y1="45" y2="267" stroke="currentColor" strokeWidth="2" strokeDasharray="4" />
        <text x={x(evento) - 8} y="30" textAnchor="end">8 oct · 17:00 · aluvión</text>
      </svg>
    </div>
    <p className={s.muted}>Barras azules: observado · línea dorada discontinua: pronóstico previous_day1 · banda inferior: modo operativo.</p>
    <ul className={c.legend}>{Object.entries(MODOS).map(([k, m]) => <li key={k}><i style={{ background: m.color }} />{m.nombre}</li>)}</ul>
  </>;
}

export default async function SanCarlosPage() {
  const caso = await leerCaso();
  if (!caso) return <main className={s.validacion}><h1>Caso San Carlos</h1><p>Reconstrucción · datos reproducidos</p><p role="status">Evidencia no disponible o huella no verificada. No se muestran cifras sin respaldo.</p></main>;
  const flujo = caso.cobertura_flujo;
  return <main className={s.validacion}>
    <h1>Caso San Carlos</h1>
    <section className={s.hallazgo} aria-labelledby="anticipacion">
      <p className={s.etiqueta}>{caso.etiqueta} · 8 octubre 2026 · Las Condes</p>
      <h2 id="anticipacion">El pronóstico del 7 de octubre ya lo anticipaba</h2>
      <p>Anticipaba lluvia, no un aluvión. Drena habría entrado en <strong>tormenta inminente {num(caso.adelanto_horas)} h antes</strong> de las 17:00 del 8 de octubre.</p>
      <dl className={s.comparacion}>
        <div className={s.gana}><dt>Pronóstico previo · 8 oct</dt><dd>{num(caso.lluvia_8_oct.pronostico_mm)} mm</dd></div>
        <div><dt>Observado · 8 oct</dt><dd>{num(caso.lluvia_8_oct.observado_mm)} mm</dd></div>
        <div><dt>Anticipación · primera alerta del 7–8 oct</dt><dd>{num(caso.adelanto_horas)} h</dd></div>
      </dl>
      <p className={s.muted}>Centro del sector reproducido: {caso.lluvia_8_oct.centro_latlon.join(", ")}. Modo desde {fecha(caso.primera_tormenta_7_8_utc)} (Santiago). Total 6–8 oct: {num(caso.lluvia_6_8_mm)} mm.</p>
      <p className={s.muted}>La referencia en −33,40, −70,52 es {num(caso.referencia_otro_centro.pronostico_mm)} / {num(caso.referencia_otro_centro.observado_mm)} mm (pronóstico / observado). Es otra celda: no se usa para calcular estas prioridades.</p>
    </section>

    <section className={s.card} aria-labelledby="antecedentes">
      <p className={s.etiqueta}>{caso.etiqueta}</p><h2 id="antecedentes">El riesgo tenía antecedentes</h2>
      <p>Había advertencias y medidas programadas. Esta reconstrucción muestra cómo convertir esa información en una lista de atención; no demuestra que la limpieza hubiera evitado la emergencia.</p>
      <ol className={c.timeline}>{caso.antecedentes.map((a) => <li key={`${a.fecha}-${a.titulo}`}>
        <time dateTime={a.fecha}>{a.fecha.includes("T") ? fecha(a.fecha) : a.fecha}</time>
        <h3>{a.titulo}</h3><p>{a.detalle}</p><a href={a.fuente_url} target="_blank" rel="noreferrer">Fuente del antecedente ↗</a>
      </li>)}</ol>
    </section>

    <section className={s.card} aria-labelledby="serie">
      <p className={s.etiqueta}>{caso.etiqueta}</p><h2 id="serie">De la lluvia prevista al modo operativo</h2>
      <Lluvia horas={caso.horas} />
      <p className={s.muted}>Open-Meteo Historical Forecast (best_match) y Previous Runs (previous_day1), CC BY 4.0. Horas de Santiago. El umbral de tormenta inminente es 5 mm previstos en las próximas 24 h; «Durante» tiene precedencia si ya llueve. La primera alerta de toda la ventana 6–8 ocurrió {num(caso.adelanto_primera_tormenta_ventana_horas)} h antes, por un pulso previo.</p>
      <a href="https://open-meteo.com/en/docs/previous-runs-api" target="_blank" rel="noreferrer">Fuente y definición del pronóstico ↗</a>
    </section>

    <section className={s.card} aria-labelledby="misiones">
      <p className={s.etiqueta}>{caso.etiqueta}</p><h2 id="misiones">Misiones preventivas de todo el sector antes de la tormenta</h2>
      <p>Propuesta ilustrativa: 10 primeras prioridades del ranking B del sector completo a las {fecha(caso.primera_tormenta_7_8_utc)}. No son órdenes emitidas ni una ruta optimizada. No se restringen al eje del aluvión.</p>
      <div className={s.tabla} role="region" aria-label="Diez prioridades reconstruidas" tabIndex={0}><table>
        <thead><tr><th scope="col">Orden</th><th scope="col">ID SIALL</th><th scope="col">Calle</th><th scope="col">Prioridad</th><th scope="col">Relación con el flujo</th></tr></thead>
        <tbody>{caso.misiones.map((m) => <tr key={m.ID_IDE}><td>{m.rank}</td><th scope="row">{m.ID_IDE}</th><td>{m.calle}<small>{m.lat}, {m.lon}</small></td><td>{num(m.prioridad)}</td><td>{m.en_flujo ? <span className={c.tag}>En eje del flujo</span> : "Fuera del eje seleccionado"}</td></tr>)}</tbody>
      </table></div>
    </section>

    <section className={s.card} aria-labelledby="rejillas-eje">
      <p className={s.etiqueta}>{caso.etiqueta}</p><h2 id="rejillas-eje">Rejillas del eje del aluvión (General Blanche / Camino El Alba)</h2>
      <p>Las 8 rejillas mejor posicionadas del eje, filtradas del mismo ranking B a las {fecha(caso.primera_tormenta_7_8_utc)}. Conservan su posición en el sector completo: no se recalcula ni se altera el orden.</p>
      <div className={s.tabla} role="region" aria-label="Prioridades del eje del aluvión" tabIndex={0}><table>
        <thead><tr><th scope="col">Posición en el sector</th><th scope="col">ID SIALL</th><th scope="col">Calle</th><th scope="col">Prioridad</th><th scope="col">Percentil superior</th></tr></thead>
        <tbody>{caso.rejillas_eje.map((m) => <tr key={m.ID_IDE}><td>{m.rank} de {m.total_rankeado}</td><th scope="row">{m.ID_IDE}</th><td>{m.calle}<small>{m.lat}, {m.lon}</small></td><td>{num(m.prioridad)}</td><td><span className={c.tag}>top {m.top_porcentaje} %</span></td></tr>)}</tbody>
      </table></div>
      <p><strong>{flujo.flujo_en_top_20} de {flujo.total_flujo}</strong> rejillas del eje están en el 20 % superior ({flujo.corte_top_20} de {flujo.total_sumideros}). Al azar se esperarían <strong>{flujo.esperado_azar.toLocaleString("es-CL", { maximumFractionDigits: 1 })}</strong>.</p>
      <p className={s.muted}>Las etiquetas «top X %» redondean hacia arriba la posición dividida por el total del sector.</p>
      <p className={s.muted}>{flujo.metodo} No mide aciertos de predicción de aluviones.</p>
    </section>

    <section className={s.card} aria-labelledby="criticos">
      <p className={s.etiqueta}>{caso.etiqueta}</p><h2 id="criticos">SENAPRED ya clasificaba el eje con riesgo Alto</h2>
      <ul className={c.criticos}>{caso.puntos_criticos.map(({ properties: p }) => <li key={p.fid}><a href={p.fuente_url} target="_blank" rel="noreferrer">{p.lugar} ↗</a><small>Alto · {p.causa} · invierno 2026, previo al evento</small></li>)}</ul>
    </section>

    <section className={`${s.card} ${c.limites}`} aria-labelledby="limites"><p className={s.etiqueta}>{caso.etiqueta}</p><h2 id="limites">Qué demuestra y qué no</h2><ul>{caso.limites.map((l) => <li key={l}>{l}</li>)}</ul></section>
  </main>;
}

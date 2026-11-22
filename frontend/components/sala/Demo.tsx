"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { datosDemo, DEMO_SUMIDERO, HORAS_DEMO, PASOS_DEMO } from "@/lib/demo";
import { useSala } from "@/lib/sala";
import { urlGoogleMaps } from "@/lib/cuadrilla";
import s from "./sala.module.css";

export function BotonDemo() {
  const { demo } = useSala();
  const router = useRouter();
  if (demo.activo) return null;
  return <button type="button" className={s.btnSec} onClick={() => { demo.iniciar(); router.push("/central/antes"); }}>Ver demo <span aria-hidden>▶</span></button>;
}

export function GuionDemo() {
  const { demo, ruta } = useSala();
  const router = useRouter();
  if (!demo.activo) return null;
  const paso = PASOS_DEMO[demo.paso];
  const datos = datosDemo(demo.paso);
  const hora = datos.hora;
  const termino = demo.paso === PASOS_DEMO.length - 1;
  const actual = datos.durante.find((p) => p.sumidero_id === DEMO_SUMIDERO)!;
  const inicial = datos.inicial.find((p) => p.sumidero_id === DEMO_SUMIDERO)!;
  const previo = demo.paso === 2 ? datos.observaciones[0].prioridad?.antes?.rank : inicial.rank;
  const horas = HORAS_DEMO.filter((h) => h.hora_utc <= hora.hora_utc).slice(-24);
  const fecha = new Date(hora.hora_utc).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return <section className={s.demo} aria-label="Demo guiada">
    <div className={s.demoEncabezado}>
      <span className={s.chipSim}>San Carlos · reconstrucción</span>
      <span>Paso {demo.paso + 1} de {PASOS_DEMO.length}</span>
    </div>
    <div aria-live="polite" aria-atomic="true">
      <h2>{demo.paso + 1}. {paso.titulo}</h2>
      <p>{paso.texto}</p>
    </div>
    {demo.paso <= 1 && <div className={s.demoClima}>
      <strong>{fecha} · Santiago</strong>
      <span>Hora actual: {hora.lluvia_pronosticada_mm.toLocaleString("es-CL")} mm previstos / {hora.lluvia_mm.toLocaleString("es-CL")} mm históricos</span>
      <svg viewBox="0 0 240 34" role="img" aria-label="Lluvia histórica de las últimas 24 horas hasta el paso actual">
        {horas.map((h, i) => <g key={h.hora_utc}><rect x={i * 10} y={32 - h.lluvia_pronosticada_mm * 3} width="4" height={Math.max(.5, h.lluvia_pronosticada_mm * 3)} fill="var(--text-3)" /><rect x={i * 10 + 4} y={32 - h.lluvia_mm * 3} width="4" height={Math.max(.5, h.lluvia_mm * 3)} fill="var(--principal)" /></g>)}
      </svg>
      <small>Últimas 24 h · gris: previsto · calipso: histórico · Open-Meteo</small>
    </div>}
    {demo.paso <= 2 && <p>Camino El Alba: puesto #{previo} {demo.paso === 2 ? "antes de la foto" : "inicial"} → #{actual.rank} actual de {datos.durante.length} rejillas.</p>}
    {demo.paso === 2 && <figure className={s.demoFoto}>
      <Image src="/img/sumidero-thumb.jpg" alt="Foto de ejemplo de una rejilla; la clasificación de la demo está simulada" width={96} height={72} />
      <figcaption>Foto de ejemplo · no enviada a Claude<br />Clasificación simulada: tapada · hojas · confianza alta</figcaption>
    </figure>}
    {demo.paso === 3 && ruta && <a className={s.btnSec} href={urlGoogleMaps(ruta.misiones.flatMap((m) => m.lat != null && m.lon != null ? [{ lat: m.lat, lon: m.lon }] : []))} target="_blank" rel="noreferrer">Abrir ruta en Google Maps ↗</a>}
    <p className={s.demoNota}>Tú marcas el ritmo · sin escrituras a producción. Lluvia histórica; foto y agua simuladas. Fórmula aplicada retrospectivamente, no una predicción emitida en octubre.</p>
    <progress aria-label="Avance de la demo" max={PASOS_DEMO.length} value={demo.paso + 1} />
    <div className={s.demoControles}>
      <button type="button" className={s.btnSec} onClick={demo.anterior} disabled={demo.paso === 0}>Anterior</button>
      {!termino && <button type="button" className={s.btnSec} onClick={demo.siguiente}>Siguiente paso</button>}
      <button type="button" className={s.btnSec} onClick={demo.iniciar}>{termino ? "Repetir demo" : "Reiniciar"}</button>
      <button type="button" className={s.btnSec} onClick={() => { demo.salir(); router.push("/central/antes"); }}>Salir de demo</button>
    </div>
  </section>;
}

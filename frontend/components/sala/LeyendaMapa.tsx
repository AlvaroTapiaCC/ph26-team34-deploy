import { CATASTRO, useSala } from "@/lib/sala";
import { horaSantiago } from "@/lib/transporte";
import s from "./sala.module.css";

export type CapasMapa = { agua: boolean; calor: boolean; cadenas: boolean; transporte: boolean; limites: boolean; catastro: boolean; infra: boolean; colectores: boolean; criticos: boolean; reportes: boolean; ruta: boolean };

export default function LeyendaMapa({ capas, durante, nReportes, modoAgua }: { capas: CapasMapa; durante: boolean; nReportes: number; modoAgua: "real" | "simulada" }) {
  const { antes, durante: rankingDurante, clima, observaciones, transporte, ruta, cuadrilla } = useSala();
  const ranking = durante ? rankingDurante : antes;
  return (
    <details className={s.lecturaMapa} aria-label="Cómo leer el mapa">
      <summary className={s.lecturaResumen}>
        Guía
        {(capas.catastro || capas.calor) && <span className={s.lecturaEscala}>
          <span><i className={s.lgAlta} />Alta</span>
          <span><i className={s.lgMedia} />Media</span>
          <span><i className={s.lgBaja} />Baja</span>
        </span>}
      </summary>
      <div className={s.lecturaContenido}>
      {(capas.catastro || capas.calor) && <>
      <h2>Prioridad de limpieza</h2>
      <p>{ranking.estado === "cargando" ? "Consultando prioridades…" : `${ranking.filas.filter((p) => p.prioridad != null).length} rejillas priorizadas · ${ranking.estado === "error" ? "sin actualizar" : "zona MUT"}`}</p>
      <ul className={s.clavesMapa}>
        <li><i className={s.lgAlta} />Alta</li>
        <li><i className={s.lgMedia} />Media</li>
        <li><i className={s.lgBaja} />Baja</li>
      </ul>
      <p className={s.claveNota}>El color ordena la limpieza; no mide agua ni obstrucción.</p>
      </>}
      <ul className={s.clavesDetalle}>
        {capas.reportes && <li><i className={s.lgReporte} /><span>{observaciones.estado === "cargando" ? "Consultando reportes…" : `${nReportes} ${nReportes === 1 ? "lugar con reporte" : "lugares con reportes"}${observaciones.estado === "error" ? " · sin actualizar" : nReportes === 1 ? " reciente" : " recientes"}`} <small>≋ Agua · ⊠ Obstrucción · ✓ Despejada<br />! Por verificar · S Simulado<br />Toca un símbolo para ver fuente y hora.</small></span></li>}
        {capas.ruta && !!ruta?.geojson && <li><i className={s.lgRuta} /><span>Ruta de la cuadrilla{cuadrilla?.is_simulated ? " simulada" : ""}</span></li>}
        {capas.transporte && <>
          <li><b className={s.lgBus}>BUS ≋</b><span>Agua observada cerca</span></li>
          <li><b className={s.lgBus}>BUS !</b><span>Prioridad alta cerca, no agua confirmada</span></li>
          {!!transporte.datos?.expuestos.length && <li><b className={s.lgBus}>BUS ↪</b><span>Paradero alternativo propuesto</span></li>}
        </>}
        {capas.catastro && <li><i className={s.lgCatastro} /><span>Catastro de contexto, sin prioridad mostrada</span></li>}
        {capas.calor && <li><i className={s.lgAlta} /><span>Halo: concentración de prioridad, no inundación</span></li>}
        {capas.agua && <li><i className={s.lgAgua} /><span>Escurrimiento {modoAgua === "simulada" ? "simulado · lluvia supuesta" : "estimado · pronóstico y reportes"}</span></li>}
      </ul>
      <details className={s.fuentesMapa}>
        <summary>Capas y fuentes</summary>
        <p><b>Rejillas · SIALL / DOH.</b> Catastro parcial de {CATASTRO.total.toLocaleString("es-CL")} rejillas en tres comunas. Fuera del ranking no significa riesgo bajo.</p>
        <p><b>Prioridad calculada.</b> {ranking.estado === "error" ? "Consulta fallando; puede quedar el último dato recibido." : ranking.estado === "cargando" ? "Consultando API…" : "Ranking recibido desde la API."} Relativa al escenario: 10 % alta, siguiente 20 % media; si todos los puntajes coinciden, baja.</p>
        <p><b>Reportes.</b> {observaciones.estado === "error" ? "Consulta fallando; datos sin actualizar." : observaciones.estado === "cargando" ? "Consultando…" : "Conectados."} Último por lugar en 72 h, no un cierre vial confirmado. Cada reporte simulado lleva su rótulo.</p>
        <p><b>Open-Meteo.</b> {clima.datos ? `${clima.datos.vigente ? "Pronóstico disponible" : "Último pronóstico, sin actualizar"} · ${horaSantiago(clima.datos.hora_dato_utc)} Santiago.` : "Sin pronóstico disponible."} El escurrimiento es un modelo, no agua observada.</p>
        {capas.transporte && <p><b>GTFS · DTPM.</b> {transporte.estado === "error" ? "Exposición sin actualizar." : "Trazados y exposición calculada."} Las líneas no son desvíos: Red debe confirmarlos. Caminata punteada: conexión en línea recta, no ruta peatonal.</p>}
        {capas.infra && <p><b>OSM.</b> Metro, pasos bajo nivel, hospitales, colegios, ferias y obras. Contexto de la zona MUT, no incidentes activos.</p>}
        {capas.colectores && <p><b>Colectores · SIALL / DOH.</b> Red subterránea catalogada cerca del MUT; no muestra su capacidad ni estado actual.</p>}
        {capas.criticos && <p><b>Las Condes · invierno 2026.</b> Puntos críticos históricos, no anegamientos activos.</p>}
        {capas.cadenas && <p><b>Calles y elevación.</b> Flechas calle abajo: dirección de escurrimiento estimada, no desvíos de tránsito.</p>}
      </details>
      </div>
    </details>
  );
}

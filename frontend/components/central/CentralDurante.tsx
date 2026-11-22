"use client";

import Link from "next/link";
import * as Select from "@radix-ui/react-select";
import * as Tabs from "@radix-ui/react-tabs";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiRankingItem } from "@/lib/api";
import {
  ESCENARIO_CENTRAL,
  getObservaciones,
  getRankingDurante,
  getRankingInicial,
  useConsultaPeriodica,
  usePulso,
  type ObservacionPublica,
} from "@/lib/central";
import { getCuadrillas, getRuta, type Cuadrilla, type RutaCuadrilla } from "@/lib/cuadrilla";
import type { LngLat, Prioridad } from "@/lib/data";
import { boundsDe, prioDe } from "@/lib/real";
import { horaSantiago, NIVEL_AGUA, useExpuestos, useRecorridos, type EstadoConsulta, type EvidenciaAgua, type Expuestos } from "@/lib/transporte";
import Transporte, { capasTransporte } from "../desktop/Transporte";
import DrenaMap, { type MapLabel, type MapPin, type MapPunto } from "../map/DrenaMap";
import { precargarMapLibre } from "../map/maplibre";
import { Logo } from "../ui";
import { useCapaCadenas } from "./capaCadenas";
import styles from "./central.module.css";

// La central siempre lleva mapa: MapLibre se pide antes de montar el componente del mapa
if (typeof window !== "undefined") precargarMapLibre();

const ESTADO_REJILLA: Record<string, string> = {
  limpia: "Rejilla limpia",
  parcial: "Rejilla parcialmente tapada",
  tapada: "Rejilla tapada",
  no_evaluable: "Foto no evaluable",
};
const ESTADO_MISION = {
  pendiente: "Pendiente",
  en_camino: "En camino",
  en_sitio: "En sitio",
  cerrada: "Cerrada",
  cancelada: "Cancelada",
};
const TIPO_REPORTE: Record<string, string> = {
  foto_agua: "Foto de calle",
  foto_rejilla: "Foto de rejilla",
  cuadro_camara: "Cuadro de cámara",
  texto: "Reporte de texto",
};
const FORMATO_PUNTAJE = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const puntaje = (valor: number | null | undefined) => (valor == null ? "Sin dato" : FORMATO_PUNTAJE.format(valor));
const captura = (o: ObservacionPublica) => TIPO_REPORTE[o.tipo] ?? "Observación";
const NOMBRE_FUENTE: Record<string, string> = { ranking: "ranking", reportes: "reportes", cuadrillas: "cuadrillas", ruta: "ruta", paraderos: "paraderos" };
const TOP_NUMERADOS = 5; // pines con número; el resto del ranking va como puntos

const sinMovimiento = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function notaPublica(o: ObservacionPublica) {
  const c = o.clasificacion;
  if (!c) return "Pendiente de clasificación.";
  if (c.evaluable === false) return "La imagen no aporta evidencia evaluable.";
  const agua = c.nivel_agua ? NIVEL_AGUA[c.nivel_agua as keyof typeof NIVEL_AGUA] : undefined;
  if (c.personas_en_riesgo) return "El reporte indica personas en riesgo.";
  if (agua) return `La clasificación indica ${agua}.`;
  if (c.rejilla === "tapada" || c.rejilla === "parcial") {
    return c.material?.length ? `Se detectó una obstrucción con ${c.material.join(", ")}.` : "Se detectó una obstrucción.";
  }
  return c.rejilla === "limpia" ? "La rejilla se ve despejada." : "La clasificación quedó registrada.";
}

/* ── Barra superior: navegación, pulso y cuadrilla ─────────────────────────────────────────── */

function EnVivo() {
  const { ultimaOk, fallando } = usePulso();
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seg = ultimaOk == null ? null : Math.max(0, Math.round((ahora - ultimaOk) / 1000));
  const tono = fallando.length ? styles.pulsoError : seg == null ? styles.pulsoEspera : seg > 15 ? styles.pulsoLento : styles.pulsoOk;
  const texto = fallando.length
    ? `Sin conexión con ${fallando.map((f) => NOMBRE_FUENTE[f] ?? f).join(", ")} · reintentando`
    : seg == null
      ? "Conectando…"
      : seg < 2
        ? "Actualizado ahora"
        : `Actualizado hace ${seg} s`;
  return (
    <p className={`${styles.pulso} ${tono}`} role="status" aria-live="polite">
      <i aria-hidden />
      {texto}
    </p>
  );
}

function SelectorCuadrilla({ equipos, valor, onChange }: { equipos: Cuadrilla[]; valor: string; onChange: (id: string) => void }) {
  return (
    <Select.Root value={valor} onValueChange={onChange}>
      <Select.Trigger className={styles.selTrigger} aria-label="Cuadrilla que sigue la central">
        <Select.Value />
        <Select.Icon className={styles.selIcon}>▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className={styles.selContent} position="popper" sideOffset={6} align="end">
          <Select.Viewport>
            {equipos.map((c) => (
              <Select.Item key={c.id} value={c.id} className={styles.selItem}>
                <Select.ItemText>{c.nombre}</Select.ItemText>
                {c.is_simulated && <span className={styles.chipSim}>Simulada</span>}
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

/* ── Qué cambió ────────────────────────────────────────────────────────────────────────────── */

function QueCambio({ observacion, ranking, estado }: { observacion: ObservacionPublica | null; ranking: ApiRankingItem[]; estado: EstadoConsulta }) {
  const c = observacion?.clasificacion;
  const despachos = observacion?.despachos ?? [];
  const punto = ranking.find((r) => r.sumidero_id === observacion?.sumidero_id);
  const prioridad = observacion?.prioridad;
  const anterior = prioridad?.antes?.scenario_id === ESCENARIO_CENTRAL ? prioridad.antes : null;
  const actual = prioridad?.despues?.scenario_id === ESCENARIO_CENTRAL ? prioridad.despues : null;
  const delta = anterior?.prioridad != null && actual?.prioridad != null ? actual.prioridad - anterior.prioridad : null;

  // Una observación nueva (no la primera carga) se destaca una vez
  const idPrevio = useRef<string | null | undefined>(undefined);
  const [destacar, setDestacar] = useState(false);
  useEffect(() => {
    const id = observacion?.id ?? null;
    if (idPrevio.current !== undefined && id && id !== idPrevio.current) {
      setDestacar(true);
      const t = setTimeout(() => setDestacar(false), 2400);
      idPrevio.current = id;
      return () => clearTimeout(t);
    }
    idPrevio.current = id;
  }, [observacion?.id]);

  return (
    <section className={`${styles.cambio} ${destacar ? styles.cambioNuevo : ""}`} aria-label="Qué cambió" aria-live="polite">
      <header className={styles.cambioHead}>
        <h2>Qué cambió</h2>
        {observacion && (
          <span className={styles.meta}>
            {captura(observacion)}, {horaSantiago(observacion.ts, true)}
            {observacion.is_simulated && <span className={styles.chipSim}>Simulada</span>}
          </span>
        )}
      </header>
      {observacion ? (
        <>
          <h3 className={styles.cambioLugar}>{punto?.intersection_nombre ?? (observacion.sumidero_id ? `Sumidero ${observacion.sumidero_id}` : "Caso reportado")}</h3>
          {observacion.urgente && <p className={styles.urgenteBanda}>Caso urgente: personas en riesgo o agua sobre la vereda</p>}
          <p className={styles.lectura}>
            <b>Claude:</b> {c?.rejilla ? (ESTADO_REJILLA[c.rejilla] ?? "Clasificada") : c ? "Clasificada" : "Pendiente"}
            {c?.material?.length ? ` · ${c.material.join(", ")}` : ""} · confianza {c?.confianza ?? "sin dato"}. {notaPublica(observacion)}
          </p>
          <div className={styles.flechas}>
            <div className={styles.flecha}>
              <span className={styles.flechaT}>Puntaje de prioridad</span>
              {anterior || actual ? (
                <span className={styles.flechaV}>
                  <span>{puntaje(anterior?.prioridad)}</span>
                  <span aria-hidden className={styles.flechaSigno}>→</span>
                  <b>{puntaje(actual?.prioridad)}</b>
                  {delta != null && delta !== 0 && <span className={delta > 0 ? styles.sube : styles.baja}>{delta > 0 ? "sube" : "baja"}</span>}
                </span>
              ) : (
                <span className={styles.flechaV}>Comparación sin registrar</span>
              )}
            </div>
            {despachos.map((cambio) => {
              const segundos = (Date.parse(cambio.hora) - Date.parse(observacion.ts)) / 1000;
              return (
                <div className={styles.flecha} key={cambio.crew_id}>
                  <span className={styles.flechaT}>
                    Siguiente parada de {cambio.cuadrilla}
                    {cambio.is_simulated && <span className={styles.chipSim}>Simulada</span>}
                  </span>
                  <span className={styles.flechaV}>
                    <span>{cambio.siguiente_antes ?? "Sin parada"}</span>
                    <span aria-hidden className={styles.flechaSigno}>→</span>
                    <b>{cambio.siguiente_despues ?? "Sin parada"}</b>
                  </span>
                  <span className={styles.meta}>
                    Propuesta a las {horaSantiago(cambio.hora, true)} · {Number.isFinite(segundos) && segundos >= 0 ? `${Math.round(segundos)} s desde la captura` : "tiempo sin dato"}
                  </span>
                </div>
              );
            })}
          </div>
          {despachos.length === 0 && <p className={styles.hint}>Este reporte no cambió la siguiente parada de ninguna cuadrilla.</p>}
          {actual && punto?.prioridad === actual.prioridad && punto.explicacion && <p className={styles.hint}>{punto.explicacion}</p>}
        </>
      ) : estado === "cargando" ? (
        <div className={styles.skelBloque} aria-hidden>
          <span className={styles.skel} style={{ width: "60%" }} />
          <span className={styles.skel} style={{ width: "90%" }} />
          <span className={styles.skel} style={{ width: "75%" }} />
        </div>
      ) : (
        <p className={styles.vacio}>
          Esperando el primer reporte. Cuando un vecino envíe una foto desde <Link href="/reportar">/reportar</Link>, aquí verás cómo cambian el puntaje y la siguiente parada.
        </p>
      )}
    </section>
  );
}

/* ── Ranking con movimiento (FLIP): una fila que sube de puesto se desliza a su lugar ───────── */

type Fila = ApiRankingItem & { puesto: number; prio: Prioridad };

function useFlip(lista: React.RefObject<HTMLOListElement | null>, claves: string) {
  const posiciones = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const ol = lista.current;
    if (!ol) return;
    const nuevas = new Map<string, number>();
    const items = Array.from(ol.querySelectorAll<HTMLElement>("[data-k]"));
    for (const el of items) nuevas.set(el.dataset.k!, el.offsetTop);
    if (!sinMovimiento()) {
      for (const el of items) {
        const antes = posiciones.current.get(el.dataset.k!);
        const ahora = nuevas.get(el.dataset.k!)!;
        if (antes == null || antes === ahora) continue;
        el.style.transition = "none";
        el.style.transform = `translateY(${antes - ahora}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 280ms var(--ease-out)";
          el.style.transform = "";
        });
      }
    }
    posiciones.current = nuevas;
  }, [lista, claves]);
}

function Ranking({ filas, estado, sel, onSel }: { filas: Fila[]; estado: EstadoConsulta; sel: string | null; onSel: (id: string) => void }) {
  const ref = useRef<HTMLOListElement>(null);
  const claves = filas.map((f) => f.sumidero_id).join("|");
  useFlip(ref, claves);
  // Puestos previos para marcar lo que subió (la marca dura unos segundos)
  const previos = useRef<Map<string, number> | null>(null);
  const [subidas, setSubidas] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    const actual = new Map(filas.map((f) => [f.sumidero_id, f.puesto]));
    if (previos.current) {
      const s = new Map<string, number>();
      for (const [id, p] of actual) {
        const antes = previos.current.get(id);
        if (antes != null && antes > p) s.set(id, antes - p);
      }
      if (s.size) {
        setSubidas(s);
        const t = setTimeout(() => setSubidas(new Map()), 8000);
        previos.current = actual;
        return () => clearTimeout(t);
      }
    }
    previos.current = actual;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claves]);
  // La fila elegida en el mapa se trae a la vista
  useEffect(() => {
    if (!sel) return;
    ref.current?.querySelector(`[data-k="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest", behavior: sinMovimiento() ? "auto" : "smooth" });
  }, [sel]);

  const max = Math.max(...filas.map((f) => f.prioridad ?? 0), 0);
  if (!filas.length) {
    if (estado === "cargando")
      return (
        <div className={styles.skelLista} aria-label="Cargando ranking">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className={styles.skel} style={{ height: 44 }} />
          ))}
        </div>
      );
    return <p className={styles.vacio}>{estado === "error" ? "No se pudo leer el ranking. Se reintenta solo cada 3 s." : "Sin puntajes calculados para la zona."}</p>;
  }
  return (
    <>
      <div className={styles.rankCab} aria-hidden>
        <span>Puesto</span>
        <span>Rejilla</span>
        <span>Puntaje</span>
      </div>
      <ol className={styles.ranking} ref={ref} aria-label="Ranking de prioridad de limpieza">
        {filas.map((p) => {
          const subio = subidas.get(p.sumidero_id);
          return (
            <li key={p.sumidero_id} data-k={p.sumidero_id}>
              <button
                type="button"
                className={`${styles.fila} ${sel === p.sumidero_id ? styles.filaSel : ""} ${subio ? styles.filaSube : ""}`}
                onClick={() => onSel(p.sumidero_id)}
                aria-pressed={sel === p.sumidero_id}
              >
                <span className={`${styles.puesto} ${styles["p_" + p.prio]}`}>{p.puesto}</span>
                <span className={styles.filaTxt}>
                  <span className={styles.filaNombre}>{p.intersection_nombre ?? `Sumidero ${p.sumidero_id}`}</span>
                  <span className={styles.filaMeta}>
                    <code>{p.sumidero_id}</code>
                    {p.detalle?.urgente && <span className={styles.chipUrgente}>Urgente</span>}
                    {p.is_simulated && <span className={styles.chipSim}>Simulado</span>}
                    {subio && <span className={styles.chipSube}>Subió {subio}</span>}
                  </span>
                </span>
                <span className={styles.filaPuntaje}>
                  <b>{puntaje(p.prioridad)}</b>
                  <span className={styles.medidor} aria-hidden>
                    <span style={{ transform: `scaleX(${max > 0 && p.prioridad != null ? p.prioridad / max : 0})` }} className={styles["b_" + p.prio]} />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className={styles.nota}>El puntaje ordena visitas; no es una probabilidad de inundación.</p>
    </>
  );
}

/* ── Misiones de la cuadrilla ──────────────────────────────────────────────────────────────── */

function Misiones({ cuadrilla, ruta, estado }: { cuadrilla: Cuadrilla; ruta: RutaCuadrilla | null; estado: EstadoConsulta }) {
  const cierre = ruta?.ultimo_cierre;
  return (
    <div className={styles.panel}>
      <p className={styles.hint}>
        Propuesta de Drena para {cuadrilla.nombre}
        {cuadrilla.is_simulated && <span className={styles.chipSim}>Cuadrilla simulada</span>}
      </p>
      {ruta?.misiones.length ? (
        <ol className={styles.paradas} aria-label="Paradas propuestas">
          {ruta.misiones.map((mision, i) => (
            <li key={mision.mission_id} className={i === 0 ? styles.paradaSiguiente : ""}>
              <span className={styles.paradaN}>{i + 1}</span>
              <span>
                <strong>{mision.nombre}</strong>
                <small>
                  {i === 0 ? "Siguiente · " : ""}
                  {ESTADO_MISION[mision.estado]}
                  {mision.sumidero_id ? ` · ${mision.sumidero_id}` : ""}
                </small>
              </span>
            </li>
          ))}
        </ol>
      ) : estado === "cargando" ? (
        <div className={styles.skelLista} aria-hidden>
          <span className={styles.skel} style={{ height: 48 }} />
          <span className={styles.skel} style={{ height: 48 }} />
        </div>
      ) : (
        <p className={styles.vacio}>{estado === "error" ? "No se pudo leer la ruta. Se reintenta solo." : "Sin paradas propuestas para esta cuadrilla."}</p>
      )}
      {cierre && (
        <div className={`${styles.cierre} ${cierre.verificado ? styles.cierreOk : ""}`}>
          <strong>{cierre.verificado ? "Cierre verificado con foto" : "Cerrada sin verificar"}</strong>
          <span>
            {cierre.nombre}
            {cierre.sumidero_id ? ` · ${cierre.sumidero_id}` : ""} · {horaSantiago(cierre.hora, true)}
          </span>
          <span>
            {cierre.rejilla ? (ESTADO_REJILLA[cierre.rejilla] ?? "Clasificación registrada") : "Clasificación no disponible"}
            {cierre.confianza ? ` · confianza ${cierre.confianza}` : ""}
          </span>
        </div>
      )}
      <Link className={styles.btnSec} href={`/cuadrilla?id=${encodeURIComponent(cuadrilla.id)}`} target="_blank">
        Abrir la vista del celular de esta cuadrilla
      </Link>
    </div>
  );
}

/* ── Mapa ──────────────────────────────────────────────────────────────────────────────────── */

const SIN_EVIDENCIA_AGUA: readonly EvidenciaAgua[] = [];

const MapaCentral = memo(function MapaCentral({
  filas,
  observaciones,
  evidenciaAgua,
  cuadrilla,
  ruta,
  transporte,
  paradero,
  onParadero,
  sel,
  onSel,
  vigenciaAguaH,
  alcanceAguaM,
}: {
  filas: Fila[];
  observaciones: ObservacionPublica[];
  evidenciaAgua: readonly EvidenciaAgua[];
  cuadrilla: Cuadrilla | null;
  ruta: RutaCuadrilla | null;
  transporte: Expuestos | null;
  paradero: string | null;
  onParadero: (id: string | null) => void;
  sel: string | null;
  onSel: (id: string) => void;
  vigenciaAguaH: number;
  alcanceAguaM: number;
}) {
  const [cadenasVisibles, setCadenasVisibles] = useState(true);
  const [leyenda, setLeyenda] = useState(true);
  const prioridades = useMemo(() => new Map(filas.flatMap((p) => (p.prioridad == null ? [] : [[p.sumidero_id, p.prio] as const]))), [filas]);
  const cadenas = useCapaCadenas(prioridades, observaciones, evidenciaAgua, cadenasVisibles, vigenciaAguaH, alcanceAguaM);
  const recorridos = useRecorridos(true);
  const tp = useMemo(() => capasTransporte(transporte, recorridos, paradero, onParadero), [transporte, recorridos, paradero, onParadero]);

  // Top 5 con número; el resto como puntos GL. La rejilla elegida siempre con pin y nombre.
  const { pins, puntos } = useMemo(() => {
    const pins: MapPin[] = [];
    const puntos: MapPunto[] = [];
    for (const p of filas) {
      if (p.puesto <= TOP_NUMERADOS || p.sumidero_id === sel) pins.push({ id: p.sumidero_id, coord: [p.lon, p.lat], rank: p.puesto, prio: p.prio, onClick: () => onSel(p.sumidero_id) });
      else puntos.push({ id: p.sumidero_id, coord: [p.lon, p.lat], prio: p.prio, nombre: p.intersection_nombre ?? undefined });
    }
    return { pins, puntos };
  }, [filas, sel, onSel]);

  const labels = useMemo(() => {
    const out: MapLabel[] = filas.filter((p) => p.detalle?.urgente).map((p) => ({ coord: [p.lon, p.lat] as LngLat, text: "Urgente", tone: "danger" as const, offset: [0, -24] as [number, number], anchor: "bottom" as const }));
    const vistos = new Set<string>();
    for (const o of observaciones) {
      const caso = o.caso_publico;
      if (!o.caso_id || vistos.has(o.caso_id) || !o.urgente || !caso || caso.estado === "resuelto" || caso.estado === "descartado") continue;
      if (filas.some((p) => p.detalle?.urgente && p.lon === caso.lon && p.lat === caso.lat)) continue;
      vistos.add(o.caso_id);
      out.push({ coord: [caso.lon, caso.lat], text: "Caso urgente", tone: "danger" });
    }
    if (cuadrilla?.is_simulated && cuadrilla.lon != null && cuadrilla.lat != null) out.push({ coord: [cuadrilla.lon, cuadrilla.lat], text: `${cuadrilla.nombre} (simulada)`, tone: "dark" });
    const elegido = filas.find((p) => p.sumidero_id === sel);
    if (elegido) out.push({ coord: [elegido.lon, elegido.lat], text: `${elegido.puesto} · ${elegido.intersection_nombre ?? elegido.sumidero_id}`, tone: "card" });
    return out;
  }, [filas, observaciones, cuadrilla, sel]);

  const elegidoCoord = useMemo((): LngLat | null => {
    const e = filas.find((p) => p.sumidero_id === sel);
    return e ? [e.lon, e.lat] : null;
  }, [filas, sel]);
  const lineas = useMemo(() => (ruta?.geojson?.type === "LineString" ? [ruta.geojson.coordinates as LngLat[]] : []), [ruta]);
  // Encuadre: solo las rejillas del ranking (estable; no salta cuando cambia una etiqueta)
  const claveEncuadre = filas.map((p) => p.sumidero_id).sort().join("|");
  const bounds = useMemo(() => boundsDe(filas.map((p) => ({ coord: [p.lon, p.lat] as LngLat }))), [claveEncuadre]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className={styles.mapa} aria-label="Mapa de la zona MUT">
      <DrenaMap
        bounds={bounds}
        padding={{ top: 64, bottom: 48, left: 40, right: 40 }}
        className={styles.mapaCanvas}
        pins={pins}
        puntos={puntos}
        onClickPunto={onSel}
        labels={labels}
        ruta={lineas}
        foco={elegidoCoord}
        pinSize={26}
        paraderos={tp.paraderos}
        recorridos={tp.recorridos}
        caminatas={tp.caminatas}
        onMapReady={cadenas.onMapReady}
        attribution="Mapa base © Esri, OpenStreetMap · Rejillas DOH · Paraderos DTPM"
        attributionSide="right"
      >
        <div className={styles.mapaBarra}>
          <span className={styles.mapaTitulo}>Zona MUT</span>
          <label className={styles.interruptor}>
            <input type="checkbox" checked={cadenasVisibles} onChange={(e) => setCadenasVisibles(e.target.checked)} />
            <span aria-hidden />
            Cadenas calle abajo (estimado)
          </label>
          {cadenasVisibles && cadenas.estado === "cargando" && <span className={styles.meta}>Cargando cadenas…</span>}
          {cadenasVisibles && cadenas.estado === "error" && <span className={styles.metaError}>Cadenas no disponibles</span>}
        </div>
        <div className={`${styles.leyenda} ${leyenda ? "" : styles.leyendaCerrada}`}>
          <button type="button" className={styles.leyendaBtn} onClick={() => setLeyenda(!leyenda)} aria-expanded={leyenda}>
            Leyenda
          </button>
          {leyenda && (
            <ul>
              <li><i className={styles.lgAlta} />Prioridad alta</li>
              <li><i className={styles.lgMedia} />Media</li>
              <li><i className={styles.lgBaja} />Baja</li>
              {lineas.length > 0 && <li><i className={styles.lgRuta} />Orden de visita (línea recta, no es el trazado por calle)</li>}
              {cadenasVisibles && cadenas.estado === "ok" && (
                <>
                  <li><i className={styles.lgCadena} />Revisar calle abajo</li>
                  <li><i className={styles.lgAgua} />Agua observada</li>
                </>
              )}
              {tp.paraderos.length > 0 && <li><i className={styles.lgBus} />Paradero expuesto</li>}
              {cadenas.haySimulados && <li className={styles.lgNota}>Incluye observaciones simuladas</li>}
            </ul>
          )}
        </div>
      </DrenaMap>
    </section>
  );
});

/* ── Página ────────────────────────────────────────────────────────────────────────────────── */

export default function CentralDurante() {
  const ranking = useConsultaPeriodica(getRankingDurante, "ranking");
  const esperaRankingDurante = ranking.estado === "ok" && ranking.datos?.items.length === 0;
  const rankingInicial = useConsultaPeriodica(esperaRankingDurante ? getRankingInicial : null, "ranking");
  const reportes = useConsultaPeriodica(getObservaciones, "reportes");
  const cuadrillas = useConsultaPeriodica(getCuadrillas, "cuadrillas");
  const [eleccion, setEleccion] = useState("");
  const [paradero, setParadero] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [pestana, setPestana] = useState("prioridad");
  const tp = useExpuestos(ESCENARIO_CENTRAL, true);
  const equipos = cuadrillas.datos ?? [];
  const cuadrilla = equipos.find((c) => c.id === eleccion) ?? equipos.find((c) => c.is_simulated) ?? equipos[0] ?? null;
  const idCuadrilla = cuadrilla?.id;
  const consultarRuta = useCallback(() => getRuta(idCuadrilla ?? ""), [idCuadrilla]);
  const consultaRuta = useConsultaPeriodica(cuadrilla ? consultarRuta : null, "ruta");
  const ruta = consultaRuta.datos?.crew_id === idCuadrilla ? consultaRuta.datos : null;
  const estadoRuta = consultaRuta.datos && !ruta && consultaRuta.estado !== "error" ? "cargando" : consultaRuta.estado;
  const items = (esperaRankingDurante ? rankingInicial.datos : ranking.datos)?.items;
  const filas = useMemo<Fila[]>(() => {
    const lista = items ?? [];
    const distintos = new Set(lista.flatMap((p) => (p.prioridad == null ? [] : [p.prioridad]))).size > 1;
    return lista.map((p, i) => ({ ...p, puesto: i + 1, prio: prioDe(i + 1, lista.length, distintos) }));
  }, [items]);
  const obs = reportes.datos ?? [];
  const nParaderos = (tp.datos?.expuestos.length ?? 0) + (tp.datos?.en_riesgo.length ?? 0);
  const elegir = useCallback((id: string) => {
    setSel((s) => (s === id ? null : id));
    setPestana("prioridad");
  }, []);
  const elegirParadero = useCallback((id: string | null) => {
    setParadero((p) => (id == null || p === id ? null : id));
    if (id) setPestana("paraderos");
  }, []);

  return (
    <main className={styles.consola}>
      <header className={styles.barra}>
        <Link href="/" aria-label="Drena, inicio" className={styles.logo}>
          <Logo />
        </Link>
        <nav className={styles.nav} aria-label="Vistas de la central">
          <Link href="/">Antes</Link>
          <Link href="/central/durante" aria-current="page">Durante</Link>
          <Link href="/central/validacion">Validación</Link>
        </nav>
        <span className={styles.escenario}>Escenario de demo · Zona MUT</span>
        <EnVivo />
        {cuadrilla && <SelectorCuadrilla equipos={equipos} valor={cuadrilla.id} onChange={setEleccion} />}
      </header>

      <MapaCentral
        filas={filas}
        observaciones={obs}
        evidenciaAgua={tp.datos?.evidencia_agua ?? SIN_EVIDENCIA_AGUA}
        cuadrilla={cuadrilla}
        ruta={ruta}
        transporte={tp.datos}
        paradero={paradero}
        onParadero={elegirParadero}
        sel={sel}
        onSel={elegir}
        vigenciaAguaH={tp.datos?.parametros.vigencia_agua_horas ?? 6}
        alcanceAguaM={tp.datos?.parametros.aguas_abajo_m ?? 150}
      />

      <aside className={styles.riel}>
        <QueCambio observacion={obs[0] ?? null} ranking={filas} estado={reportes.estado} />
        <Tabs.Root className={styles.tabs} value={pestana} onValueChange={setPestana}>
          <Tabs.List className={styles.tabLista} aria-label="Detalle de la central">
            <Tabs.Trigger value="prioridad" className={styles.tab}>
              Prioridad <span className={styles.cuenta}>{filas.length || "–"}</span>
            </Tabs.Trigger>
            <Tabs.Trigger value="cuadrilla" className={styles.tab}>
              Cuadrilla <span className={styles.cuenta}>{ruta?.misiones.length ?? "–"}</span>
            </Tabs.Trigger>
            <Tabs.Trigger value="paraderos" className={styles.tab}>
              Paraderos <span className={`${styles.cuenta} ${nParaderos ? styles.cuentaBus : ""}`}>{tp.datos ? nParaderos : "–"}</span>
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="prioridad" className={styles.tabPanel}>
            {esperaRankingDurante && filas.length > 0 && <p className={styles.hint}>Ranking inicial mientras se calcula la prioridad Durante.</p>}
            <Ranking filas={filas} estado={esperaRankingDurante ? rankingInicial.estado : ranking.estado} sel={sel} onSel={elegir} />
          </Tabs.Content>
          <Tabs.Content value="cuadrilla" className={styles.tabPanel}>
            {cuadrilla ? (
              <Misiones cuadrilla={cuadrilla} ruta={ruta} estado={estadoRuta} />
            ) : (
              <p className={styles.vacio}>{cuadrillas.estado === "cargando" ? "Cargando cuadrillas…" : "No hay cuadrillas registradas."}</p>
            )}
          </Tabs.Content>
          <Tabs.Content value="paraderos" className={styles.tabPanel}>
            <Transporte {...tp} activo={paradero} onSelect={elegirParadero} className={styles.transporte} />
          </Tabs.Content>
        </Tabs.Root>
      </aside>
    </main>
  );
}

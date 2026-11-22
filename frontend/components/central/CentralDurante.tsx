"use client";

import Link from "next/link";
import { memo, useCallback, useMemo, useState } from "react";
import type { ApiRankingItem } from "@/lib/api";
import {
  ESCENARIO_CENTRAL,
  getObservaciones,
  getRankingDurante,
  getRankingInicial,
  useConsultaPeriodica,
  type ObservacionPublica,
} from "@/lib/central";
import { getCuadrillas, getRuta, type Cuadrilla, type RutaCuadrilla, type UltimoCambio } from "@/lib/cuadrilla";
import type { LngLat } from "@/lib/data";
import { boundsDe, prioDe } from "@/lib/real";
import { horaSantiago, NIVEL_AGUA, useExpuestos, type EstadoConsulta } from "@/lib/transporte";
import Transporte from "../desktop/Transporte";
import DrenaMap, { type MapLabel, type MapPin } from "../map/DrenaMap";
import { Logo } from "../ui";
import styles from "./central.module.css";

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
const FORMATO_PUNTAJE = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 3 });
const puntaje = (valor: number | null | undefined) => valor == null ? "Sin dato" : FORMATO_PUNTAJE.format(valor);
const captura = (o: ObservacionPublica) => TIPO_REPORTE[o.tipo] ?? "Observación";

function EstadoFuente({ nombre, estado }: { nombre: string; estado: EstadoConsulta }) {
  if (estado === "ok") return null;
  return <p className={styles.hint} role="status">{estado === "cargando" ? `Consultando ${nombre}…` : `Sin conexión con ${nombre}. Reintentando.`}</p>;
}

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

function QueCambio({ observacion, cambio, ranking, estado }: {
  observacion: ObservacionPublica | null;
  cambio: UltimoCambio | null | undefined;
  ranking: ApiRankingItem[];
  estado: EstadoConsulta;
}) {
  const c = observacion?.clasificacion;
  const relacionado = cambio && observacion && cambio.observation_id === observacion.id ? cambio : null;
  const segundos = relacionado && observacion ? (Date.parse(relacionado.hora) - Date.parse(observacion.ts)) / 1000 : NaN;
  const punto = ranking.find((r) => r.sumidero_id === observacion?.sumidero_id);
  const prioridad = observacion?.prioridad;
  const anterior = prioridad?.antes?.scenario_id === ESCENARIO_CENTRAL ? prioridad.antes : null;
  const actual = prioridad?.despues?.scenario_id === ESCENARIO_CENTRAL ? prioridad.despues : null;
  return (
    <section className={styles.card} aria-label="Qué cambió" aria-live="polite">
      <h2>Qué cambió</h2>
      <EstadoFuente nombre="reportes" estado={estado} />
      {observacion ? (
        <>
          <p className={styles.kicker}>{captura(observacion)} · {horaSantiago(observacion.ts, true)}
            {observacion.is_simulated && " · Simulada"}
          </p>
          <h3>{punto?.intersection_nombre ?? (observacion.sumidero_id ? `Sumidero ${observacion.sumidero_id}` : "Caso reportado")}</h3>
          {observacion.urgente && <p className={styles.urgent}>Caso urgente</p>}
          <dl className={styles.details}>
            <div><dt>Clasificación de Claude</dt><dd>{c?.rejilla ? ESTADO_REJILLA[c.rejilla] ?? "Clasificada" : c ? "Clasificada" : "Pendiente"}</dd></div>
            <div><dt>Material</dt><dd>{c?.material?.length ? c.material.join(", ") : "Sin dato"}</dd></div>
            <div><dt>Confianza</dt><dd>{c?.confianza ?? "Sin dato"}</dd></div>
            <div><dt>Nota de clasificación</dt><dd>{notaPublica(observacion)}</dd></div>
            <div><dt>Puntaje de prioridad antes → después</dt><dd>{anterior || actual ? `${puntaje(anterior?.prioridad)} → ${puntaje(actual?.prioridad)}` : "Comparación sin registrar"}</dd></div>
            <div><dt>Siguiente parada antes → después</dt><dd>{relacionado ? `${relacionado.siguiente_antes?.nombre ?? "Sin parada"} → ${relacionado.siguiente_despues?.nombre ?? "Sin parada"}` : "Sin cambio vinculado para esta cuadrilla"}</dd></div>
            <div><dt>Hora de la nueva propuesta</dt><dd>{relacionado ? horaSantiago(relacionado.hora, true) : "Sin dato"}</dd></div>
            <div><dt>Tiempo desde la captura</dt><dd>{Number.isFinite(segundos) && segundos >= 0 ? `${Math.round(segundos)} s` : "Sin dato"}</dd></div>
          </dl>
          {actual && punto?.prioridad === actual.prioridad && punto.explicacion && <p className={styles.hint}>{punto.explicacion}</p>}
        </>
      ) : estado === "ok" && <p className={styles.hint}>Aún no hay observaciones en el tablero.</p>}
    </section>
  );
}

function Misiones({ cuadrilla, ruta, estado }: {
  cuadrilla: Cuadrilla;
  ruta: RutaCuadrilla | null;
  estado: EstadoConsulta;
}) {
  const cierre = ruta?.ultimo_cierre;
  return (
    <section className={styles.card} aria-label="Misiones">
      <h2>Misiones · {cuadrilla.nombre}</h2>
      <p className={styles.hint}>Propuesta de Drena{cuadrilla.is_simulated ? " · cuadrilla simulada" : ""}</p>
      <EstadoFuente nombre="ruta" estado={estado} />
      {ruta?.misiones.length ? (
        <ol className={styles.stops} aria-label="Paradas propuestas">
          {ruta.misiones.map((mision) => (
            <li key={mision.mission_id}>
              <strong>{mision.nombre}</strong>
              <small>{ESTADO_MISION[mision.estado]}{mision.sumidero_id ? ` · Rejilla ${mision.sumidero_id}` : ""}</small>
            </li>
          ))}
        </ol>
      ) : estado === "ok" && <p className={styles.hint}>Sin paradas propuestas.</p>}
      {cierre && (
        <div className={styles.closure}>
          <h3>{cierre.verificado ? "Cerrada y verificada" : "Cerrada sin verificar"}</h3>
          <p>{cierre.nombre}{cierre.sumidero_id ? ` · Rejilla ${cierre.sumidero_id}` : ""} · {horaSantiago(cierre.hora, true)}</p>
          <p>{cierre.rejilla ? ESTADO_REJILLA[cierre.rejilla] ?? "Clasificación registrada" : "Clasificación no disponible"}{cierre.confianza ? ` · confianza ${cierre.confianza}` : ""}</p>
        </div>
      )}
    </section>
  );
}

const MapaCentral = memo(function MapaCentral({ ranking, observaciones, cuadrilla, ruta, paraderos }: {
  ranking: ApiRankingItem[];
  observaciones: ObservacionPublica[];
  cuadrilla: Cuadrilla | null;
  ruta: RutaCuadrilla | null;
  paraderos: MapLabel[];
}) {
  const puntajes = new Set(ranking.flatMap((p) => p.prioridad == null ? [] : [p.prioridad]));
  const pins: MapPin[] = ranking.map((p, i) => ({
    id: p.sumidero_id, coord: [p.lon, p.lat], rank: i + 1,
    prio: prioDe(i + 1, ranking.length, puntajes.size > 1),
  }));
  const urgentes = ranking.filter((p) => p.detalle?.urgente);
  const labels: MapLabel[] = urgentes
    .map((p) => ({ coord: [p.lon, p.lat], text: "Urgente", tone: "danger", offset: [0, -22] }));
  const vistos = new Set<string>();
  for (const o of observaciones) {
    const caso = o.caso_publico;
    if (!o.caso_id || vistos.has(o.caso_id) || !o.urgente || !caso
      || caso.estado === "resuelto" || caso.estado === "descartado"
      || urgentes.some((p) => p.lon === caso.lon && p.lat === caso.lat)) continue;
    vistos.add(o.caso_id);
    labels.push({ coord: [caso.lon, caso.lat], text: "Caso urgente", tone: "danger" });
  }
  if (cuadrilla?.is_simulated && cuadrilla.lon != null && cuadrilla.lat != null) {
    labels.push({ coord: [cuadrilla.lon, cuadrilla.lat], text: cuadrilla.nombre, tone: "dark" });
  }
  labels.push(...paraderos);
  const lineas = ruta?.geojson?.type === "LineString" ? [ruta.geojson.coordinates] : [];
  const bounds = boundsDe([
    ...pins,
    ...labels.map(({ coord }) => ({ coord })),
    ...(lineas[0] ?? []).map((coord) => ({ coord })),
  ]);
  return (
    <section className={styles.card} aria-label="Mapa de sumideros y ruta">
      <h2>Zona MUT</h2>
      <p className={styles.mapLegend}>Prioridad de limpieza <span>Alta</span> · Media · Baja · <b>Urgente</b>{lineas.length > 0 && " · Línea de ruta propuesta"}</p>
      <DrenaMap bounds={bounds} padding={35} className={styles.map} pins={pins} labels={labels} lines={lineas} pinSize={23}
        attribution="Mapa base © OpenStreetMap · Rejillas DOH · Paraderos DTPM" />
    </section>
  );
});

export default function CentralDurante() {
  const ranking = useConsultaPeriodica(getRankingDurante);
  const esperaRankingDurante = ranking.estado === "ok" && ranking.datos?.items.length === 0;
  const rankingInicial = useConsultaPeriodica(esperaRankingDurante ? getRankingInicial : null);
  const reportes = useConsultaPeriodica(getObservaciones);
  const cuadrillas = useConsultaPeriodica(getCuadrillas);
  const [eleccion, setEleccion] = useState("");
  const [paradero, setParadero] = useState<string | null>(null);
  const tp = useExpuestos(ESCENARIO_CENTRAL, true);
  const equipos = cuadrillas.datos ?? [];
  const cuadrilla = equipos.find((c) => c.id === eleccion) ?? equipos.find((c) => c.is_simulated) ?? equipos[0] ?? null;
  const idCuadrilla = cuadrilla?.id;
  const consultarRuta = useCallback(() => getRuta(idCuadrilla ?? ""), [idCuadrilla]);
  const consultaRuta = useConsultaPeriodica(cuadrilla ? consultarRuta : null);
  const ruta = consultaRuta.datos?.crew_id === idCuadrilla ? consultaRuta.datos : null;
  const estadoRuta = consultaRuta.datos && !ruta && consultaRuta.estado !== "error" ? "cargando" : consultaRuta.estado;
  const filas = (esperaRankingDurante ? rankingInicial.datos : ranking.datos)?.items ?? [];
  const obs = reportes.datos ?? [];
  const marcas = useMemo((): MapLabel[] => {
    const expuestos = tp.datos?.expuestos ?? [];
    const expuestoElegido = expuestos.find((p) => p.id === paradero);
    const alternativos = new Map((expuestoElegido?.servicios ?? []).flatMap((s) => s.alternativo ? [[s.alternativo.id, s.alternativo] as const] : []));
    return [
      ...expuestos.map((p): MapLabel => ({ coord: [p.lon, p.lat], text: p.id === paradero ? p.nombre : `Expuesto · ${p.id}`, tone: "danger", offset: [0, 20] })),
      ...Array.from(alternativos.values(), (p): MapLabel => ({ coord: [p.lon, p.lat] as LngLat, text: `Alternativo · ${p.nombre}`, tone: "pill" })),
    ];
  }, [tp.datos, paradero]);

  return (
    <main className={styles.central}>
      <header className={styles.header}>
        <Link href="/" aria-label="Drena, inicio"><Logo /></Link>
        <Link href="/">Ver ranking Antes</Link>
        <Link href={cuadrilla ? `/cuadrilla?id=${encodeURIComponent(cuadrilla.id)}` : "/cuadrilla"}>Abrir vista de cuadrilla</Link>
      </header>
      <div className={styles.heading}>
        <div>
          <h1>Central durante la lluvia</h1>
          <p>Escenario de la demo · Zona MUT · Actualización automática</p>
        </div>
        {cuadrilla && (
          <label className={styles.crew}>
            Cuadrilla
            <select value={cuadrilla.id} onChange={(e) => setEleccion(e.target.value)}>
              {equipos.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.is_simulated ? " · simulada" : ""}</option>)}
            </select>
          </label>
        )}
      </div>
      <EstadoFuente nombre="cuadrillas" estado={cuadrillas.estado} />
      <EstadoFuente nombre="ranking" estado={ranking.estado} />
      {esperaRankingDurante && (rankingInicial.datos?.items.length
        ? <p className={styles.hint}>Ranking inicial mientras se calcula la prioridad Durante.</p>
        : <EstadoFuente nombre="ranking inicial" estado={rankingInicial.estado} />)}
      <div className={styles.layout}>
        <div className={styles.column}>
          <MapaCentral ranking={filas} observaciones={obs} cuadrilla={cuadrilla} ruta={ruta} paraderos={marcas} />
          <section aria-label="Ranking de prioridad" className={styles.card}>
            <h2>Prioridad de limpieza</h2>
            <p className={styles.hint}>Orden y puntaje de prioridad en la zona</p>
            {filas.length ? (
              <ol className={styles.ranking}>
                {filas.map((p, i) => (
                  <li key={p.sumidero_id}>
                    <span>{i + 1}</span>
                    <span>{p.intersection_nombre ?? `Sumidero ${p.sumidero_id}`}{p.intersection_nombre && <small>{p.sumidero_id}</small>}
                      {p.is_simulated && <small>Simulado</small>}
                    </span>
                    <span>{puntaje(p.prioridad)}{p.detalle?.urgente && <small className={styles.urgent}>Urgente</small>}</span>
                  </li>
                ))}
              </ol>
            ) : <p className={styles.hint}>Sin puntajes disponibles.</p>}
          </section>
        </div>
        <div className={styles.column}>
          <QueCambio observacion={obs[0] ?? null} cambio={ruta?.ultimo_cambio} ranking={filas} estado={reportes.estado} />
          {cuadrilla && <Misiones cuadrilla={cuadrilla} ruta={ruta} estado={estadoRuta} />}
          <Transporte {...tp} activo={paradero} onSelect={setParadero} />
        </div>
      </div>
    </main>
  );
}

"use client";

import { useMemo } from "react";
import type { LngLat } from "@/lib/data";
import {
  claveServicio,
  horaSantiago,
  INTERVALO_MS,
  NIVEL_AGUA,
  sentidoTexto,
  type EstadoConsulta,
  type Expuestos,
  type ParaderoEnRiesgo,
  type ParaderoExpuesto,
  type Recorrido,
} from "@/lib/transporte";
import type { MapParadero } from "../map/DrenaMap";
import { Kicker } from "../ui";

const TIPO_OBS: Record<string, string> = { foto_agua: "foto de calle", foto_rejilla: "foto de rejilla", cuadro_camara: "cuadro de cámara", texto: "reporte de texto" };

const coord = (p: { lat: number; lon: number }): LngLat => [p.lon, p.lat];

/** Capas del mapa a partir de la respuesta: paraderos, trazados de servicios afectados y caminata al alternativo. */
export function capasTransporte(d: Expuestos | null, recorridos: Recorrido[], activo: string | null, onSelect: (id: string) => void) {
  if (!d) return { paraderos: [] as MapParadero[], recorridos: [] as LngLat[][], caminatas: [] as [LngLat, LngLat][] };
  const paraderos: MapParadero[] = [];
  const caminatas: [LngLat, LngLat][] = [];
  const afectados = new Set<string>();
  const alternativos = new Map<string, MapParadero>();
  const marcados = new Set([...d.expuestos, ...d.en_riesgo].map((p) => p.id));
  for (const p of d.expuestos) {
    paraderos.push({ id: p.id, coord: coord(p), nivel: "expuesto", activo: p.id === activo, titulo: `Expuesto · ${p.nombre}`, onClick: () => onSelect(p.id) });
    for (const s of p.servicios) {
      // Con un paradero elegido, solo sus servicios; sin selección, todos los afectados
      if (activo && activo !== p.id) continue;
      afectados.add(claveServicio(s));
      const a = s.alternativo;
      if (!a) continue;
      caminatas.push([coord(p), coord(a)]);
      if (!marcados.has(a.id) && !alternativos.has(a.id))
        alternativos.set(a.id, { id: a.id, coord: coord(a), nivel: "alternativo", titulo: `Paradero alternativo · ${a.nombre}` });
    }
  }
  for (const p of d.en_riesgo)
    paraderos.push({ id: p.id, coord: coord(p), nivel: "en_riesgo", activo: p.id === activo, titulo: `En riesgo · ${p.nombre}`, onClick: () => onSelect(p.id) });
  paraderos.push(...alternativos.values());
  const lineas = recorridos.filter((r) => afectados.has(claveServicio(r))).flatMap((r) => r.tramos);
  return { paraderos, recorridos: lineas, caminatas };
}

/** "PC1016-Parada 3 / (M) Tobalaba" → código y nombre por separado. */
function partirNombre(n: string) {
  const i = n.indexOf("-");
  return i > 0 && /^P[A-Z]\d+$/.test(n.slice(0, i)) ? { codigo: n.slice(0, i), nombre: n.slice(i + 1) } : { codigo: null, nombre: n };
}

function NombreParadero({ nombre }: { nombre: string }) {
  const p = partirNombre(nombre);
  return (
    <span className="tp__name">
      {p.nombre}
      {p.codigo && <span className="tp__code">{p.codigo}</span>}
    </span>
  );
}

function Expuesto({ p, activo, onSelect }: { p: ParaderoExpuesto; activo: boolean; onSelect: () => void }) {
  const c = p.causa;
  return (
    <div className={`tp__item tp__item--expuesto ${activo ? "is-active" : ""}`}>
      <button className="tp__head" onClick={onSelect} aria-pressed={activo}>
        <span className="tp__badge tp__badge--expuesto">Expuesto</span>
        <NombreParadero nombre={p.nombre} />
      </button>
      <p className="tp__causa">
        {NIVEL_AGUA[c.nivel] ?? c.nivel} a {c.distancia_m} m
        {c.via === "calle_abajo" ? `, calle abajo de la rejilla ${c.sumidero_observado} (${Math.round(c.calle_abajo_m)} m)` : `, rejilla ${c.sumidero_id}`} · {TIPO_OBS[c.tipo] ?? c.tipo} de {c.fuente}, {horaSantiago(c.ts)}
        {c.is_simulated && <span className="tp__sim">simulado</span>}
      </p>
      <ul className="tp__servicios">
        {p.servicios.map((s) => (
          <li key={claveServicio(s)}>
            <span className="tp__svc">{s.servicio}</span>
            <span className="tp__dir">{sentidoTexto(s)}</span>
            {s.alternativo ? (
              <span className="tp__alt">
                ↪ {partirNombre(s.alternativo.nombre).nombre} · {s.alternativo.distancia_m} m en línea recta ({s.alternativo.en_secuencia})
                {s.alternativo.en_riesgo && <span className="tp__badge tp__badge--riesgo">en riesgo</span>}
              </span>
            ) : (
              <span className="tp__alt tp__alt--none">{s.motivo}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EnRiesgo({ p, activo, onSelect }: { p: ParaderoEnRiesgo; activo: boolean; onSelect: () => void }) {
  return (
    <div className={`tp__item ${activo ? "is-active" : ""}`}>
      <button className="tp__head" onClick={onSelect} aria-pressed={activo}>
        <span className="tp__badge tp__badge--riesgo">En riesgo</span>
        <NombreParadero nombre={p.nombre} />
      </button>
      <p className="tp__causa">
        Rejilla {p.causa.sumidero_id} a {p.causa.distancia_m} m, puesto {p.causa.puesto_en_zona} de prioridad en la zona · servicios {p.servicios.map((s) => s.servicio).join(", ")}
      </p>
    </div>
  );
}

export default function Transporte({
  datos,
  calculadoAt,
  estado,
  activo,
  onSelect,
  className,
}: {
  datos: Expuestos | null;
  calculadoAt: string | null;
  estado: EstadoConsulta;
  activo: string | null;
  onSelect: (id: string | null) => void;
  /** Variante del contenedor: la Central la usa para quitar el alto máximo del tablero de escritorio. */
  className?: string;
}) {
  const fuente = useMemo(() => {
    if (!datos?.fuente) return "Fuente: GTFS de DTPM";
    const f = datos.fuente;
    return `Fuente: ${f.nombre}${f.fecha_descarga ? ` (descargado el ${f.fecha_descarga.split("-").reverse().join("-")})` : ""}`;
  }, [datos?.fuente]);
  const toggle = (id: string) => onSelect(activo === id ? null : id);
  const vacio = datos && !datos.expuestos.length && !datos.en_riesgo.length;

  return (
    <section className={`card tp ${datos?.expuestos.length ? "is-active" : ""} ${className ?? ""}`} aria-live="polite">
      <div className="tp__top">
        <Kicker tone={datos?.expuestos.length ? "danger" : undefined}>Paraderos de buses expuestos</Kicker>
        <span className="tp__ts">
          {estado === "error" ? "Sin conexión · reintentando" : datos ? `Calculado ${horaSantiago(calculadoAt, true)} · cada ${INTERVALO_MS / 1000} s` : "Consultando…"}
        </span>
      </div>

      {!datos && estado === "error" && <p className="tp__aviso">No se pudo consultar la exposición del transporte.</p>}
      {datos?.aviso && <p className="tp__aviso">{datos.aviso}</p>}

      {vacio && (
        <div className="empty">
          <div className="empty__title">Sin paraderos expuestos</div>
          <div className="empty__body">Una observación con agua cerca de un paradero lo marca aquí.</div>
        </div>
      )}

      {datos && (datos.expuestos.length > 0 || datos.en_riesgo.length > 0) && (
        <div className="tp__list">
          {datos.expuestos.map((p) => (
            <Expuesto key={p.id} p={p} activo={activo === p.id} onSelect={() => toggle(p.id)} />
          ))}
          {datos.en_riesgo.map((p) => (
            <EnRiesgo key={p.id} p={p} activo={activo === p.id} onSelect={() => toggle(p.id)} />
          ))}
        </div>
      )}

      <p className="tp__note">
        <b>Expuesto</b>: agua observada a menos de {datos?.parametros.radio_m ?? 80} m. <b>En riesgo</b>: solo prioridad alta cerca, sin agua observada. Drena no
        desvía recorridos: el desvío lo confirma Red.
        <br />
        {fuente}
      </p>
    </section>
  );
}

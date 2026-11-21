"use client";

import { useEffect, useMemo, useState } from "react";
import { ESCURRIMIENTO, fmt, googleMapsTramos, MAX_WAYPOINTS_MOVIL, pad2, statsPunto, textoWhatsApp, type LngLat, type ScenarioId } from "@/lib/data";
import { boundsDe } from "@/lib/real";
import { CUADRILLAS_MAX, useStore, type MobileTab } from "@/lib/store";
import AvisoDatos from "../AvisoDatos";
import { copy } from "../desktop/Modals";
import { CriticidadPill, VariablesReales } from "../desktop/Ficha";
import DrenaMap, { type MapPin } from "../map/DrenaMap";
import { Button, Kicker, Logo, PrioChip, Segmented, Stat, Toast } from "../ui";

const PINS_MAX = 100; // con datos reales hay ~2.000 intersecciones: se dibujan las más prioritarias
const TOP_ENCUADRE = 30;

function Nav() {
  const { s, set } = useStore();
  const tabs: [MobileTab, string][] = [
    ["prioridades", "Prioridades"],
    ["ruta", "Ruta"],
  ];
  return (
    <nav className="mob__nav">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          className={`mob__tab ${s.mobileTab === id ? "is-on" : ""}`}
          onClick={() => set({ mobileTab: id, mobileView: "lista" })}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function useMobilePins(onPin: (id: string) => void, focus?: string) {
  const { ranking, s } = useStore();
  return useMemo<MapPin[]>(() => {
    const visible = ranking.filter((p) => s.comuna === "Todas" || p.comuna === s.comuna);
    const enMapa = ranking.length > PINS_MAX ? [...visible.slice(0, PINS_MAX), ...ranking.filter((p) => !visible.includes(p)).slice(0, 30)] : ranking;
    return enMapa.map((p) => ({
      id: p.id,
      coord: p.coord,
      rank: p.rank,
      prio: p.prio,
      faded: !visible.includes(p),
      onClick: () => onPin(p.id),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranking, s.comuna, focus]);
}

function Estado({ kind }: { kind: "cargando" | "vacio" | "error" }) {
  const { s, set, reload } = useStore();
  if (kind === "cargando")
    return (
      <div className="mstate">
        <h3>Cargando</h3>
        <p>Calculando la lista del escenario…</p>
      </div>
    );
  if (kind === "vacio")
    return (
      <div className="mstate">
        <h3>Sin puntos</h3>
        <p>No hay puntos de prioridad alta en {s.comuna} para este escenario.</p>
        <Button size="lg" className="btn--block" onClick={() => set({ comuna: "Todas" })}>
          Ver todas las comunas
        </Button>
      </div>
    );
  return (
      <div className="mstate mstate--ink">
        <h3>Sin conexión</h3>
        <p>Muestra la última lista guardada (13:40). La ruta sigue en Google Maps.</p>
        <Button size="lg" className="btn--block" onClick={reload}>
          Reintentar
        </Button>
      </div>
    );
}

function Prioridades() {
  const { s, set, filtered, scenarioLabel, ruta, escenarios } = useStore();
  const pins = useMobilePins((id) => set({ selected: id, mobileView: "mapa" }));
  const real = !!filtered[0]?.real;
  // Con datos reales siempre hay lista, aunque aún no haya prioridades altas
  const hasAlta = filtered.length > 0 && (real || filtered.some((p) => p.prio === "alta"));
  const bounds = useMemo(() => (real ? boundsDe(filtered.slice(0, TOP_ENCUADRE)) : ([[-70.628, -33.444], [-70.592, -33.416]] as [LngLat, LngLat])), [real, filtered]);
  return (
    <>
      <div className="mob__body">
        <div className="mob__head">
          <Logo size={26} />
          <button className="mpill" onClick={() => set({ mobileView: "filtros" })}>
            {s.comuna === "Todas" ? "Todas" : s.comuna}
          </button>
        </div>
        <div className="mob__pad">
          <Segmented<ScenarioId> size="lg" soft options={escenarios.map((x) => ({ id: x.id, label: x.short }))} value={s.scenario} onChange={(scenario) => set({ scenario })} />
        </div>
        {s.status === "error" ? (
          <div className="mgap">
            <Estado kind="error" />
          </div>
        ) : s.status === "loading" ? (
          <div className="mgap">
            <Estado kind="cargando" />
          </div>
        ) : !hasAlta ? (
          <div className="mgap">
            <Estado kind="vacio" />
          </div>
        ) : (
          <>
            <div className="mob__pad" onClick={() => set({ mobileView: "mapa", selected: filtered[0].id })}>
              <DrenaMap className="mmap" bounds={bounds} padding={10} pinSize={34} pins={pins} lines={real ? [] : ESCURRIMIENTO} />
            </div>
            <div className="mlist">
              <Kicker>
                {s.comuna === "Todas" ? "Top 30" : `Top ${s.comuna}`} · {scenarioLabel}
              </Kicker>
              {filtered.slice(0, 8).map((p, i) => (
                <button key={p.id} className={`mrow ${i === 0 ? "is-first" : ""}`} onClick={() => set({ ficha: p.id, mobileView: "ficha" })}>
                  <span className="mrow__rank">{pad2(p.rank)}</span>
                  <div>
                    <span className="mrow__name">{p.nombre}</span>
                    <span className="mrow__meta">{p.real ? `${p.real.sumideros.length} ${p.real.sumideros.length === 1 ? "sumidero" : "sumideros"}` : `${p.pctExterno} % agua externa`}</span>
                  </div>
                  <PrioChip prio={p.prio} />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {s.status === "ok" && hasAlta && (
        <div className="mob__cta">
          <Button variant="primary" size="lg" className="btn--block" style={{ boxShadow: "var(--sh-soft)" }} onClick={() => set({ mobileTab: "ruta", mobileView: "lista" })}>
            Generar ruta · {ruta.paradas.length} {ruta.paradas.length === 1 ? "punto" : "puntos"}
          </Button>
        </div>
      )}
    </>
  );
}

function MapaFull() {
  const { s, set, ranking, addRuta } = useStore();
  const sel = ranking.find((p) => p.id === s.selected) ?? ranking[0];
  const pins = useMobilePins((id) => set({ selected: id }), sel.id);
  const b: [LngLat, LngLat] = [
    [sel.coord[0] - 0.012, sel.coord[1] - 0.012],
    [sel.coord[0] + 0.012, sel.coord[1] + 0.02],
  ];
  return (
    <div className="mfull">
      <DrenaMap bounds={b} padding={20} pins={pins} lines={sel.real ? [] : ESCURRIMIENTO} attribution="© Esri, OSM">
        <div className="mfull__top">
          <button className="mfull__logo" onClick={() => set({ mobileView: "lista" })}>
            <Logo size={20} />
          </button>
          <button className="round" onClick={() => set({ mobileView: "filtros" })} aria-label="Filtros">
            ⚙
          </button>
        </div>
      </DrenaMap>
      <div className="sheet">
        <div className="grab" />
        <div className="sheet__head">
          <div className="rank-m">{pad2(sel.rank)}</div>
          <div>
            <div className="sheet__title">{sel.nombre}</div>
            <div className="sheet__sub">
              {sel.real ? `${sel.comuna} · ${sel.cerca}` : `${sel.pctExterno} % del agua viene de ${sel.origen ?? sel.comuna}`}
            </div>
          </div>
        </div>
        <div className="row-btns">
          <Button variant="primary" size="lg" onClick={() => set({ ficha: sel.id, mobileView: "ficha" })}>
            Ver ficha
          </Button>
          <Button size="lg" onClick={() => addRuta(sel.id)}>
            + Ruta
          </Button>
        </div>
      </div>
    </div>
  );
}

function FichaM() {
  const { s, set, ranking, addRuta, fichaReal } = useStore();
  const p = ranking.find((x) => x.id === s.ficha) ?? ranking[0];
  const criticidad = p.real ? (fichaReal?.criticidad ?? []) : p.criticidad;
  return (
    <div className="mob__body">
      <div className="photo mficha__photo" style={{ backgroundImage: "url(/img/sumidero-ficha-m.jpg)" }}>
        <button className="mficha__back" onClick={() => set({ mobileView: "lista", ficha: null })} aria-label="Volver">
          ‹
        </button>
        <span className="photo__tag">Foto referencial · Unsplash</span>
      </div>
      <div className="mficha__body">
        <div className="mficha__head">
          <div className="rank-m" style={{ boxShadow: "var(--sh-accent)" }}>
            {pad2(p.rank)}
          </div>
          <div>
            <div className="mficha__title">{p.nombre}</div>
            <div className="mficha__sub" style={{ color: p.prio === "alta" ? "var(--lime)" : "var(--text-2)" }}>
              {p.comuna} · {{ alta: "▲ Alta", media: "◆ Media", baja: "● Baja" }[p.prio]}
            </div>
          </div>
        </div>
        <div className="mstats">
          {p.real ? (
            statsPunto(p)
              .slice(0, 2)
              .map((st, i) => <Stat key={st.label} inset="soft" value={st.value} label={st.label} accent={i === 0} />)
          ) : (
            <>
              <Stat inset="soft" value={`${p.pctExterno} %`} label={`agua de ${p.origen ?? p.comuna}`} accent />
              <Stat inset="soft" value={`${fmt(p.area)} km²`} label="área de aporte" />
            </>
          )}
        </div>
        {p.real && <VariablesReales />}
        <div className="pills mpills" style={{ marginTop: 0 }}>
          {criticidad.map((c) => (
            <CriticidadPill key={c} text={c.replace(/Metro [^·]+·/, "Metro ·")} />
          ))}
        </div>
        <div className="todo">
          <Kicker tone="accent">Qué hacer</Kicker>
          <p>
            {p.real
              ? (fichaReal?.explicacion ?? p.real.explicacion ?? `Revisar ${p.cerca} de la esquina y despejar las rejillas antes de la lluvia.`)
              : `Limpiar los sumideros de la esquina antes de las 14:00. Recibe agua de ${fmt(p.area)} km², el ${p.pctExterno} % desde ${p.origen ?? p.comuna}.`}
          </p>
        </div>
        <div className="grow" />
        <Button variant="primary" size="lg" className="btn--block" onClick={() => addRuta(p.id)}>
          Agregar a la ruta
        </Button>
        <Button size="lg" className="btn--block" onClick={() => set({ selected: p.id, mobileView: "mapa" })}>
          Ver en mapa
        </Button>
      </div>
    </div>
  );
}

function Filtros() {
  const { s, set, escenarios, comunas } = useStore();
  const [esc, setEsc] = useState(s.scenario);
  const [com, setCom] = useState(s.comuna);
  const [cu, setCu] = useState(s.cuadrillas);
  const back = s.mobileTab === "prioridades" && s.selected ? "mapa" : "lista";
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && set({ mobileView: back })}>
      <div className="fsheet">
        <div className="grab" />
        <h2>Filtros</h2>
        <Kicker>Escenario de lluvia</Kicker>
        <Segmented<ScenarioId> size="lg" options={escenarios.map((x) => ({ id: x.id, label: x.short }))} value={esc} onChange={setEsc} />
        <Kicker>Comuna</Kicker>
        <div className="fchips">
          {comunas.map((c) => (
            <button key={c.id} className={`fchip ${com === c.id ? "is-on" : ""}`} onClick={() => setCom(c.id)}>
              {c.id}
            </button>
          ))}
        </div>
        <Kicker>Cuadrillas disponibles</Kicker>
        <div className="stepper">
          <button onClick={() => setCu(Math.max(1, cu - 1))} aria-label="Menos">
            −
          </button>
          <div>
            <b>{cu}</b>
            <small>corta la lista en {cu * 2} puntos</small>
          </div>
          <button onClick={() => setCu(Math.min(CUADRILLAS_MAX, cu + 1))} aria-label="Más">
            +
          </button>
        </div>
        <Button variant="primary" size="lg" className="btn--block" onClick={() => set({ scenario: esc, comuna: com, cuadrillas: cu, mobileView: back })}>
          Aplicar filtros
        </Button>
      </div>
    </div>
  );
}

function Ruta() {
  const { s, set, scenarioLabel, ruta } = useStore();
  const paradas = ruta.paradas;
  const hechos = new Set(s.hechos);
  const done = paradas.filter((p) => hechos.has(p.id)).length;
  const nextIdx = paradas.findIndex((p) => !hechos.has(p.id));
  const tramos = googleMapsTramos(paradas, MAX_WAYPOINTS_MOVIL);
  return (
    <>
      <div className="mob__body">
        <div className="mtitle">
          <Kicker tone="accent">Cuadrilla 1 · {scenarioLabel}</Kicker>
          <h1>Ruta de hoy</h1>
          <p>
            {paradas.length} {paradas.length === 1 ? "punto" : "puntos"} en orden · {ruta.km}
          </p>
        </div>
        <div className="progress">
          <div className="progress__bar">
            <span style={{ width: `${paradas.length ? (done / paradas.length) * 100 : 0}%` }} />
          </div>
          <small>
            {done} de {paradas.length} hechos
          </small>
        </div>
        <div className="mlist" style={{ paddingTop: 8 }}>
          {paradas.map((r, i) => {
            const st = hechos.has(r.id) ? "done" : i === nextIdx ? "next" : "todo";
            return (
              <div key={r.id} className={`stop is-${st}`}>
                <span className="stop__n">{st === "done" ? "✓" : i + 1}</span>
                <div>
                  <span className="mrow__name">{r.nombre}</span>
                  <span className="mrow__meta">{st === "done" ? "Limpio" : st === "next" ? "Siguiente" : "Pendiente"}</span>
                </div>
                <PrioChip prio={r.prio} faded={st === "done"} />
              </div>
            );
          })}
        </div>
      </div>
      <div className="mob__cta--stack">
        {tramos.map((t, i) => (
          <Button key={t.url} variant={i === 0 ? "primary" : "secondary"} size="lg" className="btn--block" onClick={() => window.open(t.url, "_blank", "noopener")}>
            {tramos.length === 1 ? "Abrir en Google Maps" : `Abrir tramo ${i + 1} en Maps · paradas ${t.desde}–${t.hasta}`}
          </Button>
        ))}
        {nextIdx >= 0 ? (
          <Button size="lg" className="btn--block" onClick={() => set({ hechos: [...s.hechos, paradas[nextIdx].id] })}>
            Marcar punto {nextIdx + 1} de {paradas.length} como limpio
          </Button>
        ) : (
          <Button size="lg" className="btn--block" onClick={() => set({ hechos: s.hechos.filter((id) => !paradas.some((p) => p.id === id)) })}>
            Reiniciar ruta
          </Button>
        )}
        <Button size="lg" className="btn--block" onClick={() => set({ mobileView: "compartir" })}>
          Compartir lista
        </Button>
      </div>
    </>
  );
}

function Compartir() {
  const { s, set, scenarioLabel, ruta } = useStore();
  const text = textoWhatsApp(ruta.paradas, scenarioLabel, s.comuna);
  return (
    <>
      <div className="mob__body">
        <div className="mtitle">
          <Kicker tone="accent">Ruta · {s.comuna === "Todas" ? "Todas las comunas" : s.comuna}</Kicker>
          <h1>Compartir lista</h1>
        </div>
        <pre className="share">{text}</pre>
      </div>
      <div className="mob__cta--stack">
        <Button
          variant="primary"
          size="lg"
          className="btn--block"
          onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener")}
        >
          Enviar por WhatsApp
        </Button>
        <Button
          size="lg"
          className="btn--block"
          onClick={async () => {
            await copy(text);
            set({ toast: "Lista copiada" });
          }}
        >
          Copiar texto
        </Button>
      </div>
    </>
  );
}

export default function Mobile() {
  const { s, set } = useStore();
  // En terreno se trabaja por comuna: por defecto Providencia (M01)
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).get("comuna")) set({ comuna: "Providencia" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  let body: React.ReactNode;
  if (s.mobileTab === "ruta") body = s.mobileView === "compartir" ? <Compartir /> : <Ruta />;
  else if (s.mobileView === "mapa" || (s.mobileView === "filtros" && s.selected)) body = <MapaFull />;
  else if (s.mobileView === "ficha" && s.ficha) body = <FichaM />;
  else body = <Prioridades />;
  return (
    <div className="mob">
      {body}
      {s.mobileView === "filtros" && <Filtros />}
      <Nav />
      <AvisoDatos movil />
      <Toast text={s.toast} className="toast--m" />
    </div>
  );
}

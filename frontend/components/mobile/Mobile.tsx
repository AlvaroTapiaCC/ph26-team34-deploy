"use client";

import { useEffect, useMemo, useState } from "react";
import { COMUNAS, ESCURRIMIENTO, fmt, googleMapsTramos, MAX_WAYPOINTS_MOVIL, pad2, PUNTOS, SCENARIOS, textoWhatsApp, type LngLat, type ScenarioId } from "@/lib/data";
import { useStore, type MobileTab } from "@/lib/store";
import { copy } from "../desktop/Modals";
import { CriticidadPill } from "../desktop/Ficha";
import DrenaMap, { type MapPin } from "../map/DrenaMap";
import { Button, Kicker, Logo, PrioChip, Segmented, Stat, Toast } from "../ui";

const SHORT = Object.fromEntries(SCENARIOS.map((s) => [s.id, s.short])) as Record<ScenarioId, string>;

function Nav() {
  const { s, set } = useStore();
  const tabs: [MobileTab, string][] = [
    ["prioridades", "Prioridades"],
    ["ruta", "Ruta"],
    ["durante", "Durante"],
  ];
  return (
    <nav className="mob__nav">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          className={`mob__tab ${s.mobileTab === id ? "is-on" : ""}`}
          onClick={() => set({ mobileTab: id, mobileView: id === "prioridades" ? "lista" : "lista", modo: id === "durante" ? "durante" : "antes" })}
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
    return ranking.map((p) => ({
      id: p.id,
      coord: p.coord,
      rank: p.rank,
      prio: p.prio,
      faded: !visible.includes(p),
      ring: p.id === (focus ?? visible[0]?.id) ? "dashed" : undefined,
      onClick: () => onPin(p.id),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranking, s.comuna, focus]);
}

function Estado({ kind }: { kind: "cargando" | "vacio" | "error" | "caido" }) {
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
  if (kind === "error")
    return (
      <div className="mstate mstate--ink">
        <h3>Sin conexión</h3>
        <p>Muestra la última lista guardada (13:40). La ruta sigue en Google Maps.</p>
        <Button size="lg" className="btn--block" onClick={reload}>
          Reintentar
        </Button>
      </div>
    );
  return (
    <div className="mstate mstate--danger">
      <h3>Cámara de la demo · sin señal</h3>
      <p>Usa “Simular reporte” para seguir la demo.</p>
    </div>
  );
}

function Prioridades() {
  const { s, set, filtered, scenarioLabel } = useStore();
  const pins = useMobilePins((id) => set({ selected: id, mobileView: "mapa" }));
  const hasAlta = filtered.some((p) => p.prio === "alta");
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
          <Segmented<ScenarioId> size="lg" soft options={SCENARIOS.map((x) => ({ id: x.id, label: x.short }))} value={s.scenario} onChange={(scenario) => set({ scenario })} />
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
              <DrenaMap className="mmap" bounds={[[-70.628, -33.444], [-70.592, -33.416]]} padding={10} pinSize={34} pins={pins} lines={ESCURRIMIENTO} />
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
                    <span className="mrow__meta">{p.pctExterno} % agua externa</span>
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
            Generar ruta · 8 puntos
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
      <DrenaMap bounds={b} padding={20} pins={pins} lines={ESCURRIMIENTO} attribution="© Esri, OSM">
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
              {sel.pctExterno} % del agua viene de {sel.origen ?? sel.comuna}
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
  const { s, set, ranking, addRuta } = useStore();
  const p = ranking.find((x) => x.id === s.ficha) ?? ranking[0];
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
          <Stat inset="soft" value={`${p.pctExterno} %`} label={`agua de ${p.origen ?? p.comuna}`} accent />
          <Stat inset="soft" value={`${fmt(p.area)} km²`} label="área de aporte" />
        </div>
        <div className="pills mpills" style={{ marginTop: 0 }}>
          {p.criticidad.map((c) => (
            <CriticidadPill key={c} text={c.replace(/Metro [^·]+·/, "Metro ·")} />
          ))}
        </div>
        <div className="todo">
          <Kicker tone="accent">Qué hacer</Kicker>
          <p>
            Limpiar los sumideros de la esquina antes de las 14:00. Recibe agua de {fmt(p.area)} km², el {p.pctExterno} % desde {p.origen ?? p.comuna}.
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
  const { s, set } = useStore();
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
        <Segmented<ScenarioId> size="lg" options={SCENARIOS.map((x) => ({ id: x.id, label: x.short }))} value={esc} onChange={setEsc} />
        <Kicker>Comuna</Kicker>
        <div className="fchips">
          {COMUNAS.map((c) => (
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
          <button onClick={() => setCu(Math.min(5, cu + 1))} aria-label="Más">
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

function DuranteM() {
  const { s, set, cadena, flood } = useStore();
  const an = s.anegado ? PUNTOS[s.anegado] : null;
  if (!an) {
    return (
      <div className="mob__body">
        <div className="mgap">
          {s.sensor === "caido" ? (
            <Estado kind="caido" />
          ) : (
            <div className="alert" style={{ boxShadow: "inset 0 0 0 1.5px var(--line)" }}>
              <Kicker tone="accent">
                <span className="sensor__dot" /> Reportes de la demo
              </Kicker>
              <h2>Sin anegamientos reportados</h2>
              <p>Simula un reporte para ver qué revisar aguas abajo.</p>
            </div>
          )}
          <Button size="lg" className="btn--block" onClick={() => flood("p2", "sensor")}>
            Simular reporte
          </Button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="mob__body">
        <div className="mgap">
          <div className="alert">
            <Kicker tone="danger">
              <span className="sensor__dot is-danger" /> {s.reportes[0]?.fuente}
            </Kicker>
            <h2>Anegado en {an.nombre}</h2>
            <p>Revisa primero los puntos que reciben su agua.</p>
          </div>
          <div className="photo" style={{ height: 170, backgroundImage: "url(/img/sumidero-anegado.jpg)" }}>
            <span className="photo__tag">Foto referencial · Unsplash</span>
          </div>
          <Kicker tone="accent">Aguas abajo · orden de recorrido</Kicker>
          {cadena.map((p, i) => (
            <div key={p.id} className="mrow">
              <span className="ord mord">{i + 1}°</span>
              <div>
                <span className="mrow__name">{p.nombre}</span>
              </div>
              <PrioChip prio={p.prio} />
            </div>
          ))}
        </div>
      </div>
      {cadena[0] && (
        <div className="mob__cta">
          <Button variant="primary" size="lg" className="btn--block" onClick={() => set({ ficha: cadena[0].id, mobileTab: "prioridades", mobileView: "ficha" })}>
            Ir al 1° · {cadena[0].nombre.split(" / ")[0]}
          </Button>
        </div>
      )}
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
  else if (s.mobileTab === "durante") body = <DuranteM />;
  else if (s.mobileView === "mapa" || (s.mobileView === "filtros" && s.selected)) body = <MapaFull />;
  else if (s.mobileView === "ficha" && s.ficha) body = <FichaM />;
  else body = <Prioridades />;
  return (
    <div className="mob">
      {body}
      {s.mobileView === "filtros" && <Filtros />}
      <Nav />
      <Toast text={s.toast} className="toast--m" />
    </div>
  );
}

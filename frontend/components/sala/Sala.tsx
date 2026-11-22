"use client";

// Sala de Drena: un solo armazón para el inicio y la central (Antes y Durante).
// El mapa se monta una vez, detrás del inicio, y queda listo cuando se entra a la central.

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Select from "@radix-ui/react-select";
import * as Tabs from "@radix-ui/react-tabs";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePulso, type ObservacionPublica } from "@/lib/central";
import type { Cuadrilla } from "@/lib/cuadrilla";
import type { LngLat } from "@/lib/data";
import { boundsDe } from "@/lib/real";
import { APORTES, CATASTRO, dos, nombreFila, puntaje, SalaProvider, useSala, type Fila } from "@/lib/sala";
import { horaSantiago, NIVEL_AGUA, useRecorridos, type EstadoConsulta, type EvidenciaAgua } from "@/lib/transporte";
import { useCapaCadenas } from "../central/capaCadenas";
import Transporte, { capasTransporte } from "../desktop/Transporte";
import DrenaMap, { type MapLabel, type MapPunto } from "../map/DrenaMap";
import { ESTADOS, FLUJO_CONFIG, type EstadoRejilla } from "@/lib/flujo/config";
import { useFlujo, type Flujo } from "@/lib/flujo/useFlujo";
import { precargarMapLibre } from "../map/maplibre";
import { Logo } from "../ui";
import s from "./sala.module.css";

if (typeof window !== "undefined") precargarMapLibre();

type Vista = "inicio" | "antes" | "durante" | "simulacion" | "validacion";
const vistaDe = (path: string): Vista =>
  path.startsWith("/central/durante")
    ? "durante"
    : path.startsWith("/central/antes")
      ? "antes"
      : path.startsWith("/central/simulacion")
        ? "simulacion"
        : path.startsWith("/central/validacion")
          ? "validacion"
          : "inicio";
const conMapa = (v: Vista) => v === "antes" || v === "durante" || v === "simulacion";
const sinMovimiento = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const ESTADO_REJILLA: Record<string, string> = { limpia: "Rejilla limpia", parcial: "Rejilla parcialmente tapada", tapada: "Rejilla tapada", no_evaluable: "Foto no evaluable" };
const ESTADO_MISION: Record<string, string> = { pendiente: "Pendiente", en_camino: "En camino", en_sitio: "En el lugar", cerrada: "Cerrada", cancelada: "Cancelada" };
const TIPO_REPORTE: Record<string, string> = { foto_agua: "Foto de calle", foto_rejilla: "Foto de rejilla", cuadro_camara: "Cuadro de cámara", texto: "Reporte de texto" };
const TOP_DESTACADOS = 5;
const CAMARA_3D = { pitch: 48, bearing: -12 };

/* ───────────────────────── Piezas pequeñas ───────────────────────── */

function Pulso() {
  const { ultimaOk, fallando } = usePulso();
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seg = ultimaOk == null ? null : Math.max(0, Math.round((ahora - ultimaOk) / 1000));
  const error = fallando.length > 0;
  const texto = error ? "Sin conexión · reintentando" : seg == null ? "Conectando con el servidor…" : seg < 2 ? "En vivo" : `En vivo · hace ${seg} s`;
  return (
    <span className={`${s.pulso} ${error ? s.pulsoError : seg == null ? s.pulsoEspera : ""}`} role="status" aria-live="polite" title={error ? `Falla: ${fallando.join(", ")}` : undefined}>
      <i aria-hidden />
      {texto}
    </span>
  );
}

function Reloj() {
  // La hora se pone en el navegador (en el servidor sería otra y React no podría hidratar)
  const [h, setH] = useState<string | null>(null);
  useEffect(() => {
    const poner = () => setH(new Date().toISOString());
    poner();
    const t = setInterval(poner, 15_000);
    return () => clearInterval(t);
  }, []);
  return <span className={s.reloj}>{h ? `${horaSantiago(h)} Santiago` : " "}</span>;
}

/** Número que cuenta hasta su valor al aparecer o cambiar (solo texto; respeta movimiento reducido). */
function Cifra({ valor }: { valor: number | null }) {
  const [mostrado, setMostrado] = useState(valor ?? 0);
  const desde = useRef(0);
  useEffect(() => {
    if (valor == null) return;
    if (sinMovimiento()) return setMostrado(valor);
    const inicio = performance.now();
    const a = desde.current;
    let raf = 0;
    const paso = (t: number) => {
      const k = Math.min(1, (t - inicio) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      setMostrado(Math.round(a + (valor - a) * e));
      if (k < 1) raf = requestAnimationFrame(paso);
      else desde.current = valor;
    };
    raf = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(raf);
  }, [valor]);
  return <>{valor == null ? "Sin dato" : mostrado.toLocaleString("es-CL")}</>;
}

function Skel({ h = 14, w = "100%" }: { h?: number; w?: string }) {
  return <span className={s.skel} style={{ height: h, width: w }} aria-hidden />;
}

function SelectorCuadrilla({ equipos, valor, onChange }: { equipos: Cuadrilla[]; valor: string; onChange: (id: string) => void }) {
  return (
    <Select.Root value={valor} onValueChange={onChange}>
      <Select.Trigger className={s.selTrigger} aria-label="Cuadrilla que sigue la central">
        <Select.Value />
        <Select.Icon className={s.selIcon}>▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className={s.selContent} position="popper" sideOffset={8} align="end">
          <Select.Viewport>
            {equipos.map((c) => (
              <Select.Item key={c.id} value={c.id} className={s.selItem}>
                <Select.ItemText>{c.nombre}</Select.ItemText>
                {c.is_simulated && <span className={s.chipSim}>Simulada</span>}
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

/* ───────────────────────── Barra ───────────────────────── */

const NAV: { href: string; vista: Vista | "validacion"; texto: string }[] = [
  { href: "/", vista: "inicio", texto: "Inicio" },
  { href: "/central/antes", vista: "antes", texto: "Antes" },
  { href: "/central/durante", vista: "durante", texto: "Durante" },
  { href: "/central/simulacion", vista: "simulacion", texto: "Simulación" },
  { href: "/central/validacion", vista: "validacion", texto: "Validación" },
];

function Barra({ vista }: { vista: Vista }) {
  const { cuadrillas, cuadrilla, elegirCuadrilla } = useSala();
  return (
    <header className={s.barra}>
      <Link href="/" className={s.logo} aria-label="Drena, inicio">
        <Logo />
      </Link>
      <nav className={s.nav} aria-label="Vistas">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.vista === vista ? "page" : undefined} className={s.navLink}>
            {n.texto}
          </Link>
        ))}
      </nav>
      <span className={s.zona}>Zona MUT · Providencia y Las Condes</span>
      <span className={s.barraDer}>
        <Pulso />
        <Reloj />
        {(vista === "antes" || vista === "durante") && cuadrilla && <SelectorCuadrilla equipos={cuadrillas} valor={cuadrilla.id} onChange={elegirCuadrilla} />}
      </span>
    </header>
  );
}

/* ───────────────────────── Inicio ───────────────────────── */

function Inicio({ activo, mapaListo }: { activo: boolean; mapaListo: boolean }) {
  const { antes, durante, cuadrilla, ruta, estadoRuta, transporte, clima, observaciones } = useSala();
  const top = antes.filas.slice(0, 3);
  const sig = ruta?.misiones[0];
  const nExp = transporte.datos ? transporte.datos.expuestos.length + transporte.datos.en_riesgo.length : null;
  const ultimo = observaciones.datos[0];
  const c = clima.datos;
  const lluvia48 = c?.lluvia_pronosticada_48h_mm;
  const cargando = antes.estado === "cargando" && !antes.filas.length;
  const subio = durante.esInicial ? null : durante.filas[0];
  return (
    <section className={`${s.inicio} ${activo ? s.inicioActivo : ""}`} aria-hidden={!activo} inert={!activo}>
      <div className={s.inicioVelo} aria-hidden />
      <div className={s.inicioCuerpo}>
        <div className={s.inicioTexto}>
        <p className={s.inicioClima}>
          <span className={s.climaDot} data-modo={c?.modo ?? "sin_dato"} />
          {c ? (
            <>
              {c.modo === "seco" ? "Sin lluvia ahora" : c.modo === "durante" ? "Lloviendo ahora" : c.modo === "tormenta_inminente" ? "Lluvia en camino" : "Clima sin dato"}
              {" · "}
              {lluvia48 == null ? "pronóstico sin dato" : `${dos(lluvia48).replace(",00", "")} mm en las próximas 48 h`}
              <span className={s.fuente}>Open-Meteo</span>
            </>
          ) : clima.estado === "error" ? (
            "Clima sin dato"
          ) : (
            "Consultando el clima…"
          )}
        </p>
        <h1 className={s.titular}>
          <span className={s.titularCifra}>
            <Cifra valor={CATASTRO.total} />
          </span>{" "}
          rejillas en Providencia, Ñuñoa y Las Condes. Drena ordena cuáles limpiar primero.
        </h1>
        <div className={s.comunas} aria-label="Rejillas del catastro por comuna">
          {CATASTRO.comunas.map((c) => (
            <span key={c.nombre} className={s.comuna}>
              <b>{c.n.toLocaleString("es-CL")}</b> {c.nombre}
            </span>
          ))}
          <span className={s.comunaFuente}>Catastro SIALL de la DOH (parcial)</span>
        </div>
        <p className={s.escenarioHoy}>
          <span className={s.escenarioMarca}>Escenario de hoy</span>
          {cargando ? (
            <Skel h={18} w="22rem" />
          ) : (
            <>
              Zona MUT: <b>{antes.filas.length || "Sin dato"}</b> rejillas con todas sus variables calculadas. La primera visita es <b>{top[0] ? nombreFila(top[0]) : "Sin dato"}</b>.
            </>
          )}
        </p>

        <div className={s.inicioPie}>
          <Link href="/central/antes" className={s.cta}>
            <span>Abrir la central</span>
            <i aria-hidden>→</i>
          </Link>
          <Link href="/central/durante" className={s.ctaSec}>
            Ir a Durante la lluvia
          </Link>
          <Link href="/explorar" className={s.ctaSec}>
            Explorar las 3 comunas
          </Link>
          <span className={s.mapaEstado} data-listo={mapaListo}>
            <i aria-hidden />
            {mapaListo ? "Mapa listo" : "Preparando el mapa…"}
          </span>
        </div>

        <p className={s.ultimo}>
          {ultimo ? (
            <>
              <b>Último reporte</b> · {TIPO_REPORTE[ultimo.tipo] ?? "Observación"} a las {horaSantiago(ultimo.ts)}
              {ultimo.is_simulated && <span className={s.chipSim}>Simulado</span>}
              {subio && <> · encabeza Durante: {nombreFila(subio)}</>}
            </>
          ) : observaciones.estado === "ok" ? (
            "Sin reportes de vecinos todavía. Llegan desde /reportar."
          ) : (
            " "
          )}
        </p>
        </div>
        <div className={s.decisiones}>
          <article className={s.decision} style={{ ["--i" as string]: 0 }}>
            <header>
              <span className={s.decN}>1</span>
              <h2>Qué limpiar primero</h2>
            </header>
            {top.length ? (
              <ol className={s.top3}>
                {top.map((p) => (
                  <li key={p.sumidero_id}>
                    <span className={s.top3N}>{p.puesto}</span>
                    <span className={s.top3T}>{nombreFila(p)}</span>
                    <b>{puntaje(p.prioridad)}</b>
                  </li>
                ))}
              </ol>
            ) : antes.estado === "error" ? (
              <p className={s.vacio}>No se pudo leer el ranking. Reintentando.</p>
            ) : (
              <div className={s.skelPila}>
                <Skel h={22} />
                <Skel h={22} />
                <Skel h={22} />
              </div>
            )}
            <p className={s.decPie}>Puntaje para ordenar visitas; no es probabilidad de inundación.</p>
          </article>

          <article className={s.decision} style={{ ["--i" as string]: 1 }}>
            <header>
              <span className={s.decN}>2</span>
              <h2>Hacia dónde va la cuadrilla</h2>
            </header>
            {sig ? (
              <>
                <p className={s.decGrande}>{sig.nombre}</p>
                <p className={s.decMeta}>
                  Siguiente parada · {ESTADO_MISION[sig.estado] ?? sig.estado} · {ruta!.misiones.length} {ruta!.misiones.length === 1 ? "parada" : "paradas"} en ruta
                </p>
              </>
            ) : estadoRuta === "cargando" ? (
              <div className={s.skelPila}>
                <Skel h={26} w="70%" />
                <Skel h={14} w="50%" />
              </div>
            ) : (
              <p className={s.vacio}>Sin paradas propuestas.</p>
            )}
            {cuadrilla && (
              <p className={s.decPie}>
                {cuadrilla.nombre}
                {cuadrilla.is_simulated && <span className={s.chipSim}>Simulada</span>}
              </p>
            )}
          </article>

          <article className={s.decision} style={{ ["--i" as string]: 2 }}>
            <header>
              <span className={s.decN}>3</span>
              <h2>Quién espera la micro</h2>
            </header>
            {nExp == null ? (
              <div className={s.skelPila}>
                <Skel h={40} w="30%" />
                <Skel h={14} w="80%" />
              </div>
            ) : (
              <>
                <p className={s.decGrande}>
                  <Cifra valor={nExp} /> <small>{nExp === 1 ? "paradero" : "paraderos"} con riesgo</small>
                </p>
                <p className={s.decMeta}>{nExp ? `${(transporte.datos!.expuestos[0] ?? transporte.datos!.en_riesgo[0]).nombre.replace(/^P[A-Z]\d+-/, "")} y servicios con alternativo` : "Ningún paradero cerca de agua o prioridad alta."}</p>
              </>
            )}
            <p className={s.decPie}>GTFS de DTPM · Red confirma cualquier desvío</p>
          </article>
        </div>

      </div>
    </section>
  );
}

/* ───────────────────────── Ranking ───────────────────────── */

function useFlip(lista: React.RefObject<HTMLOListElement | null>, claves: string) {
  const pos = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const ol = lista.current;
    if (!ol) return;
    const nuevas = new Map<string, number>();
    const items = Array.from(ol.querySelectorAll<HTMLElement>(":scope > li[data-k]"));
    for (const el of items) nuevas.set(el.dataset.k!, el.offsetTop);
    if (!sinMovimiento() && pos.current.size)
      for (const el of items) {
        const a = pos.current.get(el.dataset.k!);
        const b = nuevas.get(el.dataset.k!)!;
        if (a == null || a === b) continue;
        el.style.transition = "none";
        el.style.transform = `translateY(${a - b}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)";
          el.style.transform = "";
        });
      }
    pos.current = nuevas;
  }, [lista, claves]);
}

function PorQue({ p }: { p: Fila }) {
  const ap = p.detalle?.aportes ?? {};
  const lista = Object.entries(ap)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = Math.max(...lista.map(([, v]) => v), 0.0001);
  return (
    <div className={s.porque}>
      <p className={s.porqueT}>Por qué está aquí</p>
      {lista.length ? (
        <ul>
          {lista.map(([k, v]) => (
            <li key={k}>
              <span>
                {APORTES[k]?.nombre ?? k}
                {APORTES[k]?.simulado && <span className={s.chipSim}>Simulado</span>}
              </span>
              <span className={s.porqueBarra}>
                <i style={{ transform: `scaleX(${v / max})` }} />
              </span>
              <b>{dos(v)}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.vacio}>Sin aportes registrados para esta rejilla.</p>
      )}
      <dl className={s.porqueDl}>
        <div>
          <dt>Obstrucción</dt>
          <dd>{dos(p.p_ef ?? p.p_pred)}</dd>
        </div>
        <div>
          <dt>Consecuencia</dt>
          <dd>{dos(p.c)}</dd>
        </div>
        <div>
          <dt>Puntaje</dt>
          <dd>{puntaje(p.prioridad)}</dd>
        </div>
      </dl>
      {p.explicacion && <p className={s.porqueExp}>{p.explicacion}</p>}
    </div>
  );
}

const TOP_LISTA = 5;

function Ranking({ filas: todas, estado, sel, onSel, hover, onHover }: { filas: Fila[]; estado: EstadoConsulta; sel: string | null; onSel: (id: string) => void; hover: string | null; onHover: (id: string | null) => void }) {
  const [todasVisibles, setTodasVisibles] = useState(false);
  // La lista muestra el top; si se elige una rejilla más abajo (desde el mapa), se despliega sola
  const selFuera = !!sel && todas.findIndex((f) => f.sumidero_id === sel) >= TOP_LISTA;
  const verTodas = todasVisibles || selFuera;
  const filas = verTodas ? todas : todas.slice(0, TOP_LISTA);
  const ref = useRef<HTMLOListElement>(null);
  const claves = filas.map((f) => f.sumidero_id).join("|");
  useFlip(ref, claves);
  const previos = useRef<Map<string, number> | null>(null);
  const [subidas, setSubidas] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    const actual = new Map(filas.map((f) => [f.sumidero_id, f.puesto]));
    const prev = previos.current;
    previos.current = actual;
    if (!prev) return;
    const m = new Map<string, number>();
    for (const [id, p] of actual) {
      const a = prev.get(id);
      if (a != null && a > p) m.set(id, a - p);
    }
    if (!m.size) return;
    setSubidas(m);
    const t = setTimeout(() => setSubidas(new Map()), 9000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claves]);
  useEffect(() => {
    if (!sel) return;
    ref.current?.querySelector(`[data-k="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest", behavior: sinMovimiento() ? "auto" : "smooth" });
  }, [sel]);

  if (!filas.length)
    return estado === "error" ? (
      <p className={s.vacio}>No se pudo leer el ranking. Se reintenta solo cada 3 s.</p>
    ) : (
      <div className={s.skelPila} aria-label="Cargando ranking">
        {Array.from({ length: 9 }, (_, i) => (
          <Skel key={i} h={46} />
        ))}
      </div>
    );
  const max = Math.max(...todas.map((f) => f.prioridad ?? 0), 0.0001);
  return (
    <ol className={s.ranking} ref={ref} aria-label="Ranking de prioridad">
      {filas.map((p) => {
        const abierto = sel === p.sumidero_id;
        const subio = subidas.get(p.sumidero_id);
        return (
          <li key={p.sumidero_id} data-k={p.sumidero_id} className={`${abierto ? s.filaAbierta : ""} ${subio ? s.filaSube : ""} ${hover === p.sumidero_id ? s.filaHover : ""}`}>
            <button
              type="button"
              className={s.fila}
              onClick={() => onSel(p.sumidero_id)}
              onMouseEnter={() => onHover(p.sumidero_id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(p.sumidero_id)}
              onBlur={() => onHover(null)}
              aria-expanded={abierto}
            >
              <span className={`${s.puesto} ${s["p_" + p.prio]}`}>{p.puesto}</span>
              <span className={s.filaTxt}>
                <span className={s.filaNombre}>{nombreFila(p)}</span>
                <span className={s.filaMeta}>
                  {p.detalle?.urgente && <span className={s.chipUrgente}>Urgente</span>}
                  {subio && <span className={s.chipSube}>▲ subió {subio}</span>}
                  {p.is_simulated && <span className={s.chipSim}>Simulado</span>}
                  <code>{p.sumidero_id}</code>
                </span>
              </span>
              <span className={s.filaPuntaje}>
                <b>{puntaje(p.prioridad)}</b>
                <span className={s.medidor} aria-hidden>
                  <i style={{ transform: `scaleX(${p.prioridad != null ? p.prioridad / max : 0})` }} />
                </span>
              </span>
            </button>
            {abierto && <PorQue p={p} />}
          </li>
        );
      })}
      {todas.length > TOP_LISTA && (
        <li className={s.verMasLi}>
          <button type="button" className={s.verMas} onClick={() => setTodasVisibles(!verTodas)} aria-expanded={verTodas}>
            {verTodas ? `Mostrar solo el top ${TOP_LISTA}` : `Ver las ${todas.length} rejillas`}
            <i aria-hidden>{verTodas ? "▴" : "▾"}</i>
          </button>
        </li>
      )}
    </ol>
  );
}

/* ───────────────────────── Tarjeta superior del riel ───────────────────────── */

function notaPublica(o: ObservacionPublica) {
  const c = o.clasificacion;
  if (!c) return "Claude está clasificando la evidencia.";
  if (c.evaluable === false) return "La imagen no aporta evidencia evaluable.";
  const agua = c.nivel_agua ? NIVEL_AGUA[c.nivel_agua as keyof typeof NIVEL_AGUA] : undefined;
  if (c.personas_en_riesgo) return "El reporte indica personas en riesgo.";
  if (agua) return `Claude ve ${agua}.`;
  if (c.rejilla === "tapada" || c.rejilla === "parcial") return c.material?.length ? `Claude ve una obstrucción con ${c.material.join(", ")}.` : "Claude ve una obstrucción.";
  return c.rejilla === "limpia" ? "La rejilla se ve despejada." : "La clasificación quedó registrada.";
}

function QueCambio({ nuevo }: { nuevo: boolean }) {
  const { observaciones, durante } = useSala();
  const o = observaciones.datos[0] ?? null;
  if (!o)
    return (
      <section className={s.tarjeta}>
        <p className={s.tarjetaT}>Qué cambió</p>
        {observaciones.estado === "cargando" ? (
          <div className={s.skelPila}>
            <Skel h={24} w="70%" />
            <Skel h={14} />
          </div>
        ) : (
          <p className={s.espera}>
            <span className={s.esperaOnda} aria-hidden />
            Esperando el primer reporte de un vecino. Cuando llegue una foto, aquí verás cómo cambian el puntaje y la siguiente parada.
          </p>
        )}
      </section>
    );
  const c = o.clasificacion;
  const punto = durante.filas.find((r) => r.sumidero_id === o.sumidero_id);
  const ant = o.prioridad?.antes?.prioridad;
  const des = o.prioridad?.despues?.prioridad;
  return (
    <section className={`${s.tarjeta} ${nuevo ? s.tarjetaNueva : ""}`} aria-live="polite">
      <p className={s.tarjetaT}>
        Qué cambió
        <span>
          {TIPO_REPORTE[o.tipo] ?? "Observación"} · {horaSantiago(o.ts, true)}
          {o.is_simulated && <span className={s.chipSim}>Simulada</span>}
        </span>
      </p>
      <h2 className={s.tarjetaLugar}>{punto ? nombreFila(punto) : o.sumidero_id ? `Sumidero ${o.sumidero_id}` : "Caso reportado"}</h2>
      {o.urgente && <p className={s.urgente}>Urgente: personas en riesgo o agua sobre la vereda</p>}
      <p className={s.lectura}>
        {notaPublica(o)}
        {c?.confianza && <span className={s.conf}>confianza {c.confianza}</span>}
      </p>
      <div className={s.antesDespues}>
        <div>
          <span>Puntaje</span>
          <p>
            <s>{puntaje(ant)}</s> <i aria-hidden>→</i> <b>{puntaje(des)}</b>
          </p>
        </div>
        {(o.despachos ?? []).slice(0, 1).map((d) => (
          <div key={d.crew_id}>
            <span>Siguiente parada</span>
            <p>
              <s>{d.siguiente_antes ?? "Sin parada"}</s> <i aria-hidden>→</i> <b>{d.siguiente_despues ?? "Sin parada"}</b>
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Recomendacion() {
  const { antes } = useSala();
  const p = antes.filas[0];
  const ap = Object.entries(p?.detalle?.aportes ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  return (
    <section className={s.tarjeta}>
      <p className={s.tarjetaT}>
        Plan antes de la lluvia<span>ranking inicial congelado</span>
      </p>
      {p ? (
        <>
          <h2 className={s.tarjetaLugar}>{nombreFila(p)}</h2>
          <p className={s.lectura}>
            Primera visita con puntaje {puntaje(p.prioridad)}
            {ap.length ? `: pesan ${ap.map(([k]) => (APORTES[k]?.nombre ?? k).toLowerCase() + (APORTES[k]?.simulado ? " (simulado)" : "")).join(" y ")}.` : "."}
          </p>
        </>
      ) : (
        <div className={s.skelPila}>
          <Skel h={24} w="70%" />
          <Skel h={14} />
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── Cuadrilla ───────────────────────── */

function Misiones() {
  const { cuadrilla, ruta, estadoRuta } = useSala();
  if (!cuadrilla) return <p className={s.vacio}>No hay cuadrillas registradas.</p>;
  const cierre = ruta?.ultimo_cierre;
  return (
    <div className={s.panel}>
      <p className={s.hint}>
        Propuesta de Drena para {cuadrilla.nombre}
        {cuadrilla.is_simulated && <span className={s.chipSim}>Simulada</span>}
      </p>
      {ruta?.misiones.length ? (
        <ol className={s.paradas}>
          {ruta.misiones.map((m, i) => (
            <li key={m.mission_id} className={i === 0 ? s.paradaSig : ""} style={{ ["--i" as string]: i }}>
              <span className={s.paradaN}>{i + 1}</span>
              <span>
                <strong>{m.nombre}</strong>
                <small>
                  {i === 0 ? "Siguiente · " : ""}
                  {ESTADO_MISION[m.estado] ?? m.estado}
                  {m.sumidero_id ? ` · ${m.sumidero_id}` : ""}
                </small>
              </span>
            </li>
          ))}
        </ol>
      ) : estadoRuta === "cargando" ? (
        <div className={s.skelPila}>
          <Skel h={52} />
          <Skel h={52} />
        </div>
      ) : (
        <p className={s.vacio}>{estadoRuta === "error" ? "No se pudo leer la ruta. Reintentando." : "Sin paradas propuestas."}</p>
      )}
      {cierre && (
        <div className={`${s.cierre} ${cierre.verificado ? s.cierreOk : ""}`}>
          <strong>{cierre.verificado ? "Cierre verificado con foto" : "Cerrada sin verificar"}</strong>
          <span>
            {cierre.nombre} · {horaSantiago(cierre.hora, true)}
          </span>
          <span>
            {cierre.rejilla ? (ESTADO_REJILLA[cierre.rejilla] ?? "Clasificación registrada") : "Clasificación no disponible"}
            {cierre.confianza ? ` · confianza ${cierre.confianza}` : ""}
          </span>
        </div>
      )}
      <Link className={s.btnSec} href={`/cuadrilla?id=${encodeURIComponent(cuadrilla.id)}`} target="_blank">
        Abrir el celular de la cuadrilla <i aria-hidden>↗</i>
      </Link>
    </div>
  );
}

/* ───────────────────────── Mapa ───────────────────────── */

const SIN_AGUA: readonly EvidenciaAgua[] = [];

type Capas = { cadenas: boolean; transporte: boolean; limites: boolean; catastro: boolean };

const Mapa = memo(function Mapa({
  filas,
  vista,
  sel,
  onSel,
  hover,
  onHover,
  paradero,
  onParadero,
  foco,
  onListo,
  flujo,
  capas,
  setCapas,
}: {
  filas: Fila[];
  vista: Vista;
  sel: string | null;
  onSel: (id: string) => void;
  hover: string | null;
  onHover: (id: string | null) => void;
  paradero: string | null;
  onParadero: (id: string | null) => void;
  foco: { coord: LngLat; siempre: boolean } | null;
  onListo: () => void;
  flujo: Flujo;
  capas: Capas;
  setCapas: (c: Capas) => void;
}) {
  const { observaciones, transporte, cuadrilla, ruta } = useSala();
  const [tresD, setTresD] = useState(true);
  const [menu, setMenu] = useState(false);
  const durante = vista === "durante";
  const simulacion = vista === "simulacion";
  const prioridades = useMemo(() => new Map(filas.flatMap((p) => (p.prioridad == null ? [] : [[p.sumidero_id, p.prio] as const]))), [filas]);
  const cadenas = useCapaCadenas(prioridades, durante ? observaciones.datos : [], durante ? (transporte.datos?.evidencia_agua ?? SIN_AGUA) : SIN_AGUA, capas.cadenas && !simulacion, transporte.datos?.parametros.vigencia_agua_horas ?? 6, transporte.datos?.parametros.aguas_abajo_m ?? 150);
  const verTransporte = capas.transporte && !simulacion;
  const recorridos = useRecorridos(verTransporte);
  const tp = useMemo(() => (verTransporte ? capasTransporte(transporte.datos, recorridos, paradero, onParadero) : { paraderos: [], recorridos: [], caminatas: [] }), [verTransporte, transporte.datos, recorridos, paradero, onParadero]);

  // Todas las rejillas del ranking como puntos (capa GL): las 5 primeras más grandes y con brillo, sin números
  const puntos = useMemo<MapPunto[]>(
    () =>
      simulacion
        ? []
        : filas.map((p) => ({ id: p.sumidero_id, coord: [p.lon, p.lat], prio: p.prio, top: p.puesto <= TOP_DESTACADOS, nombre: `${p.puesto} · ${nombreFila(p)}`, sub: `Puntaje ${puntaje(p.prioridad)}` })),
    [filas, simulacion],
  );
  const labels = useMemo(() => {
    const out: MapLabel[] = [];
    if (simulacion) return out;
    if (durante) for (const p of filas) if (p.detalle?.urgente) out.push({ coord: [p.lon, p.lat], text: "Urgente", tone: "danger", offset: [0, -16], anchor: "bottom" });
    if (cuadrilla?.is_simulated && cuadrilla.lon != null && cuadrilla.lat != null) out.push({ coord: [cuadrilla.lon, cuadrilla.lat], text: `${cuadrilla.nombre} · simulada`, tone: "dark", offset: [10, 0] });
    const e = filas.find((p) => p.sumidero_id === sel);
    if (e) out.push({ coord: [e.lon, e.lat], text: `${e.puesto} · ${nombreFila(e)}`, tone: "card", offset: [14, 0] });
    return out;
  }, [filas, durante, simulacion, cuadrilla, sel]);

  const lineas = useMemo(() => (!simulacion && ruta?.geojson?.type === "LineString" ? [ruta.geojson.coordinates as LngLat[]] : []), [ruta, simulacion]);
  const clave = filas.map((p) => p.sumidero_id).sort().join("|");
  const bounds = useMemo(() => boundsDe(filas.map((p) => ({ coord: [p.lon, p.lat] as LngLat }))), [clave]); // eslint-disable-line react-hooks/exhaustive-deps
  const onMapReady = useCallback(
    (m: unknown) => {
      onListo();
      const a = cadenas.onMapReady(m) as unknown;
      const b = flujo.alMapaListo(m);
      return () => {
        if (typeof a === "function") (a as () => void)();
        b();
      };
    },
    [cadenas, flujo, onListo],
  );
  const alternar = (k: keyof Capas) => setCapas({ ...capas, [k]: !capas[k] });

  return (
    <div className={s.mapa}>
      <DrenaMap
        bounds={bounds}
        padding={{ top: 80, bottom: 70, left: 60, right: typeof window !== "undefined" && window.innerWidth > 1088 ? 470 : 40 }}
        className={s.mapaCanvas}
        puntos={puntos}
        onClickPunto={onSel}
        seleccionado={sel}
        labels={labels}
        ruta={lineas}
        foco={foco?.coord ?? null}
        focoSiempre={foco?.siempre}
        resaltado={hover}
        onHover={onHover}
        relieve
        tresD={tresD}
        camara3D={CAMARA_3D}
        comunas={capas.limites}
        rejillas={capas.catastro}
        paraderos={tp.paraderos}
        recorridos={tp.recorridos}
        caminatas={tp.caminatas}
        onMapReady={onMapReady}
        attribution="© Esri, OpenStreetMap · Rejillas DOH · Paraderos DTPM · relieve AWS · edificios OpenFreeMap"
        attributionSide="right"
      >
        <div className={s.mapaChips}>
          <span className={s.segmento} role="radiogroup" aria-label="Vista del mapa">
            <button type="button" role="radio" aria-checked={!tresD} className={!tresD ? s.segOn : ""} onClick={() => setTresD(false)}>
              2D
            </button>
            <button type="button" role="radio" aria-checked={tresD} className={tresD ? s.segOn : ""} onClick={() => setTresD(true)}>
              3D
            </button>
          </span>
          {!simulacion && (
            <span className={s.capasWrap}>
              <button type="button" className={`${s.chipMapa} ${menu ? s.chipMapaOn : ""}`} onClick={() => setMenu(!menu)} aria-expanded={menu}>
                Capas <small>{Object.values(capas).filter(Boolean).length} de 4</small>
              </button>
              {menu && (
                <div className={s.capasMenu} role="group" aria-label="Capas del mapa">
                  <CapaCheck on={capas.cadenas} onClick={() => alternar("cadenas")} titulo="Cadenas calle abajo" sub="Escurrimiento estimado por pendiente; el color se propaga con la evidencia" muestra="cadena" />
                  <CapaCheck on={capas.transporte} onClick={() => alternar("transporte")} titulo="Transporte público" sub="Paraderos expuestos, recorridos y alternativo (GTFS DTPM)" muestra="bus" />
                  <CapaCheck on={capas.limites} onClick={() => alternar("limites")} titulo="Límites comunales" sub="Providencia, Ñuñoa y Las Condes" muestra="limite" />
                  <CapaCheck on={capas.catastro} onClick={() => alternar("catastro")} titulo="Catastro completo" sub="3.002 rejillas DOH; el ranking existe solo en la zona MUT" muestra="catastro" />
                </div>
              )}
            </span>
          )}
          {capas.cadenas && !simulacion && cadenas.estado === "cargando" && <span className={s.chipInfo}>Cargando cadenas…</span>}
          {lineas.length > 0 && <span className={s.chipInfo}>— — orden de visita (línea recta)</span>}
        </div>
        {!simulacion && (
          <ul className={s.leyendaMapa} aria-label="Leyenda">
            <li>
              <i className={s.lgTop} />5 primeras
            </li>
            <li>
              <i className={s.lgAlta} />
              Alta
            </li>
            <li>
              <i className={s.lgMedia} />
              Media
            </li>
            <li>
              <i className={s.lgBaja} />
              Baja
            </li>
            {durante && (
              <li>
                <i className={s.lgAgua} />
                Agua observada
              </li>
            )}
          </ul>
        )}
      </DrenaMap>
    </div>
  );
});

function CapaCheck({ on, onClick, titulo, sub, muestra }: { on: boolean; onClick: () => void; titulo: string; sub: string; muestra: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`${s.capa} ${on ? s.capaOn : ""}`} onClick={onClick}>
      <i className={s.capaMuestra} data-m={muestra} aria-hidden />
      <span>
        <b>{titulo}</b>
        <small>{sub}</small>
      </span>
      <span className={s.capaSwitch} aria-hidden />
    </button>
  );
}

/* Esqueleto de la central mientras el mapa carga: misma distribución, sin ruedita. Se queda un mínimo de tiempo
   y se desvanece, para que el cambio se lea y no parpadee. */
function EsqueletoMapa({ listo }: { listo: boolean }) {
  const [montado, setMontado] = useState(true);
  const [saliendo, setSaliendo] = useState(false);
  const inicio = useRef(performance.now());
  // Si el mapa ya estaba listo (cambio entre vistas) la cortina es breve; en la primera carga dura un poco más
  const minimo = useRef(listo ? 360 : 650);
  useEffect(() => {
    if (!listo) return;
    const resta = Math.max(0, minimo.current - (performance.now() - inicio.current));
    const t1 = setTimeout(() => setSaliendo(true), resta);
    const t2 = setTimeout(() => setMontado(false), resta + 320);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [listo]);
  if (!montado) return null;
  return (
    <div className={`${s.esqMapa} ${saliendo ? s.esqSale : ""}`} aria-label="Cargando el mapa" role="status">
      <div className={s.esqCalles} aria-hidden />
      <div className={s.esqChips} aria-hidden>
        <Skel h={36} w="6rem" />
        <Skel h={36} w="9rem" />
      </div>
      {[
        [38, 30],
        [46, 36],
        [52, 33],
        [33, 52],
        [58, 58],
        [44, 62],
        [27, 40],
      ].map(([x, y], i) => (
        <span key={i} className={s.esqPin} style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${i * 110}ms` }} aria-hidden />
      ))}
    </div>
  );
}

/* ───────────────────────── Simulación ───────────────────────── */

function Simulacion({ flujo, estados, setEstados }: { flujo: Flujo; estados: Record<string, EstadoRejilla>; setEstados: (e: Record<string, EstadoRejilla>) => void }) {
  const ui = flujo.ui;
  const tapar20 = () => {
    const todas = flujo.rejillas();
    const n = Math.round(todas.length * 0.2);
    const elegidas = [...todas].sort(() => Math.random() - 0.5).slice(0, n);
    setEstados({ ...Object.fromEntries(todas.map((r) => [r.id, "limpia" as EstadoRejilla])), ...Object.fromEntries(elegidas.map((r) => [r.id, "tapada" as EstadoRejilla])) });
  };
  const limpiar = () => setEstados(Object.fromEntries(flujo.rejillas().map((r) => [r.id, "limpia" as EstadoRejilla])));
  const nTap = ui.tapadas.Todas ?? 0;
  const nTot = ui.total.Todas ?? 0;
  void estados;
  return (
    <>
      <section className={`${s.tarjeta} ${s.rielTop}`}>
        <p className={s.tarjetaT}>
          Modo predicción<span>simulación, no es un modelo hidráulico</span>
        </p>
        <h2 className={s.tarjetaLugar}>¿Qué pasa si se tapan estas rejillas?</h2>
        <p className={s.lectura}>Tapa rejillas con un clic en el mapa (limpia → parcial → tapada) o al azar, sube la lluvia y mira por dónde escurre el agua por las calles. El escurrimiento es estimado con la pendiente del terreno.</p>
      </section>
      <section className={`${s.tarjeta} ${s.simPanel}`}>
        {!ui.cargado && !ui.error && (
          <div className={s.skelPila}>
            <Skel h={44} />
            <Skel h={20} />
            <Skel h={60} />
          </div>
        )}
        {ui.error && <p className={s.vacio}>No se pudo cargar la red de calles. Recarga la página para reintentar.</p>}
        {ui.cargado && (
          <>
            <div className={s.simFila}>
              <button type="button" className={s.simPlay} onClick={flujo.alternar} aria-label={ui.corriendo ? "Pausar la simulación" : "Reproducir la simulación"}>
                {ui.corriendo ? "❚❚" : "▶"}
              </button>
              <span className={s.segmento} role="radiogroup" aria-label="Velocidad">
                {FLUJO_CONFIG.velocidades.map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={ui.velocidad === v} className={ui.velocidad === v ? s.segOn : ""} onClick={() => flujo.setVelocidad(v)}>
                    {v}×
                  </button>
                ))}
              </span>
              <button type="button" className={s.simReiniciar} onClick={flujo.reiniciar}>
                Reiniciar
              </button>
            </div>
            <label className={s.simLluvia}>
              <span>
                Lluvia supuesta <b>{ui.lluviaMmH} mm/h</b>
              </span>
              <input type="range" min={0} max={FLUJO_CONFIG.lluviaMaxMmH} step={1} value={ui.lluviaMmH} onChange={(e) => flujo.setLluvia(Number(e.target.value))} />
            </label>
            <div className={s.simCifras}>
              <div>
                <b>
                  {nTap} <small>de {nTot.toLocaleString("es-CL")}</small>
                </b>
                <span>rejillas tapadas</span>
              </div>
              <div>
                <b>{ui.lecturas.desbordados}</b>
                <span>puntos con agua (estimado)</span>
              </div>
            </div>
            <div className={s.simAcciones}>
              <button type="button" className={s.btnSec} onClick={tapar20}>
                Tapar 20 % al azar
              </button>
              <button type="button" className={s.btnSec} onClick={limpiar}>
                Limpiar todas
              </button>
            </div>
            {ui.elegida && (
              <p className={s.hint}>
                <b>{ui.elegida.nombre}</b>: rejilla {ui.elegida.estado} · {ui.elegida.conAgua ? "acumula agua (estimado)" : "sin agua acumulada (estimado)"}
              </p>
            )}
            <p className={s.nota}>Red de 544 rejillas y 1.606 tramos (OSM y elevación Copernicus). No calcula profundidades ni tiempos de llegada.</p>
          </>
        )}
      </section>
    </>
  );
}

/* ───────────────────────── Riel ───────────────────────── */

function Riel({ fase, sel, onSel, hover, onHover, paradero, onParadero, nuevo, pestana, setPestana }: {
  fase: "antes" | "durante";
  sel: string | null;
  onSel: (id: string) => void;
  hover: string | null;
  onHover: (id: string | null) => void;
  paradero: string | null;
  onParadero: (id: string | null) => void;
  nuevo: boolean;
  pestana: string;
  setPestana: (v: string) => void;
}) {
  const sala = useSala();
  const datos = fase === "antes" ? sala.antes : sala.durante;
  const nPar = sala.transporte.datos ? sala.transporte.datos.expuestos.length + sala.transporte.datos.en_riesgo.length : null;
  return (
    <>
      <div className={s.rielTop} key={fase}>
        {fase === "durante" ? <QueCambio nuevo={nuevo} /> : <Recomendacion />}
      </div>
      <Tabs.Root className={s.tabs} value={pestana} onValueChange={setPestana}>
        <Tabs.List className={s.tabLista} aria-label="Detalle">
          <Tabs.Trigger value="prioridad" className={s.tab}>
            Limpieza <span className={s.cuenta}>{datos.filas.length || "–"}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="cuadrilla" className={s.tab}>
            Cuadrilla <span className={s.cuenta}>{sala.ruta?.misiones.length ?? "–"}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="transporte" className={s.tab}>
            Transporte <span className={`${s.cuenta} ${nPar ? s.cuentaOn : ""}`}>{nPar ?? "–"}</span>
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="prioridad" className={s.tabPanel}>
          {fase === "durante" && sala.durante.esInicial && datos.filas.length > 0 && <p className={s.hint}>Todavía sin evidencia de la lluvia: se muestra el ranking inicial.</p>}
          <Ranking filas={datos.filas} estado={datos.estado} sel={sel} onSel={onSel} hover={hover} onHover={onHover} />
          <p className={s.nota}>El puntaje ordena visitas; no es una probabilidad de inundación.</p>
        </Tabs.Content>
        <Tabs.Content value="cuadrilla" className={s.tabPanel}>
          <Misiones />
        </Tabs.Content>
        <Tabs.Content value="transporte" className={s.tabPanel}>
          <p className={s.hint}>
            {fase === "antes"
              ? "Paraderos cerca de rejillas de prioridad alta: en riesgo si llueve. Drena no desvía recorridos; el desvío lo confirma Red."
              : "Paraderos con agua observada cerca y su alternativo para el mismo servicio y sentido. El desvío lo confirma Red."}
          </p>
          <Transporte {...sala.transporte} activo={paradero} onSelect={onParadero} className={s.transporte} />
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}

/* ───────────────────────── Sala ───────────────────────── */

const CAPAS_ANTES: Capas = { cadenas: true, transporte: false, limites: true, catastro: false };
const CAPAS_DURANTE: Capas = { cadenas: true, transporte: true, limites: true, catastro: false };

function SalaInterior({ children }: { children: ReactNode }) {
  const vista = vistaDe(usePathname() ?? "/");
  const sala = useSala();
  const fase: "antes" | "durante" = vista === "durante" ? "durante" : "antes";
  const filas = fase === "antes" ? sala.antes.filas : sala.durante.filas;
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [paradero, setParadero] = useState<string | null>(null);
  const [pestana, setPestana] = useState("prioridad");
  const [mapaListo, setMapaListo] = useState(false);
  const [presentacion, setPresentacion] = useState(false);
  const [foco, setFoco] = useState<{ coord: LngLat; siempre: boolean } | null>(null);
  const [nuevo, setNuevo] = useState(false);
  const [capas, setCapas] = useState<Capas>(CAPAS_ANTES);
  const [estados, setEstados] = useState<Record<string, EstadoRejilla>>({});

  // Las capas por defecto cambian con la fase (Durante muestra transporte); el usuario puede ajustarlas después
  useEffect(() => {
    setCapas(vista === "durante" ? CAPAS_DURANTE : CAPAS_ANTES);
  }, [vista]);

  // Motor de flujo: solo pide la red (690 KB) y dibuja en la vista Simulación
  const puntosFlujo = useMemo(() => sala.antes.filas.map((p) => ({ id: p.sumidero_id, nombre: nombreFila(p), coord: [p.lon, p.lat] as LngLat })), [sala.antes.filas]);
  const simulando = vista === "simulacion";
  const flujoRef = useRef<Flujo | null>(null);
  const flujo = useFlujo({
    scenario: "base",
    puntos: puntosFlujo,
    estados,
    visible: simulando,
    activo: simulando,
    onClickRejilla: (id) => {
      const actual: EstadoRejilla = flujoRef.current?.estadoDe(id) ?? "limpia";
      setEstados((e) => ({ ...e, [id]: ESTADOS[(ESTADOS.indexOf(actual) + 1) % ESTADOS.length] }));
      flujoRef.current?.pulsar(id);
    },
  });
  flujoRef.current = flujo;
  // Al entrar a la simulación, el agua parte sola
  useEffect(() => {
    if (simulando && flujo.ui.cargado && !flujo.ui.corriendo) flujo.reproducir();
    if (!simulando && flujo.ui.corriendo) flujo.alternar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulando, flujo.ui.cargado]);

  const elegir = useCallback(
    (id: string) => {
      setSel((x) => (x === id ? null : id));
      setPestana("prioridad");
      const f = filas.find((p) => p.sumidero_id === id);
      if (f) setFoco({ coord: [f.lon, f.lat], siempre: false });
    },
    [filas],
  );
  const elegirParadero = useCallback((id: string | null) => {
    setParadero((p) => (id == null || p === id ? null : id));
    if (id) setPestana("transporte");
  }, []);
  const listo = useCallback(() => setMapaListo(true), []);

  // Llegada de un reporte en Durante: el mapa va al lugar, la fila se abre y la tarjeta se destaca una vez
  const ultimoId = sala.observaciones.datos[0]?.id;
  const visto = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (visto.current === undefined) {
      if (sala.observaciones.estado !== "cargando") visto.current = ultimoId ?? null;
      return;
    }
    if (!ultimoId || ultimoId === visto.current) return;
    visto.current = ultimoId;
    if (vista !== "durante") return;
    const o = sala.observaciones.datos[0];
    const f = sala.durante.filas.find((p) => p.sumidero_id === o.sumidero_id);
    const coord: LngLat | null = f ? [f.lon, f.lat] : o.caso_publico ? [o.caso_publico.lon, o.caso_publico.lat] : null;
    if (coord) setFoco({ coord, siempre: true });
    if (f) setSel(f.sumidero_id);
    setPestana("prioridad");
    setNuevo(true);
    const t = setTimeout(() => setNuevo(false), 2600);
    return () => clearTimeout(t);
  }, [ultimoId, sala.observaciones.estado, sala.observaciones.datos, sala.durante.filas, vista]);

  // Modo presentación: tecla P (fuera de campos de texto)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() !== "p" || e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable]")) return;
      setPresentacion((v) => !v);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const sello = vista === "antes" ? "Antes de la lluvia" : vista === "durante" ? "Durante la lluvia" : "Simulación · escurrimiento estimado";
  return (
    <div className={`${s.sala} ${presentacion ? s.presentacion : ""}`} data-vista={vista}>
      <Barra vista={vista} />
      <main className={s.escena}>
        <Mapa filas={filas} vista={vista} sel={sel} onSel={elegir} hover={hover} onHover={setHover} paradero={paradero} onParadero={elegirParadero} foco={foco} onListo={listo} flujo={flujo} capas={capas} setCapas={setCapas} />
        {conMapa(vista) && <EsqueletoMapa key={`esq-${vista}`} listo={mapaListo && (!simulando || flujo.ui.cargado || flujo.ui.error)} />}
        <Inicio activo={vista === "inicio"} mapaListo={mapaListo} />
        {vista === "validacion" && <div className={s.pagina}>{children}</div>}
        <aside className={s.riel} aria-hidden={!conMapa(vista)} inert={!conMapa(vista)}>
          {simulando ? (
            <Simulacion flujo={flujo} estados={estados} setEstados={setEstados} />
          ) : (
            conMapa(vista) && <Riel fase={fase} sel={sel} onSel={elegir} hover={hover} onHover={setHover} paradero={paradero} onParadero={elegirParadero} nuevo={nuevo} pestana={pestana} setPestana={setPestana} />
          )}
        </aside>
        {conMapa(vista) && (
          <div className={s.faseSello} key={`sello-${vista}`}>
            {sello}
          </div>
        )}
      </main>
      {presentacion && <span className={s.presTag}>Modo presentación · P para salir</span>}
      {vista !== "validacion" && children}
    </div>
  );
}

export default function Sala({ children }: { children: ReactNode }) {
  return (
    <SalaProvider>
      <SalaInterior>{children}</SalaInterior>
    </SalaProvider>
  );
}

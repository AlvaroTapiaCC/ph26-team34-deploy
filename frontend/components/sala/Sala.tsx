"use client";

// Sala de Drena: un solo armazón para el inicio y la central (Antes y Durante).
// El mapa se monta una vez, detrás del inicio, y queda listo cuando se entra a la central.

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import * as Select from "@radix-ui/react-select";
import * as Tabs from "@radix-ui/react-tabs";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePulso, type ObservacionPublica } from "@/lib/central";
import type { Cuadrilla } from "@/lib/cuadrilla";
import type { LngLat } from "@/lib/data";
import { boundsDe } from "@/lib/real";
import { APORTES, dos, nombreFila, puntaje, SalaProvider, useSala, type Fila } from "@/lib/sala";
import { horaSantiago, NIVEL_AGUA, useRecorridos, type EstadoConsulta, type EvidenciaAgua } from "@/lib/transporte";
import { useCapaCadenas } from "../central/capaCadenas";
import { useCapaContexto } from "./capaContexto";
import Transporte, { capasTransporte } from "../desktop/Transporte";
import DrenaMap, { type MapLabel, type MapPunto } from "../map/DrenaMap";
import { ESTADOS, FLUJO_CONFIG, picoEscenario, type EstadoRejilla } from "@/lib/flujo/config";
import { fuenteReportes, fuenteSimulada } from "@/lib/flujo/fuentes";
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
      {vista !== "inicio" && (
        <>
          <nav className={s.nav} aria-label="Vistas">
            {NAV.filter((n) => n.vista !== "validacion").map((n) => (
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
        </>
      )}
    </header>
  );
}

/* ───────────────────────── Inicio ───────────────────────── */

function Inicio({ activo, mapaListo }: { activo: boolean; mapaListo: boolean }) {
  return (
    <section className={`${s.inicio} ${activo ? s.inicioActivo : ""}`} aria-hidden={!activo} inert={!activo}>
      <div className={s.inicioVelo} aria-hidden />
      <div className={s.inicioCuerpo}>
        <div className={s.inicioTexto}>
          <p className={s.inicioEtiqueta}>Drenaje urbano · Santiago</p>
          <h1 className={s.titular}>
            Cada lluvia,<br />
            <span>una respuesta a tiempo.</span>
          </h1>
          <p className={s.inicioDescripcion}>
            Drena ayuda a la central municipal a decidir qué sumideros limpiar primero y por dónde enviar a las cuadrillas.
          </p>
          <Link href="/central/antes" className={s.cta} prefetch={mapaListo}>
            <span>Abrir la central</span>
            <i aria-hidden>→</i>
          </Link>
        </div>
        <figure className={s.inicioFoto}>
          <Image
            src="/img/san-carlos-apoquindo.jpg"
            alt="Autos entre barro y escombros tras el aluvión en San Carlos de Apoquindo."
            width={1200}
            height={675}
            sizes="(max-width: 68rem) 90vw, 48vw"
            priority
          />
          <figcaption>
            <span>San Carlos de Apoquindo · 9 oct 2026</span>
            <a href="https://www.cooperativa.cl/noticias/pais/desastres-naturales/inundaciones/asi-amanecio-san-carlos-de-apoquindo-tras-el-aluvion/2026-10-09/083733.html" target="_blank" rel="noreferrer">Foto: ATON / Cooperativa</a>
          </figcaption>
        </figure>
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

function EncabezadoDurante() {
  const { observaciones } = useSala();
  const n = observaciones.datos.length;
  return (
    <p className={s.faseDurante}>
      <b>Durante la lluvia</b>
      <span>{observaciones.estado === "cargando" && !n ? "Leyendo reportes…" : n ? `${n} ${n === 1 ? "reporte recibido" : "reportes recibidos"}` : "Sin reportes todavía"}</span>
    </p>
  );
}

function QueCambio({ nuevo }: { nuevo: boolean }) {
  const { observaciones, durante, cuadrilla } = useSala();
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
  // El reporte solo mueve su propia rejilla: su puesto previo es el que tendría hoy con el puntaje anterior
  const puestoAntes = ant != null && punto ? 1 + durante.filas.filter((r) => r !== punto && (r.prioridad ?? 0) > ant).length : null;
  const despacho = o.despachos?.find((d) => d.crew_id === cuadrilla?.id);
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
          <span>Puesto en la zona MUT</span>
          <p>
            <s>{puestoAntes ? `#${puestoAntes}` : "Fuera del plan"}</s> <i aria-hidden>→</i> <b>{punto ? `#${punto.puesto}` : "Sin dato"}</b>
            <small>
              puntaje {puntaje(ant)} → {puntaje(des)}
            </small>
          </p>
        </div>
        {despacho && (
          <div>
            <span>Siguiente parada · {despacho.cuadrilla}</span>
            <p>
              <s>{despacho.siguiente_antes ?? "Sin parada"}</s> <i aria-hidden>→</i> <b>{despacho.siguiente_despues ?? "Sin parada"}</b>
            </p>
          </div>
        )}
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
const SIN_ESTADOS: Record<string, EstadoRejilla> = {};

type Capas = { agua: boolean; calor: boolean; cadenas: boolean; transporte: boolean; limites: boolean; catastro: boolean; infra: boolean; colectores: boolean; criticos: boolean };
type ModoAgua = "real" | "simulada";

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
  modoAgua,
  setModoAgua,
  sinLluvia,
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
  modoAgua: ModoAgua;
  setModoAgua: (m: ModoAgua) => void;
  sinLluvia: boolean;
}) {
  const { observaciones, transporte, cuadrilla, ruta } = useSala();
  const [tresD, setTresD] = useState(false);
  const [menu, setMenu] = useState(false);
  const durante = vista === "durante";
  const simulacion = vista === "simulacion";
  const prioridades = useMemo(() => new Map(filas.flatMap((p) => (p.prioridad == null ? [] : [[p.sumidero_id, p.prio] as const]))), [filas]);
  const cadenas = useCapaCadenas(prioridades, durante ? observaciones.datos : [], durante ? (transporte.datos?.evidencia_agua ?? SIN_AGUA) : SIN_AGUA, capas.cadenas && !simulacion, transporte.datos?.parametros.vigencia_agua_horas ?? 6, transporte.datos?.parametros.aguas_abajo_m ?? 150);
  const verTransporte = capas.transporte && !simulacion;
  const contexto = useCapaContexto({ infra: capas.infra && !simulacion, colectores: capas.colectores && !simulacion, criticos: capas.criticos && !simulacion });
  const recorridos = useRecorridos(verTransporte);
  const recorridosFondo = useMemo(() => (verTransporte ? recorridos.flatMap((r) => r.tramos) : []), [verTransporte, recorridos]);
  const tp = useMemo(() => (verTransporte ? capasTransporte(transporte.datos, recorridos, paradero, onParadero) : { paraderos: [], recorridos: [], caminatas: [] }), [verTransporte, transporte.datos, recorridos, paradero, onParadero]);

  // Todas las rejillas del ranking como puntos (capa GL): las 5 primeras más grandes y con brillo, sin números
  const puntos = useMemo<MapPunto[]>(
    () =>
      simulacion
        ? []
        : (() => {
            const max = Math.max(...filas.map((f) => f.prioridad ?? 0), 0.0001);
            return filas.map((p) => ({
              id: p.sumidero_id,
              coord: [p.lon, p.lat] as LngLat,
              prio: p.prio,
              top: p.puesto <= TOP_DESTACADOS,
              peso: Math.pow((p.prioridad ?? 0) / max, 2),
              nombre: `${p.puesto} · ${nombreFila(p)}`,
              sub: `Puntaje ${puntaje(p.prioridad)}`,
            }));
          })(),
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
    (m: unknown, ml: unknown) => {
      onListo();
      const a = cadenas.onMapReady(m) as unknown;
      const b = flujo.alMapaListo(m);
      const c = contexto.onMapReady(m, ml);
      return () => {
        if (typeof a === "function") (a as () => void)();
        b();
        c();
      };
    },
    [cadenas, flujo, contexto, onListo],
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
        recorridosFondo={recorridosFondo}
        calor={capas.calor && !simulacion}
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
                Filtros <small>{Object.values(capas).filter(Boolean).length} de {Object.keys(capas).length}</small>
              </button>
              {menu && <FiltrosMapa capas={capas} alternar={alternar} aguaRealSinLluvia={capas.agua && modoAgua === "real" && sinLluvia} />}
            </span>
          )}
          {!simulacion && capas.agua && (
            <span className={s.segmento} role="radiogroup" aria-label="Datos del agua">
              <button type="button" role="radio" aria-checked={modoAgua === "real"} className={modoAgua === "real" ? s.segOn : ""} onClick={() => setModoAgua("real")}>
                Agua: datos reales
              </button>
              <button type="button" role="radio" aria-checked={modoAgua === "simulada"} className={modoAgua === "simulada" ? s.segOn : ""} onClick={() => setModoAgua("simulada")}>
                Simulada (1 de 5 tapadas)
              </button>
            </span>
          )}
          {capas.cadenas && !simulacion && cadenas.estado === "cargando" && <span className={s.chipInfo}>Cargando cadenas…</span>}
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
            {capas.infra && (
              <>
                <li>
                  <i className={s.lgMetro} />
                  Metro
                </li>
                <li>
                  <i className={s.lgPbn} />
                  Paso bajo nivel
                </li>
              </>
            )}
            {capas.cadenas && (
              <li>
                <i className={s.lgEscurre} />
                Escurrimiento ›
              </li>
            )}

          </ul>
        )}
      </DrenaMap>
    </div>
  );
});

function FiltrosMapa({ capas, alternar, aguaRealSinLluvia }: { capas: Capas; alternar: (capa: keyof Capas) => void; aguaRealSinLluvia: boolean }) {
  const [capaInfo, setCapaInfo] = useState<keyof Capas | null>(null);
  const controles = (capa: keyof Capas) => ({
    on: capas[capa],
    onClick: () => alternar(capa),
    info: capaInfo === capa,
    onInfo: () => setCapaInfo((actual) => actual === capa ? null : capa),
  });

  return (
    <div className={s.capasMenu} role="group" aria-label="Filtros del mapa">
      <p className={s.capasGrupo}>Agua</p>
      <CapaCheck
        {...controles("agua")}
        titulo="Agua en las calles"
        sub={`Agua corriendo por las calles según la pendiente y la lluvia, con columnas donde no cabe. Con datos reales usa la lluvia de Open-Meteo y las rejillas que Claude vio tapadas; simulada supone un 20 % de rejillas tapadas${aguaRealSinLluvia ? ". Sin lluvia ahora (Open-Meteo): el agua real no escurre" : ""}`}
      />
      <CapaCheck {...controles("calor")} titulo="Mapa de calor de riesgo" sub="Zonas donde se concentra el puntaje de prioridad; donde el riesgo es bajo el mapa queda gris" />
      <CapaCheck {...controles("cadenas")} titulo="Flujo entre rejillas" sub="Muestra hacia qué rejilla escurre el agua calle abajo, según la pendiente estimada. Si una se tapa, revisa las que reciben su agua" />
      <CapaCheck {...controles("criticos")} titulo="Inundaciones registradas (Las Condes)" sub="Lugares que la Municipalidad de Las Condes registró como inundados o en riesgo de inundación durante la temporada de lluvias de 2026" />
      <p className={s.capasGrupo}>Ciudad</p>
      <CapaCheck {...controles("infra")} titulo="Infraestructura crítica" sub="Metro, pasos bajo nivel, hospital y colegios (OSM): suben la consecuencia" />
      <CapaCheck {...controles("transporte")} titulo="Transporte público" sub="Recorridos de la zona (tenues), los afectados resaltados, paraderos expuestos y caminata al alternativo (GTFS DTPM)" />
      <CapaCheck {...controles("limites")} titulo="Límites comunales" sub="Providencia, Ñuñoa y Las Condes" />
      <CapaCheck {...controles("catastro")} titulo="Catastro completo" sub="3.002 rejillas DOH; el ranking existe solo en la zona MUT" />
    </div>
  );
}

/** Un filtro del mapa: casilla para mostrarlo u ocultarlo y una «i» que despliega qué muestra. */
function CapaCheck({ on, onClick, titulo, sub, info, onInfo }: { on: boolean; onClick: () => void; titulo: string; sub: string; info: boolean; onInfo: () => void }) {
  return (
    <div className={s.filtro}>
      <label className={`${s.capa} ${on ? s.capaOn : ""}`}>
        <input type="checkbox" checked={on} onChange={onClick} className={s.filtroCheck} />
        <span className={s.filtroCaja} aria-hidden />
        <b>{titulo}</b>
      </label>
      <button type="button" className={`${s.filtroInfo} ${info ? s.filtroInfoOn : ""}`} onClick={onInfo} aria-expanded={info} aria-label={`Qué muestra: ${titulo}`}>
        i
      </button>
      {info && <p className={s.filtroTexto}>{sub}</p>}
    </div>
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

/** Supuesto fijo del agua simulada: 1 de cada 5 rejillas tapada, elegida por su id (no cambia al cargar más red). */
function quintoDe(id: string): boolean {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 5) + 5) % 5 === 0;
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
            <p className={s.nota}>
              {ui.red
                ? `Red de ${ui.red.sumideros.toLocaleString("es-CL")} rejillas y ${ui.red.tramos.toLocaleString("es-CL")} tramos en Providencia, Ñuñoa y Las Condes (OSM y elevación Copernicus); se calcula lo que se ve y lo que está aguas arriba (${ui.red.tramosCargados.toLocaleString("es-CL")} tramos ahora).`
                : "Red de calles de OSM y elevación Copernicus."}{" "}
              No calcula profundidades ni tiempos de llegada.
            </p>
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
        {fase === "durante" ? (
          <>
            <EncabezadoDurante />
            <QueCambio nuevo={nuevo} />
          </>
        ) : (
          <Recomendacion />
        )}
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

const CAPAS_ANTES: Capas = { agua: true, calor: true, cadenas: false, transporte: false, limites: true, catastro: false, infra: false, colectores: false, criticos: false };
const CAPAS_DURANTE: Capas = { agua: true, calor: true, cadenas: false, transporte: true, limites: true, catastro: false, infra: false, colectores: false, criticos: false };

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
  const [modoAgua, setModoAgua] = useState<ModoAgua>("real");

  // Las capas por defecto cambian con la fase (Durante muestra transporte); el usuario puede ajustarlas después
  useEffect(() => {
    setCapas(vista === "durante" ? CAPAS_DURANTE : CAPAS_ANTES);
  }, [vista]);

  // Motor de flujo: solo pide la red (por teselas: lo visible y lo que está aguas arriba) y dibuja en la vista Simulación
  const puntosFlujo = useMemo(() => sala.antes.filas.map((p) => ({ id: p.sumidero_id, nombre: nombreFila(p), coord: [p.lon, p.lat] as LngLat })), [sala.antes.filas]);
  const simulando = vista === "simulacion";
  const aguaEnMapa = simulando || ((vista === "antes" || vista === "durante") && capas.agua);
  const aguaReal = !simulando && modoAgua === "real";
  const flujoRef = useRef<Flujo | null>(null);
  // Agua simulada en Antes/Durante: supuesto fijo de 1 de cada 5 rejillas tapadas (siempre las mismas), para ver dónde no cabe
  const [supuestas, setSupuestas] = useState<Record<string, EstadoRejilla>>(SIN_ESTADOS);
  const flujo = useFlujo({
    scenario: "base",
    puntos: puntosFlujo,
    estados: simulando ? estados : aguaReal ? SIN_ESTADOS : supuestas,
    fuente: aguaReal ? fuenteReportes : fuenteSimulada,
    visible: aguaEnMapa,
    soloAgua: !simulando,
    activo: aguaEnMapa,
    onClickRejilla: (id) => {
      const actual: EstadoRejilla = flujoRef.current?.estadoDe(id) ?? "limpia";
      setEstados((e) => ({ ...e, [id]: ESTADOS[(ESTADOS.indexOf(actual) + 1) % ESTADOS.length] }));
      flujoRef.current?.pulsar(id);
    },
  });
  flujoRef.current = flujo;
  // La red crece por teselas al mover el mapa: cada rejilla nueva recibe su supuesto, que depende solo de su id
  const nRejillas = flujo.ui.red?.sumiderosCargados ?? 0;
  useEffect(() => {
    if (!flujo.ui.cargado) return;
    setSupuestas(Object.fromEntries(flujo.rejillas().map((r) => [r.id, (quintoDe(r.id) ? "tapada" : "limpia") as EstadoRejilla])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flujo.ui.cargado, nRejillas]);
  // El agua corre sola cuando está a la vista. Con datos reales, la lluvia es la del pronóstico de Open-Meteo (mm/h);
  // simulada, la del escenario de la demo.
  const mmhReal = (sala.clima.datos?.lluvia_pronosticada_prox_24h_mm ?? 0) / 24;
  useEffect(() => {
    if (!flujo.ui.cargado) return;
    if (aguaEnMapa && !flujo.ui.corriendo) flujo.reproducir();
    if (!aguaEnMapa && flujo.ui.corriendo) flujo.alternar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aguaEnMapa, flujo.ui.cargado]);
  useEffect(() => {
    if (!flujo.ui.cargado || simulando) return;
    flujo.setLluvia(aguaReal ? Math.round(mmhReal * 10) / 10 : picoEscenario("base"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aguaReal, mmhReal, flujo.ui.cargado, simulando]);

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
        <Mapa filas={filas} vista={vista} sel={sel} onSel={elegir} hover={hover} onHover={setHover} paradero={paradero} onParadero={elegirParadero} foco={foco} onListo={listo} flujo={flujo} capas={capas} setCapas={setCapas} modoAgua={modoAgua} setModoAgua={setModoAgua} sinLluvia={mmhReal < 0.1} />
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

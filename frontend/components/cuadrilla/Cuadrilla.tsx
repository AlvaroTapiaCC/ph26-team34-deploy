"use client";

// App de cuadrilla (/cuadrilla, issue #38): siguiente parada en grande, aviso cuando el despacho
// la cambia, "Llegué" / "Terminé" y cierre con foto. Consulta la ruta cada 2,5 s (sin Realtime).
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Kicker, Logo } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  cambiarEstado,
  cerrarMision,
  getCuadrillas,
  getRuta,
  horaSantiago,
  resultadoCierre,
  textoMotivo,
  urlGoogleMaps,
  type Cuadrilla as TCuadrilla,
  type Mision,
  type RespCierre,
  type RutaCuadrilla,
} from "@/lib/cuadrilla";
import { comprimirFoto } from "@/lib/reportar";
import "../reportar/reportar.css";
import "./cuadrilla.css";

const INTERVALO_MS = 2500;
const CLAVE_CUADRILLA = "drena.cuadrilla";

const ESTADO_TXT: Record<string, string> = { pendiente: "Pendiente", en_camino: "En camino", en_sitio: "En el lugar" };

type Aviso = { texto: string; motivo: string; hora: string | null };
type Cierre = { resp: RespCierre; nombre: string };
type Accion = "en_camino" | "en_sitio" | "cerrar";
type Fallo = { texto: string; reintentar: (() => void) | null };

// Confirmación breve: usa el mismo verbo que el botón.
const LISTO_TXT: Record<"en_camino" | "en_sitio", string> = {
  en_camino: "Listo: la central sabe que vas en camino.",
  en_sitio: "Listo: la central sabe que llegaste.",
};

function leerCuadrilla(): string | null {
  const q = new URLSearchParams(window.location.search).get("id");
  if (q) return q;
  try {
    return localStorage.getItem(CLAVE_CUADRILLA);
  } catch {
    return null;
  }
}

function guardarCuadrilla(id: string | null) {
  try {
    if (id) localStorage.setItem(CLAVE_CUADRILLA, id);
    else localStorage.removeItem(CLAVE_CUADRILLA);
  } catch {}
  const u = new URL(window.location.href);
  if (id) u.searchParams.set("id", id);
  else u.searchParams.delete("id");
  window.history.replaceState(null, "", u);
}

function Elegir({ onElegir }: { onElegir: (id: string) => void }) {
  const [lista, setLista] = useState<TCuadrilla[] | null>(null);
  const [error, setError] = useState("");
  const cargar = useCallback(() => {
    setError("");
    setLista(null);
    getCuadrillas()
      .then(setLista)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(cargar, [cargar]);
  return (
    <section className="rp-sec">
      <Kicker tone="accent">Cuadrilla</Kicker>
      <h1 className="rp-h1">¿Qué cuadrilla eres?</h1>
      {error ? (
        <>
          <p className="rp-p rp-warn">{error}</p>
          <Button size="lg" className="rp-big" onClick={cargar}>
            Reintentar
          </Button>
        </>
      ) : !lista ? (
        <p className="rp-p">Cargando cuadrillas… (el servidor puede tardar hasta un minuto en despertar)</p>
      ) : lista.length === 0 ? (
        <p className="rp-p">No hay cuadrillas cargadas.</p>
      ) : (
        lista.map((c) => (
          <button key={c.id} className="cq-crew" onClick={() => onElegir(c.id)}>
            <b>{c.nombre}</b>
            <span>
              {c.carga} {c.carga === 1 ? "misión" : "misiones"} · {c.equipamiento.join(", ")}
              {c.is_simulated && " · simulada"}
            </span>
          </button>
        ))
      )}
    </section>
  );
}

function ResultadoCierre({ c, onSeguir }: { c: Cierre; onSeguir: () => void }) {
  const r = resultadoCierre(c.resp);
  const titulo = { verificado: "Rejilla verificada limpia", sin_verificar: "Misión cerrada sin verificar", rechazado: "Sigue tapada: la misión continúa" }[r];
  const texto = {
    verificado: "Claude revisó la foto y la rejilla se ve despejada. La misión quedó cerrada.",
    sin_verificar: "La misión quedó cerrada, pero la foto no se pudo verificar. La central la revisará.",
    rechazado: "La foto muestra la rejilla todavía obstruida. Termina la limpieza y vuelve a sacar la foto.",
  }[r];
  return (
    <section className={`rp-sec cq-res cq-res--${r}`}>
      <Kicker tone={r === "rechazado" ? "danger" : "accent"}>{c.nombre}</Kicker>
      <h1 className="rp-h1">{titulo}</h1>
      <p className="rp-p">{texto}</p>
      {r === "rechazado" && c.resp.motivo && <p className="rp-small">{c.resp.motivo}</p>}
      <Button variant="primary" size="lg" className="rp-big" onClick={onSeguir}>
        {r === "rechazado" ? "Volver a la misión" : "Ver la siguiente parada"}
      </Button>
    </section>
  );
}

export default function Cuadrilla() {
  const [crewId, setCrewId] = useState<string | null>(null);
  const [listo, setListo] = useState(false);
  const [crew, setCrew] = useState<TCuadrilla | null>(null);
  const [ruta, setRuta] = useState<RutaCuadrilla | null>(null);
  const [sinConexion, setSinConexion] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [ocupado, setOcupado] = useState<Accion | null>(null);
  const [error, setError] = useState("");
  const [fallo, setFallo] = useState<Fallo | null>(null);
  const [listoTxt, setListoTxt] = useState<string | null>(null);
  const [cierre, setCierre] = useState<Cierre | null>(null);
  const siguienteRef = useRef<string | null | undefined>(undefined); // undefined = aún no se carga
  const propioRef = useRef<string | null>(null); // misión que cerró esta app: no es un cambio "de la central"
  const enCursoRef = useRef(false);
  const fotoRef = useRef<HTMLInputElement>(null);
  const listoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const confirmar = (t: string) => {
    clearTimeout(listoTimer.current);
    setListoTxt(t);
    listoTimer.current = setTimeout(() => setListoTxt(null), 3500);
  };
  useEffect(() => () => clearTimeout(listoTimer.current), []);

  useEffect(() => {
    setCrewId(leerCuadrilla());
    setListo(true);
  }, []);

  useEffect(() => {
    if (!crewId) return;
    getCuadrillas()
      .then((l) => setCrew(l.find((c) => c.id === crewId) ?? null))
      .catch(() => {});
  }, [crewId]);

  const actualizar = useCallback(async () => {
    if (!crewId || enCursoRef.current) return;
    enCursoRef.current = true;
    try {
      const r = await getRuta(crewId);
      setSinConexion(false);
      setRuta(r);
      const sig = r.misiones[0] ?? null;
      const id = sig?.mission_id ?? null;
      const previo = siguienteRef.current;
      if (previo !== undefined && previo !== id && id && previo !== propioRef.current) {
        const c = r.ultimo_cambio;
        setAviso({
          texto: `Nueva siguiente parada: ${sig.nombre}`,
          motivo: c ? textoMotivo(c) : "la central recalculó el plan",
          hora: c?.hora ? horaSantiago(c.hora) : null,
        });
        try {
          navigator.vibrate?.([200, 100, 200]);
        } catch {}
      }
      siguienteRef.current = id;
    } catch (e) {
      if (e instanceof ApiError && e.estado === 404) {
        setError(`La cuadrilla ${crewId} no existe.`);
        setCrewId(null);
        guardarCuadrilla(null);
      } else setSinConexion(true);
    } finally {
      enCursoRef.current = false;
    }
  }, [crewId]);

  useEffect(() => {
    if (!crewId) return;
    siguienteRef.current = undefined;
    setRuta(null);
    setAviso(null);
    actualizar();
    const t = setInterval(() => {
      if (!document.hidden) actualizar();
    }, INTERVALO_MS);
    const vis = () => !document.hidden && actualizar();
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [crewId, actualizar]);

  const elegir = (id: string) => {
    setError("");
    guardarCuadrilla(id);
    setCrewId(id);
  };

  async function avanzar(m: Mision, destino: "en_camino" | "en_sitio") {
    setFallo(null);
    setOcupado(destino);
    try {
      if (destino === "en_sitio" && m.estado === "pendiente") await cambiarEstado(m.mission_id, "en_camino");
      await cambiarEstado(m.mission_id, destino);
      confirmar(LISTO_TXT[destino]);
    } catch (e) {
      if (e instanceof ApiError && e.estado === 409) setFallo({ texto: "La misión cambió de estado en otro dispositivo. Actualicé la parada.", reintentar: null });
      else setFallo({ texto: `No se pudo avisar a la central: ${(e as Error).message}.`, reintentar: () => avanzar(m, destino) });
    } finally {
      setOcupado(null);
      await actualizar();
    }
  }

  async function cerrar(m: Mision, file: File) {
    setFallo(null);
    setOcupado("cerrar");
    try {
      const foto = await comprimirFoto(file);
      propioRef.current = m.mission_id;
      const resp = await cerrarMision(m.mission_id, foto, file.name || "cierre.jpg");
      setCierre({ resp, nombre: m.nombre });
      setAviso(null);
    } catch (e) {
      propioRef.current = null;
      if (e instanceof ApiError && e.estado === 409) setFallo({ texto: "La misión ya no se puede cerrar (cambió de estado). Actualicé la parada.", reintentar: null });
      else setFallo({ texto: `No se pudo cerrar la misión: ${(e as Error).message}. La foto quedó lista para reintentar.`, reintentar: () => cerrar(m, file) });
    } finally {
      setOcupado(null);
      if (fotoRef.current) fotoRef.current.value = "";
      await actualizar();
    }
  }

  if (!listo) return null;

  const misiones = ruta?.misiones ?? [];
  const sig = misiones[0];
  const resto = misiones.slice(1);
  const conCoord = misiones.filter((m): m is Mision & { lat: number; lon: number } => m.lat != null && m.lon != null);

  return (
    <main className="rp cq">
      <header className="rp-head">
        <Logo size={24} />
        {crewId && (
          <button className="btn btn--secondary btn--md cq-cambiar" onClick={() => (guardarCuadrilla(null), setCrewId(null), setCrew(null), setFallo(null))}>
            Cambiar cuadrilla
          </button>
        )}
      </header>

      {!crewId ? (
        <>
          {error && <p className="rp-p rp-warn">{error}</p>}
          <Elegir onElegir={elegir} />
        </>
      ) : cierre ? (
        <ResultadoCierre c={cierre} onSeguir={() => setCierre(null)} />
      ) : (
        <>
          <div className="cq-crewbar">
            <b>{crew?.nombre ?? crewId}</b>
            {crew?.is_simulated && <span className="cq-tag">Cuadrilla simulada · demo</span>}
            <span className={`cq-live ${sinConexion ? "is-off" : ""}`} role="status">{sinConexion ? "Sin conexión · reintentando" : "En vivo"}</span>
          </div>

          {aviso && (
            <div className="cq-aviso" role="alert">
              <div>
                <b>{aviso.texto}</b>
                <span>
                  Motivo: {aviso.motivo}
                  {aviso.hora && ` · ${aviso.hora}`}
                </span>
              </div>
              <button aria-label="Cerrar aviso" onClick={() => setAviso(null)}>
                ✕
              </button>
            </div>
          )}

          {fallo && (
            <div className="cq-fallo" role="alert">
              <p>{fallo.texto}</p>
              {fallo.reintentar && (
                <Button size="lg" className="rp-big" disabled={!!ocupado} onClick={fallo.reintentar}>
                  Reintentar
                </Button>
              )}
            </div>
          )}
          {listoTxt && (
            <p className="cq-listo" role="status">
              {listoTxt}
            </p>
          )}

          {!ruta ? (
            <p className="rp-p">Cargando la ruta…</p>
          ) : !sig ? (
            <section className="rp-sec rp-center">
              <h1 className="rp-h1">Sin misiones asignadas</h1>
              <p className="rp-p">Cuando la central te asigne una rejilla aparecerá aquí sola.</p>
            </section>
          ) : (
            <>
              <section className="cq-next" key={sig.mission_id}>
                <Kicker tone="accent">Siguiente parada · {ESTADO_TXT[sig.estado] ?? sig.estado}</Kicker>
                <h1 className="cq-next__name">{sig.nombre}</h1>
                {sig.sumidero_id && <p className="rp-small">Rejilla {sig.sumidero_id}</p>}
                <div className="rp-two">
                  {sig.estado === "pendiente" ? (
                    <Button variant="primary" size="lg" className="rp-big cq-main" disabled={!!ocupado} aria-busy={ocupado === "en_camino"} onClick={() => avanzar(sig, "en_camino")}>
                      {ocupado === "en_camino" ? "Enviando…" : "Voy en camino"}
                    </Button>
                  ) : sig.estado === "en_camino" ? (
                    <Button variant="primary" size="lg" className="rp-big cq-main" disabled={!!ocupado} aria-busy={ocupado === "en_sitio"} onClick={() => avanzar(sig, "en_sitio")}>
                      {ocupado === "en_sitio" ? "Enviando…" : "Llegué"}
                    </Button>
                  ) : null}
                  {sig.estado === "en_camino" && (
                    // Como antes: se puede cerrar con foto sin marcar «Llegué» (acción secundaria)
                    <Button size="lg" className="rp-big" disabled={!!ocupado} aria-busy={ocupado === "cerrar"} onClick={() => fotoRef.current?.click()}>
                      {ocupado === "cerrar" ? "Enviando foto…" : "Ya la limpié: cerrar con foto"}
                    </Button>
                  )}
                  {sig.estado !== "pendiente" && sig.estado !== "en_camino" && (
                    <Button variant="primary" size="lg" className="rp-big cq-main" disabled={!!ocupado} aria-busy={ocupado === "cerrar"} onClick={() => fotoRef.current?.click()}>
                      {ocupado === "cerrar" ? "Enviando foto…" : "Cerrar con foto"}
                    </Button>
                  )}
                  {ocupado === "cerrar" && <p className="rp-small" role="status">Claude revisa la foto. Puede tardar hasta un minuto; no cierres la página.</p>}
                  <input
                    ref={fotoRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) cerrar(sig, f);
                    }}
                  />
                  {conCoord.length > 0 && (
                    <a className="btn btn--secondary btn--md cq-maps" href={urlGoogleMaps(conCoord)} target="_blank" rel="noopener noreferrer">
                      Abrir en Google Maps ↗
                    </a>
                  )}
                </div>
              </section>

              {resto.length > 0 && (
                <section className="rp-sec">
                  <Kicker>Después · {resto.length} {resto.length === 1 ? "parada" : "paradas"}</Kicker>
                  <ol className="cq-list">
                    {resto.map((m, i) => (
                      <li key={m.mission_id}>
                        <span className="cq-list__n">{i + 2}</span>
                        <span>{m.nombre}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}

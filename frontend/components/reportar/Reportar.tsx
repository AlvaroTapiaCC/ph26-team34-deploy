"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Kicker, Logo } from "@/components/ui";
import {
  aCsv,
  descargar,
  esDeHoy,
  exportarDia,
  leerCola,
  nuevoId,
  registrar,
  type ClasificacionRejilla,
  type LecturaTexto,
  type Observacion,
  type TipoReporte,
} from "@/lib/observations";
import { clasificarRejilla, clasificarTexto, comprimirFoto, distM, pedirGps, type Gps } from "@/lib/reportar";
import "./reportar.css";

const REJILLA_TXT = { limpia: "Limpia", parcial: "Parcialmente tapada", tapada: "Tapada", no_evaluable: "No se puede evaluar" } as const;
const NIVEL_TXT = {
  sin_agua: "Sin agua",
  cuneta: "Agua en la cuneta",
  hasta_vereda: "Agua hasta la vereda",
  sobre_vereda: "Agua sobre la vereda",
  no_evaluable: "No se puede evaluar",
} as const;
const MATERIAL_TXT: Record<string, string> = { hojas: "hojas", basura: "basura", sedimento: "tierra o barro" };
const CONF_TXT = { alta: "alta", media: "media", baja: "baja" } as const;
const TIPO_TXT: Record<string, string> = {
  anegamiento: "Anegamiento",
  rejilla_tapada: "Rejilla tapada",
  basura: "Basura",
  arbol_caido: "Árbol caído",
  otro: "Otro",
};

// Prueba de campo: zona MUT, 47 rejillas (plan D4)
const N_REJILLAS = 47;

type Paso = "elegir" | "captura" | "enviando" | "resultado" | "urgencia" | "error";
type Cercana = { id: string; d: number };

function Emergencia() {
  return (
    <div className="rp-tel">
      <a className="btn btn--danger btn--lg rp-big" href="tel:133">
        133 · Carabineros
      </a>
      <a className="btn btn--danger btn--lg rp-big" href="tel:132">
        132 · Bomberos
      </a>
      <a className="btn btn--danger btn--lg rp-big" href="tel:131">
        131 · Ambulancia
      </a>
    </div>
  );
}

export default function Reportar() {
  const [campo, setCampo] = useState(false);
  const [paso, setPaso] = useState<Paso>("elegir");
  const [tipo, setTipo] = useState<TipoReporte>("rejilla");
  const [gps, setGps] = useState<Gps | null>(null);
  const [gpsEstado, setGpsEstado] = useState<"buscando" | "ok" | "error">("buscando");
  const [gpsMsg, setGpsMsg] = useState("");
  const [foto, setFoto] = useState<Blob | null>(null);
  const [fotoUrl, setFotoUrl] = useState<string | null>(null);
  const [archivo, setArchivo] = useState("");
  const [texto, setTexto] = useState("");
  const [lento, setLento] = useState(false);
  const [error, setError] = useState("");
  const [resultado, setResultado] = useState<Observacion | null>(null);
  const [rejillaNum, setRejillaNum] = useState(1);
  const [idIde, setIdIde] = useState<string | null>(null);
  const [cercanas, setCercanas] = useState<Cercana[]>([]);
  const [capturas, setCapturas] = useState<Observacion[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const rejillasRef = useRef<{ id: string; c: [number, number] }[] | null>(null);

  const buscarGps = useCallback(async () => {
    setGpsEstado("buscando");
    setGpsMsg("");
    try {
      const g = await pedirGps();
      setGps(g);
      setGpsEstado("ok");
    } catch (e) {
      setGps(null);
      setGpsEstado("error");
      setGpsMsg((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setCampo(new URLSearchParams(window.location.search).get("campo") === "1");
    setCapturas(leerCola().filter(esDeHoy));
    buscarGps();
  }, [buscarGps]);

  // Prueba de campo: rejillas del catastro a ≤60 m del GPS, para elegir el ID_IDE
  useEffect(() => {
    if (!campo || !gps) return setCercanas([]);
    (async () => {
      try {
        if (!rejillasRef.current) {
          const j = (await (await fetch("/data/rejillas.geojson")).json()) as { features: { properties: { id: string }; geometry: { coordinates: [number, number] } }[] };
          rejillasRef.current = j.features.map((f) => ({ id: f.properties.id, c: f.geometry.coordinates }));
        }
        const lista = rejillasRef.current
          .map((r) => ({ id: r.id, d: Math.round(distM([gps.lon, gps.lat], r.c)) }))
          .filter((r) => r.d <= 60)
          .sort((a, b) => a.d - b.d)
          .slice(0, 4);
        setCercanas(lista);
        setIdIde((cur) => (cur && lista.some((l) => l.id === cur) ? cur : null));
      } catch {
        setCercanas([]);
      }
    })();
  }, [campo, gps]);

  useEffect(() => () => void (fotoUrl && URL.revokeObjectURL(fotoUrl)), [fotoUrl]);

  function reiniciar(siguiente = false) {
    setFoto(null);
    setFotoUrl(null);
    setTexto("");
    setResultado(null);
    setError("");
    setIdIde(null);
    setPaso("elegir");
    if (siguiente) setRejillaNum((n) => Math.min(N_REJILLAS, n + 1));
    buscarGps();
  }

  function elegir(t: TipoReporte) {
    setTipo(t);
    setPaso("captura");
    setError("");
    buscarGps();
  }

  async function alElegirFoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const blob = await comprimirFoto(f);
    const hora = new Date();
    const pref = tipo === "agua" ? "agua" : "rejilla";
    const num = campo ? `-${String(rejillaNum).padStart(2, "0")}` : "";
    setArchivo(`${pref}${num}_${hora.toISOString().replace(/[:.]/g, "-")}.jpg`);
    setFoto(blob);
    setFotoUrl(URL.createObjectURL(blob));
    buscarGps(); // posición fresca en el momento de la foto
  }

  async function enviar(sinGps = false) {
    setPaso("enviando");
    setLento(false);
    setError("");
    const aviso = setTimeout(() => setLento(true), 8000);
    try {
      const base: Observacion = {
        id: nuevoId(),
        tipo,
        lat: sinGps || !gps ? null : gps.lat,
        lon: sinGps || !gps ? null : gps.lon,
        precision_m: sinGps || !gps ? null : gps.precision_m,
        sin_gps: sinGps || !gps,
        hora: new Date().toISOString(),
        clasificacion: null,
        archivo: null,
        ...(campo ? { rejilla_num: rejillaNum, id_ide: idIde } : {}),
        enviado: false,
      };
      let obs: Observacion;
      if (tipo === "texto") {
        const r = await clasificarTexto(texto.trim());
        obs = { ...base, clasificacion: r.lectura, texto: texto.trim(), urgente: r.urgente };
      } else {
        const r = await clasificarRejilla(foto!, archivo);
        obs = { ...base, clasificacion: r.clasificacion, archivo };
      }
      const guardada = await registrar(obs, tipo === "texto" ? null : foto);
      setResultado(guardada);
      setCapturas(leerCola().filter(esDeHoy));
      setPaso(guardada.urgente ? "urgencia" : "resultado");
    } catch (e) {
      setError((e as Error).message);
      setPaso("error");
    } finally {
      clearTimeout(aviso);
    }
  }

  const puedeEnviar = tipo === "texto" ? texto.trim().length >= 3 : !!foto;
  const gpsTxt =
    gpsEstado === "buscando" ? "Buscando GPS…" : gpsEstado === "ok" && gps ? `GPS listo · precisión ±${gps.precision_m} m` : `Sin GPS${gpsMsg ? ` · ${gpsMsg}` : ""}`;

  const gpsBar = (
    <div className={`rp-gps rp-gps--${gpsEstado}`} role="status">
      <span>{gpsTxt}</span>
      {gpsEstado !== "buscando" && (
        <button className="rp-link" onClick={buscarGps}>
          {gpsEstado === "ok" ? "Actualizar" : "Reintentar"}
        </button>
      )}
    </div>
  );

  return (
    <main className="rp">
      <header className="rp-head">
        <Logo size={22} />
        <Kicker tone="muted">{campo ? "Prueba de campo" : "Reportar"}</Kicker>
      </header>

      {paso === "elegir" && (
        <section className="rp-sec">
          <h1 className="rp-h1">¿Qué quieres reportar?</h1>
          {campo && (
            <label className="rp-field">
              <span>Número de rejilla (1–{N_REJILLAS})</span>
              <select value={rejillaNum} onChange={(e) => setRejillaNum(Number(e.target.value))}>
                {Array.from({ length: N_REJILLAS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    Rejilla {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button variant="primary" className="rp-big" onClick={() => elegir("rejilla")}>
            Foto de la rejilla
          </Button>
          <Button variant="secondary" className="rp-big" onClick={() => elegir("agua")}>
            Foto del agua
          </Button>
          <Button variant="secondary" className="rp-big" onClick={() => elegir("texto")}>
            Solo texto
          </Button>
          {gpsBar}
        </section>
      )}

      {paso === "captura" && (
        <section className="rp-sec">
          <h1 className="rp-h1">{tipo === "texto" ? "Cuéntanos qué pasa" : tipo === "agua" ? "Foto del agua" : "Foto de la rejilla"}</h1>
          {campo && <div className="rp-chip">Rejilla {rejillaNum}</div>}

          {tipo === "texto" ? (
            <textarea className="rp-text" rows={5} placeholder="Ej.: la calle está inundada en Irarrázaval con Los Jesuitas desde hace una hora" value={texto} onChange={(e) => setTexto(e.target.value)} />
          ) : (
            <>
              <ul className="rp-guide">
                {tipo === "rejilla" ? (
                  <>
                    <li>Desde arriba, mirando hacia abajo</li>
                    <li>A 1 metro de la rejilla</li>
                    <li>Que se vea la rejilla completa</li>
                  </>
                ) : (
                  <>
                    <li>Que se vea el agua y la vereda</li>
                    <li>Desde un lugar seguro</li>
                  </>
                )}
              </ul>
              <input ref={inputRef} type="file" accept="image/*" capture="environment" hidden onChange={alElegirFoto} />
              {fotoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="rp-prev" src={fotoUrl} alt="Foto tomada" />
              ) : null}
              <Button variant={fotoUrl ? "secondary" : "primary"} className="rp-big" onClick={() => inputRef.current?.click()}>
                {fotoUrl ? "Volver a sacar la foto" : "Sacar foto"}
              </Button>
            </>
          )}

          {gpsBar}

          {campo && tipo !== "texto" && (
            <div className="rp-field">
              <span>Rejilla del catastro (opcional)</span>
              <div className="rp-opts">
                {cercanas.length === 0 && <em>{gps ? "Ninguna a menos de 60 m" : "Necesita GPS"}</em>}
                {cercanas.map((c) => (
                  <button key={c.id} className={`rp-opt ${idIde === c.id ? "is-on" : ""}`} onClick={() => setIdIde(idIde === c.id ? null : c.id)}>
                    {c.id} · {c.d} m
                  </button>
                ))}
              </div>
            </div>
          )}

          {gpsEstado === "error" ? (
            <div className="rp-two">
              <Button variant="secondary" className="rp-big" onClick={buscarGps}>
                Reintentar GPS
              </Button>
              <Button variant="primary" className="rp-big" disabled={!puedeEnviar} onClick={() => enviar(true)}>
                Enviar sin GPS
              </Button>
            </div>
          ) : (
            <Button variant="primary" className="rp-big" disabled={!puedeEnviar || gpsEstado === "buscando"} onClick={() => enviar(false)}>
              {gpsEstado === "buscando" ? "Esperando GPS…" : "Enviar reporte"}
            </Button>
          )}
          <button className="rp-link" onClick={() => reiniciar()}>
            ← Cambiar tipo de reporte
          </button>
        </section>
      )}

      {paso === "enviando" && (
        <section className="rp-sec rp-center" role="status">
          <div className="rp-spin" aria-hidden />
          <h1 className="rp-h1">{tipo === "texto" ? "Leyendo tu mensaje…" : "Analizando la foto…"}</h1>
          <p className="rp-p">Puede tardar unos 10 segundos.</p>
          {lento && <p className="rp-p rp-warn">Despertando el servidor. La primera vez puede tardar casi un minuto. No cierres la página.</p>}
        </section>
      )}

      {paso === "error" && (
        <section className="rp-sec">
          <h1 className="rp-h1">No pudimos enviarlo</h1>
          <p className="rp-p">{error}</p>
          <Button variant="primary" className="rp-big" onClick={() => enviar(gpsEstado !== "ok")}>
            Reintentar
          </Button>
          <button className="rp-link" onClick={() => setPaso("captura")}>
            ← Volver
          </button>
        </section>
      )}

      {paso === "urgencia" && resultado && (
        <section className="rp-sec rp-urg">
          <h1 className="rp-h1">Si hay personas en riesgo, llama ahora</h1>
          <Emergencia />
          <p className="rp-p">Tu reporte quedó registrado. Llama primero; después puedes seguir.</p>
          <Button variant="secondary" className="rp-big" onClick={() => reiniciar()}>
            Nuevo reporte
          </Button>
        </section>
      )}

      {paso === "resultado" && resultado && <Resultado obs={resultado} campo={campo} foto={foto} onOtra={() => setPaso("captura")} onNuevo={reiniciar} />}

      {campo && capturas.length > 0 && paso !== "enviando" && (
        <section className="rp-sec rp-lista">
          <Kicker tone="muted">Capturas de hoy ({capturas.length})</Kicker>
          <ul>
            {capturas.map((o) => {
              const c = o.clasificacion && "rejilla" in o.clasificacion ? o.clasificacion : null;
              return (
                <li key={o.id}>
                  <b>#{o.rejilla_num ?? "–"}</b> {o.tipo} · {new Date(o.hora).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })} · {c ? `${c.rejilla} (${c.confianza})` : "—"}
                  {o.sin_gps ? " · sin GPS" : ""}
                  {o.enviado ? " · enviado" : " · en cola"}
                </li>
              );
            })}
          </ul>
          <div className="rp-two">
            <Button variant="secondary" className="rp-big" onClick={() => exportarDia(capturas)}>
              Exportar JSON y CSV
            </Button>
            <Button variant="secondary" className="rp-big" onClick={() => descargar(`prueba-campo-${new Date().toISOString().slice(0, 10)}.csv`, aCsv(capturas), "text/csv")}>
              Solo CSV
            </Button>
          </div>
        </section>
      )}
    </main>
  );
}

function Resultado({ obs, campo, foto, onOtra, onNuevo }: { obs: Observacion; campo: boolean; foto: Blob | null; onOtra: () => void; onNuevo: (sig?: boolean) => void }) {
  const esTexto = obs.tipo === "texto";
  const r = !esTexto ? (obs.clasificacion as ClasificacionRejilla) : null;
  const t = esTexto ? (obs.clasificacion as LecturaTexto) : null;
  const repetir = r && (!r.evaluable || r.rejilla === "no_evaluable" || r.confianza === "baja");

  return (
    <section className="rp-sec">
      <h1 className="rp-h1">{repetir ? "Necesitamos otra foto" : "Listo, esto vimos"}</h1>
      {r && (
        <dl className="rp-res">
          {obs.tipo === "rejilla" && (
            <>
              <dt>Estado de la rejilla</dt>
              <dd className={`rp-est rp-est--${r.rejilla}`}>{REJILLA_TXT[r.rejilla]}</dd>
              <dt>Material</dt>
              <dd>{r.material.length ? r.material.map((m) => MATERIAL_TXT[m] ?? m).join(", ") : "No se ve material"}</dd>
            </>
          )}
          <dt>Nivel de agua</dt>
          <dd>{NIVEL_TXT[r.nivel_agua]}</dd>
          <dt>Confianza</dt>
          <dd>{CONF_TXT[r.confianza]}</dd>
          {r.nota && <dd className="rp-nota">{r.nota}</dd>}
        </dl>
      )}
      {t && (
        <dl className="rp-res">
          <dt>Tipo</dt>
          <dd>{TIPO_TXT[t.tipo] ?? t.tipo}</dd>
          <dt>Gravedad</dt>
          <dd>{t.gravedad}</dd>
          <dt>Nivel de agua</dt>
          <dd>{NIVEL_TXT[t.nivel_agua]}</dd>
          {t.ubicacion_texto && (
            <>
              <dt>Lugar</dt>
              <dd>{t.ubicacion_texto}</dd>
            </>
          )}
        </dl>
      )}
      {repetir && <p className="rp-p rp-warn">La foto no se pudo evaluar bien. Sácala de nuevo desde arriba, a 1 m, con la rejilla completa y buena luz.</p>}
      <p className="rp-p rp-small">
        {obs.sin_gps ? "Sin GPS. " : `GPS ±${obs.precision_m} m. `}
        {obs.enviado ? "Enviado al servidor." : "Guardado en este teléfono; se enviará cuando el servidor lo reciba."}
      </p>
      {campo && foto && obs.archivo && (
        <Button variant="secondary" className="rp-big" onClick={() => descargar(obs.archivo!, foto, "image/jpeg")}>
          Guardar foto en el teléfono
        </Button>
      )}
      {repetir ? (
        <Button variant="primary" className="rp-big" onClick={onOtra}>
          Sacar otra foto
        </Button>
      ) : (
        <Button variant="primary" className="rp-big" onClick={() => onNuevo(campo)}>
          {campo ? "Siguiente rejilla" : "Nuevo reporte"}
        </Button>
      )}
      {!repetir && campo && (
        <button className="rp-link" onClick={() => onNuevo(false)}>
          Repetir la misma rejilla
        </button>
      )}
    </section>
  );
}

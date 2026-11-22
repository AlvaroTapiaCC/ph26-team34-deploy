"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Logo } from "@/components/ui";
import { enviarObservacion, nuevoId, type ClasificacionAgua } from "@/lib/observations";
import { imagenJpeg, NIVEL_AGUA_TXT } from "@/lib/reportar";
import "./reportar.css";

type RespuestaCuadro = {
  clasificacion: ClasificacionAgua | null;
  recalculado: boolean;
  sumidero_id: string | null;
};

type Cuadro = { hora: Date; nivel: ClasificacionAgua["nivel_agua"] };

export default function CamaraFija() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sesionRef = useRef<AbortController | null>(null);
  const [activa, setActiva] = useState(false);
  const [estado, setEstado] = useState("");
  const [ultimoCuadro, setUltimoCuadro] = useState<Cuadro | null>(null);

  useEffect(() => () => {
    sesionRef.current?.abort();
    sesionRef.current = null;
  }, []);

  function detener(mensaje: string) {
    sesionRef.current?.abort();
    sesionRef.current = null;
    setActiva(false);
    setEstado(mensaje);
  }

  async function iniciar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const video = videoRef.current;
    if (!video || sesionRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setEstado("Abre esta página por HTTPS en un navegador con acceso a la cámara.");
      return;
    }

    const datos = new FormData(event.currentTarget);
    const lat = Number(datos.get("lat"));
    const lon = Number(datos.get("lon"));
    const intervaloMs = Number(datos.get("intervalo")) * 1000;
    const sesion = new AbortController();
    const { signal } = sesion;
    sesionRef.current = sesion;
    setActiva(true);
    setEstado("Abriendo cámara…");
    setUltimoCuadro(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (signal.aborted) {
        stream.getTracks().forEach((pista) => pista.stop());
        return;
      }

      let temporizador: ReturnType<typeof setTimeout> | undefined;
      signal.addEventListener("abort", () => {
        clearTimeout(temporizador);
        stream.getTracks().forEach((pista) => pista.stop());
        video.srcObject = null;
      }, { once: true });
      stream.getVideoTracks().forEach((pista) => {
        pista.addEventListener("ended", () => detener("La cámara se desconectó."), { once: true, signal });
      });
      video.srcObject = stream;
      await video.play();

      const capturar = async () => {
        if (signal.aborted) return;
        const inicio = performance.now();
        const hora = new Date();
        try {
          setEstado("Enviando cuadro…");
          const foto = await imagenJpeg(video, video.videoWidth, video.videoHeight);
          if (signal.aborted) return;
          if (!foto) throw new Error("No se pudo capturar el cuadro.");
          const respuesta = await enviarObservacion({
            id: nuevoId(), tipo: "agua", fuente: "camara_fija", lat, lon,
            hora: hora.toISOString(), archivo: "camara-fija.jpg",
          }, foto, signal);
          if (!respuesta.ok) throw new Error(`El servidor respondió ${respuesta.status}.`);
          const cuadro = await respuesta.json() as RespuestaCuadro;
          if (signal.aborted) return;
          setUltimoCuadro({ hora, nivel: cuadro.clasificacion?.nivel_agua ?? "no_evaluable" });
          setEstado(cuadro.sumidero_id === null
            ? "Cuadro recibido sin un sumidero asociado. Revisa la ubicación del tramo."
            : cuadro.recalculado ? "Cuadro recibido." : "Cuadro recibido. El recálculo quedó pendiente.");
        } catch (error) {
          if (signal.aborted) return;
          setEstado(error instanceof TypeError ? "No se pudo conectar con el servidor."
            : error instanceof Error ? error.message : "No se pudo enviar el cuadro.");
        }
        temporizador = setTimeout(capturar, Math.max(0, intervaloMs - (performance.now() - inicio)));
      };

      void capturar();
    } catch (error) {
      if (signal.aborted) return;
      detener(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Permite el acceso a la cámara para iniciar la captura."
        : "No se pudo abrir la cámara.");
    }
  }

  return (
    <main className="rp">
      <header className="rp-head">
        <Logo size={22} />
        <Link href="/reportar" className="rp-link">Volver a Reportar</Link>
      </header>
      <form className="rp-sec" onSubmit={iniciar}>
        <h1 className="rp-h1">Cámara fija</h1>
        <div className="rp-sec rp-ajustes" hidden={activa}>
          <fieldset className="rp-coordenadas" disabled={activa}>
            <legend>Ubicación del tramo observado</legend>
            <label className="rp-field">
              <span>Latitud</span>
              <input name="lat" type="number" inputMode="decimal" step="any" min={-90} max={90} required />
            </label>
            <label className="rp-field">
              <span>Longitud</span>
              <input name="lon" type="number" inputMode="decimal" step="any" min={-180} max={180} required />
            </label>
          </fieldset>
          <label className="rp-field">
            <span>Intervalo entre cuadros (segundos)</span>
            <input name="intervalo" type="number" inputMode="numeric" defaultValue={30} min={5} max={300} required disabled={activa} />
          </label>
        </div>
        <video ref={videoRef} className="rp-prev rp-video" playsInline muted hidden={!activa} aria-label="Vista previa de la cámara" />
        {activa ? (
          <Button key="detener" type="button" variant="danger" className="rp-big" onClick={() => detener("Captura detenida.")}>Detener</Button>
        ) : (
          <Button key="iniciar" type="submit" variant="primary" className="rp-big">Iniciar</Button>
        )}
        <p className="rp-p" role="status">{estado}</p>
        {ultimoCuadro && (
          <dl className="rp-res">
            <dt>Último cuadro recibido</dt>
            <dd>{ultimoCuadro.hora.toLocaleTimeString("es-CL", { timeZone: "America/Santiago" })}</dd>
            <dt>Nivel de agua</dt>
            <dd>{NIVEL_AGUA_TXT[ultimoCuadro.nivel]}</dd>
          </dl>
        )}
      </form>
    </main>
  );
}

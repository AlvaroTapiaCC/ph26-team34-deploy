"use client";

import { useState } from "react";
import { googleMapsTramos, MAX_WAYPOINTS_WEB, PUNTOS, SIMULABLES, textoWhatsApp } from "@/lib/data";
import { useStore } from "@/lib/store";
import { Button, CloseBtn, FakeQR, Kicker, Modal, PrioChip, Stat } from "../ui";

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function RutaModal() {
  const { s, set, scenarioLabel, ruta } = useStore();
  const close = () => set({ modal: null });
  const n = ruta.paradas.length;
  return (
    <Modal onClose={close} width={1040}>
      <div className="modal__head">
        <div>
          <Kicker tone="accent">Ruta de cuadrilla · {scenarioLabel}</Kicker>
          <h2 className="modal__title">
            {s.comuna === "Todas" ? "Todas las comunas" : s.comuna} · {n} {n === 1 ? "punto" : "puntos"} en orden
          </h2>
        </div>
        <CloseBtn onClick={close} />
      </div>
      <div className="ruta">
        <div className="ruta__list">
          {ruta.paradas.map((r, i) => (
            <div key={r.id} className="ruta__row">
              <span className={`ruta__n ${i === 0 ? "is-first" : ""}`}>{i + 1}</span>
              <span className="ruta__name">{r.nombre}</span>
              <PrioChip prio={r.prio} />
              <span className="ruta__dist">{r.dist}</span>
            </div>
          ))}
        </div>
        <div className="ruta__side">
          <div className="ruta__stats">
            <Stat value={ruta.km.replace(" ", "\n")} label="distancia total" accent />
            <Stat value={String(n)} label="puntos" />
          </div>
          <div className="qrbox">
            <FakeQR size={200} />
            <p>Escanea para abrir en Google Maps</p>
            <small>QR ilustrativo · se genera con qrcode</small>
          </div>
          {googleMapsTramos(ruta.paradas, MAX_WAYPOINTS_WEB).map((t, i, all) => (
            <Button key={t.url} variant={i === 0 ? "primary" : "secondary"} className="btn--block" onClick={() => window.open(t.url, "_blank", "noopener")}>
              {all.length === 1 ? "Abrir en Google Maps" : `Abrir tramo ${i + 1} en Maps · paradas ${t.desde}–${t.hasta}`}
            </Button>
          ))}
          <Button
            className="btn--block"
            onClick={async () => {
              await copy(textoWhatsApp(ruta.paradas, scenarioLabel, s.comuna, { prio: true }));
              set({ modal: "whatsapp", copied: true, toast: "Lista copiada · pégala en el grupo de la cuadrilla" });
            }}
          >
            Copiar lista para WhatsApp
          </Button>
        </div>
      </div>
      <p className="ruta__foot">Orden por prioridad; distancias en línea recta. Sin tiempos de llegada: el modelo no los calcula con precisión.</p>
    </Modal>
  );
}

function WhatsAppModal() {
  const { s, set, scenarioLabel, ruta } = useStore();
  const text = textoWhatsApp(ruta.paradas, scenarioLabel, s.comuna, { prio: true });
  const close = () => set({ modal: null, copied: false });
  return (
    <Modal onClose={close} width={760}>
      <div className="modal__head">
        <div>
          <Kicker tone="accent">Exportar lista</Kicker>
          <h2 className="modal__title" style={{ fontSize: 30, lineHeight: "38px" }}>
            Texto listo para WhatsApp
          </h2>
        </div>
        <CloseBtn onClick={close} />
      </div>
      <pre className="preview">{text}</pre>
      <div className="row-btns">
        <Button
          variant="primary"
          onClick={async () => {
            await copy(text);
            set({ copied: true, toast: "Lista copiada · pégala en el grupo de la cuadrilla" });
          }}
        >
          {s.copied ? "✓ Copiado" : "Copiar"}
        </Button>
        <Button onClick={() => set({ modal: "ruta", copied: false })}>Volver a la ruta</Button>
      </div>
    </Modal>
  );
}

function SimularModal() {
  const { set, flood } = useStore();
  const [sel, setSel] = useState("p2");
  const close = () => set({ modal: null });
  return (
    <Modal onClose={close} width={640} className="modal--sim">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Kicker tone="accent">Modo demo</Kicker>
        <h2 className="modal__title" style={{ fontSize: 30, lineHeight: "38px" }}>
          Simular reporte
        </h2>
        <p style={{ fontSize: 15, color: "var(--text-2)" }}>Elige un punto para simular un reporte de anegamiento.</p>
        {SIMULABLES.map((id) => (
          <button key={id} className={`radio ${sel === id ? "is-on" : ""}`} onClick={() => setSel(id)} role="radio" aria-checked={sel === id}>
            <span className="radio__dot" />
            <span className="radio__name">{PUNTOS[id].nombre}</span>
            <span className="radio__meta">{PUNTOS[id].comuna}</span>
          </button>
        ))}
        <div className="row-btns">
          <Button variant="primary" onClick={() => flood(sel, "sensor")}>
            Simular anegamiento
          </Button>
          <Button onClick={close}>Cancelar</Button>
        </div>
      </div>
    </Modal>
  );
}

export default function Modals() {
  const { s } = useStore();
  if (s.modal === "ruta") return <RutaModal />;
  if (s.modal === "whatsapp") return <WhatsAppModal />;
  if (s.modal === "simular") return <SimularModal />;
  return null;
}

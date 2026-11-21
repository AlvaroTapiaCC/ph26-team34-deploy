"use client";

import { useState } from "react";
import { googleMapsUrl, PUNTOS, RUTA, RUTA_KM, SIMULABLES, textoWhatsApp } from "@/lib/data";
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
  const { set, scenarioLabel } = useStore();
  const close = () => set({ modal: null });
  return (
    <Modal onClose={close} width={1040}>
      <div className="modal__head">
        <div>
          <Kicker tone="accent">Ruta de cuadrilla · {scenarioLabel}</Kicker>
          <h2 className="modal__title">Providencia · 8 puntos en orden</h2>
        </div>
        <CloseBtn onClick={close} />
      </div>
      <div className="ruta">
        <div className="ruta__list">
          {RUTA.map((r, i) => (
            <div key={r.nombre} className="ruta__row">
              <span className={`ruta__n ${i === 0 ? "is-first" : ""}`}>{i + 1}</span>
              <span className="ruta__name">{r.nombre}</span>
              <PrioChip prio={r.prio} />
              <span className="ruta__dist">{r.dist}</span>
            </div>
          ))}
        </div>
        <div className="ruta__side">
          <div className="ruta__stats">
            <Stat value={RUTA_KM.replace(" ", "\n")} label="distancia total" accent />
            <Stat value="8" label="puntos" />
          </div>
          <div className="qrbox">
            <FakeQR size={200} />
            <p>Escanea para abrir en Google Maps</p>
            <small>QR ilustrativo · se genera con qrcode</small>
          </div>
          <Button variant="primary" className="btn--block" onClick={() => window.open(googleMapsUrl(), "_blank", "noopener")}>
            Abrir en Google Maps
          </Button>
          <Button
            className="btn--block"
            onClick={async () => {
              await copy(textoWhatsApp(scenarioLabel, { comuna: true, prio: true }));
              set({ modal: "whatsapp", copied: true, toast: "Lista copiada · pégala en el grupo de la cuadrilla" });
            }}
          >
            Copiar lista para WhatsApp
          </Button>
        </div>
      </div>
      <p className="ruta__foot">Orden calculado antes de la demo. Sin tiempos de llegada: el modelo no los calcula con precisión.</p>
    </Modal>
  );
}

function WhatsAppModal() {
  const { s, set, scenarioLabel } = useStore();
  const text = textoWhatsApp(scenarioLabel, { comuna: true, prio: true });
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
        <Kicker tone="accent">Respaldo del sensor</Kicker>
        <h2 className="modal__title" style={{ fontSize: 30, lineHeight: "38px" }}>
          Simular reporte
        </h2>
        <p style={{ fontSize: 15, color: "var(--text-2)" }}>Elige el punto que se anegó. Hace lo mismo que el ESP32.</p>
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

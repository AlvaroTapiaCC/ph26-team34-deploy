"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { PRIO_LABEL, type Prioridad } from "@/lib/data";

export function Drop({ size = 27 }: { size?: number }) {
  return (
    <svg width={(size * 20) / 27} height={size} viewBox="0 0 20 27" aria-hidden>
      <path d="M10 0.5C10 0.5 0 11.6 0 17.2C0 22.6 4.5 27 10 27C15.5 27 20 22.6 20 17.2C20 11.6 10 0.5 10 0.5Z" fill="var(--acento)" />
    </svg>
  );
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="logo" style={{ fontSize: size }}>
      <Drop size={(size * 27) / 26} />
      <span>drena</span>
    </span>
  );
}

type BtnVariant = "primary" | "secondary" | "danger" | "ghost";
export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "md" | "lg" }) {
  return <button className={`btn btn--${variant} btn--${size} ${className}`} {...rest} />;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  soft = false,
  className = "",
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: "md" | "lg";
  soft?: boolean;
  className?: string;
}) {
  return (
    <div className={`seg seg--${size} ${soft ? "seg--soft" : ""} ${className}`} role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={o.id === value} className={`seg__item ${o.id === value ? "is-on" : ""}`} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function useOutside(cb: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && cb();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [cb]);
  return ref;
}

export function Selector<T extends string | number>({
  label,
  value,
  options,
  onChange,
  active,
  footer,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; meta?: string }[];
  onChange: (v: T) => void;
  active?: boolean;
  footer?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(() => setOpen(false));
  return (
    <div className="selector-wrap" ref={ref}>
      <button className={`selector ${active || open ? "is-active" : ""}`} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <span className="selector__chev">⌄</span>
      </button>
      {open && (
        <div className="menu">
          {options.map((o) => (
            <button
              key={String(o.id)}
              className={`menu__item ${o.id === value ? "is-on" : ""}`}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              <span className="menu__label">{o.label}</span>
              {o.meta && <span className="menu__meta">{o.meta}</span>}
              {o.id === value && <span className="menu__check">✓</span>}
            </button>
          ))}
          {footer && <div className="menu__foot">{footer}</div>}
        </div>
      )}
    </div>
  );
}

export function PrioChip({ prio, faded }: { prio: Prioridad; faded?: boolean }) {
  return <span className={`chip chip--${prio} ${faded ? "chip--faded" : ""}`}>{PRIO_LABEL[prio]}</span>;
}

export function EstadoChip({ estado }: { estado: "anegado" | "pendiente" | "limpio" | "enruta" }) {
  const t = { anegado: "≋ Anegado", pendiente: "○ Pendiente", limpio: "✓ Limpio", enruta: "➜ En ruta" }[estado];
  return <span className={`echip echip--${estado}`}>{t}</span>;
}

export function Kicker({ children, tone = "muted", className = "" }: { children: ReactNode; tone?: "muted" | "accent" | "danger" | "ink" | "light"; className?: string }) {
  return <div className={`kicker kicker--${tone} ${className}`}>{children}</div>;
}

export function Stat({ value, label, accent, inset = "deep", className = "" }: { value: string; label: string; accent?: boolean; inset?: "deep" | "soft"; className?: string }) {
  return (
    <div className={`stat stat--${inset} ${className}`}>
      <div className={`stat__v ${accent ? "is-accent" : ""}`}>{value}</div>
      <div className="stat__l">{label}</div>
    </div>
  );
}

export function Check({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button className={`check ${on ? "is-on" : ""}`} onClick={onClick} role="checkbox" aria-checked={on}>
      <span className="check__box">{on ? "✓" : ""}</span>
      <span>{label}</span>
    </button>
  );
}

export function Toast({ text, className = "" }: { text: string | null; className?: string }) {
  if (!text) return null;
  return (
    <div className={`toast ${className}`} role="status">
      <span className="toast__dot" />
      <span>{text}</span>
    </div>
  );
}

export function Modal({ children, onClose, width, className = "" }: { children: ReactNode; onClose: () => void; width: number; className?: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`} style={{ width }} role="dialog" aria-modal>
        {children}
      </div>
    </div>
  );
}

export function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <Button className="btn--icon" onClick={onClick} aria-label="Cerrar">
      ✕
    </Button>
  );
}

// QR ilustrativo (no codifica la URL; se genera con qrcode en producción)
export function FakeQR({ size = 200 }: { size?: number }) {
  const n = 25;
  const cells: boolean[] = [];
  for (let i = 0; i < n * n; i++) {
    const x = i % n;
    const y = Math.floor(i / n);
    const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    cells.push(v - Math.floor(v) > 0.52);
  }
  const finder = (x: number, y: number) => {
    const inF = (fx: number, fy: number) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7;
    for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      if (inF(fx, fy)) {
        const dx = x - fx, dy = y - fy;
        const ring = dx === 0 || dy === 0 || dx === 6 || dy === 6;
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        return ring || core ? 1 : 0;
      }
      if (x >= fx - 1 && x <= fx + 7 && y >= fy - 1 && y <= fy + 7) return 0;
    }
    return -1;
  };
  const m = 12;
  const c = (size - 2 * m) / n;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="qr">
      <rect width={size} height={size} rx="8" fill="var(--surface)" />
      {cells.map((on, i) => {
        const x = i % n;
        const y = Math.floor(i / n);
        const f = finder(x, y);
        const fill = f === -1 ? on : f === 1;
        return fill ? <rect key={i} x={m + x * c} y={m + y * c} width={c + 0.3} height={c + 0.3} fill="var(--text)" /> : null;
      })}
    </svg>
  );
}

"use client";

import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { PRIO_LABEL, type Prioridad } from "@/lib/data";

export function Drop({ size = 27 }: { size?: number }) {
  return (
    <svg width={(size * 20) / 27} height={size} viewBox="0 0 20 27" aria-hidden>
      <path d="M10 0.5C10 0.5 0 11.6 0 17.2C0 22.6 4.5 27 10 27C15.5 27 20 22.6 20 17.2C20 11.6 10 0.5 10 0.5Z" fill="var(--principal)" />
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

/** Chevron hacia abajo (SVG), gira cuando el menú está abierto. */
export function Chevron({ open = false }: { open?: boolean }) {
  return (
    <svg className={`chev ${open ? "is-open" : ""}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Control base de la barra superior: 44 px de alto, mismo radio, borde y tipografía (Geist 14 px). El activo va en accent. */
export const BarButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }>(function BarButton(
  { on = false, className = "", ...rest },
  ref,
) {
  return <button ref={ref} type="button" className={`barbtn ${on ? "is-on" : ""} ${className}`} {...rest} />;
});

/** Opciones excluyentes con el mismo control base (p. ej. el escenario). */
export function BarSegment<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="bargroup" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <BarButton key={o.id} role="radio" aria-checked={o.id === value} on={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </BarButton>
      ))}
    </div>
  );
}

/**
 * Menú desplegable accesible: se abre bajo el botón, sobre el mapa; flechas, Inicio/Fin, Enter o Espacio para elegir,
 * Esc o clic afuera para cerrar. Se cierra al elegir y devuelve el foco al botón.
 */
export function Dropdown<T extends string | number>({
  label,
  value,
  options,
  onChange,
  footer,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; meta?: string }[];
  onChange: (v: T) => void;
  footer?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activo, setActivo] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const menuId = useId();

  const abrir = (i = Math.max(0, options.findIndex((o) => o.id === value))) => {
    setActivo(i);
    setOpen(true);
  };
  const cerrar = (foco = true) => {
    setOpen(false);
    if (foco) boton.current?.focus();
  };
  const elegir = (i: number) => {
    onChange(options[i].id);
    cerrar();
  };

  useEffect(() => {
    if (open) items.current[activo]?.focus();
  }, [open, activo]);

  useEffect(() => {
    if (!open) return;
    const fuera = (e: PointerEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", fuera);
    return () => document.removeEventListener("pointerdown", fuera);
  }, [open]);

  const teclaMenu = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = options.length;
    if (e.key === "ArrowDown") setActivo((activo + 1) % n);
    else if (e.key === "ArrowUp") setActivo((activo - 1 + n) % n);
    else if (e.key === "Home") setActivo(0);
    else if (e.key === "End") setActivo(n - 1);
    else if (e.key === "Enter" || e.key === " ") elegir(activo);
    else if (e.key === "Escape") cerrar();
    else if (e.key === "Tab") cerrar(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="dropdown" ref={wrap}>
      <BarButton
        ref={boton}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? cerrar() : abrir())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            abrir();
          }
        }}
      >
        <span>{label}</span>
        <Chevron open={open} />
      </BarButton>
      {open && (
        <div className="menu" id={menuId} role="listbox" aria-label={label} onKeyDown={teclaMenu}>
          {options.map((o, i) => (
            <div
              key={String(o.id)}
              ref={(el) => {
                items.current[i] = el;
              }}
              role="option"
              aria-selected={o.id === value}
              tabIndex={i === activo ? 0 : -1}
              className={`menu__item ${o.id === value ? "is-on" : ""}`}
              onClick={() => elegir(i)}
              onMouseEnter={() => setActivo(i)}
            >
              <span className="menu__label">{o.label}</span>
              {o.meta && <span className="menu__meta">{o.meta}</span>}
              {o.id === value && (
                <svg className="menu__check" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
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
        return fill ? <rect key={i} x={m + x * c} y={m + y * c} width={c + 0.3} height={c + 0.3} fill="var(--secundario)" /> : null;
      })}
    </svg>
  );
}

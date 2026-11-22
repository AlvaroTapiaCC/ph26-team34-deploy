"use client";

// Editor de la paleta (#131). Solo aparece con ?paleta=1: el jurado y los vecinos no lo ven.
// Cambiar un color actualiza al instante todo lo que usa esa variable (CSS y mapa).
import { useEffect, useMemo, useRef, useState } from "react";
import { aCssRoot, aplicarPaleta, leerPaletaGuardada, limpiarPaleta, PALETA, paletaPorDefecto, type Paleta } from "@/lib/paleta";
import "./paleta.css";

function descargar(nombre: string, contenido: string, tipo: string) {
  const url = URL.createObjectURL(new Blob([contenido], { type: `${tipo};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function EditorPaleta() {
  const [visible, setVisible] = useState(false);
  const [abierto, setAbierto] = useState(true);
  const [paleta, setPaleta] = useState<Paleta>(paletaPorDefecto);
  const [aviso, setAviso] = useState("");
  const archivo = useRef<HTMLInputElement>(null);
  const def = useMemo(paletaPorDefecto, []);

  useEffect(() => {
    const guardada = leerPaletaGuardada();
    // El script de <head> ya aplicó las variables; aquí se sincroniza la barra del navegador y el mapa.
    if (Object.keys(guardada).length) aplicarPaleta(guardada);
    setPaleta({ ...paletaPorDefecto(), ...guardada });
    setVisible(new URLSearchParams(window.location.search).get("paleta") === "1");
  }, []);

  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(""), 2500);
    return () => clearTimeout(t);
  }, [aviso]);

  const grupos = useMemo(() => {
    const m = new Map<string, typeof PALETA>();
    for (const c of PALETA) m.set(c.grupo, [...(m.get(c.grupo) ?? []), c]);
    return [...m.entries()];
  }, []);

  if (!visible) return null;

  const cambiar = (siguiente: Paleta) => {
    setPaleta(siguiente);
    aplicarPaleta(siguiente);
  };
  const editados = PALETA.filter((c) => paleta[c.id] !== def[c.id]).length;

  async function importar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const leida = limpiarPaleta(JSON.parse(await f.text()));
      if (!Object.keys(leida).length) throw new Error();
      cambiar({ ...paletaPorDefecto(), ...leida });
      setAviso(`Importados ${Object.keys(leida).length} colores`);
    } catch {
      setAviso("El archivo no es una paleta válida");
    }
  }

  async function copiarCss() {
    try {
      await navigator.clipboard.writeText(aCssRoot(paleta));
      setAviso("Bloque :root copiado");
    } catch {
      setAviso("No se pudo copiar; usa Descargar CSS");
    }
  }

  if (!abierto) {
    return (
      <button className="pal-fab" onClick={() => setAbierto(true)} aria-label="Abrir editor de paleta">
        <span style={{ background: "var(--acento)" }} />
        <span style={{ background: "var(--text)" }} />
        <span style={{ background: "var(--bg)" }} />
        Paleta
      </button>
    );
  }

  return (
    <aside className="pal" aria-label="Editor de paleta">
      <header className="pal__head">
        <div>
          <b>Paleta de colores</b>
          <small>{editados ? `${editados} editados · se guardan en este navegador` : "Valores por defecto"}</small>
        </div>
        <button className="pal__x" onClick={() => setAbierto(false)} aria-label="Minimizar">
          –
        </button>
      </header>

      <div className="pal__lista">
        {grupos.map(([grupo, colores]) => (
          <section key={grupo}>
            <h3>{grupo}</h3>
            {colores.map((c) => {
              const v = paleta[c.id];
              const editado = v !== def[c.id];
              return (
                <label key={c.id} className="pal__fila" title={`--${c.id}`}>
                  <input type="color" value={v} onChange={(e) => cambiar({ ...paleta, [c.id]: e.target.value })} />
                  <span className="pal__txt">
                    <b>
                      {c.nombre}
                      {editado && <i> · editado</i>}
                    </b>
                    <small>{c.uso}</small>
                  </span>
                  <code>{v}</code>
                  {editado && (
                    <button className="pal__reset" onClick={(e) => (e.preventDefault(), cambiar({ ...paleta, [c.id]: def[c.id] }))} aria-label={`Restablecer ${c.nombre}`}>
                      ↺
                    </button>
                  )}
                </label>
              );
            })}
          </section>
        ))}
      </div>

      <footer className="pal__pie">
        <button onClick={() => cambiar(paletaPorDefecto())} disabled={!editados}>
          Restablecer todo
        </button>
        <button onClick={() => descargar("paleta.json", JSON.stringify(paleta, null, 2), "application/json")}>Descargar JSON</button>
        <button onClick={() => archivo.current?.click()}>Importar JSON</button>
        <button onClick={() => descargar("paleta.css", aCssRoot(paleta) + "\n", "text/css")}>Descargar CSS</button>
        <button onClick={copiarCss}>Copiar :root</button>
        <input ref={archivo} type="file" accept="application/json,.json" hidden onChange={importar} />
      </footer>
      <p className="pal__nota">
        Para dejarla por defecto en el repo: descarga el JSON y, en <code>frontend/</code>, corre <code>npm run paleta -- paleta.json</code>. Actualiza{" "}
        <code>lib/paleta.json</code> y <code>globals.css</code>; el build verifica que coincidan.
      </p>
      {aviso && (
        <div className="pal__aviso" role="status">
          {aviso}
        </div>
      )}
    </aside>
  );
}

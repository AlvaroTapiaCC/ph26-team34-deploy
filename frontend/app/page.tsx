"use client";

import dynamic from "next/dynamic";

/** Esqueleto neutro mientras llega el código de la central: sirve en escritorio y celular (lo ajusta el CSS). */
function Arranque() {
  return (
    <div className="arranque" aria-busy="true" aria-label="Cargando Drena">
      <div className="skel arranque__barra" />
      <div className="arranque__cuerpo">
        <div className="arranque__lista">
          <div className="skel" style={{ height: 200, borderRadius: 24 }} />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skel" style={{ height: 56, borderRadius: 14 }} />
          ))}
        </div>
        <div className="skel arranque__mapa" />
      </div>
    </div>
  );
}

const App = dynamic(() => import("@/components/App"), { ssr: false, loading: Arranque });

export default function Home() {
  return <App />;
}

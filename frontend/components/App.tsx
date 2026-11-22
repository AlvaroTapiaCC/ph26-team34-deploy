"use client";

import { useEffect, useState } from "react";
import { StoreProvider } from "@/lib/store";
import Desktop from "./desktop/Desktop";
import Mobile from "./mobile/Mobile";

const CONSULTA_MOVIL = "(max-width: 1099px)";

/** Se monta solo en el navegador (ssr: false): decide en el primer render, sin pantallazo vacío. */
function useIsMobile() {
  const [m, setM] = useState(() => window.matchMedia(CONSULTA_MOVIL).matches);
  useEffect(() => {
    const mq = window.matchMedia(CONSULTA_MOVIL);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export default function App() {
  const mobile = useIsMobile();
  return <StoreProvider>{mobile ? <Mobile /> : <Desktop />}</StoreProvider>;
}

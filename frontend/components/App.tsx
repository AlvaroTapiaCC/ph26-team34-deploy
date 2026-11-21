"use client";

import { useEffect, useState } from "react";
import { StoreProvider } from "@/lib/store";
import Desktop from "./desktop/Desktop";
import Mobile from "./mobile/Mobile";

function useIsMobile() {
  const [m, setM] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export default function App() {
  const mobile = useIsMobile();
  if (mobile === null) return null;
  return <StoreProvider>{mobile ? <Mobile /> : <Desktop />}</StoreProvider>;
}

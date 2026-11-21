"use client";

import { useStore } from "@/lib/store";
import { Toast } from "../ui";
import Antes from "./Antes";
import Durante from "./Durante";
import Ficha from "./Ficha";
import Modals from "./Modals";
import TopBar from "./TopBar";
import { Cargando, ErrorDatos, Metodologia, Validacion, Vacio } from "./Views";

function Body() {
  const { s } = useStore();
  if (s.status === "error") return <ErrorDatos />;
  if (s.status === "loading") return <Cargando />;
  if (s.vista === "validacion") return <Validacion />;
  if (s.vista === "metodologia") return <Metodologia />;
  if (s.modo === "durante") return <Durante />;
  if (s.ficha) return <Ficha />;
  return <Antes vacio={<Vacio />} />;
}

export default function Desktop() {
  const { s } = useStore();
  return (
    <div className="desk">
      <TopBar />
      <Body />
      <Modals />
      <Toast text={s.toast} />
    </div>
  );
}

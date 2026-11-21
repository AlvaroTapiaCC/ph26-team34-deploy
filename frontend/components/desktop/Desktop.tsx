"use client";

import { useStore } from "@/lib/store";
import AvisoDatos from "../AvisoDatos";
import { Toast } from "../ui";
import Ficha from "./Ficha";
import Modals from "./Modals";
import Principal from "./Principal";
import TopBar from "./TopBar";
import { Cargando, ErrorDatos, Vacio } from "./Views";

function Body() {
  const { s } = useStore();
  if (s.status === "error") return <ErrorDatos />;
  if (s.status === "loading") return <Cargando />;
  if (s.ficha) return <Ficha />;
  return <Principal vacio={<Vacio />} />;
}

export default function Desktop() {
  const { s } = useStore();
  return (
    <div className="desk">
      <TopBar />
      <Body />
      <Modals />
      <AvisoDatos />
      <Toast text={s.toast} />
    </div>
  );
}

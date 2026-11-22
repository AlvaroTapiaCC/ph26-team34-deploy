"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { DURACION_DEMO, PASOS_DEMO } from "@/lib/demo";
import { useSala } from "@/lib/sala";
import s from "./sala.module.css";

export function BotonDemo() {
  const { demo } = useSala();
  const router = useRouter();
  if (demo.activo) return null;
  return <button type="button" className={s.btnSec} onClick={() => { demo.iniciar(); router.push("/central/antes"); }}>Ver demo <span aria-hidden>▶</span></button>;
}

export function GuionDemo() {
  const { demo } = useSala();
  const router = useRouter();
  if (!demo.activo) return null;
  const paso = PASOS_DEMO[demo.paso];
  const termino = demo.segundo >= DURACION_DEMO;
  return <section className={s.demo} aria-label="Demo guiada">
    <div className={s.demoEncabezado}>
      <span className={s.chipSim}>Demo · datos simulados</span>
      <span>{Math.floor(demo.segundo)} / {DURACION_DEMO} s</span>
    </div>
    <div aria-live="polite" aria-atomic="true">
      <h2>{demo.paso + 1}. {paso.titulo}</h2>
      <p>{paso.texto}</p>
    </div>
    {demo.paso === 1 && <figure className={s.demoFoto}>
      <Image src="/img/sumidero-thumb.jpg" alt="Foto de ejemplo de una rejilla; la clasificación de la demo está simulada" width={96} height={72} />
      <figcaption>Foto de ejemplo · no enviada a Claude<br />Clasificación simulada: tapada · hojas · confianza alta</figcaption>
    </figure>}
    <p className={s.demoNota}>Solo en este navegador · sin escrituras a producción · ruta ilustrativa, no navegación por calles</p>
    <progress aria-label="Avance de la demo" max={DURACION_DEMO} value={demo.segundo} />
    <div className={s.demoControles}>
      {!termino && <button type="button" className={s.btnSec} onClick={demo.pausar}>{demo.corriendo ? "Pausar" : "Continuar"}</button>}
      {!termino && <button type="button" className={s.btnSec} onClick={demo.siguiente}>Siguiente paso</button>}
      <button type="button" className={s.btnSec} onClick={demo.iniciar}>{termino ? "Repetir demo" : "Reiniciar"}</button>
      <button type="button" className={s.btnSec} onClick={() => { demo.salir(); router.push("/central/antes"); }}>Salir de demo</button>
    </div>
  </section>;
}

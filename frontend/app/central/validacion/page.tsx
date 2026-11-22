import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/ui";
import { leerEvidencia } from "./evidencia";
import styles from "./validacion.module.css";

export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Drena · Validación histórica",
  description: "Cobertura del replay, clasificación de imágenes y verificación de la predicción congelada de Drena.",
};

const REPO = "https://github.com/platanus-hack/platanus-hack-26-cl-team-34";
const FORMATO = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 });
const MOMENTO = new Intl.DateTimeFormat("es-CL", {
  dateStyle: "medium",
  timeStyle: "medium",
  hourCycle: "h23",
  timeZone: "America/Santiago",
});
const cantidad = (n: number) => FORMATO.format(n);
const porcentaje = (n: number) => `${cantidad(n)} %`;

function Fecha({ iso }: { iso: string }) {
  return <time dateTime={iso}>{MOMENTO.format(new Date(iso))} (Santiago)</time>;
}

function EnCurso() {
  return <p className={styles.pendienteBloque}><span className={styles.pendiente}>En curso</span> Resultado pendiente; se publica al terminar la medición.</p>;
}

function Metrica({ valor }: { valor: { porcentaje: number; aciertos: number; total: number } | null }) {
  if (!valor) return <span className={styles.pendiente}>En curso</span>;
  return (
    <>
      <strong>{porcentaje(valor.porcentaje)}</strong>
      <small>{cantidad(valor.aciertos)} de {cantidad(valor.total)}</small>
    </>
  );
}

type Replay = NonNullable<Awaited<ReturnType<typeof leerEvidencia>>["replay"]>;

/** Hallazgo principal: el corte 20 % superior a menos de 100 m (o el primero disponible), leído de los datos. */
function Hallazgo({ replay }: { replay: Replay }) {
  const c = replay.cortes.find((x) => x.top === 20 && x.distancia === 100) ?? replay.cortes[0];
  const de = (v: { aciertos: number; total: number }) => `${cantidad(v.aciertos)} de ${cantidad(v.total)}`;
  return (
    <section className={styles.hallazgo} aria-labelledby="hallazgo">
      <p className={styles.etiqueta}>Replay histórico · lluvia {replay.evento.replace("_", " al ")} · datos reproducidos</p>
      <h2 id="hallazgo">
        Con el {porcentaje(c.top)} superior de rejillas, la fórmula sin clima cubrió <strong>{de(c.formula)}</strong> {replay.puntosCriticos ? "puntos críticos" : "lugares"} a menos de {cantidad(c.distancia)} m
      </h2>
      <dl className={styles.comparacion}>
        <div className={styles.gana}><dt>Fórmula sin clima</dt><dd>{de(c.formula)}</dd></div>
        <div><dt>Solo área de aporte</dt><dd>{de(c.area)}</dd></div>
        <div><dt>Azar (promedio)</dt><dd>{de(c.azar)}</dd></div>
      </dl>
    </section>
  );
}

export default async function ValidacionPage() {
  const { replay, claude, congelamiento } = await leerEvidencia();
  return (
    <main className={styles.validacion}>
      <header className={styles.header}>
        <Link href="/" aria-label="Drena, inicio"><Logo /></Link>
        <nav className={styles.nav} aria-label="Vistas de la central">
          <Link href="/">Antes</Link>
          <Link href="/central/durante">Durante</Link>
          <Link href="/central/validacion" aria-current="page">Validación</Link>
        </nav>
      </header>
      <h1>Validación histórica</h1>
      {replay && <Hallazgo replay={replay} />}

      <section className={styles.card} aria-labelledby="replay">
        <h2 id="replay">Replay de lluvia real</h2>
        {replay ? (
          <>
            <p><strong>{replay.evento}</strong> · {cantidad(replay.lugares)} {replay.lugares === 1 ? "lugar evaluado" : "lugares evaluados"}</p>
            {replay.puntosCriticos && <p>La cobertura espacial usa puntos críticos de invierno conocidos. El tiempo de alerta requiere un primer aviso u observación con hora.</p>}
            <p className={styles.muted}>La cobertura cuenta lugares con al menos una rejilla priorizada dentro de la distancia indicada.</p>
            <div className={styles.tabla} tabIndex={0} role="region" aria-label="Comparación de cobertura">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Corte</th>
                    <th scope="col">Fórmula sin clima</th>
                    <th scope="col">Fórmula a la hora del registro</th>
                    <th scope="col">Solo área de aporte</th>
                    <th scope="col">Azar (promedio)</th>
                  </tr>
                </thead>
                <tbody>
                  {replay.cortes.map((c) => (
                    <tr key={`${c.top}-${c.distancia}`}>
                      <th scope="row">{porcentaje(c.top)} superior <small>A menos de {cantidad(c.distancia)} m</small></th>
                      <td><Metrica valor={c.formula} /></td>
                      <td><Metrica valor={c.horaria} /></td>
                      <td><Metrica valor={c.area} /></td>
                      <td><Metrica valor={c.azar} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p><strong>Distancia temporal respecto del primer registro</strong>{" · "}
              {replay.adelanto === null ? <span className={styles.pendiente}>En curso</span> : replay.adelanto === 0
                ? "Alerta y registro simultáneos"
                : `Alerta ${cantidad(Math.abs(replay.adelanto))} h ${replay.adelanto > 0 ? "antes" : "después"} del registro`}
            </p>
          </>
        ) : <EnCurso />}
        <a href={`${REPO}/issues/86`}>Fuentes y método del replay</a>
      </section>

      <div className={styles.detalle}>
        <section className={styles.card} aria-labelledby="claude">
          <h2 id="claude">Claude y etiquetas humanas</h2>
          {claude ? (
            <dl className={styles.resultados}>
              <div><dt>Imágenes del conjunto</dt><dd>{cantidad(claude.imagenes)}</dd></div>
              <div><dt>Coincidencia con el consenso</dt><dd>{claude.comparables > 0 ? `${cantidad(claude.coincidencias)} de ${cantidad(claude.comparables)} comparables` : "Sin imágenes comparables"}</dd></div>
              <div><dt>Imágenes no evaluables por Claude</dt><dd>{cantidad(claude.noEvaluables)}</dd></div>
              <div><dt>Acuerdo entre revisores</dt><dd>{cantidad(claude.acuerdo.aciertos)} de {cantidad(claude.acuerdo.total)} ({porcentaje(claude.acuerdo.porcentaje)})</dd></div>
            </dl>
          ) : <EnCurso />}
          <a href={`${REPO}/issues/30`}>Método de etiquetado y clasificación</a>
        </section>

        <section className={styles.card} aria-labelledby="congelamiento">
          <h2 id="congelamiento">Predicción congelada</h2>
          {congelamiento ? (
            <dl className={styles.resultados}>
              <div><dt>Hora de generación</dt><dd>{congelamiento.generado ? <Fecha iso={congelamiento.generado} /> : "Sin dato"}</dd></div>
              <div><dt>Commit de congelamiento</dt><dd>{congelamiento.publicacion ? <>
                <Fecha iso={congelamiento.publicacion.fecha} /> · <a href={`${REPO}/commit/${congelamiento.publicacion.commit}`}>{congelamiento.publicacion.commit.slice(0, 7)}</a>
              </> : "Sin dato"}</dd></div>
              <div><dt>CSV congelado</dt><dd>{congelamiento.csvVerificado === null ? "Huella no disponible" : congelamiento.csvVerificado ? "Huella SHA-256 verificada" : "Huella distinta a la registrada"}</dd></div>
              <div><dt>Configuración de validación</dt><dd>{congelamiento.configAjustada === null ? "Sin dato" : congelamiento.configAjustada ? "Cambió después del congelamiento" : "Conserva la huella de la versión congelada"}</dd></div>
              <div><dt>Código de la fórmula</dt><dd>{congelamiento.codigoAjustado === null ? "Sin dato" : congelamiento.codigoAjustado ? "Cambió después del congelamiento" : "Conserva la huella de la versión congelada"}</dd></div>
            </dl>
          ) : <EnCurso />}
          <a href={`${REPO}/pull/81`}>Metadatos y criterio de congelamiento</a>
        </section>

        <section className={styles.card} aria-labelledby="reclamos">
          <h2 id="reclamos">Reclamos del mismo evento</h2>
          <EnCurso />
          <a href={`${REPO}/issues/72`}>Contraste con registros municipales</a>
        </section>

        <section className={styles.card} aria-labelledby="tiempo">
          <h2 id="tiempo">Tiempo de la foto a la misión</h2>
          <EnCurso />
          <a href={`${REPO}/issues/50`}>Medición del ensayo</a>
        </section>
      </div>
    </main>
  );
}

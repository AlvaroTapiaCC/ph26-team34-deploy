"""Reconstrucción ilustrativa de San Carlos; no es validación de aluviones."""

import bz2
import csv
import importlib
import json
import math
import sys
import unicodedata
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipeline"))
replay = importlib.import_module("10_replay")
SALIDA = REPO / "data/validacion/san_carlos"
PREDICCION = REPO / "data/validacion/prediccion_replay_julio.csv"
CADENAS = REPO / "data/street_chains_replay_julio.json"
CLIMA = REPO / "data/escenarios/2026-10-08.json"
CRITICOS = REPO / "data/las_condes/puntos_criticos_invierno_2026.geojson"
OSM = REPO / "data/fuente_osm_replay_julio.osm.bz2"
ETIQUETA = "Reconstrucción · datos reproducidos"


def normalizar(texto):
    return "".join(c for c in unicodedata.normalize("NFD", texto.lower()) if not unicodedata.combining(c))


def calle_flujo(nombre):
    return any(c in normalizar(nombre) for c in ("general blanche", "camino el alba"))


def distancia_segmento(p, a, b):
    escala = math.cos(math.radians(p[1]))
    def xy(q):
        return ((q[0] - p[0]) * 111_195 * escala, (q[1] - p[1]) * 111_195)
    a, b = xy(a), xy(b)
    dx, dy = b[0] - a[0], b[1] - a[1]
    largo = dx * dx + dy * dy
    t = max(0, min(1, -(a[0] * dx + a[1] * dy) / largo)) if largo else 0
    return math.hypot(a[0] + t * dx, a[1] + t * dy)


def segmentos_flujo(ruta):
    with bz2.open(ruta) as f:
        raiz = ET.parse(f).getroot()
    nodos = {n.get("id"): (float(n.get("lon")), float(n.get("lat"))) for n in raiz.findall("node")}
    segmentos = []
    for via in raiz.findall("way"):
        tags = {t.get("k"): t.get("v") for t in via.findall("tag")}
        if tags.get("highway") and normalizar(tags.get("name", "")) in ("general blanche", "camino el alba"):
            puntos = [nodos[n.get("ref")] for n in via.findall("nd")]
            segmentos.extend(zip(puntos, puntos[1:]))
    if not segmentos:
        raise ValueError("No hay geometría vial para el eje del flujo.")
    return segmentos


def ids_flujo(filas, segmentos, coords):
    return {f["ID_IDE"] for f in filas if calle_flujo(f["calle"]) or any(
        distancia_segmento(coords[f["ID_IDE"]], a, b) <= 60 for a, b in segmentos
    )}


def construir(horas, filas, entradas, coords, cadenas, config, antecedentes, criticos, segmentos):
    horas = [h for h in horas if "2026-10-06" <= h["hora_santiago"][:10] <= "2026-10-08"]
    if len(horas) != 72 or any(h["clima"] is None for h in horas):
        raise ValueError("Se requieren 72 horas completas de clima para el 6–8 de octubre.")
    alertas = [h for h in horas if h["modo"] == "tormenta_inminente" and h["hora_santiago"][:10] >= "2026-10-07"]
    if not alertas:
        raise ValueError("No hay tormenta inminente el 7–8 de octubre; no se pueden proponer misiones.")
    primera = alertas[0]
    scores = next(replay.ranking_por_hora(entradas, replay.cadenas_del_sector(cadenas, set(coords)), config, [primera]))
    flujo = ids_flujo(filas, segmentos, coords)
    por_id = {f["ID_IDE"]: f for f in filas}
    corte = math.ceil(len(scores) * .2)
    dia8 = [h for h in horas if h["hora_santiago"].startswith("2026-10-08")]
    primeros = {modo: next((h["hora_utc"] for h in horas if h["modo"] == modo), None)
                for modo in ("seco", "tormenta_inminente", "durante", "despues", "sin_dato")}
    return {
        "etiqueta": ETIQUETA, "evento": "2026-10-08", "hora_aluvion_utc": "2026-10-08T20:00:00Z",
        "primera_hora_por_modo_utc": primeros,
        "primera_tormenta_7_8_utc": primera["hora_utc"],
        "adelanto_horas": (replay.hora_utc("2026-10-08T20:00:00Z") - replay.hora_utc(primera["hora_utc"])).total_seconds() / 3600,
        "adelanto_primera_tormenta_ventana_horas": (replay.hora_utc("2026-10-08T20:00:00Z") - replay.hora_utc(primeros["tormenta_inminente"])).total_seconds() / 3600 if primeros["tormenta_inminente"] else None,
        "lluvia_8_oct": {"pronostico_mm": round(sum(h["lluvia_pronosticada_mm"] for h in dia8), 1),
                        "observado_mm": round(sum(h["lluvia_mm"] for h in dia8), 1), "centro_latlon": [-33.418, -70.541]},
        "referencia_otro_centro": {"centro_latlon": [-33.40, -70.52], "pronostico_mm": 26.7, "observado_mm": 26.9,
                                  "nota": "Cifras de referencia aportadas para otra coordenada; no son el insumo del ranking ni de la curva.",
                                  "fuente_url": "https://open-meteo.com/en/docs/previous-runs-api"},
        "lluvia_6_8_mm": round(sum(h["lluvia_mm"] for h in horas), 1),
        "horas": horas, "antecedentes": antecedentes["eventos"],
        "misiones": [{"rank": s.rank, "ID_IDE": s.sumidero_id, "calle": por_id[s.sumidero_id]["calle"],
                      "lon": coords[s.sumidero_id][0], "lat": coords[s.sumidero_id][1],
                      "prioridad": round(s.prioridad, 6), "en_flujo": s.sumidero_id in flujo} for s in scores[:10]],
        "rejillas_eje": [{"rank": s.rank, "total_rankeado": len(scores),
                          "top_porcentaje": math.ceil(100 * s.rank / len(scores)),
                          "ID_IDE": s.sumidero_id, "calle": por_id[s.sumidero_id]["calle"],
                          "lon": coords[s.sumidero_id][0], "lat": coords[s.sumidero_id][1],
                          "prioridad": round(s.prioridad, 6)} for s in scores if s.sumidero_id in flujo][:8],
        "cobertura_flujo": {"total_sumideros": len(scores), "total_flujo": len(flujo), "corte_top_20": corte,
                            "flujo_en_top_20": sum(s.sumidero_id in flujo for s in scores[:corte]),
                            "esperado_azar": round(len(flujo) * corte / len(scores), 2),
                            "metodo": "Nombre General Blanche / Camino El Alba o hasta 60 m de la geometría vial OSM de esas dos calles. Aproximación, no huella observada del aluvión."},
        "puntos_criticos": [f for f in criticos["features"] if f["properties"]["nivel_riesgo"] == "Alto" and any(
            t in normalizar(f["properties"]["lugar"]) for t in ("honda", "bulnes", "blanche", "camino el alba"))],
        "limites": [
            "Drena no modela flujos de detritos ni aluviones. Priorizar limpieza no demuestra que se hubiera evitado esta emergencia.",
            "El catastro SIALL disponible termina aproximadamente en longitud -70.530: no hay rejillas en Bulnes Correa ni en General Blanche alto. No se inventan misiones allí.",
            "Es una ilustración / reconstrucción, no una validación. Las variables y los pesos se congelaron después del evento; no prueban una predicción operativa previa.",
            "Las misiones son las 10 primeras prioridades del ranking B, no un despacho optimizado con disponibilidad de cuadrillas.",
            "El modo usa pronóstico previous_day1 disponible previamente; el puntaje B reutiliza clima de lluvia y viento acumulados hasta cada hora, sin incorporar evidencia posterior.",
            "El adelanto destacado se mide desde la primera tormenta inminente del 7–8 de octubre. La ventana completa del 6–8 también incluye alertas por lluvia anterior.",
            "Los valores Open-Meteo son de grilla, no pluviómetro. La coordenada solicitada entrega cifras distintas de la referencia -33.40, -70.52; no se mezclan ambas series.",
            "Los puntos Alto se seleccionan por nombre de Quebrada Honda / Bulnes Correa y calles del flujo; son antecedentes de riesgo, no incidentes observados.",
            "La hipótesis de dos ductos obstruidos es preliminar y no confirmada. Las fuentes no permiten concluir que las autoridades no realizaron ninguna acción."
        ],
    }


def guardar(ruta, datos):
    ruta.write_text(json.dumps(datos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    config = yaml.safe_load(replay.CONFIG.read_text())
    meta = replay.leer_json(PREDICCION.with_suffix(".meta.json"))
    replay.verificar_hash(PREDICCION, meta["salida"]["sha256"])
    replay.verificar_hash(CADENAS, meta["entradas"]["cadenas"]["sha256"])
    replay.verificar_hash(replay.CONFIG, meta["formula"]["sha256_config"])
    clima_meta = replay.leer_json(CLIMA.with_suffix(".meta.json"))
    replay.verificar_hash(CLIMA, clima_meta["salida"]["sha256"])
    horas = replay.cargar_horas(CLIMA, clima_meta)
    entradas, coords = replay.cargar_ranking(PREDICCION, config)
    with PREDICCION.open(encoding="utf-8", newline="") as f:
        filas = list(csv.DictReader(f))
    antecedente = SALIDA / "antecedentes.json"
    resultado = construir(horas, filas, entradas, coords, replay.leer_json(CADENAS), config,
                          replay.leer_json(antecedente), replay.leer_json(CRITICOS), segmentos_flujo(OSM))
    guardar(SALIDA / "caso.json", resultado)
    insumos = [PREDICCION, PREDICCION.with_suffix(".meta.json"), CADENAS, CLIMA, CLIMA.with_suffix(".meta.json"),
               CRITICOS, CRITICOS.with_suffix(".meta.json"), OSM, OSM.with_name("fuente_osm_replay_julio.meta.json"), antecedente, replay.CONFIG,
               REPO / "backend/config/clima.yaml", REPO / "backend/app/services/formula.py",
               REPO / "pipeline/10_replay.py", REPO / "pipeline/validacion_ranking.py", Path(__file__)]
    generado = datetime.now(timezone.utc).isoformat()
    guardar(SALIDA / "antecedentes.meta.json", {"generado_utc": generado, "etiqueta": ETIQUETA,
            "metodo": "Curaduría manual de las fuentes enlazadas; sin verificación independiente.",
            "salida": replay.archivo(antecedente)})
    guardar(SALIDA / "caso.meta.json", {"generado_utc": generado, "etiqueta": ETIQUETA,
            "entradas": [replay.archivo(p) for p in insumos], "salida": replay.archivo(SALIDA / "caso.json")})
    print(json.dumps({k: resultado[k] for k in ("primera_hora_por_modo_utc", "primera_tormenta_7_8_utc", "adelanto_horas",
          "adelanto_primera_tormenta_ventana_horas", "lluvia_8_oct", "lluvia_6_8_mm", "cobertura_flujo")}, ensure_ascii=False, indent=2))
    print(f"{len(horas)} horas descargadas; {len(resultado['horas'])} horas del caso; {len(resultado['misiones'])} misiones; {len(resultado['puntos_criticos'])} puntos Alto -> {SALIDA / 'caso.json'}")


if __name__ == "__main__":
    main()

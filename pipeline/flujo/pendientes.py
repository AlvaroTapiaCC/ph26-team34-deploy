"""
Pendiente por tramo para la simulación hidráulica del front (frontend/public/data/flujo.geojson).

Parte de la red dirigida que ya escribe pipeline/04_flujo.py (PR #75: red de calles "drive" de OSM, elevación
por nodo del DEM Copernicus GLO-30, relleno de depresiones y D8 sobre el grafo). Por tramo deja:

    L    largo (m)                                   ya viene de 04_flujo.py
    ap   área de aporte propia del nodo de origen    ya viene de 04_flujo.py
    acc  área acumulada que pasa por el tramo        ya viene de 04_flujo.py
    s    pendiente del DEM, |Δz| / L (m/m)           ya viene de 04_flujo.py (no se vuelve a pedir)
    sp   pendiente que usa la simulación (m/m)       NUEVO: s suavizada donde el DEM no sirve (ver abajo)

De dónde sale la elevación:
  1. Si el tramo ya trae "s" (caso normal: todos los tramos de 04_flujo.py), se usa esa pendiente y no se
     consulta ninguna API.
  2. Solo si a algún tramo le falta "s", se pide la elevación de sus dos extremos a Open Topo Data
     (https://api.opentopodata.org/v1/srtm30m): lotes de 100 puntos, 1 consulta por segundo y como máximo
     1.000 consultas por día (límite del servicio público). Las respuestas quedan en
     cache/opentopodata/srtm30m.json y no se vuelven a pedir.
  No se usa Google Earth Engine ni LandLens.

Suavizado: con un DEM de 30 m, en calles casi planas el flujo puede ir "en contra" del DEM (el tramo sale del
relleno de una depresión, r = 1) o tener pendiente 0. Ahí la velocidad sería absurda (0 o negativa), así que
"sp" toma la mediana de la pendiente de los tramos vecinos que sí bajan (los que le entregan agua y el
siguiente), con un piso de PENDIENTE_MIN. La dirección aguas abajo NO cambia: es la de 04_flujo.py.

Uso (desde la raíz del repo, después de 04_flujo.py; solo usa la biblioteca estándar):
    python pipeline/flujo/pendientes.py

Escribe frontend/public/data/flujo.geojson (agrega "sp" a cada tramo) y la clave "pendientes" de
data/flujo.meta.json (fuente, fecha, conteos, sha256).
"""

import argparse
import hashlib
import json
import statistics
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_VERSION = "0.1.0"
PENDIENTE_MIN = 0.003  # m/m: piso para calles "planas" (una calle urbana rara vez baja menos de 0,3 %)
PENDIENTE_MAX = 0.25  # m/m: tope; más que esto en una calle es un error del DEM (bordes de taludes, puentes)
OTD_URL = "https://api.opentopodata.org/v1/srtm30m"
OTD_LOTE = 100
OTD_PAUSA_S = 1.0
OTD_MAX_DIA = 1000


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


# ---------- Open Topo Data (solo si falta la pendiente de #75) ----------
def clave(lon, lat):
    return f"{lat:.5f},{lon:.5f}"


def leer_cache(ruta):
    if ruta.exists():
        return json.loads(ruta.read_text(encoding="utf-8"))
    return {"elevaciones": {}, "consultas_por_dia": {}, "fuente": OTD_URL}


def pedir_elevaciones(puntos, ruta_cache, pausa=OTD_PAUSA_S, abrir=urllib.request.urlopen):
    """Elevación (m) de cada (lon, lat). Usa la caché en disco; lo que falta lo pide en lotes de 100."""
    cache = leer_cache(ruta_cache)
    elev = cache["elevaciones"]
    faltan = sorted({clave(lon, lat) for lon, lat in puntos} - set(elev))
    hoy = datetime.now(timezone.utc).date().isoformat()
    for i in range(0, len(faltan), OTD_LOTE):
        hechas = cache["consultas_por_dia"].get(hoy, 0)
        if hechas >= OTD_MAX_DIA:
            raise RuntimeError(f"Open Topo Data: se llegó al límite de {OTD_MAX_DIA} consultas de hoy; quedan {len(faltan) - i} puntos")
        lote = faltan[i : i + OTD_LOTE]
        req = urllib.request.Request(f"{OTD_URL}?locations={'|'.join(lote)}", headers={"User-Agent": "drena-pipeline/0.1"})
        with abrir(req, timeout=30) as r:
            datos = json.loads(r.read().decode("utf-8"))
        if datos.get("status") != "OK":
            raise RuntimeError(f"Open Topo Data respondió {datos.get('status')}: {datos.get('error')}")
        for k, res in zip(lote, datos["results"]):
            elev[k] = res["elevation"]
        cache["consultas_por_dia"][hoy] = hechas + 1
        cache["actualizado_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        ruta_cache.parent.mkdir(parents=True, exist_ok=True)
        ruta_cache.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        if i + OTD_LOTE < len(faltan):
            time.sleep(pausa)
    return {p: elev.get(clave(*p)) for p in puntos}


# ---------- Suavizado ----------
def necesita_suavizado(t):
    return t["r"] == 1 or t["s"] < PENDIENTE_MIN or t["s"] > PENDIENTE_MAX


def suavizar(tramos):
    """Devuelve {id: sp}. `tramos` es una lista de dicts con id, s, r y sig (como en flujo.geojson)."""
    por_id = {t["id"]: t for t in tramos}
    entrantes = {t["id"]: [] for t in tramos}
    for t in tramos:
        if t["sig"] is not None and t["sig"] in entrantes:
            entrantes[t["sig"]].append(t["id"])
    sp = {t["id"]: (None if necesita_suavizado(t) else t["s"]) for t in tramos}
    # Dos pasadas: la segunda llena los tramos rodeados de otros tramos malos con lo que dejó la primera
    for _ in range(2):
        nuevos = {}
        for t in tramos:
            if sp[t["id"]] is not None:
                continue
            vecinos = entrantes[t["id"]] + ([t["sig"]] if t["sig"] in por_id else [])
            vals = [sp[v] for v in vecinos if sp[v] is not None]
            if vals:
                nuevos[t["id"]] = statistics.median(vals)
        sp.update(nuevos)
    return {i: round(min(PENDIENTE_MAX, max(PENDIENTE_MIN, v if v is not None else PENDIENTE_MIN)), 4) for i, v in sp.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flujo", default="frontend/public/data/flujo.geojson")
    ap.add_argument("--meta", default="data/flujo.meta.json")
    ap.add_argument("--cache", default="cache/opentopodata/srtm30m.json")
    a = ap.parse_args()

    ruta = Path(a.flujo)
    g = json.loads(ruta.read_text(encoding="utf-8"))
    feats_t = [f for f in g["features"] if f["properties"]["kind"] == "tramo"]

    # 1) Pendiente del DEM: la de #75 si existe; si no, Open Topo Data
    sin_s = [f for f in feats_t if f["properties"].get("s") is None]
    fuente = "Copernicus DEM GLO-30, elevación por nodo de pipeline/04_flujo.py (PR #75)"
    consultadas = 0
    if sin_s:
        extremos = [tuple(f["geometry"]["coordinates"][0]) for f in sin_s] + [tuple(f["geometry"]["coordinates"][-1]) for f in sin_s]
        z = pedir_elevaciones(extremos, Path(a.cache))
        for f in sin_s:
            p = f["properties"]
            za, zb = z[tuple(f["geometry"]["coordinates"][0])], z[tuple(f["geometry"]["coordinates"][-1])]
            p["s"] = round(abs(za - zb) / max(p["L"], 1), 4) if za is not None and zb is not None else 0.0
            p["r"] = int(za is None or zb is None or za <= zb)
        consultadas = len(set(extremos))
        fuente += f"; {len(sin_s)} tramos con Open Topo Data SRTM 30 m ({OTD_URL})"
        print(f"{len(sin_s)} tramos sin pendiente: {consultadas} puntos pedidos a Open Topo Data (con caché)")
    else:
        print(f"Los {len(feats_t)} tramos ya traen la pendiente de 04_flujo.py: no se consulta ninguna API")

    # 2) Suavizado
    props = [f["properties"] for f in feats_t]
    sp = suavizar(props)
    for p in props:
        p["sp"] = sp[p["id"]]
    n_suav = sum(1 for p in props if necesita_suavizado(p))
    print(f"Suavizados {n_suav} de {len(props)} tramos (en contra del DEM, planos o con pendiente > {PENDIENTE_MAX})")

    texto = json.dumps(g, ensure_ascii=False, separators=(",", ":"))
    ruta.write_text(texto, encoding="utf-8")

    meta_ruta = Path(a.meta)
    meta = json.loads(meta_ruta.read_text(encoding="utf-8")) if meta_ruta.exists() else {}
    meta["salida"] = {"archivo": ruta.as_posix(), "sha256": sha256(ruta), "bytes": ruta.stat().st_size}
    meta["pendientes"] = {
        "generado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fuente": fuente,
        "fuente_respaldo": {"url": OTD_URL, "lote": OTD_LOTE, "pausa_s": OTD_PAUSA_S, "max_consultas_dia": OTD_MAX_DIA, "puntos_consultados": consultadas},
        "suavizado": {"pendiente_min": PENDIENTE_MIN, "pendiente_max": PENDIENTE_MAX, "tramos_suavizados": n_suav, "de": len(props),
                      "regla": "mediana de la pendiente de los tramos vecinos que bajan (entrantes y siguiente), con piso y tope"},
        "script": {"ruta": "pipeline/flujo/pendientes.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
    }
    meta_ruta.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{ruta} ({ruta.stat().st_size / 1024:.0f} KB) y {meta_ruta}")


if __name__ == "__main__":
    main()

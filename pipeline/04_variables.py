"""
Variables de la fórmula para las rejillas de la zona MUT (issues #11 y #12).

Uso (desde la raíz del repo, con data/terreno_mut.csv generado por 03_terreno.py):
    pip install -r pipeline/requirements.txt
    python pipeline/04_variables.py

Salidas (en data/):
    variables_mut.csv          una fila por rejilla de la zona MUT, variables entre 0 y 1
    osm_mut.geojson            los elementos de OSM usados (para que el cálculo sea reproducible)
    variables_mut.meta.json    fuentes, reglas, parámetros, conteos y sha256

Variables (nombres de backend/app/services/formula.py):
    arboles      fracción de píxeles de árboles (WorldCover clase 10) a menos de 15 m      #11
    suelo        fracción de suelo desnudo o escaso (WorldCover clase 60) a menos de 100 m  #11
    feria        cercanía a un mercado o feria de OSM (amenity=marketplace):
                 1 - d/300 m, con 0 desde los 300 m                                        #12
    obras        1 si hay una obra en OSM (landuse o building = construction) a menos de 100 m  #12
    criticidad   el mayor peso de la infraestructura crítica dentro de consecuencia.radio_crit_m
                 (metro, paso bajo nivel, hospital, colegio), con los pesos de
                 backend/config/formula_validacion.yaml                                    #12

Limitaciones:
  - "suelo" usa un radio alrededor de la rejilla, no el área aguas arriba.
  - "feria" no considera el día de la feria (los mercados de OSM no lo traen).
  - El paso bajo nivel se toma de calles para vehículos de OSM con tunnel=yes (no peatonales).
    Los túneles del Metro no cuentan.
  - Los puntos críticos del Gobierno no están en el repo, así que no entran a la criticidad.
"""

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import yaml

SCRIPT_VERSION = "0.1.0"
UTM = 32719
CENTRO = (-70.6010, -33.4178)  # debe ser el mismo de 03_terreno.py (se verifica con su metadata)

WORLDCOVER_URL = (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_S36W072_Map.tif"
)
CLASE_ARBOL, CLASE_SUELO = 10, 60
RADIO_ARBOLES_M = 15
RADIO_SUELO_M = 100
RADIO_OBRAS_M = 100
FERIA_ALCANCE_M = 300
# Un paso bajo nivel es un túnel de una calle para vehículos: no peatonal, ni ciclovía, ni
# "service" (en esta zona son rampas de estacionamientos)
VIAS_VEHICULARES = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential"}


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def recorte_worldcover(bbox, destino):
    """Guarda en cache/ el recorte de WorldCover de la zona (lectura remota del COG)."""
    import rasterio
    from rasterio.windows import from_bounds

    destino = Path(destino)
    if destino.exists():
        return destino
    destino.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open("/vsicurl/" + WORLDCOVER_URL) as src:
        win = from_bounds(*bbox, src.transform).round_offsets().round_lengths()
        arr = src.read(1, window=win)
        perfil = src.profile | {
            "height": arr.shape[0], "width": arr.shape[1], "transform": src.window_transform(win),
            "driver": "GTiff", "compress": "deflate", "tiled": False,
        }
        perfil.pop("blockxsize", None)
        perfil.pop("blockysize", None)
    with rasterio.open(destino, "w", **perfil) as dst:
        dst.write(arr, 1)
    return destino


def fraccion_clase(ruta, puntos_utm, radio, clase):
    """Fracción de píxeles de `clase` en un círculo de `radio` m alrededor de cada punto."""
    import geopandas as gpd
    import numpy as np
    import rasterio
    from rasterio.mask import mask

    out = []
    with rasterio.open(ruta) as src:
        circulos = gpd.GeoSeries(puntos_utm, crs=UTM).buffer(radio).to_crs(src.crs)
        for c in circulos:
            arr, _ = mask(src, [c], crop=True, all_touched=False, filled=False)
            v = arr[0].compressed() if np.ma.isMaskedArray(arr) else arr[0].ravel()
            out.append(float((v == clase).mean()) if v.size else 0.0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--terreno", default="data/terreno_mut.csv")
    ap.add_argument("--rejillas", default="data/rejillas.geojson")
    ap.add_argument("--config", default="backend/config/formula_validacion.yaml")
    ap.add_argument("--salida", default="data/variables_mut.csv")
    ap.add_argument("--overpass", default="https://maps.mail.ru/osm/tools/overpass/api",
                    help="servidor Overpass (overpass-api.de a veces rechaza conexiones)")
    a = ap.parse_args()

    import geopandas as gpd
    import osmnx as ox
    import pandas as pd

    meta_terreno = json.loads(Path(a.terreno).with_name("terreno_mut.meta.json").read_text(encoding="utf-8"))
    if tuple(meta_terreno["zona"]["centro_lonlat"]) != CENTRO:
        raise SystemExit("El centro del MUT no coincide con el de 03_terreno.py: volver a correr el terreno.")
    radio_zona = meta_terreno["zona"]["radio_m"]

    cfg = yaml.safe_load(Path(a.config).read_text(encoding="utf-8"))
    pesos_crit = cfg["consecuencia"]["criticidad"]
    radio_crit = cfg["consecuencia"]["radio_crit_m"]

    ter = pd.read_csv(a.terreno)
    ids_zona = set(ter.loc[ter["en_zona_mut"], "ID_IDE"])
    rej = gpd.read_file(a.rejillas)
    rej = rej[rej["ID_IDE"].isin(ids_zona)][["ID_IDE", "geometry"]].sort_values("ID_IDE").reset_index(drop=True)
    print(f"Rejillas de la zona MUT: {len(rej)}")
    pts = rej.to_crs(UTM).geometry

    # --- #11 WorldCover -------------------------------------------------------
    margen = 0.004
    xmin, ymin, xmax, ymax = rej.total_bounds
    bbox = (xmin - margen, ymin - margen, xmax + margen, ymax + margen)
    ruta_wc = recorte_worldcover(bbox, "cache/worldcover/worldcover_mut.tif")
    rej["arboles"] = fraccion_clase(ruta_wc, pts, RADIO_ARBOLES_M, CLASE_ARBOL)
    rej["suelo"] = fraccion_clase(ruta_wc, pts, RADIO_SUELO_M, CLASE_SUELO)

    # --- #12 OSM --------------------------------------------------------------
    alcance = max(radio_zona + max(radio_crit, FERIA_ALCANCE_M, RADIO_OBRAS_M) + 100, 1200)
    tags = {
        "amenity": ["marketplace", "hospital", "school"],
        "landuse": "construction",
        "building": "construction",
        "railway": ["station", "subway_entrance"],
        "tunnel": "yes",
    }
    ox.settings.overpass_url = a.overpass
    print(f"Bajando elementos de OSM a {alcance:.0f} m del centro desde {a.overpass}...")
    osm = ox.features_from_point((CENTRO[1], CENTRO[0]), tags=tags, dist=alcance).reset_index()

    def col(nombre):
        return osm[nombre] if nombre in osm else pd.Series([None] * len(osm))

    tipo = pd.Series([None] * len(osm), dtype="object")
    es_metro = (col("railway") == "subway_entrance") | (
        (col("railway") == "station") & ((col("station") == "subway") | (col("subway") == "yes"))
    )
    tipo[es_metro] = "metro"
    vehicular = col("highway").astype(str).str.replace("_link", "", regex=False).isin(VIAS_VEHICULARES)
    tipo[(col("tunnel") == "yes") & vehicular] = "paso_bajo_nivel"
    tipo[col("amenity") == "hospital"] = "hospital"
    tipo[col("amenity") == "school"] = "colegio"
    tipo[col("amenity") == "marketplace"] = "feria"
    tipo[(col("landuse") == "construction") | (col("building") == "construction")] = "obra"
    osm["tipo"] = tipo
    osm = osm[osm["tipo"].notna()].copy()
    keep = [c for c in ["element", "id", "name", "tipo", "highway", "geometry"] if c in osm]
    osm = osm[keep].sort_values(["tipo", "id"]).reset_index(drop=True)
    ruta_osm = Path(a.salida).with_name("osm_mut.geojson")
    osm.to_file(ruta_osm, driver="GeoJSON")
    print("Elementos OSM por tipo:", osm["tipo"].value_counts().to_dict())

    osm_utm = osm.to_crs(UTM)

    def dist_min(tp):
        g = osm_utm[osm_utm["tipo"] == tp].geometry
        if g.empty:
            return [math.inf] * len(pts)
        return [float(g.distance(p).min()) for p in pts]

    d_feria = dist_min("feria")
    rej["d_feria_m"] = [round(d, 1) if math.isfinite(d) else None for d in d_feria]
    rej["feria"] = [max(0.0, 1 - d / FERIA_ALCANCE_M) if math.isfinite(d) else 0.0 for d in d_feria]
    rej["obras"] = [1.0 if d <= RADIO_OBRAS_M else 0.0 for d in dist_min("obra")]

    crit, motivo = [0.0] * len(pts), [""] * len(pts)
    for tp in ("metro", "paso_bajo_nivel", "hospital", "colegio"):
        for i, d in enumerate(dist_min(tp)):
            if d <= radio_crit:
                motivo[i] = (motivo[i] + " " if motivo[i] else "") + f"{tp}:{d:.0f}m"
                crit[i] = max(crit[i], float(pesos_crit[tp]))
    rej["criticidad"] = crit
    rej["criticidad_motivo"] = motivo

    for c in ("arboles", "suelo", "feria"):
        rej[c] = rej[c].round(4)
    out = pd.DataFrame(rej.drop(columns="geometry"))
    salida = Path(a.salida)
    out.to_csv(salida, index=False)

    resumen = {c: {"media": round(float(out[c].mean()), 4), "max": round(float(out[c].max()), 4),
                   "no_cero": int((out[c] > 0).sum())} for c in ("arboles", "suelo", "feria", "obras", "criticidad")}
    print(json.dumps(resumen, ensure_ascii=False, indent=1))

    meta = {
        "generado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "zona": meta_terreno["zona"],
        "rejillas": len(out),
        "variables": {
            "arboles": f"fracción WorldCover clase {CLASE_ARBOL} a < {RADIO_ARBOLES_M} m",
            "suelo": f"fracción WorldCover clase {CLASE_SUELO} a < {RADIO_SUELO_M} m",
            "feria": f"max(0, 1 - d/{FERIA_ALCANCE_M} m) al amenity=marketplace más cercano",
            "obras": f"1 si landuse/building=construction a <= {RADIO_OBRAS_M} m",
            "criticidad": f"máximo peso de consecuencia.criticidad a <= {radio_crit} m (sin puntos críticos del Gobierno)",
        },
        "fuentes": {
            "worldcover": {"url": WORLDCOVER_URL, "version": "v200 (2021)", "recorte": str(ruta_wc),
                           "sha256_recorte": sha256(ruta_wc)},
            "osm": {"via": f"OSMnx {ox.__version__} features_from_point", "overpass": a.overpass,
                    "radio_m": alcance, "tags": tags,
                    "descargado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "archivo": ruta_osm.name, "sha256": sha256(ruta_osm),
                    "por_tipo": {k: int(v) for k, v in osm["tipo"].value_counts().items()}},
        },
        "entradas": {"terreno": {"ruta": a.terreno, "sha256": sha256(a.terreno)},
                     "rejillas": {"ruta": a.rejillas, "sha256": sha256(a.rejillas)},
                     "config": {"ruta": a.config, "sha256": sha256(a.config)}},
        "resumen": resumen,
        "salida": {"archivo": salida.name, "sha256": sha256(salida)},
        "script": {"ruta": "pipeline/04_variables.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
    }
    ruta_meta = salida.with_name("variables_mut.meta.json")
    ruta_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Guardado {salida}, {ruta_osm} y {ruta_meta}")


if __name__ == "__main__":
    main()

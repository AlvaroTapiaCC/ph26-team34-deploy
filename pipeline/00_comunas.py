"""
Exporta los límites comunales de Providencia, Ñuñoa y Las Condes desde OpenStreetMap.

Es la única fuente de límites comunales del proyecto: pipeline/02_rejillas.py recorta con
este archivo y el mapa del frontend dibuja el mismo (copia en frontend/public/data/).
Ejecutar antes que 02_rejillas.py.

Uso:
    pip install geopandas osmnx
    python pipeline/00_comunas.py

Salidas (en data/):
    comunas.geojson       un polígono por comuna, con la propiedad "comuna"
    comunas.meta.json     fecha de descarga, fuente, versiones y sha256
"""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_VERSION = "0.1.0"
COMUNAS = ["Providencia, Chile", "Ñuñoa, Chile", "Las Condes, Chile"]


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--salida", default="data/comunas.geojson")
    a = ap.parse_args()

    import osmnx as ox

    gdf = ox.geocode_to_gdf(COMUNAS)[["display_name", "geometry"]]
    gdf["comuna"] = gdf["display_name"].str.split(",").str[0]
    gdf = gdf[["comuna", "geometry"]].set_geometry("geometry").to_crs(4326)
    salida = Path(a.salida)
    salida.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(salida, driver="GeoJSON")
    print(gdf.assign(tipo=gdf.geom_type)[["comuna", "tipo"]].to_string(index=False))
    print(f"Guardado {salida}")

    meta = {
        "archivo": salida.name,
        "sha256": sha256(salida),
        "descargado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fuente": "OpenStreetMap, consultado con osmnx (Nominatim)",
        "osmnx": ox.__version__,
        "consultas": COMUNAS,
        "comunas": list(gdf["comuna"]),
        "script": {"ruta": "pipeline/00_comunas.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
    }
    ruta_meta = salida.with_name(salida.stem + ".meta.json")
    ruta_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Guardado {ruta_meta}")


if __name__ == "__main__":
    main()

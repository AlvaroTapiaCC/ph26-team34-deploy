"""
Exporta los límites comunales de Providencia, Ñuñoa y Las Condes desde OpenStreetMap.

Uso:
    pip install geopandas osmnx
    python pipeline/03_comunas.py

Salida:
    data/comunas.geojson    un polígono por comuna, con la propiedad "comuna"
"""

import argparse
from pathlib import Path

COMUNAS = ["Providencia, Chile", "Ñuñoa, Chile", "Las Condes, Chile"]


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


if __name__ == "__main__":
    main()

"""
Descarga UNA vez los límites de todas las comunas de la Provincia de Santiago más Puente Alto,
San Bernardo y Pirque, desde OpenStreetMap (admin_level=8), y los deja listos para el mapa.

Es solo contexto visual del frontend (límites punteados con el nombre de cada comuna): las comunas
del proyecto siguen saliendo de pipeline/00_comunas.py, que recorta el catastro y la fórmula.

Uso:
    pip install geopandas osmnx requests shapely
    python pipeline/00b_comunas_rm.py                      # OpenStreetMap (por defecto)
    python pipeline/00b_comunas_rm.py --fuente bcn --bcn ruta/DPA_comunas.shp   # plan B: DPA de la BCN

Salidas:
    frontend/public/data/comunas_rm.geojson   una geometría por comuna, propiedad "comuna"
    data/comunas.meta.json                    se agrega la clave "comunas_rm" (fuente, fecha, sha256)

Simplificación: tolerancia de 10 m (en UTM 19S) y coordenadas con 5 decimales (~1 m). Objetivo < 400 KB.
Si OpenStreetMap falla, usar la División Político Administrativa de la BCN (--fuente bcn). No usar el
SVG de Wikipedia (sin coordenadas) ni el límite urbano del PRMS (no son comunas).
"""

import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_VERSION = "0.1.0"
UTM = 32719
TOLERANCIA_M = 10.0
MAX_BYTES = 400 * 1024
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# Provincia de Santiago (32 comunas) + Puente Alto, San Bernardo y Pirque
COMUNAS = [
    "Cerrillos", "Cerro Navia", "Conchalí", "El Bosque", "Estación Central", "Huechuraba", "Independencia",
    "La Cisterna", "La Florida", "La Granja", "La Pintana", "La Reina", "Las Condes", "Lo Barnechea",
    "Lo Espejo", "Lo Prado", "Macul", "Maipú", "Ñuñoa", "Pedro Aguirre Cerda", "Peñalolén", "Providencia",
    "Pudahuel", "Quilicura", "Quinta Normal", "Recoleta", "Renca", "San Joaquín", "San Miguel", "San Ramón",
    "Santiago", "Vitacura",
    "Puente Alto", "San Bernardo", "Pirque",
]
PROYECTO = {"Providencia", "Ñuñoa", "Las Condes"}


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def desde_osm():
    """Comunas de OpenStreetMap (admin_level=8) con la geometría que arma Nominatim.

    Primero busca por Overpass las relaciones admin_level=8 de la Región Metropolitana (da los ids
    exactos). Si Overpass no responde (el servicio público se cae seguido), consulta Nominatim por
    nombre de comuna y comprueba que cada resultado sea un límite administrativo.
    """
    import osmnx as ox
    import requests

    consulta = '[out:json][timeout:60];area["ISO3166-2"="CL-RM"]->.rm;rel(area.rm)["boundary"="administrative"]["admin_level"="8"];out tags;'
    ids = {}
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": consulta}, timeout=40, headers={"User-Agent": "drena-pipeline/0.1"})
            r.raise_for_status()
            ids = {el["tags"]["name"]: el["id"] for el in r.json()["elements"] if el.get("tags", {}).get("name") in COMUNAS}
            if len(ids) == len(COMUNAS):
                break
        except requests.RequestException as e:
            print(f"  {url}: {type(e).__name__}")
    if len(ids) == len(COMUNAS):
        orden = list(ids)
        gdf = ox.geocode_to_gdf([f"R{ids[c]}" for c in orden], by_osmid=True)
        gdf["comuna"], gdf["osm_id"] = orden, [ids[c] for c in orden]
        return gdf[["comuna", "osm_id", "geometry"]], {
            "fuente": "OpenStreetMap (admin_level=8): relaciones por Overpass, geometría por Nominatim con osmnx",
            "osm_ids": ids,
        }

    print("Overpass no respondió: se consulta Nominatim por nombre.")
    filas = []
    for c in COMUNAS:
        g = ox.geocode_to_gdf(f"{c}, Región Metropolitana de Santiago, Chile")
        if g.geom_type.iloc[0] not in ("Polygon", "MultiPolygon"):
            raise RuntimeError(f"{c}: Nominatim no devolvió un polígono")
        filas.append({"comuna": c, "osm_id": int(g["osm_id"].iloc[0]), "tipo": f'{g["class"].iloc[0]}/{g["type"].iloc[0]}',
                      "geometry": g.geometry.iloc[0]})
        time.sleep(1.1)  # política de uso de Nominatim: 1 consulta por segundo
    import geopandas as gpd

    gdf = gpd.GeoDataFrame(filas, crs=4326)
    malos = gdf[gdf["tipo"] != "boundary/administrative"]
    if len(malos):
        raise RuntimeError(f"No son límites administrativos: {list(malos['comuna'])}")
    return gdf[["comuna", "osm_id", "geometry"]], {
        "fuente": "OpenStreetMap (límites administrativos), consultado por nombre en Nominatim con osmnx",
        "osm_ids": dict(zip(gdf["comuna"], map(int, gdf["osm_id"]))),
    }


def desde_bcn(ruta):
    """Plan B: División Político Administrativa de la BCN (shapefile o GeoJSON con una columna de nombre)."""
    import geopandas as gpd

    gdf = gpd.read_file(ruta)
    col = next((c for c in gdf.columns if c.lower() in ("comuna", "nom_comuna", "nombre")), None)
    if col is None:
        raise RuntimeError(f"No encuentro la columna con el nombre de la comuna en {list(gdf.columns)}")
    gdf = gdf[gdf[col].isin(COMUNAS)].rename(columns={col: "comuna"})[["comuna", "geometry"]].to_crs(4326)
    return gdf, {"fuente": "División Político Administrativa, Biblioteca del Congreso Nacional (BCN)", "archivo": str(ruta)}


def simplificar(gdf):
    import shapely
    from shapely.geometry import MultiPolygon, Polygon

    g = gdf.to_crs(UTM)
    g["geometry"] = g.geometry.buffer(0).simplify(TOLERANCIA_M, preserve_topology=True)
    g = g.to_crs(4326)
    g["geometry"] = [shapely.set_precision(geom, 1e-5) for geom in g.geometry]
    # Solo polígonos: se descartan islotes de menos de 1 ha que ensucian el mapa
    def limpiar(geom):
        partes = [geom] if isinstance(geom, Polygon) else list(geom.geoms)
        partes = [p for p in partes if p.area > 1e-6] or partes
        return partes[0] if len(partes) == 1 else MultiPolygon(partes)

    g["geometry"] = g.geometry.apply(limpiar)
    return g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fuente", choices=["osm", "bcn"], default="osm")
    ap.add_argument("--bcn", help="archivo de la DPA de la BCN (con --fuente bcn)")
    ap.add_argument("--salida", default="frontend/public/data/comunas_rm.geojson")
    ap.add_argument("--meta", default="data/comunas.meta.json")
    a = ap.parse_args()

    if a.fuente == "bcn":
        if not a.bcn:
            ap.error("--fuente bcn requiere --bcn")
        gdf, info = desde_bcn(a.bcn)
    else:
        try:
            gdf, info = desde_osm()
        except Exception as e:  # noqa: BLE001 - el plan B es explícito
            raise SystemExit(f"OpenStreetMap falló ({e}). Reintenta o usa --fuente bcn --bcn <DPA de la BCN>.") from e

    g = simplificar(gdf)
    g["en_proyecto"] = g["comuna"].isin(PROYECTO)
    # Punto de la etiqueta: el centroide si cae dentro de la comuna; si no, un punto interior
    def etiqueta(geom):
        pt = geom.centroid
        return pt if geom.contains(pt) else geom.representative_point()

    pts = g.geometry.apply(etiqueta)
    g["lon"], g["lat"] = pts.x.round(4), pts.y.round(4)
    km2 = g.to_crs(UTM).area / 1e6
    print(g.assign(km2=km2.round(1))[["comuna", "km2"]].to_string(index=False))
    salida = Path(a.salida)
    salida.parent.mkdir(parents=True, exist_ok=True)
    coleccion = json.loads(g[["comuna", "en_proyecto", "lon", "lat", "geometry"]].to_json(drop_id=True))
    texto = json.dumps(coleccion, ensure_ascii=False, separators=(",", ":"))
    salida.write_text(texto, encoding="utf-8")
    kb = salida.stat().st_size / 1024
    print(f"{len(g)} comunas, {kb:.0f} KB -> {salida}")
    if salida.stat().st_size > MAX_BYTES:
        print(f"OJO: supera {MAX_BYTES // 1024} KB; subir TOLERANCIA_M.")

    meta_ruta = Path(a.meta)
    meta = json.loads(meta_ruta.read_text(encoding="utf-8")) if meta_ruta.exists() else {}
    meta["comunas_rm"] = {
        "archivo": "frontend/public/data/comunas_rm.geojson",
        "sha256": sha256(salida),
        "bytes": salida.stat().st_size,
        "descargado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "simplificacion": {"tolerancia_m": TOLERANCIA_M, "decimales": 5, "crs_calculo": f"EPSG:{UTM}"},
        "comunas": list(g["comuna"]),
        "script": {"ruta": "pipeline/00b_comunas_rm.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
        **info,
    }
    meta_ruta.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Metadata en {meta_ruta}")


if __name__ == "__main__":
    main()

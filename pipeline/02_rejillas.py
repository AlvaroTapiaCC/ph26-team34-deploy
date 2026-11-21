"""
Descarga el catastro de sumideros SIALL (DOH) de una zona y lo deja versionado.

Uso:
    pip install requests geopandas osmnx
    python pipeline/02_rejillas.py                       # Providencia + Ñuñoa
    python pipeline/02_rejillas.py --anegados data/anegados_20261013.geojson
    python pipeline/02_rejillas.py --sin-recorte         # no recorta por comunas

Salidas (en data/):
    rejillas.geojson         rejillas dentro de la zona, ordenadas por OBJECTID
    rejillas.meta.json       fecha de descarga, servicio, conteos, versión y sha256 del script
    anegados_rejillas.csv    (con --anegados) rejillas a menos de 50 m de cada punto anegado

Qué hace:
  1. Lee la ficha de la capa: nombre, campos, límite de resultados por consulta.
  2. Cuenta cuántas rejillas hay en el rectángulo de la zona y pide sus IDs.
  3. Pide las coordenadas a /identify por baldosas: el servicio oculta la geometría en /query.
  4. Descarga los atributos en lotes por /query y los une con las coordenadas.
  5. Recorta por los límites de las comunas (OSM) y guarda el GeoJSON y su metadata.
  6. Cuenta las rejillas a 700 m del MUT y, si se entregan, las cercanas a cada punto anegado.

Notas:
  - ID estable para el resto del sistema: ID_IDE (p. ej. AL13SU013887). OBJECTID puede
    cambiar si la DOH republica la capa. Los registros repetidos con el mismo ID_IDE se
    descartan (queda el OBJECTID menor) y se listan en la metadata.
  - Los valores -99 significan dato desconocido.
  - Archivo de anegados: GeoJSON de puntos o CSV con columnas lat/lon (y opcionalmente id).
"""

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

SCRIPT_VERSION = "0.2.0"

CAPA = "https://rest-sit.mop.gob.cl/arcgis/rest/services/DOH/SIALL/MapServer/3"
MAPSERVER = CAPA.rsplit("/", 1)[0]
UTM = 32719  # metros, huso 19S

# Rectángulos aproximados (lon_min, lat_min, lon_max, lat_max), con margen.
# El recorte fino se hace después con los límites comunales de OSM.
ZONAS = {
    "provi_nunoa": {
        "bbox": (-70.650, -33.485, -70.560, -33.405),
        "comunas": ["Providencia, Chile", "Ñuñoa, Chile"],
    },
    # Centro aproximado del MUT; confirmar en el mapa. ~700 m de radio.
    "mut": {
        "bbox": (-70.6085, -33.4240, -70.5935, -33.4115),
        "comunas": None,
        "centro": (-70.6010, -33.4178),
        "radio_m": 700,
    },
}

S = requests.Session()
S.headers["User-Agent"] = "hackaton-sumideros/0.2"


def pedir(url, params, metodo="get"):
    params = {**params, "f": params.get("f", "json")}
    for intento in range(3):
        try:
            if metodo == "post":
                r = S.post(url, data=params, timeout=60)
            else:
                r = S.get(url, params=params, timeout=60)
            r.raise_for_status()
            data = r.json()
            if "error" in data:
                raise RuntimeError(json.dumps(data["error"], ensure_ascii=False))
            return data
        except Exception as e:  # noqa: BLE001
            print(f"  intento {intento + 1} falló: {e}")
            time.sleep(2 * (intento + 1))
    sys.exit("No se pudo consultar el servicio. Prueben abrir la URL de la capa en el navegador.")


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def ficha_capa():
    info = pedir(CAPA, {})
    print("== Ficha de la capa ==")
    print("Nombre:          ", info.get("name"))
    print("Geometría:       ", info.get("geometryType"))
    print("Versión servidor:", info.get("currentVersion"))
    print("Máx. por consulta:", info.get("maxRecordCount"))
    return info


def params_zona(bbox):
    xmin, ymin, xmax, ymax = bbox
    return {
        "where": "1=1",
        "geometry": f"{xmin},{ymin},{xmax},{ymax}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
    }


def contar(bbox):
    d = pedir(f"{CAPA}/query", {**params_zona(bbox), "returnCountOnly": "true"})
    return d.get("count")


def ids(bbox):
    d = pedir(f"{CAPA}/query", {**params_zona(bbox), "returnIdsOnly": "true"})
    return d.get("objectIdFieldName"), sorted(d.get("objectIds") or [])


def coords_identify(bbox, paso=0.01):
    """El servicio oculta la geometría en /query; /identify sí la entrega.

    Recorre la zona en baldosas de ~1 km (la capa solo es visible a escala
    1:9028 o más cerca) y subdivide si una baldosa devuelve menos que el conteo.
    """
    xmin, ymin, xmax, ymax = bbox
    coords = {}

    def baldosa(bx):
        n = contar(bx) or 0
        if n == 0:
            return
        x0, y0, x1, y1 = bx
        ext = f"{x0},{y0},{x1},{y1}"
        d = pedir(
            f"{MAPSERVER}/identify",
            {
                "geometry": ext,
                "geometryType": "esriGeometryEnvelope",
                "sr": 4326,
                "layers": "all:3",
                "tolerance": 0,
                "mapExtent": ext,
                "imageDisplay": "1000,1000,96",
                "returnGeometry": "true",
            },
        )
        res = [r for r in d.get("results", []) if r.get("geometry")]
        if len(res) < n and (x1 - x0) > 0.001:
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            for sub in ((x0, y0, mx, my), (mx, y0, x1, my), (x0, my, mx, y1), (mx, my, x1, y1)):
                baldosa(sub)
            return
        for r in res:
            g = r["geometry"]
            coords[int(r["attributes"]["OBJECTID"])] = (g["x"], g["y"])

    x = xmin
    while x < xmax:
        y = ymin
        while y < ymax:
            baldosa((x, y, min(x + paso, xmax), min(y + paso, ymax)))
            y += paso
        x += paso
        print(f"  coordenadas obtenidas: {len(coords)}")
    return coords


def descargar(oid_campo, lista_ids, lote, coords):
    feats = []
    for i in range(0, len(lista_ids), lote):
        trozo = lista_ids[i : i + lote]
        d = pedir(
            f"{CAPA}/query",
            {
                "objectIds": ",".join(map(str, trozo)),
                "outFields": "*",
                "returnGeometry": "false",
            },
            metodo="post",
        )
        for f in d.get("features", []):
            attrs = f.get("attributes", {})
            xy = coords.get(attrs.get(oid_campo))
            if xy is None:
                continue  # sin coordenada desde identify
            feats.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": list(xy)},
                    "properties": attrs,
                }
            )
        print(f"  descargadas {len(feats)} de {len(lista_ids)}")
    return feats


def en_radio(gdf, centro, radio_m):
    import geopandas as gpd
    from shapely.geometry import Point

    c = gpd.GeoSeries([Point(centro)], crs=4326).to_crs(UTM).iloc[0]
    return gdf[gdf.to_crs(UTM).distance(c) <= radio_m].copy()


def recortar(gdf, zona):
    import geopandas as gpd

    if zona.get("comunas"):
        import osmnx as ox

        limites = ox.geocode_to_gdf(zona["comunas"])[["display_name", "geometry"]]
        limites["comuna"] = limites["display_name"].str.split(",").str[0]
        return gpd.sjoin(gdf, limites[["comuna", "geometry"]], predicate="within").drop(columns="index_right")
    if zona.get("centro"):
        return en_radio(gdf, zona["centro"], zona["radio_m"])
    return gdf


def dentro_bbox(lon, lat, bbox):
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def cargar_anegados(ruta):
    import geopandas as gpd
    import pandas as pd

    if str(ruta).lower().endswith(".csv"):
        df = pd.read_csv(ruta)
        cols = {c.lower(): c for c in df.columns}
        lat = next((cols[k] for k in ("lat", "latitud", "y") if k in cols), None)
        lon = next((cols[k] for k in ("lon", "lng", "longitud", "x") if k in cols), None)
        if not lat or not lon:
            sys.exit(f"{ruta}: el CSV necesita columnas lat y lon.")
        g = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df[lon], df[lat]), crs=4326)
    else:
        g = gpd.read_file(ruta).to_crs(4326)
    if "id" not in g.columns:
        g["id"] = range(1, len(g) + 1)
    return g.reset_index(drop=True)


def rejillas_cerca(anegados, rejillas, radio_m, bbox):
    """Para cada punto anegado: cuántas rejillas hay a menos de radio_m y cuál es la más cercana."""
    import geopandas as gpd

    a = anegados.to_crs(UTM)
    r = rejillas[["ID_IDE", "geometry"]].to_crs(UTM)
    filas = []
    for i, p in a.iterrows():
        dist = r.distance(p.geometry)
        cerca = r[dist < radio_m]
        orig = anegados.geometry.iloc[i]
        filas.append(
            {
                "id": p["id"],
                "lat": round(orig.y, 6),
                "lon": round(orig.x, 6),
                "n_rejillas": len(cerca),
                "dist_min_m": round(float(dist.min()), 1) if len(dist) else None,
                "ids_rejillas": " ".join(cerca["ID_IDE"].astype(str)),
                "fuera_de_zona": not dentro_bbox(orig.x, orig.y, bbox),
            }
        )
    return gpd.pd.DataFrame(filas)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zona", default="provi_nunoa", choices=ZONAS.keys())
    ap.add_argument("--sin-recorte", action="store_true")
    ap.add_argument("--salida", default="data/rejillas.geojson")
    ap.add_argument("--anegados", help="GeoJSON o CSV con los puntos anegados (p. ej. 13 de octubre)")
    ap.add_argument("--radio-anegados", type=float, default=50.0)
    a = ap.parse_args()
    zona = ZONAS[a.zona]
    salida = Path(a.salida)
    salida.parent.mkdir(parents=True, exist_ok=True)

    import geopandas as gpd

    info = ficha_capa()
    maximo = info.get("maxRecordCount") or 1000

    print(f"\n== Zona '{a.zona}' ==")
    n = contar(zona["bbox"])
    print("Rejillas en el rectángulo:", n)

    campo_oid, lista = ids(zona["bbox"])
    print("IDs recibidos:", len(lista))
    if n is not None and len(lista) != n:
        print("  OJO: el número de IDs no coincide con el conteo.")

    print("Obteniendo coordenadas vía identify...")
    coords = coords_identify(zona["bbox"])
    feats = descargar(campo_oid, lista, lote=min(maximo, 500), coords=coords)
    print("Rejillas descargadas:", len(feats))
    if len(feats) < len(lista):
        print("  OJO: faltan rejillas; revisar si hay geometrías vacías o errores de lote.")

    todas = gpd.GeoDataFrame.from_features(feats, crs=4326).sort_values("OBJECTID")
    # El catastro publica algunas rejillas dos veces (mismo ID_IDE, coordenada y atributos;
    # solo cambia OBJECTID). Se conserva el OBJECTID menor para que ID_IDE sea único.
    rep = todas["ID_IDE"].duplicated(keep="first")
    descartados = [int(o) for o in todas.loc[rep, "OBJECTID"]]
    if descartados:
        print(f"Registros duplicados por ID_IDE descartados: {len(descartados)}")
    todas = todas[~rep]

    gdf = todas if a.sin_recorte else recortar(todas, zona)
    gdf = gdf.sort_values("OBJECTID").reset_index(drop=True)
    print("\nRejillas dentro de la zona:", len(gdf))

    conteos = {"rectangulo": n, "descargadas": len(feats), "en_zona": len(gdf)}
    if "comuna" in gdf.columns:
        conteos["por_comuna_osm"] = {k: int(v) for k, v in gdf["comuna"].value_counts().items()}
        print(gdf["comuna"].value_counts().to_string())

    conteos["duplicados_descartados_rectangulo"] = len(descartados)

    # Paso: rejillas a 700 m del MUT (sobre todo el rectángulo, sin recorte comunal,
    # porque el círculo cruza a Las Condes).
    mut = ZONAS["mut"]
    cx, cy = mut["centro"]
    if dentro_bbox(cx, cy, zona["bbox"]):
        n_mut = len(en_radio(todas, mut["centro"], mut["radio_m"]))
        conteos["mut_700m"] = {"centro_lonlat": list(mut["centro"]), "radio_m": mut["radio_m"], "rejillas": n_mut}
        print(f"\nRejillas a {mut['radio_m']} m del MUT: {n_mut} (centro aproximado, confirmar en el mapa)")

    gdf.to_file(salida, driver="GeoJSON")
    print(f"\nGuardado {salida}")

    meta = {
        "archivo": salida.name,
        "sha256": sha256(salida),
        "descargado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "servicio": CAPA,
        "operaciones": {"atributos": "query", "coordenadas": "identify"},
        "version_servidor": info.get("currentVersion"),
        "zona": a.zona,
        "bbox_lonlat": list(zona["bbox"]),
        "recorte": "ninguno" if a.sin_recorte else (zona.get("comunas") or f"{zona.get('radio_m')} m"),
        "n_rejillas": len(gdf),
        "id_estable": "ID_IDE",
        "objectid_duplicados_descartados": descartados,
        "valores_desconocidos": -99,
        "conteos": conteos,
        "script": {"ruta": "pipeline/02_rejillas.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
    }

    # Paso: rejillas cercanas a cada punto anegado (13 de octubre, cuando exista el archivo).
    if a.anegados:
        aneg = cargar_anegados(a.anegados)
        tabla = rejillas_cerca(aneg, todas, a.radio_anegados, zona["bbox"])
        ruta_csv = salida.with_name("anegados_rejillas.csv")
        tabla.to_csv(ruta_csv, index=False)
        sin = int((tabla["n_rejillas"] == 0).sum())
        fuera = int(tabla["fuera_de_zona"].sum())
        print(f"\nPuntos anegados: {len(tabla)}; sin rejilla a <{a.radio_anegados:g} m: {sin}")
        if fuera:
            print(f"  OJO: {fuera} puntos están fuera del rectángulo descargado; su conteo no es válido.")
        print(f"Guardado {ruta_csv}")
        meta["anegados"] = {
            "fuente": str(a.anegados),
            "sha256_fuente": sha256(a.anegados),
            "radio_m": a.radio_anegados,
            "puntos": len(tabla),
            "puntos_sin_rejilla": sin,
            "puntos_fuera_de_zona": fuera,
            "salida": ruta_csv.name,
        }
    else:
        meta["anegados"] = None
        print("\nSin archivo de anegados: el paso de 50 m queda pendiente (usar --anegados).")

    ruta_meta = salida.with_name(salida.stem + ".meta.json")
    ruta_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Guardado {ruta_meta}")


if __name__ == "__main__":
    main()

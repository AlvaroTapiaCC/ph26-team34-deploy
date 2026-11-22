"""
Copia los datos del pipeline a frontend/public/data/ para que el mapa los cargue.

Uso (desde la raíz del repo, con data/ ya generado por 00_comunas.py y 02_rejillas.py):
    python pipeline/publicar_front.py
    python pipeline/publicar_front.py --datos ruta/a/data     # si data/ está en otra carpeta

Salidas (en frontend/public/data/):
    comunas.geojson     copia idéntica de data/comunas.geojson
    rejillas.geojson    versión liviana de data/rejillas.geojson: solo id (ID_IDE) y comuna,
                        coordenadas con 6 decimales (el mapa solo necesita la posición)
    recorridos.geojson  trazado de cada servicio y sentido del extracto GTFS de DTPM
                        (backend/data/transporte_mut.json, pipeline/09_gtfs.py). El tablero
                        dibuja los servicios de los paraderos expuestos (issue #92)
    cadenas_mut.geojson  tramos dirigidos de las cadenas que pasan por la zona MUT

    python pipeline/publicar_front.py --solo-recorridos   # solo recorridos.geojson

Correr este script cuando cambie el catastro, el terreno o las cadenas.
"""

import argparse
import csv
import hashlib
import json
import math
import shutil
from pathlib import Path


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def publicar_recorridos(origen, destino):
    """Un MultiLineString por servicio y sentido, con la fuente y la fecha del GTFS."""
    src = json.loads(Path(origen).read_text(encoding="utf-8"))
    meta_ruta = Path(origen).with_suffix(".meta.json")
    meta = json.loads(meta_ruta.read_text(encoding="utf-8")) if meta_ruta.exists() else {}
    salida = {
        "type": "FeatureCollection",
        "fuente": meta.get("fuente", "GTFS de DTPM"),
        "fecha_descarga": meta.get("fecha_descarga"),
        "url": meta.get("url"),
        "sha256_origen": sha256(origen),
        "features": [
            {
                "type": "Feature",
                "properties": {"servicio": r["servicio"], "sentido": r["sentido"], "destino": r.get("destino")},
                "geometry": {
                    "type": "MultiLineString",
                    "coordinates": [[[round(x, 6), round(y, 6)] for x, y in tramo] for tramo in r["geometria"]],
                },
            }
            for r in src["recorridos"]
            if r.get("geometria")
        ],
    }
    ruta = Path(destino) / "recorridos.geojson"
    ruta.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{ruta}  sha256={sha256(ruta)[:12]}…  {len(salida['features'])} recorridos")


def publicar_cadenas(datos, destino, coordenadas):
    """Une rejillas consecutivas de la cadena en el sentido de la pendiente."""
    origen = datos / "street_chains_mut.json"
    terreno = datos / "terreno_mut.csv"
    if not origen.exists() or not terreno.exists():
        print("Sin cadenas o terreno MUT: no se publica cadenas_mut.geojson")
        return

    with terreno.open(newline="", encoding="utf-8") as archivo:
        zona = {fila["ID_IDE"] for fila in csv.DictReader(archivo) if fila["en_zona_mut"].lower() in ("true", "1")}
    tramos = {}
    for cadena in json.loads(origen.read_text(encoding="utf-8")):
        ids = cadena["sumidero_ids"]
        if zona.isdisjoint(ids):
            continue
        distancias = [float(d) for d in cadena["distancias_m"]]
        if len(ids) != len(distancias) or not all(math.isfinite(d) for d in distancias):
            raise ValueError(f"Distancias inválidas en {cadena['street_id']}")
        for anterior, siguiente, inicio, fin in zip(ids, ids[1:], distancias, distancias[1:]):
            if fin < inicio:
                raise ValueError(f"Distancias decrecientes en {cadena['street_id']}")
            a, b = coordenadas.get(anterior), coordenadas.get(siguiente)
            if a is None or b is None or a == b:
                continue
            clave = anterior, siguiente
            distancia = round(fin - inicio, 1)
            tramos[clave] = min(tramos.get(clave, distancia), distancia)

    salida = {
        "type": "FeatureCollection",
        "fuentes_sha256": {ruta.name: sha256(ruta) for ruta in (origen, terreno, datos / "rejillas.geojson")},
        "features": [
            {
                "type": "Feature",
                "properties": {"desde": a, "hasta": b, "distancia_m": distancia},
                "geometry": {"type": "LineString", "coordinates": [coordenadas[a], coordenadas[b]]},
            }
            for (a, b), distancia in sorted(tramos.items())
        ],
    }
    ruta = Path(destino) / "cadenas_mut.geojson"
    ruta.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{ruta}  sha256={sha256(ruta)[:12]}…  {len(tramos)} tramos dirigidos")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="data")
    ap.add_argument("--destino", default="frontend/public/data")
    ap.add_argument("--transporte", default="backend/data/transporte_mut.json")
    ap.add_argument("--solo-recorridos", action="store_true")
    a = ap.parse_args()
    datos, destino = Path(a.datos), Path(a.destino)
    destino.mkdir(parents=True, exist_ok=True)

    if Path(a.transporte).exists():
        publicar_recorridos(a.transporte, destino)
    else:
        print(f"Sin {a.transporte}: no se publica recorridos.geojson")
    if a.solo_recorridos:
        return

    shutil.copyfile(datos / "comunas.geojson", destino / "comunas.geojson")

    src = json.loads((datos / "rejillas.geojson").read_text(encoding="utf-8"))
    liviano = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"id": f["properties"]["ID_IDE"], "comuna": f["properties"].get("comuna")},
                "geometry": {"type": "Point", "coordinates": [round(c, 6) for c in f["geometry"]["coordinates"]]},
            }
            for f in src["features"]
        ],
    }
    (destino / "rejillas.geojson").write_text(json.dumps(liviano, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    coordenadas = {f["properties"]["id"]: f["geometry"]["coordinates"] for f in liviano["features"]}
    publicar_cadenas(datos, destino, coordenadas)

    for nombre in ("comunas.geojson", "rejillas.geojson"):
        print(f"{destino / nombre}  sha256={sha256(destino / nombre)[:12]}…")
    print(f"{len(liviano['features'])} rejillas")


if __name__ == "__main__":
    main()

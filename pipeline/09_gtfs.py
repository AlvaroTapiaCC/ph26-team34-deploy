"""Extracto de buses MUT. Uso: python pipeline/09_gtfs.py GTFS_20261114_v2.zip --fecha 2026-11-21"""
import argparse
import csv
import hashlib
import io
import json
import math
from collections import defaultdict
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
CENTRO = (-70.601433, -33.417741)
RADIO = 900
METROS_LAT = math.pi * 6371000 / 180
METROS_LON = METROS_LAT * math.cos(math.radians(CENTRO[1]))
URL = "https://www.dtpm.cl/descargas/gtfs/GTFS_20261114_v2.zip"


def distancia(a, b):
    return math.hypot((a[0] - b[0]) * METROS_LON, (a[1] - b[1]) * METROS_LAT)


def filas(z, nombre):
    with z.open(nombre + ".txt") as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))


def tramos(puntos):
    """Recorta segmentos al círculo en coordenadas métricas locales, incluso al cruzarlo."""
    partes = []
    for a, b in zip(puntos, puntos[1:]):
        dx, dy = (b[0]-a[0])*METROS_LON, (b[1]-a[1])*METROS_LAT
        x, y = (a[0]-CENTRO[0])*METROS_LON, (a[1]-CENTRO[1])*METROS_LAT
        longitud2 = dx*dx + dy*dy
        if longitud2 == 0:
            continue
        proy = x*dx + y*dy
        disc = proy**2 - longitud2*(x*x + y*y - RADIO**2)
        if disc <= 0:
            continue
        inicio = max(0, (-proy-math.sqrt(disc))/longitud2)
        fin = min(1, (-proy+math.sqrt(disc))/longitud2)
        if inicio >= fin:
            continue
        extremos = [[round(a[i]+t*(b[i]-a[i]), 7) for i in (0, 1)] for t in (inicio, fin)]
        if partes and partes[-1][-1] == extremos[0]:
            partes[-1].append(extremos[1])
        else:
            partes.append(extremos)
    return partes


def extraer(z):
    paraderos = {}
    for r in filas(z, "stops"):
        if r["location_type"] not in ("", "0"):
            continue
        lon, lat = float(r["stop_lon"]), float(r["stop_lat"])
        if distancia((lon, lat), CENTRO) < RADIO:
            paraderos[r["stop_id"]] = dict(id=r["stop_id"], nombre=r["stop_name"], lon=lon, lat=lat)
    buses = {r["route_id"]: r["route_short_name"] for r in filas(z, "routes") if r["route_type"] == "3"}
    viajes = {r["trip_id"]: r for r in filas(z, "trips") if r["route_id"] in buses}
    secuencias = defaultdict(list)
    for r in filas(z, "stop_times"):
        if r["stop_id"] in paraderos and r["trip_id"] in viajes:
            secuencias[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"]))

    servicios = defaultdict(set)
    elegidos = {}
    for tid in sorted(secuencias):
        viaje = viajes[tid]
        clave = (buses[viaje["route_id"]], viaje["direction_id"])
        for _, pid in secuencias[tid]:
            servicios[pid].add((*clave, viaje["trip_headsign"]))
        # Preferir el viaje que cubre más paradas de la zona y desempatar por trip_id.
        if clave not in elegidos or len(secuencias[tid]) > len(secuencias[elegidos[clave]]):
            elegidos[clave] = tid

    formas = {viajes[tid]["shape_id"]: [] for tid in elegidos.values()}
    for r in filas(z, "shapes"):
        if r["shape_id"] in formas:
            formas[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))
    lineas = []
    for (servicio, sentido), tid in sorted(elegidos.items()):
        v = viajes[tid]
        puntos = [(lon, lat) for _, lon, lat in sorted(formas[v["shape_id"]])]
        lineas.append(dict(servicio=servicio, sentido=sentido, destino=v["trip_headsign"], viaje=tid,
                           paraderos=[p for _, p in sorted(secuencias[tid])], geometria=tramos(puntos)))
    stops = []
    for pid, claves in sorted(servicios.items()):
        stops.append({**paraderos[pid], "servicios": [dict(servicio=s, sentido=d, destino=h) for s, d, h in sorted(claves)]})
    return dict(paraderos=stops, recorridos=lineas)


def cercanos(stops):
    with (ROOT/"data/terreno_mut.csv").open(encoding="utf-8") as f:
        ranking = {r["ID_IDE"] for r in csv.DictReader(f) if r["en_zona_mut"] == "True" and r["fuera_de_red"] == "False"}
    puntos = json.loads((ROOT/"data/rejillas.geojson").read_text(encoding="utf-8"))["features"]
    rejillas = [(p["properties"]["ID_IDE"], p["geometry"]["coordinates"]) for p in puntos if p["properties"]["ID_IDE"] in ranking]
    out = []
    for s in stops:
        metros, rejilla = min((distancia((s["lon"], s["lat"]), xy), rid) for rid, xy in rejillas)
        if metros < 80:
            out.append(dict(paradero=s["id"], rejilla=rejilla, distancia_m=round(metros, 1)))
    return sorted(out, key=lambda p: p["distancia_m"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path)
    parser.add_argument("--url", default=URL)
    parser.add_argument("--fecha", required=True, help="Fecha de descarga (AAAA-MM-DD)")
    args = parser.parse_args()
    with ZipFile(args.zip) as z:
        datos = extraer(z)
    with args.zip.open("rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    meta = dict(fuente="GTFS de DTPM", url=args.url, fecha_descarga=args.fecha,
                sha256_zip=digest, centro_lonlat=CENTRO, radio_m=RADIO,
                paraderos_a_menos_de_80m=cercanos(datos["paraderos"]))
    dest = ROOT/"backend/data/transporte_mut.json"
    dest.write_bytes((json.dumps(datos, ensure_ascii=False, separators=(",", ":"))+"\n").encode())
    meta["sha256_salida"] = hashlib.sha256(dest.read_bytes()).hexdigest()
    dest.with_suffix(".meta.json").write_bytes((json.dumps(meta, ensure_ascii=False, indent=2)+"\n").encode())


if __name__ == "__main__":
    main()

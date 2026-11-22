"""Extracto de buses MUT. Uso: python pipeline/09_gtfs.py GTFS_20261114_v2.zip --fecha 2026-11-21"""
import argparse
import csv
import hashlib
import io
import json
import math
import os
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
CENTRO = (-70.601433, -33.417741)
RADIO = 900
METROS_LAT = math.pi * 6371000 / 180
METROS_LON = METROS_LAT * math.cos(math.radians(CENTRO[1]))
URL = "https://www.dtpm.cl/descargas/gtfs/GTFS_20261114_v2.zip"
OSRM_URL = "https://router.project-osrm.org"
MATCH_PARAMS = dict(overview="full", geometries="geojson", tidy="true", gaps="split")
MAX_COORDS = 10
RADIO_MATCH = 30
CONFIANZA_MIN = 0.7
DESVIO_MAX_M = 40
VARIACION_MAX = 0.25


def distancia(a, b):
    return math.hypot((a[0] - b[0]) * METROS_LON, (a[1] - b[1]) * METROS_LAT)


def longitud(puntos):
    return sum(distancia(a, b) for a, b in zip(puntos, puntos[1:]))


def distancia_segmento(p, a, b):
    dx, dy = (b[0]-a[0])*METROS_LON, (b[1]-a[1])*METROS_LAT
    px, py = (p[0]-a[0])*METROS_LON, (p[1]-a[1])*METROS_LAT
    t = max(0, min(1, (px*dx + py*dy)/(dx*dx + dy*dy))) if dx or dy else 0
    return math.hypot(px-t*dx, py-t*dy)


def validar_match(datos, fuente):
    matches = datos.get("matchings") or []
    if datos.get("code") != "Ok" or len(matches) != 1:
        return None
    match = matches[0]
    geom = match.get("geometry") or {}
    puntos = geom.get("coordinates") or []
    if match.get("confidence", 0) < CONFIANZA_MIN or geom.get("type") != "LineString" or len(puntos) < 2:
        return None
    if any(len(p) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in p) for p in puntos):
        return None
    if any(min(distancia_segmento(p, a, b) for a, b in zip(fuente, fuente[1:])) > DESVIO_MAX_M for p in puntos):
        return None
    if distancia(puntos[0], fuente[0]) > DESVIO_MAX_M or distancia(puntos[-1], fuente[-1]) > DESVIO_MAX_M:
        return None
    # Los extremos originales unen sin huecos los chunks ajustados y los de respaldo.
    unidos = [fuente[0], *puntos, fuente[-1]]
    original = longitud(fuente)
    if not original or abs(longitud(unidos)/original - 1) > VARIACION_MAX:
        return None
    return unidos


class AjustadorOSRM:
    def __init__(self, servidor, cache):
        self.servidor = servidor.rstrip("/")
        self.cache = cache
        self.cache.mkdir(parents=True, exist_ok=True)
        self.conteos = {}
        self.fallos = 0

    def consultar(self, puntos):
        coords = ";".join(f"{lon},{lat}" for lon, lat in puntos)
        params = {**MATCH_PARAMS, "radiuses": ";".join([str(RADIO_MATCH)]*len(puntos))}
        url = f"{self.servidor}/match/v1/driving/{coords}?{urlencode(params)}"
        ruta = self.cache / (hashlib.sha256(url.encode()).hexdigest() + ".json")
        if ruta.exists():
            self.fallos = 0
            return json.loads(ruta.read_text())
        for intento in range(3):
            time.sleep(1 + intento*2)
            try:
                with urlopen(Request(url, headers={"User-Agent": "Drena-GTFS/1.0"}), timeout=40) as response:
                    datos = json.load(response)
                ruta.write_text(json.dumps(datos, separators=(",", ":")))
                self.fallos = 0
                return datos
            except HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504):
                    return {}
            except (URLError, TimeoutError, ValueError):
                pass
        self.fallos += 1
        if self.fallos >= 3:
            raise RuntimeError("OSRM no responde tras tres chunks; se detiene sin publicar datos")
        return {}

    def ajustar(self, puntos, shape):
        salida = []
        conteo = dict(matched=0, fallback=0)
        for inicio in range(0, len(puntos)-1, MAX_COORDS-1):
            chunk = puntos[inicio:inicio+MAX_COORDS]
            ajustado = validar_match(self.consultar(chunk), chunk)
            conteo["matched" if ajustado else "fallback"] += 1
            for p in ajustado or chunk:
                if not salida or list(salida[-1]) != list(p):
                    salida.append(p)
        self.conteos[shape] = conteo
        print(f"{shape}: {conteo}", flush=True)
        return salida

    def metadatos(self):
        return dict(metodo="OSRM match", servidor=self.servidor, perfil="driving",
                    parametros={**MATCH_PARAMS, "radiuses_m": RADIO_MATCH},
                    fecha_utc=datetime.now(timezone.utc).isoformat(), max_coordenadas=MAX_COORDS,
                    solapamiento=1, confianza_min=CONFIANZA_MIN, desvio_max_m=DESVIO_MAX_M,
                    variacion_longitud_max=VARIACION_MAX, por_shape=self.conteos,
                    totales={k: sum(c[k] for c in self.conteos.values()) for k in ("matched", "fallback")})


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


def extraer(z, ajustador=None):
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
        if ajustador:
            puntos = ajustador.ajustar(puntos, v["shape_id"])
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
    parser.add_argument("--osrm-url", default=os.getenv("OSRM_URL", OSRM_URL))
    parser.add_argument("--cache-osrm", type=Path, default=ROOT/"cache/gtfs-osrm")
    args = parser.parse_args()
    ajustador = AjustadorOSRM(args.osrm_url, args.cache_osrm)
    with ZipFile(args.zip) as z:
        datos = extraer(z, ajustador)
    with args.zip.open("rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    meta = dict(fuente="GTFS de DTPM", url=args.url, fecha_descarga=args.fecha,
                sha256_zip=digest, centro_lonlat=CENTRO, radio_m=RADIO,
                paraderos_a_menos_de_80m=cercanos(datos["paraderos"]))
    meta["ajuste_geometria"] = ajustador.metadatos()
    dest = ROOT/"backend/data/transporte_mut.json"
    dest.write_bytes((json.dumps(datos, ensure_ascii=False, separators=(",", ":"))+"\n").encode())
    meta["sha256_salida"] = hashlib.sha256(dest.read_bytes()).hexdigest()
    dest.with_suffix(".meta.json").write_bytes((json.dumps(meta, ensure_ascii=False, indent=2)+"\n").encode())


if __name__ == "__main__":
    main()

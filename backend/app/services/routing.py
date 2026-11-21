"""Rutas por calle con OSRM, con caché y plan B en línea recta (plan §9.1, issue #31).

- `ruta(puntos)`: recorrido en orden por las paradas, con geometría GeoJSON, distancia y
  duración por tramo. Lo usan el despacho y /cuadrilla.
- `matriz(origenes, destinos)`: tiempos y distancias por calle entre puntos. La usa el
  despacho para elegir la cuadrilla más cercana por calle (§7.2).

OSRM público (router.project-osrm.org) tiene límites de uso, así que todo pasa por una
caché en memoria. Si OSRM falla o tarda, se responde con una estimación en línea recta
(distancia × factor de desvío, a velocidad urbana) marcada `fuente = "linea_recta"`,
para que la demo nunca se caiga por las rutas.

Coordenadas siempre como (lat, lon). OSRM las espera al revés (lon, lat).
"""
from __future__ import annotations

import logging
import math
import threading
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

Punto = tuple[float, float]  # (lat, lon)

TIMEOUT_S = 8
DECIMALES_CACHE = 5            # ~1 m: puntos casi iguales comparten caché
FACTOR_DESVIO = 1.3            # las calles no van en línea recta
VELOCIDAD_URBANA_MS = 25 / 3.6  # 25 km/h para el plan B
MAX_PUNTOS_RUTA = 50           # OSRM público rechaza consultas muy grandes
MAX_PUNTOS_MATRIZ = 100


@dataclass
class Tramo:
    distancia_m: float
    duracion_s: float


@dataclass
class Ruta:
    geojson: dict[str, Any]          # LineString
    distancia_m: float
    duracion_s: float
    tramos: list[Tramo] = field(default_factory=list)
    fuente: str = "osrm"             # "osrm" | "linea_recta"

    def to_dict(self) -> dict[str, Any]:
        return {
            "geojson": self.geojson,
            "distancia_m": round(self.distancia_m, 1),
            "duracion_s": round(self.duracion_s, 1),
            "tramos": [{"distancia_m": round(t.distancia_m, 1), "duracion_s": round(t.duracion_s, 1)}
                       for t in self.tramos],
            "fuente": self.fuente,
        }


@dataclass
class Matriz:
    duraciones_s: list[list[float]]   # [origen][destino]
    distancias_m: list[list[float]]
    fuente: str = "osrm"


class _LRU:
    """Caché LRU en memoria, segura entre hilos."""

    def __init__(self, maximo: int = 2000):
        self._datos: OrderedDict[Any, Any] = OrderedDict()
        self._maximo = maximo
        self._lock = threading.Lock()

    def get(self, k):
        with self._lock:
            if k in self._datos:
                self._datos.move_to_end(k)
                return self._datos[k]
            return None

    def put(self, k, v) -> None:
        with self._lock:
            self._datos[k] = v
            self._datos.move_to_end(k)
            while len(self._datos) > self._maximo:
                self._datos.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._datos.clear()


_cache = _LRU()
_client: httpx.Client | None = None


def _get_client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=TIMEOUT_S, headers={"User-Agent": "drena/0.1"})
    return _client


def _base_url() -> str:
    return get_settings().osrm_url.rstrip("/")


def _clave(tipo: str, *grupos: Sequence[Punto]) -> tuple:
    return (tipo,) + tuple(
        tuple((round(lat, DECIMALES_CACHE), round(lon, DECIMALES_CACHE)) for lat, lon in g) for g in grupos
    )


def _coords(puntos: Sequence[Punto]) -> str:
    return ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in puntos)


def _validar(puntos: Sequence[Punto]) -> None:
    for lat, lon in puntos:
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError(f"Coordenada inválida: ({lat}, {lon})")


# ---------------------------------------------------------------------------
# Plan B: línea recta
# ---------------------------------------------------------------------------
def haversine_m(a: Punto, b: Punto) -> float:
    r = 6_371_000
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _tramo_recto(a: Punto, b: Punto) -> Tramo:
    d = haversine_m(a, b) * FACTOR_DESVIO
    return Tramo(d, d / VELOCIDAD_URBANA_MS)


def ruta_linea_recta(puntos: Sequence[Punto]) -> Ruta:
    tramos = [_tramo_recto(a, b) for a, b in pairwise(puntos)]
    return Ruta(
        geojson={"type": "LineString", "coordinates": [[lon, lat] for lat, lon in puntos]},
        distancia_m=sum(t.distancia_m for t in tramos),
        duracion_s=sum(t.duracion_s for t in tramos),
        tramos=tramos,
        fuente="linea_recta",
    )


def matriz_linea_recta(origenes: Sequence[Punto], destinos: Sequence[Punto]) -> Matriz:
    tramos = [[_tramo_recto(o, d) for d in destinos] for o in origenes]
    return Matriz(
        duraciones_s=[[t.duracion_s for t in fila] for fila in tramos],
        distancias_m=[[t.distancia_m for t in fila] for fila in tramos],
        fuente="linea_recta",
    )


# ---------------------------------------------------------------------------
# OSRM
# ---------------------------------------------------------------------------
def ruta(puntos: Sequence[Punto]) -> Ruta:
    """Ruta por calle que pasa por los puntos en el orden dado."""
    puntos = list(puntos)
    _validar(puntos)
    if len(puntos) < 2:
        p = puntos[0] if puntos else None
        coords = [[p[1], p[0]]] if p else []
        return Ruta({"type": "LineString", "coordinates": coords}, 0.0, 0.0, [], "osrm")
    if len(puntos) > MAX_PUNTOS_RUTA:
        raise ValueError(f"Máximo {MAX_PUNTOS_RUTA} puntos por ruta")

    clave = _clave("ruta", puntos)
    if (hit := _cache.get(clave)) is not None:
        return hit
    try:
        r = _get_client().get(
            f"{_base_url()}/route/v1/driving/{_coords(puntos)}",
            params={"overview": "full", "geometries": "geojson", "steps": "false"},
        )
        r.raise_for_status()
        data = r.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            raise ValueError(f"OSRM respondió {data.get('code')}")
        best = data["routes"][0]
        resultado = Ruta(
            geojson=best["geometry"],
            distancia_m=float(best["distance"]),
            duracion_s=float(best["duration"]),
            tramos=[Tramo(float(leg["distance"]), float(leg["duration"])) for leg in best["legs"]],
        )
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        log.warning("OSRM falló en ruta (%s); uso línea recta", type(e).__name__)
        return ruta_linea_recta(puntos)  # el plan B no se guarda: se reintenta OSRM la próxima vez
    _cache.put(clave, resultado)
    return resultado


def matriz(origenes: Sequence[Punto], destinos: Sequence[Punto]) -> Matriz:
    """Tiempos (s) y distancias (m) por calle de cada origen a cada destino."""
    origenes, destinos = list(origenes), list(destinos)
    _validar(origenes + destinos)
    if not origenes or not destinos:
        return Matriz([[] for _ in origenes], [[] for _ in origenes])
    if len(origenes) + len(destinos) > MAX_PUNTOS_MATRIZ:
        raise ValueError(f"Máximo {MAX_PUNTOS_MATRIZ} puntos por matriz")

    clave = _clave("matriz", origenes, destinos)
    if (hit := _cache.get(clave)) is not None:
        return hit
    todos = origenes + destinos
    try:
        r = _get_client().get(
            f"{_base_url()}/table/v1/driving/{_coords(todos)}",
            params={
                "sources": ";".join(str(i) for i in range(len(origenes))),
                "destinations": ";".join(str(len(origenes) + j) for j in range(len(destinos))),
                "annotations": "duration,distance",
            },
        )
        r.raise_for_status()
        data = r.json()
        if data.get("code") != "Ok":
            raise ValueError(f"OSRM respondió {data.get('code')}")
        plan_b = matriz_linea_recta(origenes, destinos)
        # OSRM devuelve null cuando un par no tiene ruta: se completa con línea recta
        dur = [[float(v) if v is not None else plan_b.duraciones_s[i][j] for j, v in enumerate(fila)]
               for i, fila in enumerate(data["durations"])]
        dist = [[float(v) if v is not None else plan_b.distancias_m[i][j] for j, v in enumerate(fila)]
                for i, fila in enumerate(data["distances"])]
        resultado = Matriz(dur, dist)
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        log.warning("OSRM falló en matriz (%s); uso línea recta", type(e).__name__)
        return matriz_linea_recta(origenes, destinos)
    _cache.put(clave, resultado)
    return resultado

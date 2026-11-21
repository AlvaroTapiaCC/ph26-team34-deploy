"""Paraderos expuestos al agua y paradero alternativo (issue #91, plan §E10).

Se calcula al consultar, sin guardar nada: cruza el GTFS de DTPM recortado a la zona MUT
(`backend/data/transporte_mut.json`, issue #90) con las observaciones de agua vigentes y con
la prioridad de la zona.

Dos niveles que no se mezclan (lo observado manda sobre lo estimado):
- **expuesto:** hay agua observada (nivel `cuneta` o más) a menos de `radio_m` del paradero,
  en la rejilla observada o calle abajo de ella en la misma cadena. La causa dice cuál
  observación lo provocó y si el punto es el observado o uno inferido calle abajo.
- **en_riesgo:** solo hay prioridad alta cerca: una de las `riesgo_top_n` rejillas de mayor
  prioridad de la zona (el mismo criterio con que el despacho elige candidatas, #32).

De cada rejilla cuenta su ÚLTIMA observación de agua vigente: si una foto posterior muestra
el agua bajo la cuneta (`sin_agua`), el paradero deja de estar expuesto. `no_evaluable` no
cuenta como "sin agua" (un dato faltante no es un valor válido).

Drena informa la exposición; el desvío lo confirma Red.
"""
from __future__ import annotations

import json
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from psycopg import Connection

from app.config import get_formula_config
from app.services.formula import StreetChain, cadena_valida

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
ARCHIVO = DATA_DIR / "transporte_mut.json"
ARCHIVO_META = DATA_DIR / "transporte_mut.meta.json"

PARAMETROS_DEFECTO: dict[str, Any] = {
    "radio_m": 80,          # paradero expuesto si hay agua a menos de esto
    "aguas_abajo_m": 150,   # cuánto se extiende el agua calle abajo en la misma cadena
    "riesgo_top_n": 8,      # rejillas de mayor prioridad de la zona que marcan "en riesgo"
    "zona": "zona_mut",     # etiqueta de `sumideros.etiquetas`
    "modo": "durante",
}
NIVELES_CON_AGUA = ("sobre_vereda", "hasta_vereda", "cuneta")  # peor primero
NIVELES_VALIDOS = (*NIVELES_CON_AGUA, "sin_agua")
NOTA = "Drena informa la exposición de cada paradero; el desvío lo confirma Red."
SIN_ALTERNATIVO = "Sin paradero alternativo no expuesto de este servicio dentro de la zona."
FUERA_DE_ZONA = "El recorrido de este servicio no tiene la secuencia de paraderos en la zona."

# Última clasificación de cada observación (igual que en scoring.py)
_ULTIMA_CLASIFICACION = """
    join lateral (
        select resultado from classifications cl
         where cl.observation_id = o.id
         order by cl.created_at desc, cl.id desc
         limit 1
    ) c on true
"""


# ---------------------------------------------------------------------------
# Datos del GTFS
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class DatosTransporte:
    paraderos: dict[str, dict]                       # id → {id, nombre, lat, lon, servicios}
    secuencias: dict[tuple[str, str], list[str]]     # (servicio, sentido) → paraderos en orden
    fuente: dict


_cache: DatosTransporte | None = None


def cargar_datos(archivo: Path = ARCHIVO, meta: Path = ARCHIVO_META) -> DatosTransporte | None:
    """Lee el archivo de #90. Devuelve None si falta o está mal formado (no se cachea el fallo)."""
    global _cache
    if _cache is not None and archivo == ARCHIVO:
        return _cache
    try:
        with archivo.open(encoding="utf-8") as f:
            d = json.load(f)
        paraderos = {p["id"]: p for p in d["paraderos"]}
        secuencias = {(r["servicio"], r["sentido"]): list(r["paraderos"]) for r in d["recorridos"]}
    except (OSError, ValueError, KeyError, TypeError):
        return None
    fuente: dict = {"nombre": "GTFS de DTPM", "url": None, "fecha_descarga": None}
    try:
        with meta.open(encoding="utf-8") as f:
            m = json.load(f)
        fuente = {"nombre": m.get("fuente", fuente["nombre"]), "url": m.get("url"),
                  "fecha_descarga": m.get("fecha_descarga")}
    except (OSError, ValueError):
        pass  # sin meta se responde igual, con la fecha vacía
    datos = DatosTransporte(paraderos, secuencias, fuente)
    if archivo == ARCHIVO:
        _cache = datos
    return datos


def parametros(cfg: Mapping[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg if cfg is not None else get_formula_config()
    return {**PARAMETROS_DEFECTO, **(cfg.get("transporte") or {}),
            "vigencia_agua_horas": cfg.get("durante", {}).get("vigencia_agua_horas", 6)}


def distancia_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distancia en línea recta (haversine)."""
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(h))


# ---------------------------------------------------------------------------
# Puntos con agua y en riesgo (lógica pura)
# ---------------------------------------------------------------------------
def puntos_con_agua(
    ultimas: Iterable[Mapping[str, Any]],
    chains: Iterable[StreetChain],
    coords: Mapping[str, tuple[float, float]],
    aguas_abajo_m: float,
) -> list[dict]:
    """Rejillas con agua: las observadas y las de calle abajo en su cadena.

    `ultimas`: la última observación de agua vigente de cada rejilla (incluye `sin_agua`).
    Una rejilla cuya propia última observación dice `sin_agua` no se marca por la cadena:
    lo observado ahí manda sobre lo inferido.
    """
    ultimas = list(ultimas)
    secas = {u["sumidero_id"] for u in ultimas if u["nivel"] == "sin_agua"}
    puntos: dict[str, dict] = {}
    for u in ultimas:
        if u["nivel"] not in NIVELES_CON_AGUA or u["sumidero_id"] not in coords:
            continue
        lat, lon = coords[u["sumidero_id"]]
        puntos[u["sumidero_id"]] = {**_causa(u), "sumidero_id": u["sumidero_id"], "via": "observado",
                                    "calle_abajo_m": 0.0, "lat": lat, "lon": lon}
    observados = list(puntos.values())
    for ch in chains:
        if not cadena_valida(ch):
            continue
        for origen in observados:
            if origen["sumidero_id"] not in ch.sumidero_ids:
                continue
            i = ch.sumidero_ids.index(origen["sumidero_id"])
            for j in range(i + 1, len(ch.sumidero_ids)):
                d = float(ch.distancias_m[j]) - float(ch.distancias_m[i])
                if d > aguas_abajo_m:
                    break
                sid = ch.sumidero_ids[j]
                if sid in secas or sid not in coords:
                    continue
                prev = puntos.get(sid)
                if prev is not None and (prev["via"] == "observado" or prev["calle_abajo_m"] <= d):
                    continue
                lat, lon = coords[sid]
                puntos[sid] = {**{k: origen[k] for k in _CAMPOS_CAUSA}, "sumidero_id": sid,
                               "via": "calle_abajo", "calle_abajo_m": round(d, 1), "lat": lat, "lon": lon}
    return list(puntos.values())


_CAMPOS_CAUSA = ("observation_id", "sumidero_observado", "nivel", "ts", "tipo", "fuente", "is_simulated")


def _causa(u: Mapping[str, Any]) -> dict:
    return {"observation_id": str(u["observation_id"]), "sumidero_observado": u["sumidero_id"],
            "nivel": u["nivel"], "ts": u["ts"], "tipo": u["tipo"], "fuente": u["fuente"],
            "is_simulated": bool(u["is_simulated"])}


# ---------------------------------------------------------------------------
# Cruce con paraderos (lógica pura)
# ---------------------------------------------------------------------------
def _mas_cercano(paradero: Mapping[str, Any], puntos: Iterable[Mapping[str, Any]], radio_m: float):
    mejor = None
    for p in puntos:
        d = distancia_m(paradero["lat"], paradero["lon"], p["lat"], p["lon"])
        if d > radio_m:
            continue
        # Prefiere el punto observado sobre el inferido calle abajo; después, el más cercano
        clave = (p.get("via") != "observado", d)
        if mejor is None or clave < mejor[0]:
            mejor = (clave, p, d)
    return None if mejor is None else (mejor[1], mejor[2])


def _alternativo(datos: DatosTransporte, pid: str, servicio: Mapping[str, str],
                 expuestos: set[str], en_riesgo: set[str]) -> dict:
    base = {"servicio": servicio["servicio"], "sentido": servicio["sentido"],
            "destino": servicio.get("destino")}
    seq = datos.secuencias.get((servicio["servicio"], servicio["sentido"]))
    if not seq or pid not in seq:
        return {**base, "alternativo": None, "motivo": FUERA_DE_ZONA}
    i = seq.index(pid)
    origen = datos.paraderos[pid]
    candidatos = []
    for direccion, rango in (("anterior", range(i - 1, -1, -1)), ("siguiente", range(i + 1, len(seq)))):
        for j in rango:  # el primero no expuesto en cada sentido de la secuencia
            otro = datos.paraderos.get(seq[j])
            if otro is None or otro["id"] in expuestos:
                continue
            d = distancia_m(origen["lat"], origen["lon"], otro["lat"], otro["lon"])
            candidatos.append((d, direccion, otro))
            break
    if not candidatos:
        return {**base, "alternativo": None, "motivo": SIN_ALTERNATIVO}
    d, direccion, otro = min(candidatos, key=lambda c: (c[0], c[2]["id"]))
    return {**base, "motivo": None, "alternativo": {
        "id": otro["id"], "nombre": otro["nombre"], "lat": otro["lat"], "lon": otro["lon"],
        "en_secuencia": direccion, "distancia_m": round(d), "en_riesgo": otro["id"] in en_riesgo}}


def calcular(datos: DatosTransporte, agua: list[dict], riesgo: list[dict], radio_m: float) -> dict:
    """Clasifica cada paradero en expuesto / en_riesgo y propone alternativos para los expuestos."""
    expuestos: dict[str, dict] = {}
    en_riesgo: dict[str, dict] = {}
    for pid, p in datos.paraderos.items():
        hit = _mas_cercano(p, agua, radio_m)
        if hit is not None:
            punto, d = hit
            causa = {k: punto[k] for k in (*_CAMPOS_CAUSA, "sumidero_id", "via", "calle_abajo_m")}
            expuestos[pid] = {**_publico(p), "nivel": "expuesto", "causa": {**causa, "distancia_m": round(d)}}
            continue
        hit = _mas_cercano(p, riesgo, radio_m)
        if hit is not None:
            punto, d = hit
            en_riesgo[pid] = {**_publico(p), "nivel": "en_riesgo", "causa": {
                "sumidero_id": punto["sumidero_id"], "prioridad": punto["prioridad"],
                "puesto_en_zona": punto["puesto"], "distancia_m": round(d)}}
    for pid, e in expuestos.items():
        e["servicios"] = [_alternativo(datos, pid, s, set(expuestos), set(en_riesgo))
                          for s in datos.paraderos[pid].get("servicios", [])]
    for pid, r in en_riesgo.items():
        r["servicios"] = [{"servicio": s["servicio"], "sentido": s["sentido"], "destino": s.get("destino")}
                          for s in datos.paraderos[pid].get("servicios", [])]
    orden = lambda x: (x["causa"]["distancia_m"], x["id"])
    return {"expuestos": sorted(expuestos.values(), key=orden),
            "en_riesgo": sorted(en_riesgo.values(), key=orden)}


def _publico(p: Mapping[str, Any]) -> dict:
    return {"id": p["id"], "nombre": p["nombre"], "lat": p["lat"], "lon": p["lon"]}


# ---------------------------------------------------------------------------
# Base de datos
# ---------------------------------------------------------------------------
def ultimas_observaciones_agua(conn: Connection, vigencia_h: float, incluir_simulados: bool) -> list[dict]:
    """Última observación de agua vigente y evaluable de cada rejilla (la más reciente manda)."""
    return conn.execute(
        f"""
        select distinct on (o.sumidero_id) o.id as observation_id, o.sumidero_id, o.ts, o.tipo,
               o.fuente, o.is_simulated, c.resultado->>'nivel_agua' as nivel
          from observations o {_ULTIMA_CLASIFICACION}
         where o.sumidero_id is not null
           and c.resultado->>'nivel_agua' = any(%(niveles)s)
           and o.ts > now() - make_interval(hours => %(h)s)
           and o.ts <= now()
           and (%(sim)s or not o.is_simulated)
         order by o.sumidero_id, o.ts desc, o.id desc
        """,
        {"niveles": list(NIVELES_VALIDOS), "h": vigencia_h, "sim": incluir_simulados},
    ).fetchall()


def cadenas_y_coords(conn: Connection, sumidero_ids: list[str]) -> tuple[list[StreetChain], dict]:
    if not sumidero_ids:
        return [], {}
    chains = [
        StreetChain(r["street_id"], r["sumidero_ids"], r["distancias_m"])
        for r in conn.execute(
            "select street_id, sumidero_ids, distancias_m from street_chains where sumidero_ids && %s",
            (sumidero_ids,),
        )
    ]
    ids = set(sumidero_ids) | {s for ch in chains for s in ch.sumidero_ids}
    coords = {
        r["id"]: (r["lat"], r["lon"])
        for r in conn.execute("select id, st_y(geom) as lat, st_x(geom) as lon from sumideros where id = any(%s)",
                              (list(ids),))
    }
    return chains, coords


def puntos_en_riesgo(conn: Connection, scenario_id: str, prm: Mapping[str, Any]) -> list[dict]:
    rows = conn.execute(
        """
        select s.id as sumidero_id, st_y(s.geom) as lat, st_x(s.geom) as lon, sc.prioridad
          from scores sc join sumideros s on s.id = sc.sumidero_id
         where sc.scenario_id = %(esc)s and sc.modo = %(modo)s and sc.prioridad is not null
           and (%(zona)s::text is null or %(zona)s = any(s.etiquetas))
         order by sc.prioridad desc, s.id
         limit %(n)s
        """,
        {"esc": scenario_id, "modo": prm["modo"], "zona": prm["zona"], "n": prm["riesgo_top_n"]},
    ).fetchall()
    return [{**r, "puesto": i + 1} for i, r in enumerate(rows)]


def expuestos(conn_fn, scenario_id: str = "base", incluir_simulados: bool = True,
              datos: DatosTransporte | None = None, cfg: Mapping[str, Any] | None = None) -> dict:
    """Respuesta de GET /transporte/expuestos. `conn_fn(fn)` corre `fn(conn)` con plazo."""
    prm = parametros(cfg)
    datos = datos if datos is not None else cargar_datos()
    ahora = datetime.now(UTC).isoformat()
    base = {"scenario_id": scenario_id, "calculado_at": ahora, "nota": NOTA,
            "parametros": {k: prm[k] for k in ("radio_m", "aguas_abajo_m", "riesgo_top_n", "vigencia_agua_horas")}}
    if datos is None:
        return {**base, "fuente": None, "expuestos": [], "en_riesgo": [],
                "aviso": "No está el archivo de paraderos (transporte_mut.json): no se puede calcular la exposición."}

    def consultar(conn: Connection):
        ultimas = ultimas_observaciones_agua(conn, prm["vigencia_agua_horas"], incluir_simulados)
        chains, coords = cadenas_y_coords(conn, [u["sumidero_id"] for u in ultimas
                                                 if u["nivel"] in NIVELES_CON_AGUA])
        riesgo = puntos_en_riesgo(conn, scenario_id, prm)
        return ultimas, chains, coords, riesgo

    ultimas, chains, coords, riesgo = conn_fn(consultar)
    agua = puntos_con_agua(ultimas, chains, coords, prm["aguas_abajo_m"])
    aviso = None if riesgo else f"Sin puntajes para el escenario {scenario_id!r}: no se calcula 'en riesgo'."
    return {**base, "fuente": datos.fuente, "aviso": aviso, **calcular(datos, agua, riesgo, prm["radio_m"])}

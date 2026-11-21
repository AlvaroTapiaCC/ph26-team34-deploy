"""Carga a Supabase los sumideros, sus variables y las cadenas por calle (issue #14).

Uso (desde la raíz del repo, con el venv del backend porque necesita psycopg y backend/.env):

    backend/.venv/Scripts/python pipeline/07_cargar.py --dry-run      # revisar sin escribir
    backend/.venv/Scripts/python pipeline/07_cargar.py --recalcular   # cargar y recalcular el ranking

(En Linux/Mac: backend/.venv/bin/python.)

Entradas (todas en data/; solo la primera es obligatoria):
  - rejillas.geojson          catastro DOH (Point, id = properties.ID_IDE, properties.comuna)
  - terreno_*.csv             salida de pipeline/03_terreno.py: elevacion_m, pendiente,
                              area_aporte_m2, street_id, orden_en_calle, en_zona_mut
  - street_chains_*.json      [{street_id, nombre, sumidero_ids, distancias_m}]
  - features_*.csv o          contrato para los demás pasos del pipeline (#11, #12, #13);
    variables_*.csv           pipeline/04_variables.py (#81) lo escribe como variables_mut.csv:
                              columna ID_IDE + columnas con nombre de feature de la fórmula
                              (arboles, feria, obras, suelo, pendiente, clima, camara,
                              criticidad, area_aporte), normalizadas 0-1 salvo area_aporte (m²)

Garantías:
  - Todo en UNA transacción: si algo falla no queda una carga a medias.
  - Idempotente: se puede correr las veces que haga falta. Las features se FUSIONAN con las
    que ya tiene el sumidero (jsonb ||), así un paso nuevo agrega variables sin borrar otras.
  - No borra sumideros que ya no vengan en los archivos (se avisa).
  - Valida antes de escribir: IDs únicos, coordenadas finitas, features numéricas y finitas,
    cadenas bien formadas (mismo largo, distancias crecientes) y que referencien sumideros.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

RAIZ = Path(__file__).resolve().parents[1]
DATA = RAIZ / "data"
sys.path.insert(0, str(RAIZ / "backend"))

RADIO_ESQUINA_M = 60   # sumideros con el mismo par de calles a más de esto son esquinas distintas

FEATURES_FORMULA = {"arboles", "feria", "obras", "suelo", "pendiente", "clima", "camara", "criticidad",
                    "area_aporte", "dias_sin_limpieza"}


@dataclass
class Sumidero:
    id: str
    lon: float
    lat: float
    comuna: str | None
    calle: str | None
    intersection_id: str | None
    features: dict[str, float] = field(default_factory=dict)
    elevacion: float | None = None
    street_id: str | None = None
    orden_en_calle: int | None = None
    etiquetas: set[str] = field(default_factory=set)
    quitar: set[str] = field(default_factory=set)   # etiquetas que una fuente desmiente explícitamente


@dataclass
class Interseccion:
    id: str
    nombre: str
    comuna: str
    puntos: list[tuple[float, float]] = field(default_factory=list)


class DatosInvalidos(ValueError):
    pass


# ---------------------------------------------------------------------------
# Lectura y validación (sin base de datos: se puede testear con archivos)
# ---------------------------------------------------------------------------
def _slug(texto: str) -> str:
    t = unicodedata.normalize("NFKD", texto.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")


_CONECTORES = {"de", "del", "la", "las", "el", "los", "y", "con"}
_ABREVIATURAS = {"av": "Av.", "avda": "Av.", "pje": "Pje.", "psje": "Pje.", "pdte": "Pdte.", "gral": "Gral.",
                 "sta": "Sta.", "sto": "Sto.", "pza": "Pza.", "dr": "Dr."}


def _titulo(calle: str) -> str:
    """'AV LAS CONDES' -> 'Av. Las Condes'; 'PASAJE DE LA PAZ' -> 'Pasaje de la Paz'."""
    palabras = []
    for i, p in enumerate(calle.split()):
        base = p.lower().rstrip(".")
        if base in _ABREVIATURAS:
            palabras.append(_ABREVIATURAS[base])
        elif i > 0 and base in _CONECTORES and palabras[-1] not in _ABREVIATURAS.values():
            # "de la Paz" en minúscula; pero tras "Av." el artículo es parte del nombre: "Av. Las Condes"
            palabras.append(base)
        else:
            palabras.append(p.capitalize())
    return " ".join(palabras)


def _distancia_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distancia aproximada en metros entre (lon, lat); suficiente para escalas de una cuadra."""
    dx = (a[0] - b[0]) * 111_320 * math.cos(math.radians((a[1] + b[1]) / 2))
    dy = (a[1] - b[1]) * 110_540
    return math.hypot(dx, dy)


def _num(v: Any) -> float | None:
    """Número finito o None ('' / 'nan' / None / texto no numérico)."""
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def leer_rejillas(path: Path) -> tuple[dict[str, Sumidero], dict[str, Interseccion]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    sumideros: dict[str, Sumidero] = {}
    inters: dict[str, Interseccion] = {}
    # Orden estable por ID antes de agrupar: el resultado (esquinas y sus IDs -2, -3...) no
    # depende del orden de las filas del archivo.
    def _clave(f: dict[str, Any]) -> str:
        return str(f.get("id") or (f.get("properties") or {}).get("ID_IDE") or "")

    for f in sorted(data.get("features", []), key=_clave):
        p = f.get("properties") or {}
        sid = f.get("id") or p.get("ID_IDE")
        if not sid:
            raise DatosInvalidos("Hay una rejilla sin ID_IDE")
        if sid in sumideros:
            raise DatosInvalidos(f"ID_IDE duplicado: {sid}")
        g = f.get("geometry") or {}
        coords = g.get("coordinates") or []
        if g.get("type") != "Point" or len(coords) < 2 or _num(coords[0]) is None or _num(coords[1]) is None:
            raise DatosInvalidos(f"Geometría inválida en {sid}")
        lon, lat = float(coords[0]), float(coords[1])
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise DatosInvalidos(f"Coordenada fuera de rango en {sid}")
        comuna = p.get("comuna") or (p.get("COMUNA") or "").title() or None
        calle_p, calle_i = (p.get("CALLE_P") or "").strip(), (p.get("CALLE_I") or "").strip()
        iid = None
        if calle_p:
            # La misma esquina aparece como (A, B) o (B, A): se ordena para agruparlas. Pero el
            # nombre no basta (dos calles pueden cruzarse más de una vez o el catastro repetir
            # nombres): solo se agrupa con un sumidero a menos de RADIO_ESQUINA_M; si no, es
            # otra esquina con sufijo -2, -3...
            par = sorted(x for x in (calle_p, calle_i) if x)
            base = _slug(f"{comuna or ''} {' / '.join(par)}")
            n = 1
            iid = base
            while iid in inters and _distancia_m(inters[iid].puntos[0], (lon, lat)) > RADIO_ESQUINA_M:
                n += 1
                iid = f"{base}-{n}"
            if iid not in inters:
                inters[iid] = Interseccion(iid, " / ".join(_titulo(x) for x in par), comuna or "")
            inters[iid].puntos.append((lon, lat))
        sumideros[sid] = Sumidero(sid, lon, lat, comuna, _titulo(calle_p) if calle_p else None, iid)
    if not sumideros:
        raise DatosInvalidos(f"{path} no tiene rejillas")
    return sumideros, inters


def aplicar_terreno(path: Path, sumideros: dict[str, Sumidero], avisos: list[str]) -> int:
    n = 0
    with path.open(encoding="utf-8") as fh:
        for fila in csv.DictReader(fh):
            sid = fila.get("ID_IDE")
            s = sumideros.get(sid)
            if s is None:
                avisos.append(f"{path.name}: {sid} no está en rejillas (se ignora)")
                continue
            if (e := _num(fila.get("elevacion_m"))) is not None:
                s.elevacion = e
            if (pend := _num(fila.get("pendiente"))) is not None:
                s.features["pendiente"] = min(1.0, max(0.0, pend))
            if (area := _num(fila.get("area_aporte_m2"))) is not None:
                s.features["area_aporte"] = max(0.0, area)
            if fila.get("street_id"):
                s.street_id = fila["street_id"]
            if (orden := _num(fila.get("orden_en_calle"))) is not None:
                s.orden_en_calle = int(orden)
            zona = str(fila.get("en_zona_mut", "")).strip().lower()
            if zona == "true":
                s.etiquetas.add("zona_mut")
                s.quitar.discard("zona_mut")
            elif zona == "false":  # un False explícito desmiente una carga anterior; vacío = sin dato
                s.quitar.add("zona_mut")
                s.etiquetas.discard("zona_mut")
            n += 1
    return n


def aplicar_features(path: Path, sumideros: dict[str, Sumidero], avisos: list[str]) -> int:
    n = 0
    with path.open(encoding="utf-8") as fh:
        lector = csv.DictReader(fh)
        columnas = [c for c in (lector.fieldnames or []) if c != "ID_IDE"]
        desconocidas = [c for c in columnas if c not in FEATURES_FORMULA]
        if desconocidas:
            avisos.append(f"{path.name}: columnas que la fórmula no usa (se ignoran): {', '.join(desconocidas)}")
        for fila in lector:
            s = sumideros.get(fila.get("ID_IDE"))
            if s is None:
                avisos.append(f"{path.name}: {fila.get('ID_IDE')} no está en rejillas (se ignora)")
                continue
            for c in columnas:
                if c in FEATURES_FORMULA and (x := _num(fila.get(c))) is not None:
                    s.features[c] = max(0.0, x) if c == "area_aporte" else min(1.0, max(0.0, x))
            n += 1
    return n


def leer_cadenas(paths: list[Path], sumideros: dict[str, Sumidero], avisos: list[str]) -> list[dict[str, Any]]:
    cadenas: dict[str, dict[str, Any]] = {}
    for path in paths:
        for c in json.loads(path.read_text(encoding="utf-8")):
            sid, ids, dist = c.get("street_id"), list(c.get("sumidero_ids") or []), list(c.get("distancias_m") or [])
            if not sid or len(ids) < 2 or len(ids) != len(dist) or len(set(ids)) != len(ids):
                avisos.append(f"{path.name}: cadena {sid} mal formada (se ignora)")
                continue
            d = [_num(x) for x in dist]
            if any(x is None for x in d) or any(b < a for a, b in zip(d, d[1:], strict=False)):
                avisos.append(f"{path.name}: cadena {sid} con distancias inválidas (se ignora)")
                continue
            faltan = [x for x in ids if x not in sumideros]
            if faltan:
                avisos.append(f"{path.name}: cadena {sid} referencia {len(faltan)} sumideros que no existen (se ignora)")
                continue
            cadenas[sid] = {"street_id": sid, "nombre": c.get("nombre"), "sumidero_ids": ids, "distancias_m": d}
    return list(cadenas.values())


def preparar(data_dir: Path = DATA, rejillas: Path | None = None) -> dict[str, Any]:
    """Lee y valida todas las entradas. No toca la base."""
    avisos: list[str] = []
    rejillas = rejillas or data_dir / "rejillas.geojson"
    sumideros, inters = leer_rejillas(rejillas)
    resumen = {"rejillas": str(rejillas.name), "terreno": {}, "features": {}, "cadenas_archivos": []}
    for p in sorted(data_dir.glob("terreno_*.csv")):
        resumen["terreno"][p.name] = aplicar_terreno(p, sumideros, avisos)
    # variables_*.csv es como las deja pipeline/04_variables.py (#81); features_*.csv, el nombre genérico.
    for p in sorted([*data_dir.glob("features_*.csv"), *data_dir.glob("variables_*.csv")]):
        resumen["features"][p.name] = aplicar_features(p, sumideros, avisos)
    paths_cadenas = sorted(data_dir.glob("street_chains_*.json"))
    resumen["cadenas_archivos"] = [p.name for p in paths_cadenas]
    cadenas = leer_cadenas(paths_cadenas, sumideros, avisos)
    return {"sumideros": sumideros, "intersecciones": inters, "cadenas": cadenas, "avisos": avisos,
            "resumen": resumen}


# ---------------------------------------------------------------------------
# Escritura
# ---------------------------------------------------------------------------
def escribir(conn, datos: dict[str, Any]) -> dict[str, int]:
    from psycopg.types.json import Jsonb

    sumideros: dict[str, Sumidero] = datos["sumideros"]
    inters: dict[str, Interseccion] = datos["intersecciones"]
    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(
            """
            insert into intersections (id, nombre, geom, comuna)
            values (%s, %s, st_setsrid(st_point(%s, %s), 4326), %s)
            on conflict (id) do update set nombre = excluded.nombre, geom = excluded.geom, comuna = excluded.comuna
            """,
            [(i.id, i.nombre, sum(p[0] for p in i.puntos) / len(i.puntos),
              sum(p[1] for p in i.puntos) / len(i.puntos), i.comuna) for i in inters.values()],
        )
        cur.executemany(
            """
            insert into sumideros (id, geom, fuente, intersection_id, street_id, orden_en_calle, elevacion,
                                   features, is_simulated, comuna, calle, etiquetas)
            values (%s, st_setsrid(st_point(%s, %s), 4326), 'doh', %s, %s, %s, %s, %s, false, %s, %s, %s)
            on conflict (id) do update set
              geom = excluded.geom, fuente = excluded.fuente, intersection_id = excluded.intersection_id,
              street_id = coalesce(excluded.street_id, sumideros.street_id),
              orden_en_calle = coalesce(excluded.orden_en_calle, sumideros.orden_en_calle),
              elevacion = coalesce(excluded.elevacion, sumideros.elevacion),
              features = sumideros.features || excluded.features,
              comuna = excluded.comuna, calle = excluded.calle,
              etiquetas = (select coalesce(array_agg(distinct e order by e), '{}')
                             from unnest(sumideros.etiquetas || excluded.etiquetas) as e
                            where e <> all(%s::text[]))
            """,
            [(s.id, s.lon, s.lat, s.intersection_id, s.street_id, s.orden_en_calle, s.elevacion,
              Jsonb(s.features), s.comuna, s.calle, sorted(s.etiquetas), sorted(s.quitar))
             for s in sumideros.values()],
        )
        cur.executemany(
            """
            insert into street_chains (street_id, nombre, sumidero_ids, distancias_m)
            values (%s, %s, %s, %s)
            on conflict (street_id) do update set
              nombre = excluded.nombre, sumidero_ids = excluded.sumidero_ids, distancias_m = excluded.distancias_m
            """,
            [(c["street_id"], c["nombre"], c["sumidero_ids"], c["distancias_m"]) for c in datos["cadenas"]],
        )
        # Una recarga corrige la anterior: las esquinas que ya no tienen sumideros se borran
        huerfanas = cur.execute(
            "delete from intersections i where not exists (select 1 from sumideros s where s.intersection_id = i.id)"
        ).rowcount
        sobrantes = cur.execute(
            "select count(*) as n from sumideros where fuente = 'doh' and not (id = any(%s))", (list(sumideros),)
        ).fetchone()
    return {"intersecciones": len(inters), "intersecciones_huerfanas_borradas": huerfanas,
            "sumideros": len(sumideros), "cadenas": len(datos["cadenas"]),
            "sumideros_doh_que_no_vienen": (sobrantes["n"] if isinstance(sobrantes, dict) else sobrantes[0])}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="validar y mostrar el resumen sin escribir")
    ap.add_argument("--recalcular", action="store_true", help="recalcular el ranking después de cargar")
    ap.add_argument("--data", type=Path, default=DATA, help="carpeta de entradas (por defecto data/)")
    args = ap.parse_args(argv)

    try:
        datos = preparar(args.data)
    except DatosInvalidos as e:
        print(f"✗ Datos inválidos: {e}")
        return 1
    sums: dict[str, Sumidero] = datos["sumideros"]
    con_terreno = sum(1 for s in sums.values() if "area_aporte" in s.features)
    print(f"Rejillas: {len(sums)} | intersecciones: {len(datos['intersecciones'])} | "
          f"con terreno: {con_terreno} | zona_mut: {sum('zona_mut' in s.etiquetas for s in sums.values())} | "
          f"cadenas válidas: {len(datos['cadenas'])}")
    print(f"Archivos: {json.dumps(datos['resumen'], ensure_ascii=False)}")
    for a in datos["avisos"][:20]:
        print(f"! {a}")
    if len(datos["avisos"]) > 20:
        print(f"! ... y {len(datos['avisos']) - 20} avisos más")
    if args.dry_run:
        print("Dry run: no se escribió nada.")
        return 0

    from app.db import get_conn

    with get_conn(timeout=30) as conn:
        r = escribir(conn, datos)
        print(f"✓ Cargado: {r}")
        if r["sumideros_doh_que_no_vienen"]:
            print(f"! {r['sumideros_doh_que_no_vienen']} sumideros DOH en la base no vienen en los archivos (no se borran)")
        if args.recalcular:
            from app.services.scoring import recalcular_todo

            print(f"✓ Ranking recalculado: {recalcular_todo(conn)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

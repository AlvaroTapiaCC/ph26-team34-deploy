"""Cuadrillas e historial de limpieza SIMULADOS (issue #16).

No tenemos cuadrillas ni registros de limpieza reales de los municipios, así que se simulan con
datos verosímiles y `is_simulated = true` (plan §4, regla para datos simulados). La interfaz los
marca como simulados y la prueba de campo los excluye (`incluir_simulados=false`).

Uso (desde la raíz, con el venv del backend; requiere sumideros ya cargados con 07_cargar.py):

    backend/.venv/Scripts/python pipeline/08_simulados.py --dry-run
    backend/.venv/Scripts/python pipeline/08_simulados.py --recalcular

Garantías:
  - Determinista: la fecha de última limpieza sale de un hash del id del sumidero contra una
    FECHA_REFERENCIA fija, así correrlo dos veces (o en otra máquina) da exactamente lo mismo.
  - Solo toca filas simuladas: las cuadrillas `sim-*` y el historial con `is_simulated = true`
    de los sumideros que procesa. Nunca borra ni cambia datos reales.
  - Una transacción.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "backend"))

FECHA_REFERENCIA = date(2026, 11, 21)   # "hoy" de la simulación: fija para que sea reproducible
DIAS_MAX = 120                          # la última limpieza cae entre 0 y 120 días antes
PCT_SIN_REGISTRO = 10                   # % de sumideros sin ningún registro de limpieza

CENTRO_MUT = (-70.6010, -33.4178)       # zona de la prueba de campo (mismo centro que #75)

# (id, nombre, comuna, equipamiento, posición fija o None = centro de los sumideros de la comuna)
CUADRILLAS = [
    ("sim-c1", "Cuadrilla 1 · Providencia", "Providencia", ["basica", "hidrojet"], None),
    ("sim-c2", "Cuadrilla 2 · Ñuñoa", "Ñuñoa", ["basica"], None),
    ("sim-c3", "Cuadrilla 3 · Las Condes", "Las Condes", ["basica", "hidrojet"], None),
    ("sim-c4", "Cuadrilla 4 · zona MUT", "Providencia", ["basica"], CENTRO_MUT),
]


@dataclass(frozen=True)
class Cuadrilla:
    id: str
    nombre: str
    equipamiento: tuple[str, ...]
    lon: float
    lat: float


def _hash(texto: str) -> int:
    return int.from_bytes(hashlib.sha256(texto.encode("utf-8")).digest()[:8], "big")


def ultima_limpieza(sumidero_id: str) -> date | None:
    """Fecha simulada de la última limpieza, o None si el sumidero no tiene registro.

    Determinista: depende solo del id. La distribución es uniforme entre 0 y DIAS_MAX días
    antes de FECHA_REFERENCIA, y ~PCT_SIN_REGISTRO % queda sin registro.
    """
    h = _hash(sumidero_id)
    if h % 100 < PCT_SIN_REGISTRO:
        return None
    return FECHA_REFERENCIA - timedelta(days=(h // 100) % (DIAS_MAX + 1))


def generar_historial(sumidero_ids: list[str]) -> list[tuple[str, date]]:
    return [(sid, f) for sid in sorted(sumidero_ids) if (f := ultima_limpieza(sid)) is not None]


def generar_cuadrillas(centros: dict[str, tuple[float, float]]) -> list[Cuadrilla]:
    """Una cuadrilla por entrada de CUADRILLAS que tenga comuna con sumideros cargados.

    Parte en su posición fija si la tiene; si no, en el centro de los sumideros de su comuna.
    """
    out = []
    for cid, nombre, comuna, equipo, fija in CUADRILLAS:
        if comuna not in centros:
            continue
        lon, lat = fija or centros[comuna]
        out.append(Cuadrilla(cid, nombre, tuple(equipo), lon, lat))
    return out


def leer_base(conn) -> tuple[list[str], dict[str, tuple[float, float]]]:
    ids = [r["id"] for r in conn.execute("select id from sumideros where not is_simulated order by id")]
    centros = {
        r["comuna"]: (r["lon"], r["lat"])
        for r in conn.execute(
            "select comuna, avg(st_x(geom)) as lon, avg(st_y(geom)) as lat from sumideros"
            " where comuna is not null and not is_simulated group by comuna"
        )
    }
    return ids, centros


def escribir(conn, cuadrillas: list[Cuadrilla], historial: list[tuple[str, date]],
             sumidero_ids: list[str]) -> dict[str, int]:
    """Upsert de cuadrillas y reemplazo del historial SIMULADO de `sumidero_ids` (nada más)."""
    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(
            """
            insert into crews (id, nombre, equipamiento, estado, geom_actual, is_simulated)
            values (%s, %s, %s, 'disponible', st_setsrid(st_point(%s, %s), 4326), true)
            on conflict (id) do update set nombre = excluded.nombre, equipamiento = excluded.equipamiento,
              geom_actual = excluded.geom_actual, is_simulated = true
            """,
            [(c.id, c.nombre, list(c.equipamiento), c.lon, c.lat) for c in cuadrillas],
        )
        borrados = cur.execute(
            "delete from cleaning_history where is_simulated and sumidero_id = any(%s)", (sumidero_ids,)
        ).rowcount
        cur.executemany(
            "insert into cleaning_history (sumidero_id, fecha, is_simulated) values (%s, %s, true)", historial
        )
    return {"cuadrillas": len(cuadrillas), "historial": len(historial), "historial_reemplazado": borrados}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="mostrar qué se generaría, sin escribir")
    ap.add_argument("--recalcular", action="store_true", help="recalcular el ranking después")
    args = ap.parse_args(argv)

    from app.db import get_conn

    with get_conn(timeout=30) as conn:
        ids, centros = leer_base(conn)
        if not ids:
            print("✗ No hay sumideros reales cargados. Corre antes pipeline/07_cargar.py")
            return 1
        cuadrillas = generar_cuadrillas(centros)
        historial = generar_historial(ids)
        dias = sorted((FECHA_REFERENCIA - f).days for _, f in historial)
        print(f"Cuadrillas: {[c.id for c in cuadrillas]}")
        print(f"Historial: {len(historial)} de {len(ids)} sumideros | días sin limpieza: "
              f"mín {dias[0]}, mediana {dias[len(dias) // 2]}, máx {dias[-1]}")
        if args.dry_run:
            print("Dry run: no se escribió nada.")
            return 0
        print(f"✓ Escrito: {escribir(conn, cuadrillas, historial, ids)}")
        if args.recalcular:
            from app.services.scoring import recalcular_todo

            print(f"✓ Ranking recalculado: {recalcular_todo(conn)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

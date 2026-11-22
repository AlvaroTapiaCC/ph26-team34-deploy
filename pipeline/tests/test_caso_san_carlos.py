import csv
import importlib.util
import json
import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "pipeline"))
spec = importlib.util.spec_from_file_location("caso_san_carlos", REPO / "pipeline/15_caso_san_carlos.py")
caso = importlib.util.module_from_spec(spec)
spec.loader.exec_module(caso)


def test_distancia_segmento_y_flujo():
    coords = {"a": (-70.55, -33.4), "b": (-70.54, -33.4), "c": (-70.545, -33.4004), "d": (-70.545, -33.402)}
    filas = [{"ID_IDE": sid, "calle": "General Blanche" if sid in "ab" else "Otra"} for sid in coords]
    segmentos = [(coords["a"], coords["b"])]
    assert caso.ids_flujo(filas, segmentos, coords) == {"a", "b", "c"}
    assert caso.ids_flujo([], [], {}) == set()
    assert caso.ids_flujo(filas, [], coords) == {"a", "b"}
    assert caso.distancia_segmento(coords["a"], coords["a"], coords["a"]) == 0


def insumos():
    config = yaml.safe_load(caso.replay.CONFIG.read_text())
    entradas, coords = caso.replay.cargar_ranking(caso.PREDICCION, config)
    with caso.PREDICCION.open() as f:
        filas = list(csv.DictReader(f))
    return [caso.replay.leer_json(caso.CLIMA)["horas"], filas, entradas, coords,
            caso.replay.leer_json(caso.CADENAS), config,
            caso.replay.leer_json(caso.SALIDA / "antecedentes.json"), caso.replay.leer_json(caso.CRITICOS), caso.segmentos_flujo(caso.OSM)]


def test_reconstruccion_reutiliza_ranking_b():
    args = insumos()
    resultado = caso.construir(*args)
    h = next(h for h in args[0] if h["hora_utc"] == resultado["primera_tormenta_7_8_utc"])
    esperado = next(caso.replay.ranking_por_hora(args[2], caso.replay.cadenas_del_sector(args[4], set(args[3])), args[5], [h]))
    assert [m["ID_IDE"] for m in resultado["misiones"]] == [s.sumidero_id for s in esperado[:10]]
    assert resultado["misiones"][0]["prioridad"] == round(esperado[0].prioridad, 6)
    assert len(resultado["horas"]) == 72
    assert resultado["adelanto_horas"] == 23
    assert resultado["lluvia_8_oct"] == {"pronostico_mm": 22.5, "observado_mm": 37.5, "centro_latlon": [-33.418, -70.541]}
    assert all(f["properties"]["nivel_riesgo"] == "Alto" for f in resultado["puntos_criticos"])
    assert all(a["fuente_url"].startswith("https://") for a in resultado["antecedentes"])


def test_serie_vacia_o_sin_alerta_falla():
    args = insumos()
    args[0] = []
    with pytest.raises(ValueError, match="72 horas"):
        caso.construir(*args)
    args = insumos()
    args[0] = [{**h, "modo": "seco"} for h in args[0]]
    with pytest.raises(ValueError, match="No hay tormenta"):
        caso.construir(*args)


def test_huellas_resultado():
    meta = json.loads((caso.SALIDA / "caso.meta.json").read_text())
    for entrada in [*meta["entradas"], meta["salida"]]:
        assert caso.replay.archivo(REPO / entrada["ruta"])["sha256"] == entrada["sha256"]

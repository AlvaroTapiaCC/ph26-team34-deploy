import csv
import hashlib
import json
import subprocess
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
PREDICCION = REPO / "data/validacion/prediccion_congelada.csv"
CLIMA = REPO / "data/escenarios/2026-10-13.json"
CONFIG = REPO / "backend/config/formula_validacion.yaml"
HORA_PRUEBA = "2026-10-13T13:00:00Z"


def puntos_sinteticos(ruta, cantidad=8):
    with PREDICCION.open(newline="") as csvfile:
        ranking = list(csv.DictReader(csvfile))
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(f["lon"]), float(f["lat"])]},
            "properties": {
                "lugar": f"Punto sintético {i}",
                "hora": "2026-10-13T10:30:00-03:00",
                "tipo_hora": "aviso",
                "fuente_url": "https://example.invalid/prueba",
                "precision": "cruce_exacto",
            },
        }
        for i, f in enumerate(ranking[:cantidad])
    ]
    ruta.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    return ruta


def ejecutar(puntos, salida, *args, clima=CLIMA, tipo="evento"):
    return subprocess.run(
        [
            sys.executable, "pipeline/10_replay.py",
            "--anegados", str(puntos), "--clima", str(clima), "--salida", str(salida),
            "--tipo-evidencia", tipo, "--motivo", "Prueba con puntos sintéticos",
            *map(str, args),
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
    )


def test_compara_ranking_congelado_serie_y_referencias(tmp_path):
    puntos = puntos_sinteticos(tmp_path / "puntos.geojson")
    salida = tmp_path / "salida"
    primera = ejecutar(puntos, salida)
    assert primera.returncode == 0, primera.stderr
    resultado = json.loads((salida / "resultado.json").read_text())
    principal, *sensibilidad = resultado["cobertura"]
    assert (principal["top_porcentaje"], principal["distancia_m_menor_que"]) == (20, 100)
    assert {(c["top_porcentaje"], c["distancia_m_menor_que"]) for c in sensibilidad} == {
        (10, 100), (20, 50), (10, 50),
    }
    assert principal["formula_sin_clima"] == {"aciertos": 8, "total": 8, "porcentaje": 100}
    assert principal["solo_area_aporte"]["total"] == principal["azar"]["total"] == 8
    serie = next(h for h in resultado["cobertura_por_hora"] if h["hora_utc"] == HORA_PRUEBA)
    assert principal["formula_horaria_al_registro"] == serie["cobertura"][0]["formula_horaria"]
    assert resultado["tiempo"]["primer_registro_utc"] == "2026-10-13T13:30:00+00:00"
    with (salida / "ranking_horario.csv").open(newline="") as csvfile:
        filas = list(csv.DictReader(csvfile))
    assert len(filas) == 46 * 72
    assert len({f["p_pred"] for f in filas if f["ID_IDE"] == filas[0]["ID_IDE"]}) > 1
    meta = json.loads((salida / "resultado.meta.json").read_text())
    espera = json.loads(PREDICCION.with_suffix(".meta.json").read_text())["formula"]["sha256_config"]
    assert meta["formula"]["config"]["sha256"] == espera
    assert meta["metodo"]["permutaciones_azar"] == 1000
    segunda = ejecutar(puntos, tmp_path / "otra_salida")
    assert segunda.returncode == 0, segunda.stderr
    assert (salida / "resultado.json").read_bytes() == (tmp_path / "otra_salida/resultado.json").read_bytes()


def test_hora_sin_clima_preserva_dato_faltante(tmp_path):
    puntos = puntos_sinteticos(tmp_path / "puntos.geojson")
    clima = tmp_path / "clima.json"
    serie = json.loads(CLIMA.read_text())
    hora = next(h for h in serie["horas"] if h["hora_utc"] == HORA_PRUEBA)
    hora["clima"] = None
    clima.write_text(json.dumps(serie))
    meta = json.loads(CLIMA.with_suffix(".meta.json").read_text())
    meta["salida"]["sha256"] = hashlib.sha256(clima.read_bytes()).hexdigest()
    clima.with_suffix(".meta.json").write_text(json.dumps(meta))

    salida = tmp_path / "salida"
    proceso = ejecutar(puntos, salida, clima=clima)
    assert proceso.returncode == 0, proceso.stderr
    resultado = json.loads((salida / "resultado.json").read_text())
    assert resultado["horas_sin_clima"] == 1
    assert resultado["cobertura"][0]["formula_horaria_al_registro"] is None
    with (salida / "ranking_horario.csv").open(newline="") as csvfile:
        filas = [f for f in csv.DictReader(csvfile) if f["hora_utc"] == HORA_PRUEBA]
    assert len(filas) == 46
    assert all(not f["clima"] and not f["prioridad"] and f["rank_sin_clima"] for f in filas)


def test_exige_config_congelada_y_minimo_de_lugares(tmp_path):
    puntos = puntos_sinteticos(tmp_path / "puntos.geojson", cantidad=7)
    salida = tmp_path / "salida"
    proceso = ejecutar(puntos, salida)
    assert proceso.returncode != 0
    assert "7 lugares elegibles" in proceso.stderr
    assert not salida.exists()

    config = tmp_path / "formula.yaml"
    config.write_bytes(CONFIG.read_bytes() + b"\n# Cambio posterior al congelamiento\n")
    proceso = ejecutar(puntos, salida, "--config", config)
    assert proceso.returncode != 0
    assert "SHA-256" in proceso.stderr
    assert not salida.exists()


def test_puntos_criticos_reportan_cobertura_espacial_sin_cronologia(tmp_path):
    puntos = puntos_sinteticos(tmp_path / "puntos.geojson", cantidad=1)
    salida = tmp_path / "salida"
    clima = REPO / "data/escenarios/2026-07-16_17.json"
    proceso = ejecutar(puntos, salida, clima=clima, tipo="puntos-criticos")
    assert proceso.returncode == 0, proceso.stderr
    resultado = json.loads((salida / "resultado.json").read_text())
    assert resultado["tipo_evidencia"] == "puntos-criticos"
    assert resultado["cobertura"][0]["formula_sin_clima"]["total"] == 1
    assert resultado["cobertura"][0]["formula_horaria_al_registro"] is None
    assert resultado["tiempo"]["horas_entre_alerta_y_registro"] is None

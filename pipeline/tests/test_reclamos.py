"""Pruebas de pipeline/14_reclamos.py con tickets SINTÉTICOS (no son datos reales)."""

import csv
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PREDICCION = REPO / "data/validacion/prediccion_replay_julio.csv"
SALIDA = "2026-07-16_17_replay_julio"
CLIMA_META = REPO / "data/escenarios/2026-07-16_17.meta.json"
CAMPOS = (
    "id", "ticket", "canal_ingreso", "estado", "tipo_solicitud", "prioridad", "motivo",
    "unidad_municipal", "depto_nombre", "depto_destino_nombre", "macrozona", "unidad_vecinal",
    "ubicacion_solicitud", "lat_solicitud", "long_solicitud", "fc_creacion", "fc_revisado",
    "fc_jefedepto", "fc_director", "fc_publicado", "tmo_dias", "tp_activo", "cantidad",
)

spec = importlib.util.spec_from_file_location("reclamos", REPO / "pipeline/14_reclamos.py")
reclamos = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reclamos)


def rejilla(rank):
    with PREDICCION.open(newline="", encoding="utf-8") as archivo:
        fila = next(f for f in csv.DictReader(archivo) if int(f["rank"]) == rank)
    return float(fila["lon"]), float(fila["lat"])


def coma(valor):
    return f"{valor:.8f}".replace(".", ",")


def escribir_crudo(ruta, tickets):
    """Imita el formato del portal: ; como separador, coma decimal y BOM doble."""
    with ruta.open("w", encoding="utf-8", newline="") as archivo:
        archivo.write("﻿﻿")
        writer = csv.DictWriter(archivo, fieldnames=CAMPOS, delimiter=";", quoting=csv.QUOTE_ALL)
        writer.writeheader()
        for i, (tipo, ubicacion, lonlat, dia) in enumerate(tickets):
            writer.writerow({
                "id": i, "ticket": 900000 + i, "tipo_solicitud": tipo, "motivo": "Reclamo",
                "ubicacion_solicitud": ubicacion, "long_solicitud": coma(lonlat[0]),
                "lat_solicitud": coma(lonlat[1]), "fc_creacion": dia,
            })
    return ruta


def ejecutar(crudo, salida):
    return subprocess.run(
        [sys.executable, "pipeline/14_reclamos.py", "--crudo", str(crudo),
         "--descargado-utc", "2026-11-22T01:21:28Z", "--clima-meta", str(CLIMA_META),
         "--salida", str(salida)],
        cwd=REPO, capture_output=True, text=True, encoding="cp1252",
        # Emula la consola predeterminada de Windows.
        env={**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"},
    )


def test_cuadra_quita_el_numero_de_casa():
    assert reclamos.cuadra("CALLE ENSAYO 3721") == "CALLE ENSAYO 3700-3799"
    assert reclamos.cuadra("  Av. Sintética  45 ") == "AV SINTETICA 0-99"
    assert reclamos.cuadra("SIN NUMERO") is None


def verificar_formato_publico(resultado):
    assert set(resultado) == {
        "rotulo", "evento", "sector", "resolucion_temporal", "ventanas", "ranking_horario_b",
    }
    assert set(resultado["sector"]) == {"nombre", "centro_lonlat", "radio_m", "rejillas"}
    assert set(resultado["ventanas"]) == {"principal"}
    principal = resultado["ventanas"]["principal"]
    campos = {
        "desde_santiago", "hasta_santiago", "tickets_comuna", "tickets_en_sector",
        "cuadras_en_sector", "cobertura",
    }
    if principal["cobertura"] is None:
        campos.add("nota")
    assert set(principal) == campos
    for corte in principal["cobertura"] or []:
        rankings = {"formula_sin_clima", "solo_area_aporte", "azar"}
        assert set(corte) == rankings | {"top_porcentaje", "distancia_m_menor_que"}
        for ranking in rankings:
            assert set(corte[ranking]) == {"aciertos", "total", "porcentaje"}
    return principal


def test_calcula_cobertura_por_cuadra_y_publica_solo_el_total(tmp_path):
    lon, lat = rejilla(1)
    cerca = (lon + 0.0002, lat)  # unos 19 m al este de la rejilla con rank 1
    crudo = escribir_crudo(tmp_path / "crudo.csv", [
        ("Sumideros de Aguas Lluvias", "CALLE SINTETICA 1234", cerca, "2026-07-16"),
        ("Anegamiento por aguas lluvias o desbordamiento de canales", "CALLE SINTETICA 1288", cerca, "2026-07-17"),
        ("Sumideros de Aguas Lluvias", "CALLE SINTETICA 1250", cerca, "2026-07-18"),
        ("Sumideros de Aguas Lluvias", "CALLE LEJANA 77", (-70.45, -33.36), "2026-07-16"),
        ("Permiso estacionamiento de mudanza", "CALLE SINTETICA 1234", cerca, "2026-07-16"),
        ("Sumideros de Aguas Lluvias", "CALLE SINTETICA 1234", cerca, "2026-06-01"),
    ])
    salida = tmp_path / "salida"
    proceso = ejecutar(crudo, salida)
    assert proceso.returncode == 0, proceso.stderr

    texto = (salida / f"{SALIDA}.json").read_text(encoding="utf-8")
    for prohibido in ("SINTETICA 1234", "SINTETICA 1288", "SINTETICA 1250", "LEJANA 77",
                      "-70.45", "-33.36", coma(cerca[1])[:7], f"{cerca[0]:.4f}"):
        assert prohibido not in texto
    principal = verificar_formato_publico(json.loads(texto))
    assert principal["tickets_comuna"] == 3
    assert principal["tickets_en_sector"] == 2
    assert principal["cuadras_en_sector"] == 1
    assert "2026-07-18" not in texto
    corte = principal["cobertura"][0]
    assert corte["formula_sin_clima"]["porcentaje"] == 100.0
    assert 0 <= corte["azar"]["porcentaje"] <= 100

    meta = json.loads((salida / f"{SALIDA}.meta.json").read_text(encoding="utf-8"))
    assert meta["fuente"]["filas_crudo"] == 6
    assert meta["formula"]["config"]["sha256"] == meta["formula"]["sha256_config_al_congelar"]


def test_un_ticket_aislado_solo_aporta_a_los_agregados(tmp_path):
    crudo = escribir_crudo(tmp_path / "crudo.csv", [
        ("Sumideros de Aguas Lluvias", "CALLE AISLADA 4567", rejilla(1), "2026-07-16"),
    ])
    salida = tmp_path / "salida"
    proceso = ejecutar(crudo, salida)
    assert proceso.returncode == 0, proceso.stderr
    texto = (salida / f"{SALIDA}.json").read_text(encoding="utf-8")
    metadatos = (salida / f"{SALIDA}.meta.json").read_text(encoding="utf-8")
    principal = verificar_formato_publico(json.loads(texto))
    assert principal["tickets_en_sector"] == principal["cuadras_en_sector"] == 1
    assert principal["cobertura"][0]["formula_sin_clima"]["aciertos"] == 1
    for privado in ("CALLE AISLADA", "4500-4599", '"ticket": 900000', '"Reclamo"', rejilla_id(1)):
        assert privado not in texto and privado not in metadatos
    assert set(json.loads(metadatos)["filtro"]) == {"tipos_solicitud"}


def test_resultados_versionados_conservan_los_agregados_y_sus_hashes():
    carpeta = REPO / "data/validacion/reclamos"
    for nombre, totales, aciertos in (
        (SALIDA, (12, 6, 3), (0, 1, 0.686)),
        ("2026-10-13_mut", (5, 2, 1), (0, 1, 0.744)),
    ):
        salida = carpeta / f"{nombre}.json"
        principal = verificar_formato_publico(json.loads(salida.read_text(encoding="utf-8")))
        assert (principal["tickets_comuna"], principal["tickets_en_sector"], principal["cuadras_en_sector"]) == totales
        corte = principal["cobertura"][0]
        assert tuple(corte[r]["aciertos"] for r in ("formula_sin_clima", "solo_area_aporte", "azar")) == aciertos
        meta = json.loads(salida.with_suffix(".meta.json").read_text(encoding="utf-8"))
        assert reclamos.sha256(salida) == meta["salida"]["sha256"]
        assert reclamos.sha256(REPO / meta["script"]["ruta"]) == meta["script"]["sha256"]


def test_sin_tickets_en_el_sector_no_calcula_cifra(tmp_path):
    crudo = escribir_crudo(tmp_path / "crudo.csv", [
        ("Sumideros de Aguas Lluvias", "CALLE LEJANA 77", (-70.45, -33.36), "2026-07-16"),
    ])
    proceso = ejecutar(crudo, tmp_path / "salida")
    assert proceso.returncode == 0, proceso.stderr
    resultado = json.loads((tmp_path / "salida" / f"{SALIDA}.json").read_text(encoding="utf-8"))
    principal = verificar_formato_publico(resultado)
    assert principal["tickets_en_sector"] == 0
    assert principal["cobertura"] is None


def test_rechaza_el_crudo_dentro_del_repo(tmp_path):
    proceso = ejecutar(REPO / "data/validacion/atencion_vecino.csv", tmp_path / "salida")
    assert proceso.returncode == 1
    assert "fuera del repositorio" in proceso.stderr


def rejilla_id(rank):
    with PREDICCION.open(newline="", encoding="utf-8") as archivo:
        return next(f["ID_IDE"] for f in csv.DictReader(archivo) if int(f["rank"]) == rank)

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
         "--nota", "Prueba sintética", "--salida", str(salida)],
        cwd=REPO, capture_output=True, text=True, encoding="cp1252",
        # Emula la consola predeterminada de Windows.
        env={**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"},
    )


def test_cuadra_quita_el_numero_de_casa():
    assert reclamos.cuadra("APOQUINDO 3721") == "APOQUINDO 3700-3799"
    assert reclamos.cuadra("  Av. Las Condés  45 ") == "AV LAS CONDES 0-99"
    assert reclamos.cuadra("SIN NUMERO") is None


def test_agrega_por_cuadra_sin_guardar_domicilios(tmp_path):
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
    resultado = json.loads(texto)
    principal = resultado["ventanas"]["principal"]
    assert principal["tickets_comuna"] == 3
    assert principal["tickets_en_sector"] == 2
    cuadra, = principal["cuadras"]
    assert cuadra["cuadra"] == "CALLE SINTETICA 1200-1299"
    assert cuadra["tickets"] == 2 and cuadra["cubierta_top20_100m"]
    assert {"ID_IDE": rejilla_id(1), "rank": 1} in cuadra["rejillas_menos_50m"]
    corte = principal["cobertura"][0]
    assert corte["formula_sin_clima"]["porcentaje"] == 100.0
    assert 0 <= corte["azar"]["porcentaje"] <= 100
    assert resultado["ventanas"]["sensibilidad_dia_siguiente"]["tickets_en_sector"] == 3

    meta = json.loads((salida / f"{SALIDA}.meta.json").read_text(encoding="utf-8"))
    assert meta["fuente"]["filas_crudo"] == 6
    assert meta["formula"]["config"]["sha256"] == meta["formula"]["sha256_config_al_congelar"]


def test_sin_tickets_en_el_sector_no_calcula_cifra(tmp_path):
    crudo = escribir_crudo(tmp_path / "crudo.csv", [
        ("Sumideros de Aguas Lluvias", "CALLE LEJANA 77", (-70.45, -33.36), "2026-07-16"),
    ])
    proceso = ejecutar(crudo, tmp_path / "salida")
    assert proceso.returncode == 0, proceso.stderr
    principal = json.loads((tmp_path / "salida" / f"{SALIDA}.json").read_text(encoding="utf-8"))["ventanas"]["principal"]
    assert principal["tickets_en_sector"] == 0
    assert principal["cobertura"] is None


def test_rechaza_el_crudo_dentro_del_repo(tmp_path):
    proceso = ejecutar(REPO / "data/validacion/atencion_vecino.csv", tmp_path / "salida")
    assert proceso.returncode == 1
    assert "fuera del repositorio" in proceso.stderr


def rejilla_id(rank):
    with PREDICCION.open(newline="", encoding="utf-8") as archivo:
        return next(f["ID_IDE"] for f in csv.DictReader(archivo) if int(f["rank"]) == rank)

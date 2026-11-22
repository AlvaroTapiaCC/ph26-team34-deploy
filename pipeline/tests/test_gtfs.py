import importlib.util
import io
import json
from pathlib import Path
from urllib.error import URLError

import pytest


spec = importlib.util.spec_from_file_location("gtfs", Path(__file__).parents[1] / "09_gtfs.py")
gtfs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gtfs)

FUENTE = [[-70.604, -33.42], [-70.604, -33.419], [-70.604, -33.418]]


def respuesta(puntos=FUENTE, confidence=0.99):
    return {"code": "Ok", "tracepoints": [{}, {}, {}], "matchings": [
        {"confidence": confidence, "geometry": {"type": "LineString", "coordinates": puntos}}
    ]}


def test_match_conserva_extremos_y_trazado():
    assert gtfs.validar_match(respuesta(), FUENTE) == [FUENTE[0], *FUENTE, FUENTE[-1]]


@pytest.mark.parametrize("datos", [
    {}, {"code": "NoMatch"}, {"code": "Ok", "matchings": []},
    respuesta(confidence=0.2), respuesta([[-70.61, -33.42], [-70.61, -33.418]]),
    respuesta([FUENTE[0], FUENTE[1], FUENTE[0], FUENTE[-1]]),
    respuesta([[float("nan"), -33.42], FUENTE[-1]]),
])
def test_match_inseguro_usa_respaldo(datos):
    assert gtfs.validar_match(datos, FUENTE) is None


def test_tidy_puede_omitir_trazas_intermedias():
    datos = respuesta()
    datos["tracepoints"][1] = None
    assert gtfs.validar_match(datos, FUENTE) is not None


def test_match_dividido_usa_respaldo():
    datos = respuesta()
    datos["matchings"] *= 2
    assert gtfs.validar_match(datos, FUENTE) is None


def test_chunks_solapados_continuos_y_respaldo(tmp_path, monkeypatch):
    ajustador = gtfs.AjustadorOSRM("https://osrm.invalid", tmp_path)
    puntos = [[-70.604, -33.42 + i*0.00001] for i in range(22)]
    consultas = []

    def consultar(chunk):
        consultas.append(chunk)
        if len(consultas) == 2:
            return {}
        return {"code": "Ok", "tracepoints": [{}]*len(chunk), "matchings": [
            {"confidence": 1, "geometry": {"type": "LineString", "coordinates": chunk}}
        ]}

    monkeypatch.setattr(ajustador, "consultar", consultar)
    assert ajustador.ajustar(puntos, "test") == puntos
    assert max(map(len, consultas)) == 10
    assert consultas[0][-1] == consultas[1][0]
    assert ajustador.conteos["test"] == {"matched": 2, "fallback": 1}


def test_vacio_no_consulta(tmp_path):
    ajustador = gtfs.AjustadorOSRM("https://osrm.invalid", tmp_path)
    assert ajustador.ajustar([], "vacio") == []


def test_cache_evade_nueva_consulta(tmp_path, monkeypatch):
    urls = []

    def abrir(request, timeout):
        urls.append(request.full_url)
        assert timeout == 40
        return io.BytesIO(json.dumps(respuesta()).encode())

    monkeypatch.setattr(gtfs, "urlopen", abrir)
    monkeypatch.setattr(gtfs.time, "sleep", lambda _: None)
    ajustador = gtfs.AjustadorOSRM("https://osrm.invalid/", tmp_path)
    assert ajustador.consultar(FUENTE) == ajustador.consultar(FUENTE)
    assert len(urls) == 1
    assert "/match/v1/driving/" in urls[0]
    assert "overview=full" in urls[0]


def test_servidor_inaccesible_detiene_publicacion(tmp_path, monkeypatch):
    def abrir(*args, **kwargs):
        raise URLError("sin conexión")

    monkeypatch.setattr(gtfs, "urlopen", abrir)
    monkeypatch.setattr(gtfs.time, "sleep", lambda _: None)
    ajustador = gtfs.AjustadorOSRM("https://osrm.invalid", tmp_path)
    assert ajustador.consultar(FUENTE) == {}
    assert ajustador.consultar(FUENTE) == {}
    with pytest.raises(RuntimeError, match="OSRM no responde"):
        ajustador.consultar(FUENTE)

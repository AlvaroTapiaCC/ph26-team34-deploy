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


def test_solo_cache_conserva_gtfs_sin_red(tmp_path, monkeypatch):
    def abrir(*args, **kwargs):
        pytest.fail("No debe consultar la red")

    monkeypatch.setattr(gtfs, "urlopen", abrir)
    ajustador = gtfs.AjustadorOSRM("https://osrm.invalid", tmp_path, solo_cache=True)
    assert ajustador.ajustar(FUENTE, "test") == FUENTE
    assert ajustador.metadatos()["totales"] == {"matched": 0, "fallback": 1}
    assert ajustador.metadatos()["solo_cache"] is True


def test_zona_san_carlos_cubre_ranking_y_margen(tmp_path):
    ranking = tmp_path/"ranking.csv"
    ranking.write_text("rank,ID_IDE,prioridad\n1,a,0.7\n2,b,0.3\n")
    rejillas = tmp_path/"rejillas.geojson"
    coords = [[-70.544252, -33.406522], [-70.553754, -33.42352]]
    rejillas.write_text(json.dumps({"features": [
        {"properties": {"ID_IDE": key}, "geometry": {"coordinates": xy}}
        for key, xy in zip(("a", "b"), coords)]}))
    centro, radio, sector, meta = gtfs.zona_san_carlos(ranking, rejillas)
    assert centro == (-70.541, -33.418)
    assert all(gtfs.distancia(p, centro)+80 <= radio for p in coords)
    assert radio % 100 == 0
    assert [r["rank"] for r in sector] == [1, 2]
    assert meta["cantidad_rejillas"] == 2
    assert len(meta["sha256_ranking"]) == 64


def test_zona_rechaza_ranking_vacio_y_rejilla_sin_coordenadas(tmp_path):
    ranking = tmp_path/"ranking.csv"
    rejillas = tmp_path/"rejillas.geojson"
    ranking.write_text("rank,ID_IDE,prioridad\n")
    rejillas.write_text('{"features": []}')
    with pytest.raises(ValueError, match="vacío"):
        gtfs.zona_san_carlos(ranking, rejillas)
    ranking.write_text("rank,ID_IDE,prioridad\n1,a,0.7\n")
    with pytest.raises(KeyError):
        gtfs.zona_san_carlos(ranking, rejillas)


def test_cercanos_incluye_todas_las_rejillas_del_sector():
    stops = [{"id": "s", "lon": -70.541, "lat": -33.418}]
    sector = [{"id": "a", "coords": [-70.541, -33.418], "rank": 1, "prioridad": .7},
              {"id": "b", "coords": [-70.541, -33.4181], "rank": 2, "prioridad": .6},
              {"id": "c", "coords": [-70.541, -33.42], "rank": 3, "prioridad": .5}]
    pares = gtfs.cercanos(stops, sector)
    assert [p["rejilla"] for p in pares] == ["a", "b"]
    assert pares[1]["rank"] == 2 and pares[1]["prioridad"] == .6
    assert gtfs.cercanos(stops, []) == []
    assert gtfs.cercanos([], sector) == []


def test_recorte_zona_y_default_mut():
    puntos = [[-70.545, -33.418], [-70.537, -33.418]]
    assert gtfs.tramos(puntos) == gtfs.tramos(puntos, gtfs.CENTRO, gtfs.RADIO) == []
    assert gtfs.tramos(puntos, (-70.541, -33.418), 1600) == [puntos]


def test_publicar_zona_no_reemplaza_mut(tmp_path):
    spec = importlib.util.spec_from_file_location("publicar", Path(__file__).parents[1]/"publicar_front.py")
    publicar = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publicar)
    origen = tmp_path/"transporte.json"
    datos = {"paraderos": [], "recorridos": [{"servicio": "C", "sentido": "0", "destino": "X",
                                              "geometria": [FUENTE]}]}
    origen.write_text(json.dumps(datos))
    mut = tmp_path/"recorridos.geojson"
    mut.write_text("mut intacto")
    publicar.publicar_recorridos(origen, tmp_path, "san-carlos")
    assert mut.read_text() == "mut intacto"
    assert json.loads((tmp_path/"transporte_san_carlos.json").read_text()) == datos
    assert len(json.loads((tmp_path/"recorridos_san_carlos.geojson").read_text())["features"]) == 1


def test_completo_conserva_shape_y_secuencia_fuera_de_zona(monkeypatch):
    tablas = {
        "stops": [{"stop_id": id, "stop_name": id, "stop_lon": str(x), "stop_lat": "-33.418", "location_type": "0"}
                  for id, x in [("fuera", -70.63), ("local", -70.601), ("local2", -70.602)]],
        "routes": [{"route_id": "r", "route_short_name": "1", "route_type": "3"}],
        "trips": [{"trip_id": "t", "route_id": "r", "direction_id": "0", "trip_headsign": "X", "shape_id": "s"}],
        "stop_times": [{"trip_id": "t", "stop_id": id, "stop_sequence": str(i)}
                       for i, id in [(3, "local2"), (1, "fuera"), (2, "local")]],
        "shapes": [{"shape_id": "s", "shape_pt_sequence": str(i), "shape_pt_lon": str(x), "shape_pt_lat": "-33.418"}
                   for i, x in [(2, -70.601), (1, -70.63), (3, -70.602)]],
    }
    monkeypatch.setattr(gtfs, "filas", lambda _, nombre: iter(tablas[nombre]))
    completos = []
    local = gtfs.extraer(None, completos=completos)
    assert local == gtfs.extraer(None)
    assert local["recorridos"][0]["paraderos"] == ["local", "local2"]
    assert [p["id"] for p in completos[0]["paraderos"]] == ["fuera", "local", "local2"]
    assert completos[0]["geometria"][0] == (-70.63, -33.418)
    assert gtfs.distancia(completos[0]["geometria"][0], gtfs.CENTRO) > gtfs.RADIO


def test_completos_sin_servicios(monkeypatch):
    monkeypatch.setattr(gtfs, "filas", lambda *_: iter([]))
    completos = []
    assert gtfs.extraer(None, completos=completos) == {"paraderos": [], "recorridos": []}
    assert completos == []

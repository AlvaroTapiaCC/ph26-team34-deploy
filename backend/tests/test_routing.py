"""Servicio de rutas con OSRM simulado (sin red)."""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import routing

A, B, C = (-33.4560, -70.6000), (-33.4530, -70.5950), (-33.4500, -70.5900)


def _ruta_ok(n_legs):
    return {"code": "Ok", "routes": [{
        "distance": 1500.0, "duration": 180.0,
        "geometry": {"type": "LineString", "coordinates": [[-70.6, -33.456], [-70.595, -33.453]]},
        "legs": [{"distance": 1500.0 / n_legs, "duration": 180.0 / n_legs}] * n_legs,
    }]}


@pytest.fixture
def osrm(monkeypatch):
    """Instala un OSRM falso. Devuelve la lista de URLs llamadas y permite cambiar la respuesta."""
    estado = {"llamadas": [], "responder": None}

    def handler(request: httpx.Request):
        estado["llamadas"].append(str(request.url))
        return estado["responder"](request)

    monkeypatch.setattr(routing, "_client", httpx.Client(transport=httpx.MockTransport(handler)))
    routing._cache.clear()
    yield estado
    routing._cache.clear()


def test_ruta_osrm_y_cache(osrm):
    osrm["responder"] = lambda r: httpx.Response(200, json=_ruta_ok(2))
    r1 = routing.ruta([A, B, C])
    r2 = routing.ruta([A, B, C])
    assert r1.fuente == "osrm" and r1.distancia_m == 1500 and len(r1.tramos) == 2
    assert r2 is r1 and len(osrm["llamadas"]) == 1
    # OSRM recibe lon,lat
    assert "-70.600000,-33.456000;-70.595000,-33.453000" in osrm["llamadas"][0]


def test_ruta_plan_b_si_osrm_falla_y_no_se_cachea(osrm):
    osrm["responder"] = lambda r: httpx.Response(503)
    r = routing.ruta([A, B])
    assert r.fuente == "linea_recta" and r.distancia_m > routing.haversine_m(A, B)
    assert r.geojson["coordinates"] == [[A[1], A[0]], [B[1], B[0]]]
    osrm["responder"] = lambda r: httpx.Response(200, json=_ruta_ok(1))
    assert routing.ruta([A, B]).fuente == "osrm"  # se reintentó OSRM


def test_ruta_plan_b_si_osrm_no_encuentra_ruta(osrm):
    osrm["responder"] = lambda r: httpx.Response(200, json={"code": "NoRoute", "routes": []})
    assert routing.ruta([A, B]).fuente == "linea_recta"


def test_ruta_plan_b_si_hay_timeout(osrm):
    def lento(r):
        raise httpx.ReadTimeout("timeout", request=r)
    osrm["responder"] = lento
    assert routing.ruta([A, B]).fuente == "linea_recta"


def test_ruta_casos_borde(osrm):
    osrm["responder"] = lambda r: pytest.fail("no debería llamar a OSRM")
    with pytest.raises(ValueError):
        routing.ruta([(-200.0, 0.0), A])
    with pytest.raises(ValueError):
        routing.ruta([A] * (routing.MAX_PUNTOS_RUTA + 1))


def test_matriz_marca_pares_estimados_y_no_los_cachea(osrm):
    """[P2] Un par sin ruta en OSRM se estima, queda marcado y la matriz parcial no se cachea."""
    osrm["responder"] = lambda r: httpx.Response(200, json={
        "code": "Ok", "durations": [[60.0, None]], "distances": [[500.0, None]]})
    m = routing.matriz([A], [B, C])
    assert m.fuente == "mixta" and m.estimadas == [[False, True]]
    assert m.duraciones_s[0][0] == 60 and m.duraciones_s[0][1] > 0
    url = osrm["llamadas"][0]
    assert "sources=0" in url and "destinations=1%3B2" in url
    routing.matriz([A], [B, C])
    assert len(osrm["llamadas"]) == 2  # no se reutilizó la estimación: se volvió a consultar OSRM


def test_matriz_completa_se_cachea(osrm):
    osrm["responder"] = lambda r: httpx.Response(200, json={
        "code": "Ok", "durations": [[60.0, 90.0]], "distances": [[500.0, 800.0]]})
    m1 = routing.matriz([A], [B, C])
    m2 = routing.matriz([A], [B, C])
    assert m1.fuente == "osrm" and m1.estimadas == [[False, False]] and m2 is m1
    assert len(osrm["llamadas"]) == 1


@pytest.mark.parametrize("cuerpo", [
    {"code": "Ok", "durations": [[60.0]], "distances": [[500.0]]},                      # 1x1 para 1x2
    {"code": "Ok", "durations": [[60.0, 70.0]], "distances": [[500.0]]},                # distancias cortas
    {"code": "Ok", "durations": [[60.0, 70.0], [1.0, 2.0]], "distances": [[1, 2], [3, 4]]},  # filas de más
    {"code": "Ok"},                                                                     # sin matrices
])
def test_matriz_con_dimensiones_incorrectas_usa_plan_b_sin_cachear(osrm, cuerpo):
    """[P2] Una respuesta Ok con dimensiones que no calzan no se acepta ni se cachea."""
    osrm["responder"] = lambda r: httpx.Response(200, json=cuerpo)
    m = routing.matriz([A], [B, C])
    assert m.fuente == "linea_recta" and len(m.duraciones_s[0]) == 2 and m.estimadas == [[True, True]]
    routing.matriz([A], [B, C])
    assert len(osrm["llamadas"]) == 2


def test_ruta_de_una_parada_es_un_point_valido(osrm):
    """[P3] Una sola parada: GeoJSON Point (un LineString necesita 2 posiciones)."""
    osrm["responder"] = lambda r: pytest.fail("no debería llamar a OSRM")
    r = routing.ruta([A])
    assert r.geojson == {"type": "Point", "coordinates": [A[1], A[0]]}
    assert r.distancia_m == 0 and r.tramos == [] and r.fuente == "una_parada"
    with pytest.raises(ValueError):
        routing.ruta([])


def test_ruta_con_tramos_que_no_calzan_usa_plan_b(osrm):
    osrm["responder"] = lambda r: httpx.Response(200, json=_ruta_ok(1))  # 1 tramo para 3 paradas
    r = routing.ruta([A, B, C])
    assert r.fuente == "linea_recta" and len(r.tramos) == 2


def test_ruta_con_geometria_invalida_usa_plan_b(osrm):
    cuerpo = _ruta_ok(1)
    cuerpo["routes"][0]["geometry"] = {"type": "LineString", "coordinates": [[-70.6, -33.45]]}
    osrm["responder"] = lambda r: httpx.Response(200, json=cuerpo)
    assert routing.ruta([A, B]).fuente == "linea_recta"


def test_matriz_plan_b(osrm):
    osrm["responder"] = lambda r: httpx.Response(500)
    m = routing.matriz([A, B], [C])
    assert m.fuente == "linea_recta" and len(m.duraciones_s) == 2 and len(m.duraciones_s[0]) == 1


def test_haversine():
    # ~1 grado de latitud ≈ 111 km
    assert routing.haversine_m((0, 0), (1, 0)) == pytest.approx(111_195, rel=1e-3)


def test_endpoint_rutas(osrm):
    osrm["responder"] = lambda r: httpx.Response(200, json=_ruta_ok(1))
    c = TestClient(app)
    r = c.post("/rutas", json={"puntos": [list(A), list(B)]})
    assert r.status_code == 200 and r.json()["fuente"] == "osrm"
    assert c.post("/rutas", json={"puntos": [list(A)]}).status_code == 422
    assert c.post("/rutas", json={"puntos": [[-200, 0], list(B)]}).status_code == 422

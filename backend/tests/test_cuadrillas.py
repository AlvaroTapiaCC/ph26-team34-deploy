"""Endpoints de cuadrillas, misiones y rutas (issue #33)."""
import io
import os
import threading
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from psycopg.types.json import Jsonb

from app.main import app
from app.services import cuadrillas, routing, storage

client = TestClient(app)
INTEGRACION = pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1",
                                 reason="DRENA_TEST_INTEGRACION=1 para correrlo")


def _jpeg():
    b = io.BytesIO()
    Image.new("RGB", (40, 30), (80, 80, 80)).save(b, "JPEG")
    return b.getvalue()


# --- Reglas puras ---------------------------------------------------------------------
@pytest.mark.parametrize("lat,lon,ok", [(-33.45, -70.6, True), (0, 0, False), (-33.45, -71.5, False),
                                        (-34.5, -70.6, False)])
def test_validar_posicion(lat, lon, ok):
    if ok:
        cuadrillas.validar_posicion(lat, lon)
    else:
        with pytest.raises(cuadrillas.PosicionInvalida):
            cuadrillas.validar_posicion(lat, lon)


def test_cerrar_no_es_un_estado_editable_y_toda_transicion_es_valida():
    assert "cerrada" not in cuadrillas.TRANSICIONES  # solo por /close, con foto
    for nuevo, desde in cuadrillas.TRANSICIONES.items():
        assert nuevo in cuadrillas.ESTADOS and set(desde) <= set(cuadrillas.ACTIVAS)


def test_ids_de_mision_invalidos_dan_422():
    assert client.post("/missions/no-es-uuid/status", json={"estado": "en_camino"}).status_code == 422
    assert client.post(f"/missions/{uuid.uuid4()}/status", json={"estado": "cerrada"}).status_code == 422


def test_crew_token_se_exige_si_esta_configurado(monkeypatch):
    monkeypatch.setattr("app.seguridad.get_settings", lambda: SimpleNamespace(crew_token="t0k", admin_token=""))
    r = client.post("/crews/x/position", json={"lat": -33.45, "lon": -70.6})
    assert r.status_code == 401
    r = client.post(f"/missions/{uuid.uuid4()}/status", json={"estado": "en_camino"}, headers={"X-Crew-Token": "mal"})
    assert r.status_code == 401


# --- Integración contra Supabase --------------------------------------------------------
@pytest.fixture
def escena(monkeypatch):
    """Una cuadrilla simulada, una real, dos sumideros y tres misiones; IDs únicos por ejecución."""
    from app.db import get_conn

    monkeypatch.setattr(routing, "ruta", routing.ruta_linea_recta)  # sin depender de OSRM
    run = uuid.uuid4().hex[:10]
    e = SimpleNamespace(crew=f"test-crew-{run}", real=f"test-real-{run}", s1=f"test-s1-{run}",
                        s2=f"test-s2-{run}", run=run)
    with get_conn() as conn:
        conn.execute("insert into crews (id, nombre, equipamiento, geom_actual, is_simulated) values"
                     " (%s, 'Sim', '{basica}', st_point(-70.60, -33.45, 4326), true),"
                     " (%s, 'Real', '{basica}', st_point(-70.61, -33.44, 4326), false)", (e.crew, e.real))
        conn.execute("insert into sumideros (id, geom, fuente, calle) values"
                     " (%s, st_point(-70.601, -33.451, 4326), 'manual', 'Calle Uno'),"
                     " (%s, st_point(-70.602, -33.452, 4326), 'manual', 'Calle Dos')", (e.s1, e.s2))
        e.m1, e.m2, e.m3 = [conn.execute(
            "insert into missions (crew_id, sumidero_id, orden) values (%s, %s, %s) returning id",
            (e.crew, s, o)).fetchone()["id"] for s, o in ((e.s1, 1), (e.s2, 2), (e.s1, 3))]
    yield e
    with get_conn() as conn:
        conn.execute("delete from events where payload->>'crew_id' = any(%s)", ([e.crew, e.real],))
        conn.execute("delete from missions where crew_id = any(%s)", ([e.crew, e.real],))
        conn.execute("delete from crews where id = any(%s)", ([e.crew, e.real],))
        conn.execute("delete from sumideros where id = any(%s)", ([e.s1, e.s2],))


@INTEGRACION
def test_listar_oculta_posicion_de_cuadrillas_reales(escena, monkeypatch):
    por_id = {c["id"]: c for c in client.get("/crews").json()}
    assert por_id[escena.crew]["lat"] is not None and por_id[escena.crew]["carga"] == 3
    assert por_id[escena.real]["lat"] is None and por_id[escena.real]["posicion_oculta"]
    monkeypatch.setattr("app.seguridad.get_settings", lambda: SimpleNamespace(admin_token="adm", crew_token=""))
    por_id = {c["id"]: c for c in client.get("/crews", headers={"X-Admin-Token": "adm"}).json()}
    assert por_id[escena.real]["lat"] == pytest.approx(-33.44)


@INTEGRACION
def test_posicion(escena):
    r = client.post(f"/crews/{escena.crew}/position", json={"lat": -33.46, "lon": -70.59})
    assert r.status_code == 200
    assert client.post(f"/crews/{escena.crew}/position", json={"lat": 0, "lon": 0}).status_code == 422
    assert client.post("/crews/no-existe/position", json={"lat": -33.46, "lon": -70.59}).status_code == 404
    from app.db import get_conn
    with get_conn() as conn:
        n = conn.execute("select count(*) n from crew_positions where crew_id = %s", (escena.crew,)).fetchone()["n"]
    assert n == 1


@INTEGRACION
def test_ruta_calculada_con_paradas_en_orden(escena):
    r = client.get(f"/crews/{escena.crew}/route").json()
    assert r["origen"] == "calculada" and r["geojson"]["type"] == "LineString"
    assert [m["sumidero_id"] for m in r["misiones"]] == [escena.s1, escena.s2, escena.s1]
    assert len(r["tramos"]) == 3  # posición de la cuadrilla + 3 paradas
    assert r["geojson"]["coordinates"][0] == pytest.approx([-70.60, -33.45])  # simulada: parte en su posición
    assert "posicion_oculta" not in r
    assert client.get("/crews/no-existe/route").status_code == 404


@INTEGRACION
def test_ruta_publica_de_cuadrilla_real_no_revela_su_posicion(escena, monkeypatch):
    from app.db import get_conn

    pos = "-70.61"  # longitud de la cuadrilla real (-33.44, -70.61); ninguna parada la comparte
    monkeypatch.setattr("app.seguridad.get_settings", lambda: SimpleNamespace(admin_token="adm", crew_token=""))

    # (a) Sin misiones: no hay geometría ni coordenadas de la cuadrilla
    r = client.get(f"/crews/{escena.real}/route")
    assert r.status_code == 200
    j = r.json()
    assert j["origen"] == "sin_misiones" and j["geojson"] is None and j["posicion_oculta"] is True
    assert pos not in r.text and "-33.44" not in r.text

    # (b) Con misiones y una ruta guardada que parte en su posición: se ignora y se calcula
    #     desde la primera parada
    with get_conn() as conn:
        for s, o in ((escena.s1, 1), (escena.s2, 2)):
            conn.execute("insert into missions (crew_id, sumidero_id, orden) values (%s, %s, %s)", (escena.real, s, o))
        conn.execute("insert into routes (crew_id, version, geojson) values (%s, 1, %s)",
                     (escena.real, Jsonb({"type": "LineString", "coordinates": [[-70.61, -33.44], [-70.601, -33.451]]})))
    r = client.get(f"/crews/{escena.real}/route")
    j = r.json()
    assert j["origen"] == "calculada" and j["posicion_oculta"] is True and j["version"] is None
    assert j["geojson"]["coordinates"][0] == pytest.approx([-70.601, -33.451])  # primera parada
    assert len(j["tramos"]) == 1
    assert pos not in r.text and "-33.44" not in r.text

    # Con token de admin se entrega la ruta guardada
    j = client.get(f"/crews/{escena.real}/route", headers={"X-Admin-Token": "adm"}).json()
    assert j["origen"] == "despacho" and j["geojson"]["coordinates"][0] == [-70.61, -33.44]


@INTEGRACION
def test_transiciones_y_sincronizacion(escena):
    from app.db import get_conn

    m = str(escena.m1)
    assert client.post(f"/missions/{m}/status", json={"estado": "en_sitio"}).status_code == 409  # salta un paso
    assert client.post(f"/missions/{m}/status", json={"estado": "en_camino"}).json()["estado"] == "en_camino"
    with get_conn() as conn:
        assert conn.execute("select estado from crews where id = %s", (escena.crew,)).fetchone()["estado"] == "en_ruta"
    assert client.post(f"/missions/{m}/status", json={"estado": "en_sitio"}).status_code == 200
    assert client.post(f"/missions/{uuid.uuid4()}/status", json={"estado": "en_camino"}).status_code == 404
    with get_conn() as conn:
        ev = conn.execute("select count(*) n from events where tipo = 'mision_estado' and payload->>'mission_id' = %s",
                          (m,)).fetchone()["n"]
        assert conn.execute("select estado from crews where id = %s", (escena.crew,)).fetchone()["estado"] == "en_sitio"
    assert ev == 2


@INTEGRACION
def test_dos_peticiones_simultaneas_solo_una_gana(escena):
    m = str(escena.m2)
    codigos = []
    barrera = threading.Barrier(6)

    def mover():
        barrera.wait()
        codigos.append(client.post(f"/missions/{m}/status", json={"estado": "en_camino"}).status_code)

    hilos = [threading.Thread(target=mover) for _ in range(6)]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join(30)
    assert sorted(codigos) == [200] + [409] * 5


@INTEGRACION
def test_cierre_con_foto(escena, monkeypatch):
    subidas, borradas = [], []
    monkeypatch.setattr(storage, "subir", lambda data, ruta, ct="image/jpeg": subidas.append((ruta, data)) or ruta)
    monkeypatch.setattr(storage, "borrar", lambda rutas: borradas.extend(rutas))
    monkeypatch.setattr(storage, "url_firmada", lambda ruta, expira_s=3600: f"https://firmada/{ruta}")
    m = str(escena.m3)

    monkeypatch.setattr("app.routers.missions.clasificar_rejilla", lambda data: None)  # Claude caído: sin verificar

    # No se puede cerrar desde pendiente: se responde antes de subir la foto (ni de llamar a Claude)
    r = client.post(f"/missions/{m}/close", files={"foto": ("x.jpg", _jpeg(), "image/jpeg")})
    assert r.status_code == 409 and subidas == [] and borradas == []

    client.post(f"/missions/{m}/status", json={"estado": "en_camino"})
    r = client.post(f"/missions/{m}/close", files={"foto": ("x.jpg", _jpeg(), "image/jpeg")})
    assert r.status_code == 200
    j = r.json()
    assert j["mision"]["estado"] == "cerrada" and j["cierre"]["verificado"] is False
    assert j["cierre"]["foto_url"].startswith("cierres/") and j["cierre"]["foto_url_firmada"].startswith("https://")
    assert subidas[-1][1][:2] == b"\xff\xd8"  # se guarda un JPEG re-codificado

    # Cerrar dos veces: 409; imagen ilegible: 422; misión inexistente: 404
    assert client.post(f"/missions/{m}/close", files={"foto": ("x.jpg", _jpeg(), "image/jpeg")}).status_code == 409
    assert client.post(f"/missions/{escena.m1}/close", files={"foto": ("x.jpg", b"nope", "image/jpeg")}).status_code == 422
    assert client.post(f"/missions/{uuid.uuid4()}/close", files={"foto": ("x.jpg", _jpeg(), "image/jpeg")}).status_code == 404
    from app.db import get_conn
    with get_conn() as conn:
        conn.execute("delete from closures where mission_id = %s", (m,))

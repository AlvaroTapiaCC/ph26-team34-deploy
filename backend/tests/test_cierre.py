"""Cierre verificado con foto (issue #42)."""
import contextlib
import io
import os
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.routers import missions as router
from app.schemas.claude import ClasificacionRejilla
from app.services import cuadrillas, routing, storage
from app.services.claude_common import ResultadoClaude

client = TestClient(app)
INTEGRACION = pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1",
                                 reason="DRENA_TEST_INTEGRACION=1 para correrlo")


@pytest.fixture(autouse=True)
def sin_crew_token(monkeypatch):
    """Las pruebas no mandan X-Crew-Token: un CREW_TOKEN en el .env local no debe hacerlas fallar."""
    monkeypatch.setattr("app.seguridad.get_settings", lambda: SimpleNamespace(crew_token="", admin_token=""))


def _jpeg():
    b = io.BytesIO()
    Image.new("RGB", (40, 30), (80, 80, 80)).save(b, "JPEG")
    return b.getvalue()


def _foto():
    return {"foto": ("x.jpg", _jpeg(), "image/jpeg")}


def _rejilla(estado: str, evaluable: bool = True, nivel_agua: str = "sin_agua") -> ResultadoClaude:
    c = ClasificacionRejilla(evaluable=evaluable, rejilla=estado, material=[] if estado == "limpia" else ["hojas"],
                             hojas_calzada="pocas", agua_visible=nivel_agua != "sin_agua", nivel_agua=nivel_agua,
                             confianza="alta", nota=f"Rejilla {estado}")
    return ResultadoClaude(c, "modelo-test", "rejilla-v1", f"k-{uuid.uuid4().hex}", latencia_ms=1)


def _caido() -> ResultadoClaude:
    return ResultadoClaude(ClasificacionRejilla.no_evaluable("No se pudo clasificar la foto"), "modelo-test",
                           "rejilla-v1", "k", fallo=True, extra={"motivo": "claude_no_configurado"})


# --- Reglas puras ----------------------------------------------------------------------
@pytest.mark.parametrize("r,esperado", [
    (_rejilla("limpia"), "verificado"),
    (_rejilla("parcial"), "rechazado"),
    (_rejilla("tapada"), "rechazado"),
    (_rejilla("no_evaluable", evaluable=False), "sin_verificar"),
    (_caido(), "sin_verificar"),
    (None, "sin_verificar"),
])
def test_veredicto(r, esperado):
    assert router._veredicto(r)[0] == esperado


# --- Endpoint con la base simulada ------------------------------------------------------
@pytest.fixture
def falso(monkeypatch):
    """Reemplaza base, Storage, despacho y recálculo; registra lo que el endpoint escribe."""
    f = SimpleNamespace(cerradas=[], rechazadas=[], observaciones=[], recalculos=0, despachos=[], borradas=[])
    mision = {"id": "m1", "crew_id": "c1", "case_id": None, "sumidero_id": "s1", "estado": "en_sitio",
              "lat": -33.45, "lon": -70.6}

    @contextlib.contextmanager
    def conn():
        yield object()

    def cerrar(_c, mid, ruta, clasif, verificado=False):
        f.cerradas.append((ruta, clasif, verificado))
        return {"mision": {**mision, "estado": "cerrada"}, "cierre": {"id": "x", "foto_url": ruta,
                                                                       "verificado": verificado}}

    def rechazar(_c, mid, ruta, clasif, motivo):
        f.rechazadas.append((ruta, motivo))
        return {"mision": mision, "cierre": None}

    def recalcular(_c):
        f.recalculos += 1

    monkeypatch.setattr(router, "get_conn", conn)
    monkeypatch.setattr(cuadrillas, "mision_cerrable", lambda _c, mid: mision)
    monkeypatch.setattr(cuadrillas, "cerrar_mision", cerrar)
    monkeypatch.setattr(cuadrillas, "rechazar_cierre", rechazar)
    monkeypatch.setattr(router.obs_svc, "insertar_observacion",
                        lambda _c, **kw: f.observaciones.append(kw) or "obs-1")
    monkeypatch.setattr(router.obs_svc, "insertar_clasificacion", lambda *a: None)
    monkeypatch.setattr(router, "recalcular_todo", recalcular)
    monkeypatch.setattr(router.dispatch, "replanificar_seguro",
                        lambda motivo, **kw: f.despachos.append(motivo) or {"despachado": True})
    monkeypatch.setattr(storage, "subir", lambda data, ruta, ct="image/jpeg": ruta)
    monkeypatch.setattr(storage, "borrar", lambda rutas: f.borradas.extend(rutas))
    monkeypatch.setattr(storage, "url_firmada", lambda ruta, expira_s=3600: f"https://firmada/{ruta}")
    f.mision = mision
    return f


def test_limpia_cierra_verificada_y_entra_como_observacion(falso, monkeypatch):
    monkeypatch.setattr(router, "clasificar_rejilla", lambda data: _rejilla("limpia"))
    j = client.post("/missions/00000000-0000-0000-0000-000000000001/close", files=_foto()).json()
    assert j["cerrada"] and j["verificado"] and j["resultado"] == "verificado"
    assert falso.cerradas[0][2] is True and falso.cerradas[0][1]["rejilla"] == "limpia"
    assert falso.observaciones[0]["fuente"] == "cuadrilla" and falso.observaciones[0]["tipo"] == "foto_rejilla"
    assert falso.observaciones[0]["sumidero_id"] == "s1" and j["observation_id"] == "obs-1"
    assert falso.recalculos == 1 and j["recalculado"] and falso.despachos == ["cierre"]


@pytest.mark.parametrize("estado", ["parcial", "tapada"])
def test_parcial_o_tapada_no_cierra(falso, monkeypatch, estado):
    monkeypatch.setattr(router, "clasificar_rejilla", lambda data: _rejilla(estado))
    r = client.post("/missions/00000000-0000-0000-0000-000000000001/close", files=_foto())
    assert r.status_code == 200
    j = r.json()
    assert j["cerrada"] is False and j["verificado"] is False and estado in j["motivo"]
    assert j["cierre"] is None and falso.cerradas == [] and len(falso.rechazadas) == 1
    # La foto sigue siendo evidencia: sube la prioridad y se vuelve a planificar
    assert len(falso.observaciones) == 1 and falso.recalculos == 1 and falso.despachos == ["observacion"]


@pytest.mark.parametrize("claude", [
    lambda data: _caido(),
    lambda data: _rejilla("no_evaluable", evaluable=False),
    lambda data: (_ for _ in ()).throw(RuntimeError("caído")),
])
def test_sin_verificar_cierra_igual_sin_500(falso, monkeypatch, claude):
    monkeypatch.setattr(router, "clasificar_rejilla", claude)
    r = client.post("/missions/00000000-0000-0000-0000-000000000001/close", files=_foto())
    assert r.status_code == 200
    j = r.json()
    assert j["cerrada"] and j["verificado"] is False and j["resultado"] == "sin_verificar"
    assert falso.cerradas[0][2] is False
    # Sin clasificación válida no hay observación nueva: lo observado antes sigue vigente
    assert falso.observaciones == [] and falso.recalculos == 0 and falso.despachos == ["cierre"]


def test_falla_de_storage_no_muestra_detalles_tecnicos_a_la_cuadrilla(falso, monkeypatch):
    def sin_storage(*a, **kw):
        raise storage.StorageError("Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY")

    monkeypatch.setattr(router, "clasificar_rejilla", lambda data: _rejilla("limpia"))
    monkeypatch.setattr(storage, "subir", sin_storage)
    r = client.post("/missions/00000000-0000-0000-0000-000000000001/close", files=_foto())
    assert r.status_code == 503 and r.json()["detail"] == "No se pudo guardar la foto en el servidor"
    assert falso.cerradas == [] and falso.rechazadas == []


def test_falla_del_recalculo_no_tumba_el_cierre(falso, monkeypatch):
    monkeypatch.setattr(router, "clasificar_rejilla", lambda data: _rejilla("limpia"))
    monkeypatch.setattr(router, "recalcular_todo", lambda _c: (_ for _ in ()).throw(RuntimeError("db")))
    j = client.post("/missions/00000000-0000-0000-0000-000000000001/close", files=_foto()).json()
    assert j["cerrada"] and j["recalculado"] is False and falso.despachos == ["cierre"]


def test_no_llama_a_claude_si_la_mision_no_se_puede_cerrar(falso, monkeypatch):
    llamadas = []
    monkeypatch.setattr(router, "clasificar_rejilla", lambda data: llamadas.append(1))

    def no_cerrable(_c, mid):
        raise cuadrillas.TransicionInvalida("pendiente", "cerrada")

    monkeypatch.setattr(cuadrillas, "mision_cerrable", no_cerrable)
    r = client.post("/missions/00000000-0000-0000-0000-000000000001/close", files=_foto())
    assert r.status_code == 409 and llamadas == []


# --- Integración contra Supabase ----------------------------------------------------------
@pytest.fixture
def escena(monkeypatch):
    """Cuadrilla simulada, un sumidero con score y una misión en sitio; IDs únicos por ejecución."""
    from app.db import get_conn

    monkeypatch.setattr(routing, "ruta", routing.ruta_linea_recta)
    monkeypatch.setattr(storage, "subir", lambda data, ruta, ct="image/jpeg": ruta)
    monkeypatch.setattr(storage, "borrar", lambda rutas: None)
    monkeypatch.setattr(storage, "url_firmada", lambda ruta, expira_s=3600: f"https://firmada/{ruta}")
    run = uuid.uuid4().hex[:10]
    e = SimpleNamespace(crew=f"test-crew-{run}", s=f"test-s-{run}")
    with get_conn() as conn:
        conn.execute("insert into crews (id, nombre, equipamiento, geom_actual, is_simulated) values"
                     " (%s, 'Sim', '{basica}', st_point(-70.60, -33.45, 4326), true)", (e.crew,))
        conn.execute("insert into sumideros (id, geom, fuente, calle) values"
                     " (%s, st_point(-70.601, -33.451, 4326), 'manual', 'Calle Uno')", (e.s,))
        e.m = conn.execute("insert into missions (crew_id, sumidero_id, orden, estado) values (%s, %s, 1, 'en_sitio')"
                           " returning id", (e.crew, e.s)).fetchone()["id"]
    yield e
    with get_conn() as conn:
        conn.execute("delete from events where payload->>'crew_id' = %s", (e.crew,))
        conn.execute("delete from closures where mission_id in (select id from missions where crew_id = %s)", (e.crew,))
        conn.execute("delete from missions where crew_id = %s", (e.crew,))
        conn.execute("delete from observations where sumidero_id = %s", (e.s,))
        conn.execute("delete from cleaning_history where sumidero_id = %s", (e.s,))
        conn.execute("delete from scores where sumidero_id = %s", (e.s,))
        conn.execute("delete from crews where id = %s", (e.crew,))
        conn.execute("delete from sumideros where id = %s", (e.s,))


def _prioridad(s):
    from app.db import get_conn
    from app.services import observations as svc
    with get_conn() as conn:
        return (svc.prioridad_de(conn, s) or {}).get("prioridad")


@INTEGRACION
def test_tapada_no_cierra_y_limpia_cierra_y_baja_la_prioridad(escena, monkeypatch):
    from app.db import get_conn

    url = f"/missions/{escena.m}/close"
    monkeypatch.setattr(router, "clasificar_rejilla", lambda data: _rejilla("tapada", nivel_agua="hasta_vereda"))
    j = client.post(url, files=_foto()).json()
    assert j["cerrada"] is False and j["mision"]["estado"] == "en_sitio"
    tapada = _prioridad(escena.s)
    with get_conn() as conn:
        assert conn.execute("select count(*) n from closures where mission_id = %s", (escena.m,)).fetchone()["n"] == 0
        assert conn.execute("select estado from missions where id = %s", (escena.m,)).fetchone()["estado"] == "en_sitio"

    monkeypatch.setattr(router, "clasificar_rejilla", lambda data: _rejilla("limpia"))
    j = client.post(url, files=_foto()).json()
    assert j["cerrada"] and j["verificado"] and j["cierre"]["clasificacion"]["rejilla"] == "limpia"
    limpia = _prioridad(escena.s)
    assert tapada is not None and limpia is not None and limpia < tapada
    with get_conn() as conn:
        assert conn.execute("select verificado from closures where mission_id = %s", (escena.m,)).fetchone()["verificado"]
        assert conn.execute("select count(*) n from cleaning_history where sumidero_id = %s",
                            (escena.s,)).fetchone()["n"] == 1
        # El agua observada en el tramo sigue vigente tras el cierre
        det = conn.execute("select detalle from scores where sumidero_id = %s and modo = 'durante'"
                           " and scenario_id = 'base'", (escena.s,)).fetchone()["detalle"]
    assert det["nivel_agua"] == "hasta_vereda"
    assert client.post(url, files=_foto()).status_code == 409  # ya cerrada


@INTEGRACION
def test_con_claude_caido_cierra_sin_verificar(escena, monkeypatch):
    monkeypatch.setattr(router, "clasificar_rejilla", lambda data: _caido())
    r = client.post(f"/missions/{escena.m}/close", files=_foto())
    assert r.status_code == 200
    j = r.json()
    assert j["cerrada"] and j["verificado"] is False and j["claude_disponible"] is False

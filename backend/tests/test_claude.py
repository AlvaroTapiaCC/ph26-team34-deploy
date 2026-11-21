"""Tests de los servicios de Claude sin llamar a la API (cliente y caché simulados)."""
import io
import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from PIL import Image

from app.schemas.claude import ClasificacionCamara, ClasificacionRejilla, LecturaTexto
from app.services import cache, claude_common
from app.services.claude_text import heuristica_riesgo, leer_texto
from app.services.claude_vision import clasificar_rejilla, preparar_imagen, senal_camara

OK = {"evaluable": True, "rejilla": "tapada", "material": ["hojas"], "hojas_calzada": "muchas",
      "agua_visible": False, "nivel_agua": "sin_agua", "confianza": "alta", "nota": "Tapada con hojas"}


class FakeClient:
    def __init__(self, respuestas):
        self.respuestas = list(respuestas)
        self.llamadas = 0
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.llamadas += 1
        texto = self.respuestas.pop(0)
        return SimpleNamespace(stop_reason="end_turn", model="claude-test", stop_details=None,
                               content=[SimpleNamespace(type="text", text=texto)])


@pytest.fixture
def sin_db(monkeypatch):
    mem = {}
    monkeypatch.setattr(cache, "get", lambda k: mem.get(k))
    monkeypatch.setattr(cache, "put", lambda k, r, m: mem.__setitem__(k, {"respuesta": r, "modelo": m}))
    return mem


def _foto():
    b = io.BytesIO()
    Image.new("RGB", (3000, 2000), (90, 90, 90)).save(b, "JPEG")
    return b.getvalue()


def test_preparar_imagen_achica():
    b64, mt = preparar_imagen(_foto())
    import base64
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    assert mt == "image/jpeg" and max(img.size) <= 1568


def test_clasifica_y_usa_cache(monkeypatch, sin_db):
    fake = FakeClient([json.dumps(OK)])
    monkeypatch.setattr(claude_common, "get_client", lambda: fake)
    r1 = clasificar_rejilla(_foto())
    r2 = clasificar_rejilla(_foto())
    assert r1.resultado.rejilla == "tapada" and not r1.desde_cache
    assert r2.desde_cache and fake.llamadas == 1


def test_reintenta_una_vez_y_luego_no_evaluable(monkeypatch, sin_db):
    fake = FakeClient(["no es json", json.dumps({"rejilla": "rara"})])
    monkeypatch.setattr(claude_common, "get_client", lambda: fake)
    r = clasificar_rejilla(_foto())
    assert fake.llamadas == 2 and r.fallo
    assert r.resultado.rejilla == "no_evaluable" and not r.resultado.evaluable
    assert sin_db == {}  # un fallo no queda en caché


def test_reintento_exitoso(monkeypatch, sin_db):
    fake = FakeClient(["{malo", json.dumps(OK)])
    monkeypatch.setattr(claude_common, "get_client", lambda: fake)
    r = clasificar_rejilla(_foto())
    assert not r.fallo and r.resultado.rejilla == "tapada" and fake.llamadas == 2


def test_texto_fallback_con_riesgo(monkeypatch, sin_db):
    fake = FakeClient(["x", "y"])
    monkeypatch.setattr(claude_common, "get_client", lambda: fake)
    r = leer_texto("Hay un niño atrapado en el auto, el agua sube")
    assert r.fallo and r.resultado.personas_en_riesgo and r.resultado.gravedad == "alta"


@pytest.mark.parametrize("texto,esperado", [
    ("Auxilio, adulto mayor no puede salir", True),
    ("hay gente ATRAPADA en el paso bajo nivel", True),
    ("la rejilla está tapada con hojas", False),
])
def test_heuristica_riesgo(texto, esperado):
    assert heuristica_riesgo(texto) is esperado


def test_senal_camara():
    base = dict(evaluable=True, material=[], hojas_calzada="pocas", basura_calzada="poca",
                agua_visible=False, nivel_agua="sin_agua", confianza="alta", nota="")
    assert senal_camara(ClasificacionCamara(**base)) == 0
    alto = {**base, "hojas_calzada": "muchas", "basura_calzada": "mucha", "material": ["hojas", "basura"]}
    assert senal_camara(ClasificacionCamara(**alto)) == 1.0
    assert senal_camara(ClasificacionCamara.no_evaluable()) == 0


def test_schemas_rechazan_valores_fuera_de_lista():
    with pytest.raises(ValidationError):
        ClasificacionRejilla(**{**OK, "rejilla": "sucia"})
    with pytest.raises(ValidationError):
        LecturaTexto(tipo="x", gravedad="alta", personas_en_riesgo=False, ubicacion_texto=None,
                     desde_cuando=None, nivel_agua="sin_agua")


# --- Revisión de RichiMa en #59 -------------------------------------------------------
import asyncio  # noqa: E402
import httpx  # noqa: E402
import time  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.routers import clasificar as router_clasificar  # noqa: E402
from app.services.claude_common import ResultadoClaude  # noqa: E402


def test_clasificar_foto_no_bloquea_otras_peticiones(monkeypatch):
    """[P1] Una clasificación lenta no debe frenar el event loop del worker.

    Criterio: /health tiene que TERMINAR mientras la clasificación sigue corriendo. Si el
    endpoint bloqueara el loop, /health recién podría avanzar cuando la clasificación acaba.
    """
    import threading

    empezo = threading.Event()
    tiempos = {}

    def lenta(data):
        tiempos["inicio"] = time.perf_counter()
        empezo.set()
        time.sleep(0.5)  # Pillow + Postgres + Claude: todo bloqueante
        tiempos["fin"] = time.perf_counter()
        return ResultadoClaude(ClasificacionRejilla(**OK), "test", "v", "k")

    monkeypatch.setattr(router_clasificar, "clasificar_rejilla", lenta)

    async def escenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            foto = asyncio.create_task(c.post("/clasificar/rejilla", files={"foto": ("x.jpg", _foto(), "image/jpeg")}))
            await asyncio.to_thread(empezo.wait, 5)  # esperar en un hilo: no depende del loop
            r = await c.get("/health")
            tiempos["health"] = time.perf_counter()
            await foto
            return r.status_code

    assert asyncio.run(escenario()) == 200
    assert tiempos["health"] < tiempos["fin"], "/health tuvo que esperar a que terminara la clasificación"


def test_imagen_ilegible_responde_422(monkeypatch, sin_db):
    """[P2] Bytes que no son imagen: 422 claro, no 500, y sin llamar a Claude."""
    monkeypatch.setattr(claude_common, "get_client", lambda: pytest.fail("no debe llamar a Claude"))
    c = TestClient(app)
    for ruta in ("/clasificar/rejilla", "/clasificar/camara"):
        r = c.post(ruta, files={"foto": ("x.jpg", b"esto no es una imagen", "image/jpeg")})
        assert r.status_code == 422 and "imagen" in r.json()["detail"]


def _sin_clave(monkeypatch):
    claude_common.get_client.cache_clear()
    monkeypatch.setattr(claude_common, "get_settings", lambda: SimpleNamespace(
        anthropic_api_key="", claude_model="claude-test", claude_effort="low"))


def test_texto_sin_clave_mantiene_heuristica_de_urgencia(monkeypatch, sin_db):
    """[P2] Sin ANTHROPIC_API_KEY el texto no da 500: responde con la heurística local."""
    _sin_clave(monkeypatch)
    r = TestClient(app).post("/clasificar/texto", json={"texto": "auxilio, hay un adulto mayor atrapado"})
    claude_common.get_client.cache_clear()
    assert r.status_code == 200
    j = r.json()
    assert j["urgente"] is True and len(j["numeros_emergencia"]) == 3
    assert j["claude_disponible"] is False and j["fallo"] is True


def test_foto_sin_clave_queda_no_evaluable(monkeypatch, sin_db):
    _sin_clave(monkeypatch)
    r = TestClient(app).post("/clasificar/rejilla", files={"foto": ("x.jpg", _foto(), "image/jpeg")})
    claude_common.get_client.cache_clear()
    assert r.status_code == 200
    assert r.json()["clasificacion"]["rejilla"] == "no_evaluable" and r.json()["claude_disponible"] is False


def test_cache_invalida_vuelve_a_llamar_con_la_foto(monkeypatch, sin_db):
    """[P2] Entrada de caché que no valida: se regenera CON la imagen (antes iba content=[])."""
    from app.services import cache as cache_mod
    from app.services.claude_vision import PROMPT_VERSION_REJILLA

    foto = _foto()
    sin_db[cache_mod.cache_key(foto, PROMPT_VERSION_REJILLA)] = {"respuesta": {"rejilla": "rara"}, "modelo": "x"}
    vistos = []

    class Cliente(FakeClient):
        def _create(self, **kwargs):
            vistos.append(kwargs["messages"][0]["content"])
            return super()._create(**kwargs)

    fake = Cliente([json.dumps(OK)])
    monkeypatch.setattr(claude_common, "get_client", lambda: fake)
    r = clasificar_rejilla(foto)
    assert not r.fallo and not r.desde_cache and r.resultado.rejilla == "tapada"
    assert len(vistos) == 1 and vistos[0][0]["type"] == "image"

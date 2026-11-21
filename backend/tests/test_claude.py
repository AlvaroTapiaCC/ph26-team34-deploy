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

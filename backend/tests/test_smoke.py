from fastapi.testclient import TestClient

from app.config import get_formula_config
from app.main import app
from app.schemas.claude import ClasificacionRejilla

client = TestClient(app)


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_stub_routes_mounted():
    assert client.get("/crews").status_code == 501


def test_formula_weights_sum_to_one():
    pesos = get_formula_config()["p_pred"]
    assert abs(sum(pesos.values()) - 1.0) < 1e-9


def test_no_evaluable_is_valid():
    c = ClasificacionRejilla.no_evaluable()
    assert c.rejilla == "no_evaluable" and not c.evaluable

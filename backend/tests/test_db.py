"""Pool único bajo concurrencia y /health/db con la base caída (revisión del PR #56)."""
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app

client = TestClient(app)


@pytest.fixture
def pool_limpio(monkeypatch):
    """Aísla el pool global: cierra el real y lo restaura vacío al terminar."""
    db.close_pool()
    yield monkeypatch
    db.close_pool()


def _url(monkeypatch, url):
    monkeypatch.setattr(db, "get_settings", lambda: SimpleNamespace(database_url=url))


def test_health_no_toca_la_base(pool_limpio):
    _url(pool_limpio, "")
    assert client.get("/health").status_code == 200
    assert db._pool is None


def test_health_db_503_sin_database_url(pool_limpio):
    _url(pool_limpio, "")
    t = time.perf_counter()
    r = client.get("/health/db")
    assert r.status_code == 503 and "DATABASE_URL" in r.json()["detail"]
    assert time.perf_counter() - t < 1


def test_health_db_503_rapido_si_la_base_no_responde(pool_limpio):
    _url(pool_limpio, "postgresql://u:p@127.0.0.1:1/nada")  # puerto cerrado
    t = time.perf_counter()
    r = client.get("/health/db")
    assert r.status_code == 503
    assert time.perf_counter() - t < 8


def test_endpoints_con_base_responden_503(pool_limpio):
    _url(pool_limpio, "")
    assert client.get("/scenarios").status_code in (501, 503)  # stub o 503, nunca 500


class PoolLento:
    creados = []

    def __init__(self, *a, **k):
        time.sleep(0.2)  # ventana para que otro hilo entre en paralelo
        self.cerrado = False
        PoolLento.creados.append(self)

    def close(self):
        self.cerrado = True


def test_un_solo_pool_con_requests_simultaneos(pool_limpio):
    _url(pool_limpio, "postgresql://x")
    pool_limpio.setattr(db, "ConnectionPool", PoolLento)
    PoolLento.creados = []
    resultados = []
    hilos = [threading.Thread(target=lambda: resultados.append(db.get_pool())) for _ in range(8)]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join()
    assert len(PoolLento.creados) == 1
    assert all(r is resultados[0] for r in resultados)
    db.close_pool()
    assert PoolLento.creados[0].cerrado and db._pool is None

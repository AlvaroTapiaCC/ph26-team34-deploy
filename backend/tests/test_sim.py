from fastapi.testclient import TestClient

from app.main import app
from app.services import sim
from app.services.sim import Simulador, cargar_timeline


class Reloj:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def _sim():
    reloj = Reloj()
    return Simulador(cargar_timeline(), reloj), reloj


def test_timeline_valido_y_ordenado():
    tl = cargar_timeline()
    ts = [e["t"] for e in tl["eventos"]]
    assert ts == sorted(ts) and tl["eventos"]
    assert {e["tipo"] for e in tl["eventos"]} >= {"reporte", "movimiento_cuadrilla"}


def test_eventos_vencen_con_el_reloj():
    s, reloj = _sim()
    s.start()
    assert s.status()["eventos_aplicados"] == 1  # t=0
    reloj.t = 15
    assert [e["t"] for e in s.status()["eventos"]] == [0, 6, 14]


def test_stop_congela_y_start_reanuda():
    s, reloj = _sim()
    s.start()
    reloj.t = 10
    s.stop()
    reloj.t = 500
    st = s.status()
    assert st["estado"] == "pausada" and st["t"] == 10 and st["eventos_aplicados"] == 2
    s.start()
    reloj.t = 505
    assert s.status()["t"] == 15


def test_repetible_de_principio_a_fin():
    s, reloj = _sim()
    corridas = []
    for _ in range(2):
        s.reset()
        reloj.t = 100.0
        s.start()
        reloj.t = 1000.0
        st = s.status()
        assert st["estado"] == "terminada"
        corridas.append([(e["t"], e["tipo"], e["payload"]) for e in st["eventos"]])
    assert corridas[0] == corridas[1] and len(corridas[0]) == len(s._timeline["eventos"])


def test_disparar_no_altera_el_timeline():
    s, reloj = _sim()
    s.start()
    s.disparar({"sumidero_id": "p2"})
    reloj.t = 1000
    st = s.status()
    assert sum(1 for e in st["eventos"] if e.get("en_vivo")) == 1
    s.reset()
    assert s.status()["eventos_aplicados"] == 0


def test_endpoints(monkeypatch):
    reloj = Reloj()
    monkeypatch.setattr(sim, "_instancia", Simulador(cargar_timeline(), reloj))
    c = TestClient(app)
    assert c.post("/sim/start").json()["estado"] == "corriendo"
    reloj.t = 7
    assert c.get("/sim/status").json()["eventos_aplicados"] == 2
    assert c.post("/sim/trigger", json={"sumidero_id": "p5"}).json()["en_vivo"] is True
    assert c.post("/sim/stop").json()["estado"] == "pausada"
    assert c.post("/sim/reset").json()["eventos_aplicados"] == 0


def test_sink_que_falla_no_duplica_eventos():
    llamadas = []

    def sink(e):
        llamadas.append(e["t"])
        if e["t"] == 6 and llamadas.count(6) == 1:
            raise RuntimeError("falla")

    reloj = Reloj()
    s = Simulador(cargar_timeline(), reloj, sink)
    s.start()
    reloj.t = 15
    s.status()
    st = s.status()
    assert [e["t"] for e in st["eventos"]] == [0, 6, 14]
    assert llamadas == [0, 6, 14]
    assert "error" in st["eventos"][1]


def test_tope_de_reportes_en_vivo(monkeypatch):
    monkeypatch.setattr(sim, "_instancia", Simulador(cargar_timeline(), Reloj()))
    monkeypatch.setattr(sim, "MAX_EN_VIVO", 2)
    c = TestClient(app)
    assert c.post("/sim/trigger").status_code == 200
    assert c.post("/sim/trigger").status_code == 200
    assert c.post("/sim/trigger").status_code == 429


def test_validacion_del_reporte_en_vivo(monkeypatch):
    monkeypatch.setattr(sim, "_instancia", Simulador(cargar_timeline(), Reloj()))
    c = TestClient(app)
    assert c.post("/sim/trigger", json={"fuente": "otro"}).status_code == 422
    assert c.post("/sim/trigger", json={"tipo_obs": "video"}).status_code == 422
    assert c.post("/sim/trigger", json={"texto": "x" * 501}).status_code == 422


def test_controles_exigen_token(monkeypatch):
    from app.config import Settings

    monkeypatch.setattr(sim, "_instancia", Simulador(cargar_timeline(), Reloj()))
    monkeypatch.setattr("app.routers.sim.get_settings", lambda: Settings(admin_token="secreto"))
    c = TestClient(app)
    for ruta in ("start", "stop", "reset", "trigger"):
        assert c.post(f"/sim/{ruta}").status_code == 401
    assert c.post("/sim/reset", headers={"X-Admin-Token": "secreto"}).status_code == 200
    assert c.get("/sim/status").status_code == 200

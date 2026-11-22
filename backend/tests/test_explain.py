from contextlib import nullcontext
import json
from unittest.mock import Mock

from fastapi.testclient import TestClient

from app.main import app
from app.routers import scenarios
from app.services import explain


def fila(rank=1, explicacion=None):
    return {
        "rank": rank, "sumidero_id": f"s{rank}", "prioridad": 0.42, "p_ef": 0.5, "c": 0.84,
        "detalle": {"aportes": {"arboles": 0.22}, "area_norm": 0.61},
        "explicacion": explicacion,
    }


def test_ranking_da_respaldo_solo_al_top_y_conserva_el_orden(monkeypatch):
    primera = fila()
    segunda = fila(2, "Explicación guardada.")
    ultima = fila(explain.TOP + 1)
    conn = Mock()
    conn.execute.return_value.fetchone.return_value = {"existe": 1}
    conn.execute.return_value.fetchall.return_value = [primera, segunda, ultima]
    completar = Mock()
    monkeypatch.setattr(scenarios, "get_conn", lambda: nullcontext(conn))
    monkeypatch.setattr(explain, "completar", completar)

    response = TestClient(app).get("/scenarios/base/ranking")
    assert response.status_code == 200
    items = response.json()["items"]
    assert [x["sumidero_id"] for x in items] == [x["sumidero_id"] for x in [primera, segunda, ultima]]
    assert [x["prioridad"] for x in items] == [0.42, 0.42, 0.42]
    assert "0,220" in items[0]["explicacion"]
    assert items[1]["explicacion"] == segunda["explicacion"]
    assert items[2]["explicacion"] is None
    completar.assert_called_once_with("base", "antes", [primera])


def test_fallo_conserva_respaldo_y_texto_valido_se_guarda(monkeypatch):
    conn = Mock()
    row = fila()
    generar = Mock(side_effect=[None, "La cobertura de árboles aporta al puntaje."])
    monkeypatch.setattr(explain, "_explicar", generar)
    monkeypatch.setattr(explain, "get_settings", lambda: Mock(anthropic_api_key="clave-de-prueba"))
    monkeypatch.setattr(explain, "get_conn", lambda: nullcontext(conn))

    explain.completar("base", "antes", [row])
    conn.execute.assert_not_called()
    explain.completar("base", "antes", [row])
    sql, params = conn.execute.call_args.args
    assert params[:5] == ("La cobertura de árboles aporta al puntaje.", "base", "antes", "s1", explain.TOP)
    assert "explicacion is null" in sql and "detalle = %s" in sql
    assert json.loads(generar.call_args.args[0])["aportes_prediccion"] == {"cobertura de árboles": 0.22}

import json
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app import seguridad
from app.main import app
from app.routers import events
from app.services import report


DESDE = datetime(2026, 10, 13, 9, tzinfo=UTC)
HASTA = DESDE + timedelta(hours=2)


def _fila(segundos, tipo="observacion", **datos):
    ts = DESDE + timedelta(seconds=segundos)
    return {
        "id": segundos, "tipo": tipo, "ts": ts, "obs_id": f"obs-{segundos}",
        "observacion_existe": True, "caso_id": "caso-a", "comuna": "Providencia",
        "sumidero_id": "AL01", "fuente": "vecino", "capturada": ts, "rejilla": None,
        "estado": None, "verificado": False, "motivo": None, "simulado": False, **datos,
    }


def test_evento_deduplica_casos_y_mide_reincidencias_y_tiempos():
    filas = [
        _fila(20, rejilla="tapada"),
        _fila(21, "replan", obs_id="obs-20", motivo="observacion"),
        _fila(23, "replan", obs_id="obs-20", motivo="observacion"),
        _fila(50, "mision_estado", estado="en_camino"),
        _fila(60, "mision_estado", estado="en_sitio"),
        _fila(65, "mision_estado", estado="en_sitio"),
        _fila(70, rejilla="tapada"),
        _fila(80, "mision_cerrada"),
        _fila(90, rejilla="tapada"),
        _fila(100, "mision_cerrada", verificado=True),
        _fila(110, rejilla="tapada", caso_id="caso-b"),
        _fila(120, rejilla="limpia", caso_id="caso-c", simulado=True),
        _fila(130, "mision_estado", caso_id="caso-b", estado="en_sitio", simulado=True),
    ]
    datos = report.calcular(filas, None, DESDE, HASTA, False)
    assert datos["casos"] == 2
    assert datos["observaciones_registradas"] == 4
    assert datos["reincidencias"] == [{"sumidero_id": "AL01", "episodios_tapada": 2}]
    assert datos["llegada_en_sitio"] == {"medidos": 1, "sin_medicion": 1, "mediana_s": 40}
    assert datos["casos_por_sector"] == [{
        "sector": "Providencia", "casos": 2, "llegada_en_sitio": datos["llegada_en_sitio"],
    }]
    assert datos["replan_propuesto"] == {"medidos": 1, "sin_medicion": 3, "mediana_s": 1}
    assert datos["eventos_marcados_simulados"] == 2
    assert datos["ranking_antes"] == {"estado": "sin_ranking_anterior"}
    con_simulados = report.calcular(filas, None, DESDE, HASTA, True)
    assert con_simulados["casos"] == 3
    assert con_simulados["llegada_en_sitio"]["mediana_s"] == 30


def test_ranking_compara_solo_primera_evidencia_valida_y_previa_a_cierre():
    filas = [
        _fila(1, sumidero_id="alto-1", rejilla="tapada"),
        _fila(2, sumidero_id="alto-2", rejilla="limpia"),
        _fila(3, sumidero_id="medio-1", rejilla="parcial"),
        _fila(4, sumidero_id="medio-1", rejilla="tapada"),
        _fila(5, sumidero_id="medio-2", rejilla="tapada"),
        _fila(6, sumidero_id="medio-3", rejilla="limpia"),
        _fila(7, "mision_cerrada", sumidero_id="medio-4", verificado=True),
        _fila(8, sumidero_id="medio-4", rejilla="limpia"),
        _fila(9, sumidero_id="medio-5", rejilla="tapada", capturada=DESDE - timedelta(days=1)),
    ]
    ranking = {
        "ids": ["alto-1", "alto-2", *(f"medio-{n}" for n in range(1, 6))],
        "fuente": "scores_base_antes", "calculado_utc": DESDE - timedelta(hours=1), "incluye_simulados": False,
    }
    datos = report.calcular(filas, ranking, DESDE, HASTA, False)["ranking_antes"]
    assert datos["estado"] == "evaluado"
    assert datos["comparables"] == 4
    assert datos["aciertos_tapadas"] == datos["aciertos_limpias"] == 1
    assert datos["falsas_alertas"] == datos["tapadas_fuera_del_top"] == 1
    assert report.calcular([], ranking, DESDE, HASTA, False)["ranking_antes"]["estado"] == "sin_fotos_comparables"


def test_ranking_guardado_debe_preceder_la_ventana():
    recalculado = {"sumidero_id": "AL-FUTURO", "rank": 1, "computed_at": HASTA, "sin_simulados": True}
    conn = SimpleNamespace(execute=lambda sql: SimpleNamespace(fetchall=lambda: [recalculado]))
    assert report._ranking(conn, DESDE, False) is None
    conn = SimpleNamespace(execute=lambda sql: SimpleNamespace(fetchall=list))
    despues_del_congelamiento = datetime(2026, 11, 22, tzinfo=UTC)
    congelado = report._ranking(conn, despues_del_congelamiento, False)
    assert congelado["fuente"] == "prediccion_congelada_mut"
    assert congelado["calculado_utc"] < despues_del_congelamiento
    assert len(congelado["ids"]) == 46


def test_solo_agregados_van_a_claude_y_si_falla_hay_resumen(monkeypatch):
    datos = report.calcular([_fila(1)], None, DESDE, HASTA, False)
    datos["reincidencias"] = [{"sumidero_id": "ID-PRIVADO-TEST", "episodios_tapada": 2}]
    monkeypatch.setattr(report, "get_settings", lambda: SimpleNamespace(anthropic_api_key="configurada"))
    enviado = []

    def claude(**kwargs):
        enviado.append(kwargs["content"][0]["text"])
        return SimpleNamespace(fallo=True)

    monkeypatch.setattr(report, "llamar_estructurado", claude)
    narrativa = report.redactar(datos)
    texto, = enviado
    assert "ID-PRIVADO-TEST" not in texto
    assert "obs-1" not in texto and "caso-a" not in texto
    assert json.loads(texto)["rejillas_con_reincidencia"] == 1
    assert narrativa["fuente"] == "drena"
    assert narrativa["resumen"] == "La ventana consultada registra 1 caso."
    assert narrativa["recomendaciones"]


def test_api_exige_token_privado_valida_intervalo_y_no_cachea(monkeypatch):
    monkeypatch.setattr(seguridad, "get_settings", lambda: SimpleNamespace(admin_token="token-de-prueba"))
    conexion = object()

    @contextmanager
    def get_conn():
        yield conexion

    def medir(conn, desde, hasta, incluir_simulados):
        assert conn is conexion
        assert desde == DESDE and hasta == HASTA
        assert incluir_simulados is False
        return report.calcular([], None, desde, hasta, incluir_simulados)

    monkeypatch.setattr(events, "get_conn", get_conn)
    monkeypatch.setattr(report, "medir", medir)
    cliente = TestClient(app)
    url = "/events/report"
    assert cliente.get(url).status_code == 401
    assert cliente.get(url, headers={"X-Admin-Token": "inválido".encode("latin-1")}).status_code == 401
    token = {"X-Admin-Token": "token-de-prueba"}
    assert cliente.get(url, headers=token, params={"desde": "2026-10-13T09:00:00"}).status_code == 422
    assert cliente.get(url, headers=token, params={"desde": HASTA.isoformat(), "hasta": DESDE.isoformat()}).status_code == 422
    resp = cliente.get(url, headers=token, params={
        "desde": "2026-10-13T06:00:00-03:00", "hasta": HASTA.isoformat(),
    })
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    assert resp.json()["metricas"]["casos"] == 0


def test_llegada_de_mision_por_rejilla_cuenta_una_vez_en_su_sector():
    """Revisión de #133: reporte → despacho por `sumidero_id` → llegada. La auditoría de la llegada
    trae el caso de la misión, y la llegada cuenta una vez en el sector del caso."""
    filas = [
        _fila(10, caso_id="caso-p", comuna="Providencia", sumidero_id="AL01"),
        _fila(20, caso_id="caso-lc", comuna="Las Condes", sumidero_id="AL02"),
        _fila(30, "replan", obs_id="obs-20", motivo="observacion", caso_id=None),
        _fila(80, "mision_estado", estado="en_camino", caso_id="caso-lc", comuna=None),
        _fila(140, "mision_estado", estado="en_sitio", caso_id="caso-lc", comuna=None),
        _fila(150, "mision_estado", estado="en_sitio", caso_id="caso-lc", comuna=None),
    ]
    datos = report.calcular(filas, None, DESDE, HASTA, False)
    assert datos["casos_por_sector"] == [
        {"sector": "Las Condes", "casos": 1, "llegada_en_sitio": {"medidos": 1, "sin_medicion": 0, "mediana_s": 120}},
        {"sector": "Providencia", "casos": 1, "llegada_en_sitio": {"medidos": 0, "sin_medicion": 1, "mediana_s": None}},
    ]
    assert datos["llegada_en_sitio"] == {"medidos": 1, "sin_medicion": 1, "mediana_s": 120}

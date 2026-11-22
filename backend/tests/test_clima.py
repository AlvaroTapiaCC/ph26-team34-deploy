from datetime import datetime, timedelta, timezone

import pytest

from app.services import clima

AHORA = datetime(2026, 11, 21, 15, 30, tzinfo=timezone.utc)  # 12:30 en Santiago
T0 = datetime(2026, 11, 19, 16, tzinfo=timezone.utc)          # 48 h antes de la hora actual


def respuesta(lluvia_fn=lambda t: 0.0, racha=10.0):
    horas = [T0 + timedelta(hours=k) for k in range(48 + 50)]
    return {"latitude": -33.42, "longitude": -70.6,
            "hourly": {"time": [t.strftime("%Y-%m-%dT%H:%M") for t in horas],
                       "precipitation": [lluvia_fn(t) for t in horas],
                       "wind_gusts_10m": [racha] * len(horas)}}


@pytest.fixture(autouse=True)
def cache_vacia():
    clima._reiniciar_cache()
    yield
    clima._reiniciar_cache()


def test_seco():
    r = clima.clima_actual(AHORA, pedir=lambda *_: respuesta())
    assert r["modo"] == "seco"
    assert r["plazo"] is None
    assert r["vigente"] is True
    assert r["clima"] == 0.0
    assert r["hora_dato_utc"] == "2026-11-21T15:00:00Z"
    assert r["lluvia_pronosticada_48h_mm"] == 0.0


def test_tormenta_inminente_con_plazo():
    # Lluvia pronosticada desde mañana 12:00 UTC (09:00 en Santiago, UTC-3 en noviembre), dentro de 24 h
    inicio = datetime(2026, 11, 22, 12, tzinfo=timezone.utc)
    r = clima.clima_actual(AHORA, pedir=lambda *_: respuesta(lambda t: 2.0 if inicio <= t < inicio + timedelta(hours=4) else 0.0))
    assert r["modo"] == "tormenta_inminente"
    assert r["inicio_lluvia_pronosticado_utc"] == "2026-11-22T12:00:00Z"
    assert r["plazo"] == "antes de mañana a las 09:00"
    assert r["lluvia_pronosticada_48h_mm"] == 8.0


def test_durante():
    r = clima.clima_actual(AHORA, pedir=lambda *_: respuesta(lambda t: 1.0 if AHORA - timedelta(hours=3) < t <= AHORA else 0.0))
    assert r["modo"] == "durante"
    assert r["plazo"] == "lloviendo ahora"


def test_lluvia_futura_no_cuenta_como_observada():
    # Lluvia fuerte en 30 h: no está en el pronóstico de 24 h ni en lo observado
    r = clima.clima_actual(AHORA, pedir=lambda *_: respuesta(lambda t: 9.0 if t > AHORA + timedelta(hours=30) else 0.0))
    assert r["modo"] == "seco"
    assert r["lluvia_acum_24h_mm"] == 0.0


def test_cache_de_una_hora():
    llamadas = []

    def pedir(*_):
        llamadas.append(1)
        return respuesta()

    clima.clima_actual(AHORA, pedir=pedir)
    clima.clima_actual(AHORA + timedelta(minutes=59), pedir=pedir)
    assert len(llamadas) == 1
    clima.clima_actual(AHORA + timedelta(minutes=61), pedir=pedir)
    assert len(llamadas) == 2


def test_falla_devuelve_ultimo_valor_con_su_hora():
    clima.clima_actual(AHORA, pedir=lambda *_: respuesta())

    def falla(*_):
        raise TimeoutError("sin red")

    r = clima.clima_actual(AHORA + timedelta(hours=2), pedir=falla)
    assert r["vigente"] is False
    assert r["modo"] == "seco"
    assert r["consultado_utc"] == "2026-11-21T15:30:00Z"


def test_falla_sin_valor_previo_es_sin_dato_no_cero():
    def falla(*_):
        raise RuntimeError("Open-Meteo: caído")

    r = clima.clima_actual(AHORA, pedir=falla)
    assert r["modo"] == "sin_dato"
    assert r["vigente"] is False
    assert r["clima"] is None and r["lluvia_acum_24h_mm"] is None


def test_hueco_en_los_datos_es_sin_dato():
    d = respuesta()
    d["hourly"]["precipitation"][40] = None
    r = clima.clima_actual(AHORA, pedir=lambda *_: d)
    assert r["modo"] == "sin_dato"
    assert r["clima"] is None


def test_plazo_otro_dia():
    assert clima.plazo_texto(datetime(2026, 11, 23, 12, tzinfo=timezone.utc), AHORA) == "antes del lunes 23 a las 09:00"
    assert clima.plazo_texto(datetime(2026, 11, 21, 21, tzinfo=timezone.utc), AHORA) == "antes de hoy a las 18:00"


def test_endpoint(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setattr(clima, "_pedir_open_meteo", lambda *_: (_ for _ in ()).throw(OSError("sin red")))
    r = TestClient(app).get("/clima")
    assert r.status_code == 200
    assert r.json()["modo"] == "sin_dato"

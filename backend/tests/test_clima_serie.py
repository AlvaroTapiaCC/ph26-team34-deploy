from datetime import datetime, timedelta, timezone

from app.services.clima_serie import cargar_config, clima_normalizado, evaluar_serie

CFG = cargar_config()
T0 = datetime(2026, 10, 13, tzinfo=timezone.utc)


def serie(lluvia, racha=None, pron=None):
    n = len(lluvia)
    racha = racha or [10.0] * n
    pron = pron or [0.0] * n
    return [{"hora_utc": T0 + timedelta(hours=i), "lluvia_mm": lluvia[i], "racha_kmh": racha[i],
             "lluvia_pronosticada_mm": pron[i]} for i in range(n)]


def test_clima_normalizado_extremos():
    assert clima_normalizado(0, 10, CFG) == 0.0
    assert clima_normalizado(30, 60, CFG) == 1.0
    assert clima_normalizado(100, 200, CFG) == 1.0
    assert clima_normalizado(15, 40, CFG) == 0.5   # 0,6·0,5 + 0,4·0,5


def test_clima_sin_dato_no_es_cero():
    assert clima_normalizado(None, 30, CFG) is None
    assert clima_normalizado(5, None, CFG) is None


def test_modos_en_orden():
    # 30 h secas, 3 h de lluvia fuerte, 30 h secas; el pronóstico anuncia la lluvia
    lluvia = [0.0] * 30 + [3.0] * 3 + [0.0] * 30
    pron = [0.0] * 30 + [3.0] * 3 + [0.0] * 30
    r = evaluar_serie(serie(lluvia, pron=pron), CFG)
    assert r[0]["modo"] == "sin_dato"          # sin 24 h de historia
    assert r[24]["modo"] == "tormenta_inminente"
    assert r[24]["inicio_lluvia_pronosticado_utc"] == T0 + timedelta(hours=30)
    assert r[30]["modo"] == "durante"
    assert r[40]["modo"] == "despues"          # 9 mm en las últimas 24 h
    assert r[60]["modo"] == "sin_dato"         # sin 24 h de pronóstico hacia adelante
    assert r[33]["clima"] == 0.18              # 9 mm / 30 → 0,3 · 0,6


def test_seco_y_hueco_de_dato():
    lluvia = [0.0] * 60
    r = evaluar_serie(serie(lluvia), CFG)
    assert r[30]["modo"] == "seco"
    lluvia[28] = None
    r = evaluar_serie(serie(lluvia), CFG)
    assert r[30]["modo"] == "sin_dato"
    assert r[30]["clima"] is None


def test_no_mira_el_futuro_observado():
    # Cambiar la lluvia observada futura no cambia la hora actual
    a = [0.0] * 60
    b = [0.0] * 50 + [9.0] * 10
    assert evaluar_serie(serie(a), CFG)[30] == evaluar_serie(serie(b), CFG)[30]

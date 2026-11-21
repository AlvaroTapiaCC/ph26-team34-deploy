import math

import pytest

from app.config import get_formula_config
from app.services.formula import (
    StreetChain,
    SumideroInput,
    calcular_ranking,
    consecuencia,
    efecto_cadena,
    normalizar_areas,
    p_final,
    p_pred,
)

CFG = get_formula_config()


# --- Paso 1 -----------------------------------------------------------------
def test_p_pred_todo_cero_y_todo_uno():
    assert p_pred({}, CFG)[0] == 0
    todo = {f: 1 for f in ["arboles", "feria", "obras", "suelo", "pendiente", "clima", "dias_sin_limpieza", "camara"]}
    assert p_pred(todo, CFG)[0] == pytest.approx(1.0)


def test_p_pred_clampa_features_fuera_de_rango():
    assert p_pred({"arboles": 5}, CFG)[0] == pytest.approx(CFG["p_pred"]["w_arb"])


def test_lo_confirmado_manda():
    s = SumideroInput("a", {"arboles": 1, "feria": 1}, rejilla_observada="limpia", reportes_texto=3)
    p, pp, po, det = p_final(s, CFG)
    assert p == 0 and po == 0 and pp > 0 and det["fuente_p"] == "foto"
    assert p_final(SumideroInput("b", {}, rejilla_observada="tapada"), CFG)[0] == 1
    assert p_final(SumideroInput("c", {}, rejilla_observada="parcial"), CFG)[0] == pytest.approx(0.6)


def test_no_evaluable_no_cuenta_como_confirmado():
    p, _, po, _ = p_final(SumideroInput("a", {"arboles": 1}, rejilla_observada="no_evaluable"), CFG)
    assert po is None and p == pytest.approx(CFG["p_pred"]["w_arb"])


def test_reportes_de_texto_suben_p_con_tope():
    rt = CFG["reportes_texto"]
    uno = p_final(SumideroInput("a", {}, reportes_texto=1), CFG)[0]
    assert uno == pytest.approx(rt["factor"] * rt["aporte_por_reporte"])
    # un texto pesa menos que una foto de rejilla tapada
    assert uno < CFG["observado"]["tapada"]
    muchos = p_final(SumideroInput("a", {}, reportes_texto=100), CFG)[0]
    assert muchos == pytest.approx(rt["max_aporte"])


# --- Paso 2 -----------------------------------------------------------------
def test_cadena_suma_aguas_arriba_con_decaimiento():
    cfg = CFG["cadena"]
    p = {"arriba": 1.0, "abajo": 0.0}
    ch = [StreetChain("s", ["arriba", "abajo"], [0, 100])]
    p_ef, _ = efecto_cadena(p, ch, CFG)
    esperado = min(cfg["alpha"] * math.exp(-100 / cfg["lambda_m"]), cfg["tope"])
    assert p_ef["abajo"] == pytest.approx(esperado)
    assert p_ef["arriba"] == 1.0  # nadie más arriba


def test_cadena_respeta_tope():
    ids = [f"s{i}" for i in range(30)]
    p = {i: 1.0 if i != "s29" else 0.0 for i in ids}
    p_ef, _ = efecto_cadena(p, [StreetChain("s", ids, [i * 5 for i in range(30)])], CFG)
    assert p_ef["s29"] == pytest.approx(CFG["cadena"]["tope"])


def test_cadena_no_sube_un_confirmado():
    p = {"arriba": 1.0, "abajo": 0.0}
    p_ef, _ = efecto_cadena(p, [StreetChain("s", ["arriba", "abajo"], [0, 10])], CFG, {"abajo"})
    assert p_ef["abajo"] == 0.0


def test_cadena_nunca_pasa_de_1():
    p = {"a": 1.0, "b": 0.95}
    p_ef, _ = efecto_cadena(p, [StreetChain("s", ["a", "b"], [0, 1])], CFG)
    assert p_ef["b"] <= 1.0


# --- Paso 3 -----------------------------------------------------------------
def test_normalizar_areas():
    n = normalizar_areas({"a": 0, "b": 100, "c": 10_000})
    assert n["c"] == 1 and n["a"] == 0 and 0 < n["b"] < 1
    assert normalizar_areas({"a": 0}) == {"a": 0.0}
    assert normalizar_areas({"a": 50, "b": 100}, "lineal")["a"] == 0.5


PISO = CFG["consecuencia"]["piso_area"]


def _area_ef(n):
    return PISO + (1 - PISO) * n


def test_consecuencia_criticidad_y_agua():
    assert consecuencia(0.5, 0, CFG) == pytest.approx(_area_ef(0.5))
    assert consecuencia(0.5, 1, CFG) == pytest.approx(_area_ef(0.5) * (1 + CFG["consecuencia"]["w_crit"]))
    # el agua solo cuenta en modo durante
    assert consecuencia(0.5, 0, CFG, "sobre_vereda", "antes") == pytest.approx(_area_ef(0.5))
    assert consecuencia(0.5, 0, CFG, "sobre_vereda", "durante") == pytest.approx(_area_ef(0.5) * 2)
    assert consecuencia(0.5, 0, CFG, "cuneta", "durante") == pytest.approx(_area_ef(0.5) * 1.3)


def test_consecuencia_sin_area_no_es_cero():
    assert consecuencia(0, 0, CFG) == pytest.approx(PISO) and PISO > 0
    assert consecuencia(1, 0, CFG) == pytest.approx(1.0)


def test_tapada_confirmada_sin_area_no_queda_al_fondo():
    """Bloqueante 1 del PR #58: antes quedaba con prioridad 0 y rank 2."""
    s = [
        SumideroInput("tapada_sin_area", {"criticidad": 1}, rejilla_observada="tapada"),
        SumideroInput("normal", {"arboles": 0.1, "area_aporte": 50}),
    ]
    r = calcular_ranking(s, [], CFG)
    assert r[0].sumidero_id == "tapada_sin_area" and r[0].prioridad > 0
    assert r[0].detalle["area_faltante"] is True
    assert "area_faltante" not in r[1].detalle


# --- Paso 4 -----------------------------------------------------------------
def _red():
    return [
        SumideroInput("alto", {"arboles": 1, "area_aporte": 1000}),
        SumideroInput("medio", {"arboles": 0.2, "area_aporte": 5000}),
        SumideroInput("bajo", {"area_aporte": 20000, "criticidad": 1}),
        SumideroInput("suelto", {"feria": 1, "area_aporte": 100}),
    ], [StreetChain("calle", ["alto", "medio", "bajo"], [0, 80, 160])]


def test_ranking_determinista_y_ordenado():
    s, ch = _red()
    r1 = calcular_ranking(s, ch, CFG)
    r2 = calcular_ranking(list(reversed(s)), ch, CFG)
    assert [x.sumidero_id for x in r1] == [x.sumidero_id for x in r2]
    assert [x.rank for x in r1] == [1, 2, 3, 4]
    assert all(a.prioridad >= b.prioridad for a, b in zip(r1, r1[1:]))
    for x in r1:
        assert x.prioridad == pytest.approx(x.p_ef * x.c)


def test_foto_tapada_sube_en_el_ranking():
    s, ch = _red()
    antes = {x.sumidero_id: x.rank for x in calcular_ranking(s, ch, CFG)}
    s[3] = SumideroInput("suelto", {"feria": 1, "area_aporte": 100}, rejilla_observada="tapada")
    despues = {x.sumidero_id: x.rank for x in calcular_ranking(s, ch, CFG)}
    assert antes["suelto"] > 1 and despues["suelto"] == 1


def test_durante_urgentes_primero_y_agua():
    s, ch = _red()
    s[3] = SumideroInput("suelto", {"area_aporte": 1}, urgente=True)
    r = calcular_ranking(s, ch, CFG, "durante")
    assert r[0].sumidero_id == "suelto" and r[0].urgente
    # en modo antes el urgente no se adelanta
    assert calcular_ranking(s, ch, CFG, "antes")[0].sumidero_id != "suelto"


def test_modo_invalido():
    with pytest.raises(ValueError):
        calcular_ranking([], [], CFG, "otro")


# --- Datos mal formados (revisión del PR #58) ---------------------------------------
def test_cadena_con_largos_distintos_se_ignora_sin_romper():
    p = {"a": 1.0, "b": 0.0}
    p_ef, aporte = efecto_cadena(p, [StreetChain("mala", ["a", "b"], [0])], CFG)
    assert p_ef == p and aporte == {}


def test_cadena_con_distancias_desordenadas_se_ignora():
    p = {"a": 1.0, "b": 0.0, "c": 0.0}
    p_ef, _ = efecto_cadena(p, [StreetChain("mala", ["a", "b", "c"], [0, 200, 100])], CFG)
    assert p_ef == p


def test_cadena_mala_no_afecta_a_las_buenas():
    p = {"a": 1.0, "b": 0.0, "x": 1.0, "y": 0.0}
    chains = [StreetChain("mala", ["x", "y"], [0]), StreetChain("buena", ["a", "b"], [0, 10])]
    p_ef, _ = efecto_cadena(p, chains, CFG)
    assert p_ef["b"] > 0 and p_ef["y"] == 0


def test_ranking_no_se_cae_con_cadena_mala():
    s = [SumideroInput("a", {"arboles": 1, "area_aporte": 10}), SumideroInput("b", {"area_aporte": 10})]
    r = calcular_ranking(s, [StreetChain("mala", ["a", "b"], [0, 1, 2])], CFG)
    assert [x.rank for x in r] == [1, 2]


@pytest.mark.parametrize("valor", [float("nan"), float("inf"), "abc", None])
def test_features_invalidas_cuentan_como_cero(valor):
    assert p_pred({"arboles": valor}, CFG)[0] == 0


def test_clamp_nan():
    from app.services.formula import clamp
    assert clamp(float("nan")) == 0.0

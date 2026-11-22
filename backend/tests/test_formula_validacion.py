"""formula_validacion.yaml debe ser formula.yaml sin las variables simuladas (§8.1)."""
import pytest

from app.config import get_formula_config

COMPLETA = get_formula_config()
VALIDACION = get_formula_config("formula_validacion")
SIMULADAS = {"w_dias", "w_cam"}


def test_simuladas_en_cero():
    for w in SIMULADAS:
        assert VALIDACION["p_pred"][w] == 0


def test_pesos_suman_uno():
    assert sum(VALIDACION["p_pred"].values()) == pytest.approx(1.0, abs=1e-9)


def test_pesos_reescalados_en_proporcion():
    reales = {k: v for k, v in COMPLETA["p_pred"].items() if k not in SIMULADAS}
    total = sum(reales.values())
    for k, v in reales.items():
        assert VALIDACION["p_pred"][k] == pytest.approx(v / total, abs=1e-5)


def test_mismos_pesos_que_la_completa():
    assert set(VALIDACION["p_pred"]) == set(COMPLETA["p_pred"])


def test_resto_identico():
    # Solo cambian p_pred y la lista de features simuladas; todo lo demás debe ser igual.
    # `confianza` (#88) pondera observaciones, que la predicción congelada no tiene: su config
    # queda sin cambios para conservar el hash registrado en prediccion_congelada.meta.json.
    ignorar = {"p_pred", "features_simuladas", "confianza"}
    assert {k: v for k, v in VALIDACION.items() if k not in ignorar} == {
        k: v for k, v in COMPLETA.items() if k not in ignorar
    }


def test_nombre_desconocido():
    with pytest.raises(ValueError):
        get_formula_config("otra")

"""scoring.py contra el Supabase real (revisión del PR #58, puntos 2 a 6).

Se corre con `DRENA_TEST_INTEGRACION=1`. Crea un escenario y sumideros `test-sc-*` y los borra.
"""
import json
import os
import uuid

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1",
                                reason="DRENA_TEST_INTEGRACION=1 para correrlo")

SC = "test-sc"


@pytest.fixture
def red():
    from app.db import get_conn

    tag = uuid.uuid4().hex[:6]
    ids = {k: f"test-sc-{k}-{tag}" for k in ("real", "foto", "sim", "aneg", "urg")}

    def obs(conn, sid, tipo, clasificaciones, simulada=False, horas=0):
        o = conn.execute(
            "insert into observations (sumidero_id, fuente, tipo, ts, is_simulated)"
            " values (%s, 'vecino', %s, now() - make_interval(hours => %s), %s) returning id",
            (sid, tipo, horas, simulada)).fetchone()["id"]
        for i, res in enumerate(clasificaciones):  # en orden: la última es la vigente
            conn.execute(
                "insert into classifications (observation_id, resultado, modelo, prompt_version, created_at)"
                " values (%s, %s, 'test', 'v0', now() + make_interval(secs => %s))",
                (o, json.dumps(res), i))
        return o

    with get_conn() as conn:
        conn.execute("insert into scenarios (id, nombre) values (%s, 'test') on conflict do nothing", (SC,))
        for k, sid in ids.items():
            feats = {"arboles": 0.5, "area_aporte": 1000}
            if k == "real":
                feats["dias_sin_limpieza"] = 1.0  # feature simulada colada en features
            conn.execute("insert into sumideros (id, geom, fuente, features, is_simulated)"
                         " values (%s, st_point(-70.6,-33.45,4326), 'manual', %s, %s)",
                         (sid, json.dumps(feats), k == "sim"))
        conn.execute("insert into cleaning_history (sumidero_id, fecha, is_simulated)"
                     " values (%s, current_date - 80, true)", (ids["real"],))
        # Foto reclasificada: primero limpia, después tapada → manda tapada
        obs(conn, ids["foto"], "foto_rejilla", [{"evaluable": True, "rejilla": "limpia"},
                                                {"evaluable": True, "rejilla": "tapada"}])
        # Texto reclasificado 3 veces: cuenta como UN reporte
        obs(conn, ids["real"], "texto", [{"tipo": "rejilla_tapada"}] * 3)
        # Anegamiento: no sube P
        obs(conn, ids["aneg"], "texto", [{"tipo": "anegamiento", "nivel_agua": "hasta_vereda"}])
        # Caso urgente sostenido solo por una observación simulada
        o = obs(conn, ids["urg"], "texto", [{"tipo": "anegamiento"}], simulada=True)
        c = conn.execute("insert into cases (geom, sumidero_id, urgente) values"
                         " (st_point(-70.6,-33.45,4326), %s, true) returning id", (ids["urg"],)).fetchone()["id"]
        conn.execute("insert into case_observations values (%s, %s)", (c, o))
    yield ids
    with get_conn() as conn:
        conn.execute("delete from cases where sumidero_id like 'test-sc-%%'")
        conn.execute("delete from observations where sumidero_id like 'test-sc-%%'")
        conn.execute("delete from sumideros where id like 'test-sc-%%'")
        conn.execute("delete from scenarios where id = %s", (SC,))


def _por_id(scores):
    return {s.sumidero_id: s for s in scores}


def test_ultima_clasificacion_y_textos_sin_duplicar(red):
    from app.config import get_formula_config
    from app.db import get_conn
    from app.services.scoring import calcular

    rt = get_formula_config()["reportes_texto"]
    with get_conn() as conn:
        s = _por_id(calcular(conn, SC, "antes"))
    assert s[red["foto"]].p_obs == 1.0                                  # la última dice tapada
    assert s[red["real"]].detalle["aporte_reportes_texto"] == pytest.approx(
        rt["factor"] * rt["aporte_por_reporte"])                         # 3 clasificaciones = 1 reporte
    assert "aporte_reportes_texto" not in s[red["aneg"]].detalle        # anegamiento no sube P


def test_sin_simulados_no_cuela_datos_simulados(red):
    from app.db import get_conn
    from app.services.scoring import calcular

    with get_conn() as conn:
        con = _por_id(calcular(conn, SC, "durante", incluir_simulados=True))
        sin = _por_id(calcular(conn, SC, "durante", incluir_simulados=False))
    assert red["sim"] in con and red["sim"] not in sin                  # sumidero simulado fuera
    assert con[red["real"]].detalle["aportes"]["dias_sin_limpieza"] > 0
    assert sin[red["real"]].detalle["aportes"]["dias_sin_limpieza"] == 0  # ni features ni historial
    assert con[red["urg"]].urgente and not sin[red["urg"]].urgente      # caso solo simulado no adelanta
    assert sin[red["real"]].detalle["incluye_simulados"] is False


def test_recompute_sin_simulados_no_pisa_la_tabla_de_la_demo(red):
    from app.db import get_conn
    from app.main import app

    c = TestClient(app)
    assert c.post("/formula/recompute", params={"scenario_id": SC, "modo": "antes"}).json()["guardado"]
    with get_conn() as conn:
        antes = conn.execute("select sumidero_id, prioridad, rank from scores where scenario_id = %s"
                             " and modo = 'antes' order by sumidero_id", (SC,)).fetchall()
    r = c.post("/formula/recompute", params={"scenario_id": SC, "modo": "antes", "incluir_simulados": False})
    assert r.status_code == 200 and r.json()["guardado"] is False
    assert red["sim"] not in {i["sumidero_id"] for i in r.json()["items"]}
    with get_conn() as conn:
        despues = conn.execute("select sumidero_id, prioridad, rank from scores where scenario_id = %s"
                               " and modo = 'antes' order by sumidero_id", (SC,)).fetchall()
    assert despues == antes and len(antes) == 5


def test_explicacion_se_borra_solo_si_cambia_el_ranking(red):
    from app.db import get_conn
    from app.services.scoring import recalcular

    with get_conn() as conn:
        recalcular(conn, SC, "antes")
        conn.execute("update scores set explicacion = 'vieja' where scenario_id = %s", (SC,))
        recalcular(conn, SC, "antes")  # sin cambios en los datos
        sin_cambio = conn.execute("select count(*) n from scores where scenario_id = %s"
                                  " and explicacion = 'vieja'", (SC,)).fetchone()["n"]
        # Cambia un dato: el sumidero "aneg" pasa a tener muchos árboles y sube
        conn.execute("update sumideros set features = features || '{\"arboles\": 1, \"area_aporte\": 50000}'"
                     " where id = %s", (red["aneg"],))
        recalcular(conn, SC, "antes")
        filas = {r["sumidero_id"]: r["explicacion"] for r in conn.execute(
            "select sumidero_id, explicacion from scores where scenario_id = %s and modo = 'antes'", (SC,))}
    assert sin_cambio == 5
    assert filas[red["aneg"]] is None                                   # cambió: se borró

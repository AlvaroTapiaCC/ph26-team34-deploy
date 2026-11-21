"""Reinicio de la demo (issue #97).

Los de integración corren contra el Supabase compartido DENTRO de una transacción que se deshace
al final (rollback): no dejan nada escrito ni borran datos de otros.
"""
import json
import os
import uuid

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from app.db import DatabaseUnavailable
from app.main import app
from app.routers import sim as router_sim
from app.services import reinicio, routing

client = TestClient(app)
INTEGRACION = pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1",
                                 reason="DRENA_TEST_INTEGRACION=1 para correrlo")
REJILLA_DEMO = "AL13SU010174"  # junto al paradero PC1329


# --- R4 ------------------------------------------------------------------------------------
def test_base_caida_es_503_y_no_500(monkeypatch):
    from contextlib import contextmanager

    @contextmanager
    def caida():
        raise DatabaseUnavailable("La base no respondió a tiempo")
        yield  # pragma: no cover

    monkeypatch.setattr(router_sim, "get_conn", caida)
    monkeypatch.setattr("app.routers.sim.get_settings", lambda: __import__("app.config").config.Settings())
    assert client.post("/sim/reset").status_code == 503


def test_desde_sin_zona_horaria_es_422(monkeypatch):
    monkeypatch.setattr("app.routers.sim.get_settings", lambda: __import__("app.config").config.Settings())
    assert client.post("/sim/reset", params={"desde": "2026-11-22T08:00:00"}).status_code == 422


# --- Integración ---------------------------------------------------------------------------
@pytest.fixture
def conn(monkeypatch):
    from app.config import get_settings

    def osrm_caido():
        raise httpx.ConnectError("OSRM caído en el test")

    routing._cache.clear()
    monkeypatch.setattr(routing, "_get_client", osrm_caido)  # línea recta: determinista y sin red
    c = psycopg.connect(get_settings().database_url, row_factory=dict_row, prepare_threshold=None)
    c.execute("set statement_timeout = '60s'")
    if not c.execute("select 1 from crews where id = 'sim-c4' and is_simulated").fetchone():
        c.close()
        pytest.skip("Faltan las cuadrillas simuladas de 08_simulados")
    try:
        yield c
    finally:
        c.rollback()
        c.close()


def _foto(conn, sid, rejilla):
    """Lo que deja POST /observations: observación, clasificación y evento, con la hora real."""
    o = conn.execute("insert into observations (sumidero_id, fuente, tipo, ts) values"
                     " (%s, 'vecino', 'foto_rejilla', clock_timestamp()) returning id", (sid,)).fetchone()["id"]
    conn.execute("insert into classifications (observation_id, resultado, modelo, prompt_version)"
                 " values (%s, %s, 'test', 'v0')",
                 (o, json.dumps({"evaluable": True, "rejilla": rejilla, "material": ["hojas"],
                                 "nivel_agua": "sin_agua", "confianza": "alta"})))
    conn.execute("insert into events (tipo, ts, payload) values ('observacion', clock_timestamp(), %s)",
                 (json.dumps({"observation_id": str(o), "sumidero_id": sid}),))
    return o


def _pasada(conn):
    """Foto tapada en la rejilla de la demo → nueva siguiente parada → cierre de esa misión."""
    from app.services import dispatch
    from app.services.scoring import recalcular_todo

    o = _foto(conn, REJILLA_DEMO, "tapada")
    recalcular_todo(conn)
    plan = dispatch.planificar(conn, "observacion", str(o))
    r = dispatch.para_observacion(plan, REJILLA_DEMO, None)
    m = r["siguiente_despues"]["mission_id"]
    conn.execute("update missions set estado = 'cerrada', cerrada_at = clock_timestamp() where id = %s", (m,))
    conn.execute("insert into closures (mission_id, verificado) values (%s, true)", (m,))
    # Lo que deja un cierre verificado de #42: la limpieza de hoy (simulada, por ser sim-c*)
    conn.execute("insert into cleaning_history (sumidero_id, fecha, is_simulated)"
                 " values (%s, (now() at time zone 'America/Santiago')::date, true)", (REJILLA_DEMO,))
    return {"crew": r["crew_id"], "antes": r["siguiente_antes"]["sumidero_id"],
            "despues": r["siguiente_despues"]["sumidero_id"]}


def _ranking_base(conn):
    return [r["sumidero_id"] for r in conn.execute(
        "select sumidero_id from scores where scenario_id = 'base' and modo = 'antes'"
        " order by prioridad desc nulls last, sumidero_id limit 50")]


@INTEGRACION
def test_dos_pasadas_con_reinicio_dan_lo_mismo_y_no_cambian_la_base(conn):
    """Criterios de aceptación de #97."""
    conteo = "select (select count(*) from sumideros) s, (select count(*) from claude_cache) cc," \
             " (select count(*) from cleaning_history) ch, (select count(*) from street_chains) sc"
    r0 = reinicio.reiniciar(conn)                    # estado inicial y marca
    base0, conteo0 = _ranking_base(conn), conn.execute(conteo).fetchone()
    plan0 = r0["plan"]

    p1 = _pasada(conn)
    assert p1["despues"] == REJILLA_DEMO and p1["antes"] != REJILLA_DEMO

    r1 = reinicio.reiniciar(conn)
    assert r1["borrado"]["observaciones"] == 1 and r1["borrado"]["eventos"] >= 1
    assert r1["borrado"]["limpiezas"] == 1
    assert r1["plan"] == plan0                       # vuelve al mismo plan inicial
    assert _ranking_base(conn) == base0
    assert conn.execute(conteo).fetchone() == conteo0  # catastro, caché de Claude, historial y cadenas

    p2 = _pasada(conn)
    assert p2 == p1                                  # la segunda pasada muestra el mismo cambio


@INTEGRACION
def test_no_toca_lo_anterior_al_corte_ni_cuadrillas_reales(conn):
    """R5: el corte acota lo que se borra; las misiones de cuadrillas reales no se tocan."""
    tag = uuid.uuid4().hex[:8]
    real = f"test-real-{tag}"
    vieja = _foto(conn, REJILLA_DEMO, "parcial")
    conn.execute("update observations set ts = clock_timestamp() - interval '2 hours' where id = %s", (vieja,))
    conn.execute("update events set ts = clock_timestamp() - interval '2 hours'"
                 " where payload->>'observation_id' = %s", (str(vieja),))
    conn.execute("insert into crews (id, nombre, geom_actual, is_simulated) values"
                 " (%s, 'Real', st_setsrid(st_point(-70.6, -33.42), 4326), false)", (real,))
    m_real = conn.execute("insert into missions (crew_id, sumidero_id) values (%s, %s) returning id",
                          (real, REJILLA_DEMO)).fetchone()["id"]
    corte = conn.execute("select clock_timestamp() - interval '1 hour' as c").fetchone()["c"]
    nueva = _foto(conn, REJILLA_DEMO, "tapada")

    r = reinicio.reiniciar(conn, desde=corte, params_despacho={"cuadrillas": ["sim-c4"]})
    quedan = {x["id"] for x in conn.execute("select id from observations where id = any(%s)", ([vieja, nueva],))}
    assert quedan == {vieja}
    assert conn.execute("select estado from missions where id = %s", (m_real,)).fetchone()["estado"] == "pendiente"
    assert r["corte"] == corte


@INTEGRACION
def test_primer_reinicio_sin_marca_no_borra_observaciones(conn):
    """R3/R5: sin marca ni `desde` no se inventa un corte."""
    conn.execute("delete from events where tipo = %s", (reinicio.MARCA,))  # se deshace al final
    o = _foto(conn, REJILLA_DEMO, "tapada")
    r = reinicio.reiniciar(conn)
    assert r["corte"] is None and r["aviso"]
    assert conn.execute("select 1 from observations where id = %s", (o,)).fetchone()

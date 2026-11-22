"""Despacho y re-planificación (issue #32)."""
import os
import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import cuadrillas, dispatch, report, routing
from app.services.dispatch import Cuadrilla, Parada

client = TestClient(app)
INTEGRACION = pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1",
                                 reason="DRENA_TEST_INTEGRACION=1 para correrlo")
INTERV = 600.0


# --- Reglas puras ---------------------------------------------------------------------
def _tiempo(pos: dict[str, float]):
    """Tiempos en una recta: |x_a − x_b| segundos."""
    return lambda a, b: abs(pos[a] - pos[b])


def _p(clave, prioridad=0.5, **kw):
    return Parada(clave, -33.42, -70.60, clave, prioridad, **kw)


def test_sedimento_va_a_la_cuadrilla_con_hidrojet_aunque_este_mas_lejos():
    cerca = Cuadrilla("cerca", -33.42, -70.60, hidrojet=False, is_simulated=True)
    lejos = Cuadrilla("lejos", -33.42, -70.60, hidrojet=True, is_simulated=True)
    t = _tiempo({"crew:cerca": 0, "crew:lejos": 900, "s:A": 10, "s:B": 20})
    dispatch.asignar([_p("s:A", hidrojet=True), _p("s:B")], [cerca, lejos], t, INTERV)
    assert [p.clave for p in lejos.paradas] == ["s:A"]
    assert [p.clave for p in cerca.paradas] == ["s:B"]


def test_sin_cuadrilla_con_hidrojet_igual_se_asigna():
    c = Cuadrilla("c", -33.42, -70.60, hidrojet=False, is_simulated=True)
    dispatch.asignar([_p("s:A", hidrojet=True)], [c], _tiempo({"crew:c": 0, "s:A": 5}), INTERV)
    assert [p.clave for p in c.paradas] == ["s:A"]


def test_la_carga_reparte_entre_cuadrillas_cercanas():
    a = Cuadrilla("a", -33.42, -70.60, hidrojet=False, is_simulated=True)
    b = Cuadrilla("b", -33.42, -70.60, hidrojet=False, is_simulated=True)
    t = _tiempo({"crew:a": 0, "crew:b": 100, "s:1": 0, "s:2": 0, "s:3": 0})
    dispatch.asignar([_p("s:1"), _p("s:2"), _p("s:3")], [a, b], t, INTERV)
    assert len(a.paradas) == 2 and len(b.paradas) == 1


def test_cuadrilla_sin_posicion_ni_mision_iniciada_no_recibe_misiones():
    sin_pos = Cuadrilla("sin", None, None, hidrojet=True, is_simulated=True)
    con_pos = Cuadrilla("con", -33.42, -70.60, hidrojet=False, is_simulated=True)
    dispatch.asignar([_p("s:A")], [sin_pos, con_pos], _tiempo({"crew:con": 0, "s:A": 5}), INTERV)
    assert sin_pos.paradas == [] and len(con_pos.paradas) == 1


def test_la_mision_iniciada_va_primero_aunque_tenga_menos_prioridad():
    c = Cuadrilla("c", -33.42, -70.60, hidrojet=False, is_simulated=True)
    c.paradas = [_p("s:alta", 0.9), _p("s:iniciada", 0.1, estado="en_camino"), _p("s:sitio", 0.05, estado="en_sitio")]
    t = _tiempo({"crew:c": 0, "s:alta": 1, "s:iniciada": 500, "s:sitio": 800})
    assert [p.clave for p in dispatch.ordenar(c, t, INTERV)] == ["s:sitio", "s:iniciada", "s:alta"]


def test_urgente_antes_que_el_resto():
    c = Cuadrilla("c", -33.42, -70.60, hidrojet=False, is_simulated=True)
    c.paradas = [_p("s:alta", 0.9), _p("c:urgente", 0.1, urgente=True)]
    t = _tiempo({"crew:c": 0, "s:alta": 1, "c:urgente": 900})
    assert [p.clave for p in dispatch.ordenar(c, t, INTERV)] == ["c:urgente", "s:alta"]


def test_prioridad_y_cercania():
    """La foto 'tapada' sube la prioridad de una rejilla cercana: pasa a ser la siguiente."""
    c = Cuadrilla("c", -33.42, -70.60, hidrojet=False, is_simulated=True)
    t = _tiempo({"crew:c": 0, "s:media": 60, "s:foto": 120, "s:lejos": 2000})
    c.paradas = [_p("s:media", 0.40), _p("s:foto", 0.30), _p("s:lejos", 0.50)]
    assert dispatch.ordenar(c, t, INTERV)[0].clave == "s:media"
    c.paradas[1].prioridad = 0.80  # llegó la foto
    orden = [p.clave for p in dispatch.ordenar(c, t, INTERV)]
    assert orden[0] == "s:foto" and orden[-1] == "s:lejos"


def test_para_observacion_ubica_la_cuadrilla_de_la_rejilla():
    plan = {"cuadrillas": {
        "a": {"cambio": True, "siguiente_antes": None, "siguiente_despues": {"sumidero_id": "X"},
              "ruta_version": 3, "paradas": [{"sumidero_id": "X", "case_id": None}]},
        "b": {"cambio": True, "siguiente_antes": None, "siguiente_despues": {"sumidero_id": "Y"},
              "ruta_version": 7, "paradas": [{"sumidero_id": "Y", "case_id": None}]},
    }}
    r = dispatch.para_observacion(plan, "Y", None)
    assert r["crew_id"] == "b" and r["en_plan"] and r["ruta_version"] == 7
    r = dispatch.para_observacion(plan, "Z", None)
    assert r["en_plan"] is False and r["crew_id"] == "a"


def test_replanificar_seguro_no_lanza(monkeypatch):
    def cae(*a, **k):
        raise RuntimeError("base caída")

    monkeypatch.setattr(dispatch, "planificar", cae)

    class Conn:
        def __enter__(self):
            return None

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(dispatch, "get_conn", Conn)
    r = dispatch.replanificar_seguro("observacion", "obs-1", "X")
    assert r["despachado"] is False and r["error"] == "RuntimeError"


def test_plan_exige_token_de_admin(monkeypatch):
    monkeypatch.setattr("app.routers.dispatch.get_settings", lambda: SimpleNamespace(admin_token="secreto"))
    assert client.post("/dispatch/plan").status_code == 401
    assert client.post("/dispatch/plan", headers={"X-Admin-Token": "mal"}).status_code == 401


def test_vincular_el_caso_explicito_sincroniza_la_parada_del_plan(monkeypatch):
    fila = {"id": "m-1", "crew_id": "c1", "case_id": "caso-1", "sumidero_id": "AL01", "estado": "en_camino"}
    llamadas = []
    conn = SimpleNamespace(execute=lambda sql, prm: llamadas.append(prm) or SimpleNamespace(fetchall=lambda: [fila]))
    sincronizadas = []
    monkeypatch.setattr(cuadrillas, "_sincronizar", lambda c, m: sincronizadas.append(m))
    parada = _p("s:AL01", sumidero_id="AL01", mission_id="m-1")
    previa = _p("s:AL02", sumidero_id="AL02", mission_id="m-2", case_id="caso-2")
    dispatch._vincular_caso_del_reporte(conn, "obs-1", "caso-1", [parada, previa])
    assert llamadas == [{"observation_id": "obs-1", "caso_id": "caso-1", "misiones": ["m-1"]}]
    assert parada.case_id == "caso-1" and previa.case_id == "caso-2"
    assert sincronizadas == [fila]


# --- Integración contra Supabase --------------------------------------------------------
@pytest.fixture
def escena(monkeypatch):
    """Dos cuadrillas simuladas y cuatro rejillas con puntaje en el escenario `base`, con IDs y
    etiqueta únicos por ejecución: el plan se acota a ellas y no toca otros datos."""
    from app.db import get_conn

    def osrm_caido():
        raise httpx.ConnectError("OSRM caído en el test")

    routing._cache.clear()
    monkeypatch.setattr(routing, "_get_client", osrm_caido)  # plan B en línea recta, sin red
    run = uuid.uuid4().hex[:10]
    e = SimpleNamespace(run=run, zona=f"test-zona-{run}", c1=f"test-c1-{run}", c2=f"test-c2-{run}",
                        s=[f"test-s{i}-{run}" for i in range(4)])
    e.params = {"zona": e.zona, "cuadrillas": [e.c1, e.c2], "candidatas": 2}
    # Rejillas sobre Av. Apoquindo, ~100 m entre sí; c1 en el extremo oriente, c2 a 2 km
    coords = [(-70.6000, -33.4170), (-70.6011, -33.4172), (-70.6022, -33.4174), (-70.6033, -33.4176)]
    prioridades = [0.60, 0.50, 0.20, 0.10]
    with get_conn() as conn:
        conn.execute("insert into crews (id, nombre, equipamiento, geom_actual, is_simulated) values"
                     " (%s, 'C1', '{basica,hidrojet}', st_setsrid(st_point(-70.5995, -33.4170), 4326), true),"
                     " (%s, 'C2', '{basica}', st_setsrid(st_point(-70.6200, -33.4300), 4326), true)",
                     (e.c1, e.c2))
        for sid, (lon, lat), pr in zip(e.s, coords, prioridades, strict=True):
            conn.execute("insert into sumideros (id, geom, fuente, calle, etiquetas) values"
                         " (%s, st_setsrid(st_point(%s, %s), 4326), 'manual', %s, %s)",
                         (sid, lon, lat, f"Calle {sid}", [e.zona]))
            conn.execute("insert into scores (sumidero_id, scenario_id, modo, prioridad) values (%s, 'base', 'durante', %s)",
                         (sid, pr))
    yield e
    with get_conn() as conn:
        conn.execute("delete from events where payload->>'crew_id' = any(%s)", ([e.c1, e.c2],))
        conn.execute("delete from events where tipo = 'observacion' and payload->>'observation_id' in"
                     " (select id::text from observations where sumidero_id = any(%s))", (e.s,))
        conn.execute("delete from missions where crew_id = any(%s) or sumidero_id = any(%s)", ([e.c1, e.c2], e.s))
        conn.execute("delete from cases where sumidero_id = any(%s)", (e.s,))
        conn.execute("delete from observations where sumidero_id = any(%s)", (e.s,))
        conn.execute("delete from crews where id = any(%s)", ([e.c1, e.c2],))
        conn.execute("delete from sumideros where id = any(%s)", (e.s,))


def _plan(e, motivo="test", observation_id=None, caso_id=None):
    from app.db import get_conn

    with get_conn() as conn:
        return dispatch.planificar(conn, motivo, observation_id, params=e.params, caso_id=caso_id)


def _contar(e):
    from app.db import get_conn

    with get_conn() as conn:
        m = conn.execute("select count(*) as n from missions where crew_id = any(%s)", ([e.c1, e.c2],)).fetchone()["n"]
        r = conn.execute("select count(*) as n from routes where crew_id = any(%s)", ([e.c1, e.c2],)).fetchone()["n"]
    return m, r


@INTEGRACION
def test_foto_tapada_fuera_del_plan_cambia_la_siguiente_parada(escena):
    from app.db import get_conn

    p1 = _plan(escena)
    c1 = p1["cuadrillas"][escena.c1]
    assert c1["siguiente_despues"]["sumidero_id"] in escena.s[:2]  # las dos de mayor prioridad
    # La rejilla 3 (prioridad 0,1, fuera del plan) recibe una foto "tapada": su prioridad sube
    with get_conn() as conn:
        conn.execute("update scores set prioridad = 0.95 where sumidero_id = %s and scenario_id = 'base'"
                     " and modo = 'durante'", (escena.s[3],))
    p2 = _plan(escena, "observacion")
    r = dispatch.para_observacion(p2, escena.s[3], None)
    assert r["en_plan"] and r["siguiente_despues"]["sumidero_id"] == escena.s[3]
    assert r["siguiente_antes"] != r["siguiente_despues"] and r["ruta_version"] is not None
    with get_conn() as conn:
        ev = conn.execute("select payload from events where tipo = 'replan' and payload->>'crew_id' = %s"
                          " order by id desc limit 1", (r["crew_id"],)).fetchone()["payload"]
    assert ev["siguiente_despues"]["sumidero_id"] == escena.s[3] and ev["motivo"] == "observacion"
    ruta = client.get(f"/crews/{r['crew_id']}/route").json()
    assert ruta["origen"] == "despacho" and ruta["version"] == r["ruta_version"]
    assert ruta["paradas"][0]["sumidero_id"] == escena.s[3]


@INTEGRACION
def test_la_mision_iniciada_no_se_mueve(escena):
    from app.db import get_conn

    p1 = _plan(escena)
    primera = p1["cuadrillas"][escena.c1]["siguiente_despues"]
    with get_conn() as conn:
        conn.execute("update missions set estado = 'en_camino' where id = %s", (primera["mission_id"],))
        # Otra rejilla pasa a ser mucho más prioritaria
        conn.execute("update scores set prioridad = 0.99 where sumidero_id = %s and scenario_id = 'base'"
                     " and modo = 'durante'", (escena.s[3],))
    p2 = _plan(escena, "observacion")
    c1 = p2["cuadrillas"][escena.c1]
    assert c1["siguiente_despues"]["mission_id"] == primera["mission_id"]
    with get_conn() as conn:
        m = conn.execute("select crew_id, estado, orden from missions where id = %s", (primera["mission_id"],)).fetchone()
    assert m["crew_id"] == escena.c1 and m["estado"] == "en_camino" and m["orden"] == 1


@INTEGRACION
def test_planificar_dos_veces_sin_datos_nuevos_no_crea_nada(escena):
    _plan(escena)
    antes = _contar(escena)
    p2 = _plan(escena)
    assert _contar(escena) == antes
    assert p2["creadas"] == 0 and p2["canceladas"] == 0
    assert not any(r["cambio"] for r in p2["cuadrillas"].values())


@INTEGRACION
def test_rejilla_que_sale_del_plan_cancela_su_mision_pendiente(escena):
    from app.db import get_conn

    _plan(escena)
    with get_conn() as conn:
        conn.execute("update scores set prioridad = 0.01 where sumidero_id = %s and scenario_id = 'base'"
                     " and modo = 'durante'", (escena.s[0],))
    p2 = _plan(escena)
    assert p2["canceladas"] == 1
    with get_conn() as conn:
        n = conn.execute("select count(*) as n from missions where sumidero_id = %s and estado = 'pendiente'",
                         (escena.s[0],)).fetchone()["n"]
    assert n == 0


@INTEGRACION
def test_con_osrm_caido_no_hay_error(escena):
    # La escena ya tiene OSRM caído: el plan sale con tiempos y geometría en línea recta
    p = _plan(escena)
    assert p["despachado"] and any(r["cambio"] for r in p["cuadrillas"].values())


def _reportar(sid):
    """Reporte vecinal con caso abierto en la rejilla, como lo registra POST /observations."""
    from psycopg.types.json import Jsonb

    from app.db import get_conn
    from app.services import observations as svc

    with get_conn() as conn:
        o = conn.execute(
            "insert into observations (sumidero_id, geom, fuente, tipo, texto)"
            " select id, geom, 'vecino', 'texto', 'Rejilla tapada (test)' from sumideros where id = %s"
            " returning id, st_y(geom) as lat, st_x(geom) as lon, ts", (sid,)).fetchone()
        caso = svc.crear_caso(conn, o["lat"], o["lon"], sid, False, o["ts"])
        svc.vincular_caso(conn, caso, str(o["id"]))
        conn.execute("insert into events (tipo, payload) values ('observacion', %s)",
                     (Jsonb({"observation_id": str(o["id"]), "tipo": "texto", "fuente": "vecino", "caso_id": caso}),))
    return str(o["id"]), caso


def _mision(sid):
    from app.db import get_conn

    with get_conn() as conn:
        return conn.execute(
            "select m.id, m.case_id, ca.estado as caso_estado from missions m left join cases ca on ca.id = m.case_id"
            " where m.sumidero_id = %s and m.estado <> 'cancelada'", (sid,)).fetchall()


@INTEGRACION
def test_reporte_despacho_por_rejilla_y_llegada_cuentan_una_vez_en_el_informe(escena, monkeypatch):
    """Revisión de #133: la misión creada por `sumidero_id` lleva el caso y su llegada entra al informe."""
    from app.db import get_conn
    from app.routers.observations import solicitar_despacho

    comuna = f"test-comuna-{escena.run}"
    with get_conn() as conn:
        desde = conn.execute("select now() - interval '1 second' as t").fetchone()["t"]
        conn.execute("update sumideros set comuna = %s where id = %s", (comuna, escena.s[0]))
    obs, caso = _reportar(escena.s[0])
    _, caso_mas_reciente = _reportar(escena.s[0])
    assert caso_mas_reciente != caso
    monkeypatch.setattr(dispatch, "PARAMS", {**dispatch.PARAMS, **escena.params})

    assert solicitar_despacho(obs, caso, escena.s[0])["en_plan"]
    mision, = _mision(escena.s[0])
    assert str(mision["case_id"]) == caso and mision["caso_estado"] == "asignado"

    with get_conn() as conn:
        cuadrillas.cambiar_estado(conn, mision["id"], "en_camino")
        cuadrillas.cambiar_estado(conn, mision["id"], "en_sitio")
    _plan(escena)  # re-planificar no duplica la misión ni cambia su caso
    assert [(m["id"], str(m["case_id"]), m["caso_estado"]) for m in _mision(escena.s[0])] == [
        (mision["id"], caso, "en_curso")]

    with get_conn() as conn:
        hasta = conn.execute("select now() + interval '1 second' as t").fetchone()["t"]
        ev = conn.execute("select payload from events where tipo = 'mision_estado' and payload->>'mission_id' = %s"
                          " and payload->>'estado' = 'en_sitio'", (str(mision["id"]),)).fetchone()["payload"]
    with get_conn() as conn:  # `medir` fija el aislamiento antes de su primera consulta
        datos = report.medir(conn, desde, hasta, True)
    assert ev["caso_id"] == caso
    sector, = [x for x in datos["casos_por_sector"] if x["sector"] == comuna]
    assert sector["casos"] == 2
    assert sector["llegada_en_sitio"]["medidos"] == 1 and sector["llegada_en_sitio"]["sin_medicion"] == 1


@INTEGRACION
def test_mision_existente_recibe_el_caso_que_llega_despues(escena):
    _plan(escena)
    antes, = _mision(escena.s[0])
    assert antes["case_id"] is None
    obs, caso = _reportar(escena.s[0])
    p2 = _plan(escena, "observacion", obs, caso)
    despues, = _mision(escena.s[0])
    assert despues["id"] == antes["id"] and str(despues["case_id"]) == caso and despues["caso_estado"] == "asignado"
    assert p2["creadas"] == 0


@INTEGRACION
def test_llegada_sin_caso_no_se_atribuye_retroactivamente(escena):
    from app.db import get_conn

    comuna = f"test-comuna-{escena.run}"
    with get_conn() as conn:
        desde = conn.execute("select now() - interval '1 second' as t").fetchone()["t"]
        conn.execute("update sumideros set comuna = %s where id = %s", (comuna, escena.s[0]))
    _plan(escena)
    mision, = _mision(escena.s[0])
    obs, caso = _reportar(escena.s[0])
    with get_conn() as conn:
        cuadrillas.cambiar_estado(conn, mision["id"], "en_camino")
        cuadrillas.cambiar_estado(conn, mision["id"], "en_sitio")

    _plan(escena, "observacion", obs, caso)
    actual, = _mision(escena.s[0])
    assert actual["id"] == mision["id"] and actual["case_id"] is None

    # Si una vinculación administrativa posterior cambia la misión, la auditoría conserva la llegada original.
    with get_conn() as conn:
        conn.execute("update missions set case_id = %s where id = %s", (caso, mision["id"]))
        hasta = conn.execute("select now() + interval '1 second' as t").fetchone()["t"]
    with get_conn() as conn:
        datos = report.medir(conn, desde, hasta, True)
    sector, = [x for x in datos["casos_por_sector"] if x["sector"] == comuna]
    assert sector["llegada_en_sitio"] == {"medidos": 0, "sin_medicion": 1, "mediana_s": None}

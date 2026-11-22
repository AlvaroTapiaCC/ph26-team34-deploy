"""Despacho y re-planificación (issue #32)."""
import os
import uuid
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from app.main import app
from app.services import dispatch, routing
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
        conn.execute("delete from events where tipo = 'replan' and payload->>'crew_id' = any(%s)", ([e.c1, e.c2],))
        conn.execute("delete from missions where crew_id = any(%s) or sumidero_id = any(%s)", ([e.c1, e.c2], e.s))
        conn.execute("delete from crews where id = any(%s)", ([e.c1, e.c2],))
        conn.execute("delete from sumideros where id = any(%s)", (e.s,))


def _plan(e, motivo="test"):
    from app.db import get_conn

    with get_conn() as conn:
        return dispatch.planificar(conn, motivo, params=e.params)


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
def test_observaciones_muestran_el_ultimo_despacho_por_cuadrilla_y_reporte(escena, monkeypatch):
    from app.db import get_conn

    captura = datetime.now(UTC)
    primera, segunda, sin_despacho = [uuid.uuid4() for _ in range(3)]

    def registrar(conn, reporte, cuadrilla, segundos, despues):
        payload = {"observation_id": str(reporte), "crew_id": cuadrilla,
                   "siguiente_antes": {"nombre": "Calle Uno", "detalle": "domicilio privado"},
                   "siguiente_despues": {"nombre": despues} if despues else None}
        conn.execute("insert into events (tipo, payload, ts) values ('replan', %s, %s)",
                     (Jsonb(payload), captura + timedelta(seconds=segundos)))

    with get_conn() as conn, conn.transaction(force_rollback=True):
        for i, reporte in enumerate((primera, segunda, sin_despacho)):
            conn.execute("insert into observations (id, fuente, tipo, ts, texto)"
                         " values (%s, 'vecino', 'texto', %s, 'domicilio privado')",
                         (reporte, captura + timedelta(seconds=i)))
        registrar(conn, primera, escena.c2, 8, "Cambio anterior")
        registrar(conn, primera, escena.c1, 12, "Calle Dos")
        registrar(conn, primera, escena.c2, 14, "Calle Tres")
        registrar(conn, segunda, escena.c2, 25, None)
        monkeypatch.setattr("app.routers.observations.get_conn", lambda: nullcontext(conn))
        r = client.get("/observations", params={"desde": captura.isoformat()})

    assert r.status_code == 200
    por_id = {item["id"]: item["despachos"] for item in r.json()["items"]}
    cambios = por_id[str(primera)]
    assert [(c["crew_id"], c["cuadrilla"], c["siguiente_despues"]) for c in cambios] == [
        (escena.c1, "C1", "Calle Dos"), (escena.c2, "C2", "Calle Tres")]
    assert all(c["siguiente_antes"] == "Calle Uno" and c["is_simulated"] for c in cambios)
    assert datetime.fromisoformat(cambios[1]["hora"]) == captura + timedelta(seconds=14)
    assert len(por_id[str(segunda)]) == 1 and por_id[str(segunda)][0]["siguiente_despues"] is None
    assert por_id[str(sin_despacho)] == []
    assert "domicilio privado" not in r.text


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

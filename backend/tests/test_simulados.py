"""pipeline/08_simulados.py (issue #16): datos simulados deterministas que no tocan datos reales."""
import importlib.util
import os
import sys
import uuid
from datetime import date
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("simulados", RAIZ / "pipeline" / "08_simulados.py")
sim = importlib.util.module_from_spec(_spec)
sys.modules["simulados"] = sim  # los dataclass del módulo lo necesitan registrado
_spec.loader.exec_module(sim)


def test_ultima_limpieza_es_determinista_y_acotada():
    ids = [f"AL13SU{i:06d}" for i in range(2000)]
    fechas = [sim.ultima_limpieza(i) for i in ids]
    assert fechas == [sim.ultima_limpieza(i) for i in ids]  # mismo resultado siempre
    con = [f for f in fechas if f is not None]
    dias = [(sim.FECHA_REFERENCIA - f).days for f in con]
    assert min(dias) >= 0 and max(dias) <= sim.DIAS_MAX
    sin = len(fechas) - len(con)
    assert 0.05 < sin / len(fechas) < 0.15  # ~10 % sin registro
    assert len(set(dias)) > 100  # usa todo el rango, no un par de valores


def test_historial_ordenado_y_sin_los_que_no_tienen_registro():
    h = sim.generar_historial(["b", "a", "c"])
    assert [x[0] for x in h] == sorted(x[0] for x in h)
    assert all(isinstance(f, date) for _, f in h)


def test_cuadrillas_en_su_comuna_y_sin_superponerse():
    centros = {"Providencia": (-70.61, -33.43), "Ñuñoa": (-70.6, -33.46), "Las Condes": (-70.55, -33.41)}
    cs = sim.generar_cuadrillas(centros)
    assert [c.id for c in cs] == ["sim-c1", "sim-c2", "sim-c3", "sim-c4"]
    assert len({(c.lon, c.lat) for c in cs}) == 4  # las dos de Providencia no quedan encima
    assert (cs[3].lon, cs[3].lat) == sim.CENTRO_MUT  # la de la prueba de campo parte en la zona MUT
    assert "hidrojet" in cs[0].equipamiento and "hidrojet" not in cs[1].equipamiento
    assert "hidrojet" in cs[3].equipamiento  # la única dentro de la zona MUT puede recibir sedimento


def test_cuadrillas_omiten_comunas_sin_sumideros():
    assert [c.id for c in sim.generar_cuadrillas({"Ñuñoa": (-70.6, -33.46)})] == ["sim-c2"]


@pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1", reason="DRENA_TEST_INTEGRACION=1 para correrlo")
def test_integracion_solo_toca_lo_simulado_de_sus_sumideros():
    from app.db import get_conn

    run = uuid.uuid4().hex[:10]
    a, b, otro = f"test-sim-a-{run}", f"test-sim-b-{run}", f"test-sim-otro-{run}"
    crew = sim.Cuadrilla(f"sim-test-{run}", "test", ("basica",), -70.6, -33.45)
    real = sim.Cuadrilla(f"real-test-{run}", "simulada?", ("hidrojet",), -70.7, -33.5)
    try:
        with get_conn() as conn:
            for sid in (a, b, otro):
                conn.execute("insert into sumideros (id, geom, fuente) values (%s, st_point(-70.6,-33.45,4326), 'manual')",
                             (sid,))
            # Una cuadrilla REAL con el id que el generador intentará usar: no debe tocarse
            conn.execute("insert into crews (id, nombre, equipamiento, is_simulated)"
                         " values (%s, 'Real', '{basica}', false)", (real.id,))
            # Un registro real (no simulado) en `a` y uno simulado en `otro`: ninguno debe tocarse
            conn.execute("insert into cleaning_history (sumidero_id, fecha, is_simulated) values (%s, '2026-01-01', false)",
                         (a,))
            conn.execute("insert into cleaning_history (sumidero_id, fecha, is_simulated) values (%s, '2026-02-02', true)",
                         (otro,))
            # Simulado previo en `a`, que tiene historial real: debe desaparecer
            conn.execute("insert into cleaning_history (sumidero_id, fecha, is_simulated)"
                         " values (%s, '2026-11-20', true)", (a,))
            hist = [(b, date(2026, 10, 1))]  # solo `b` (sin historial real) recibe simulado
            r1 = sim.escribir(conn, [crew, real], hist, [a, b])
            # La cuadrilla simulada sale y actualiza su GPS: una recarga no la devuelve a su posición inicial
            conn.execute("update crews set geom_actual = st_setsrid(st_point(-70.65, -33.40), 4326), estado = 'en_ruta'"
                         " where id = %s", (crew.id,))
            r2 = sim.escribir(conn, [crew, real], hist, [a, b])  # idempotente
            pos = conn.execute("select st_x(geom_actual) as lon, st_y(geom_actual) as lat, estado from crews"
                               " where id = %s", (crew.id,)).fetchone()
            filas = conn.execute("select sumidero_id, fecha, is_simulated from cleaning_history"
                                 " where sumidero_id = any(%s) order by sumidero_id, fecha", ([a, b, otro],)).fetchall()
            c = conn.execute("select is_simulated, equipamiento from crews where id = %s", (crew.id,)).fetchone()
            cr = conn.execute("select is_simulated, nombre, equipamiento from crews where id = %s",
                              (real.id,)).fetchone()
        assert r2["historial_reemplazado"] == 1
        assert (round(pos["lon"], 6), round(pos["lat"], 6), pos["estado"]) == (-70.65, -33.40, "en_ruta")
        # El resumen cuenta solo lo escrito: la real con el mismo id figura como omitida
        assert r1["cuadrillas"] == r2["cuadrillas"] == 1 and r2["cuadrillas_omitidas_por_ser_reales"] == [real.id]
        assert [(f["sumidero_id"], str(f["fecha"]), f["is_simulated"]) for f in filas] == [
            (a, "2026-01-01", False),   # el real sigue y su simulado previo se borró
            (b, "2026-10-01", True),
            (otro, "2026-02-02", True),  # fuera del alcance: intacto
        ]
        assert c["is_simulated"] is True and c["equipamiento"] == ["basica"]
        assert cr["is_simulated"] is False and cr["nombre"] == "Real" and cr["equipamiento"] == ["basica"]
    finally:
        with get_conn() as conn:
            conn.execute("delete from crews where id = any(%s)", ([crew.id, real.id],))
            conn.execute("delete from sumideros where id = any(%s)", ([a, b, otro],))

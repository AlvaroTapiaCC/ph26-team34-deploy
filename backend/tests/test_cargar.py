"""pipeline/07_cargar.py (issue #14): validación de entradas y carga idempotente."""
import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("cargar", RAIZ / "pipeline" / "07_cargar.py")
cargar = importlib.util.module_from_spec(_spec)
sys.modules["cargar"] = cargar  # los dataclass del módulo lo necesitan registrado
_spec.loader.exec_module(cargar)


def _rejilla(sid, lon=-70.6, lat=-33.45, calle_p="AV PROVIDENCIA", calle_i="LOS LEONES", comuna="Providencia"):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"ID_IDE": sid, "CALLE_P": calle_p, "CALLE_I": calle_i, "comuna": comuna}}


def _datos(tmp_path, rejillas, terreno=None, cadenas=None, features=None):
    (tmp_path / "rejillas.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": rejillas}),
                                               encoding="utf-8")
    if terreno is not None:
        (tmp_path / "terreno_x.csv").write_text(terreno, encoding="utf-8")
    if cadenas is not None:
        (tmp_path / "street_chains_x.json").write_text(json.dumps(cadenas), encoding="utf-8")
    if features is not None:
        (tmp_path / "features_x.csv").write_text(features, encoding="utf-8")
    return tmp_path


# --- Rejillas ---------------------------------------------------------------------------
def test_id_duplicado_es_invalido(tmp_path):
    with pytest.raises(cargar.DatosInvalidos, match="duplicado"):
        cargar.preparar(_datos(tmp_path, [_rejilla("A"), _rejilla("A")]))


@pytest.mark.parametrize("geom", [None, {"type": "Point", "coordinates": [float("nan"), 1]},
                                  {"type": "Point", "coordinates": [200, 0]}, {"type": "LineString", "coordinates": []}])
def test_geometria_invalida(tmp_path, geom):
    r = _rejilla("A")
    r["geometry"] = geom
    with pytest.raises(cargar.DatosInvalidos):
        cargar.preparar(_datos(tmp_path, [r]))


def test_esquina_en_ambos_ordenes_es_una_interseccion(tmp_path):
    d = cargar.preparar(_datos(tmp_path, [_rejilla("A", calle_p="X", calle_i="Y"),
                                          _rejilla("B", -70.6003, calle_p="Y", calle_i="X")]))
    assert len(d["intersecciones"]) == 1
    i = next(iter(d["intersecciones"].values()))
    assert len(i.puntos) == 2 and d["sumideros"]["A"].intersection_id == d["sumideros"]["B"].intersection_id


def test_mismo_par_de_calles_lejos_son_esquinas_distintas(tmp_path):
    """Revisión #76: antes se agrupaban por nombre aunque estuvieran a 444 m."""
    d = cargar.preparar(_datos(tmp_path, [_rejilla("A", -70.600, calle_p="X", calle_i="Y"),
                                          _rejilla("B", -70.6003, calle_p="Y", calle_i="X"),   # ~28 m
                                          _rejilla("C", -70.605, calle_p="X", calle_i="Y")]))  # ~460 m
    s = d["sumideros"]
    assert s["A"].intersection_id == s["B"].intersection_id != s["C"].intersection_id
    assert len(d["intersecciones"]) == 2


# --- Terreno y features -----------------------------------------------------------------
TERRENO = """ID_IDE,elevacion_m,pendiente,area_aporte_m2,street_id,orden_en_calle,en_zona_mut
A,620.5,1.7,1500,flujo:A,0.0,True
B,,,,,,False
Z,600,0.5,10,flujo:Z,1,True
"""


def test_terreno_mapea_columnas_y_acota(tmp_path):
    d = cargar.preparar(_datos(tmp_path, [_rejilla("A"), _rejilla("B")], terreno=TERRENO))
    a, b = d["sumideros"]["A"], d["sumideros"]["B"]
    assert a.elevacion == 620.5 and a.features == {"pendiente": 1.0, "area_aporte": 1500.0}
    assert a.street_id == "flujo:A" and a.orden_en_calle == 0 and a.etiquetas == {"zona_mut"}
    assert b.features == {} and b.elevacion is None and not b.etiquetas  # vacíos no inventan datos
    assert any("Z no está en rejillas" in x for x in d["avisos"])


def test_features_solo_las_de_la_formula(tmp_path):
    feats = "ID_IDE,arboles,feria,inventada,area_aporte\nA,0.4,nan,9,2500\nB,3,0.2,1,-5\n"
    d = cargar.preparar(_datos(tmp_path, [_rejilla("A"), _rejilla("B")], features=feats))
    assert d["sumideros"]["A"].features == {"arboles": 0.4, "area_aporte": 2500.0}  # nan se ignora
    assert d["sumideros"]["B"].features == {"arboles": 1.0, "feria": 0.2, "area_aporte": 0.0}  # acotadas
    assert any("inventada" in x for x in d["avisos"])


def test_variables_del_paso_04_tambien_se_cargan(tmp_path):
    """pipeline/04_variables.py (#81) deja `variables_mut.csv`, no `features_*.csv`: mismo contrato."""
    _datos(tmp_path, [_rejilla("A")])
    (tmp_path / "variables_mut.csv").write_text(  # encabezado real de data/variables_mut.csv
        "ID_IDE,arboles,suelo,d_feria_m,feria,obras,criticidad,criticidad_motivo\n"
        "A,0.8889,0.0023,787.8,0.0,0.0,0.6,colegio:50m\n", encoding="utf-8")
    d = cargar.preparar(tmp_path)
    assert d["sumideros"]["A"].features == {"arboles": 0.8889, "suelo": 0.0023, "feria": 0.0, "obras": 0.0,
                                           "criticidad": 0.6}
    assert "variables_mut.csv" in d["resumen"]["features"]


# --- Cadenas ----------------------------------------------------------------------------
def test_cadenas_invalidas_se_ignoran(tmp_path):
    cadenas = [
        {"street_id": "ok", "sumidero_ids": ["A", "B"], "distancias_m": [0, 10]},
        {"street_id": "largo", "sumidero_ids": ["A", "B"], "distancias_m": [0]},
        {"street_id": "desorden", "sumidero_ids": ["A", "B"], "distancias_m": [10, 0]},
        {"street_id": "fantasma", "sumidero_ids": ["A", "NO"], "distancias_m": [0, 5]},
        {"street_id": "texto", "sumidero_ids": ["A", "B"], "distancias_m": ["0", "x"]},
        {"street_id": "repetido", "sumidero_ids": ["A", "A", "B"], "distancias_m": [0, 0, 10]},
    ]
    d = cargar.preparar(_datos(tmp_path, [_rejilla("A"), _rejilla("B")], cadenas=cadenas))
    assert [c["street_id"] for c in d["cadenas"]] == ["ok"]
    assert len(d["avisos"]) == 5


def test_dry_run_no_toca_la_base(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("app.db.get_conn", lambda *a, **k: pytest.fail("dry-run no debe conectarse"))
    assert cargar.main(["--dry-run", "--data", str(_datos(tmp_path, [_rejilla("A")]))]) == 0
    assert "Dry run" in capsys.readouterr().out


def test_datos_invalidos_salen_con_error(tmp_path, capsys):
    assert cargar.main(["--dry-run", "--data", str(_datos(tmp_path, [_rejilla("A"), _rejilla("A")]))]) == 1
    assert "Datos inválidos" in capsys.readouterr().out


# --- Integración: carga real, idempotente, con IDs únicos -------------------------------------
@pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1", reason="DRENA_TEST_INTEGRACION=1 para correrlo")
def test_integracion_carga_idempotente_y_fusiona_features(tmp_path):
    from app.db import get_conn

    run = uuid.uuid4().hex[:10]
    a, b = f"test-carga-a-{run}", f"test-carga-b-{run}"
    calle = f"CALLE TEST {run}"
    datos_dir = _datos(
        tmp_path, [_rejilla(a, calle_p=calle, calle_i="X"), _rejilla(b, -70.6003, calle_p="X", calle_i=calle)],
        terreno=f"ID_IDE,elevacion_m,pendiente,area_aporte_m2,street_id,orden_en_calle,en_zona_mut\n"
                f"{a},630,0.3,800,flujo:{run},0,True\n",
        cadenas=[{"street_id": f"flujo:{run}", "nombre": "test", "sumidero_ids": [a, b], "distancias_m": [0, 40]}],
    )
    iid = None
    try:
        with get_conn() as conn:
            r1 = cargar.escribir(conn, cargar.preparar(datos_dir))
            # Otro paso del pipeline agrega una feature directo en la base
            conn.execute("update sumideros set features = features || '{\"arboles\": 0.7}' where id = %s", (a,))
            r2 = cargar.escribir(conn, cargar.preparar(datos_dir))  # segunda corrida: idempotente
            etiquetas_antes = conn.execute("select etiquetas from sumideros where id = %s", (a,)).fetchone()["etiquetas"]
            # Una corrección posterior con en_zona_mut=False quita la etiqueta (vacío la conservaría)
            (datos_dir / "terreno_x.csv").write_text(
                "ID_IDE,elevacion_m,pendiente,area_aporte_m2,street_id,orden_en_calle,en_zona_mut\n"
                f"{a},630,0.3,800,flujo:{run},0,False\n", encoding="utf-8")
            cargar.escribir(conn, cargar.preparar(datos_dir))
            etiquetas_despues = conn.execute("select etiquetas from sumideros where id = %s", (a,)).fetchone()["etiquetas"]
            filas = {x["id"]: x for x in conn.execute(
                "select id, intersection_id, street_id, orden_en_calle, elevacion, features, comuna, calle, etiquetas"
                " from sumideros where id = any(%s)", ([a, b],))}
            iid = filas[a]["intersection_id"]
            n_inter = conn.execute("select count(*) as n from intersections where id = %s", (iid,)).fetchone()["n"]
            cadena = conn.execute("select sumidero_ids from street_chains where street_id = %s",
                                  (f"flujo:{run}",)).fetchone()
        assert r1["sumideros"] == r2["sumideros"] == 2
        assert filas[a]["features"] == {"pendiente": 0.3, "area_aporte": 800.0, "arboles": 0.7}  # fusionadas
        assert filas[a]["elevacion"] == 630
        assert etiquetas_antes == ["zona_mut"] and etiquetas_despues == []
        assert filas[a]["comuna"] == "Providencia" and filas[a]["calle"].startswith("Calle Test")
        assert filas[a]["intersection_id"] == filas[b]["intersection_id"] and n_inter == 1
        assert cadena["sumidero_ids"] == [a, b]
    finally:
        with get_conn() as conn:
            # Todas las intersecciones de esta ejecución (sus nombres llevan `run`), no solo la de `a`
            conn.execute("delete from street_chains where street_id = %s", (f"flujo:{run}",))
            conn.execute("delete from sumideros where id = any(%s)", ([a, b],))
            conn.execute("delete from intersections where id like %s", (f"%{run}%",))


@pytest.mark.parametrize("entrada,salida", [
    ("AV LAS CONDES", "Av. Las Condes"),
    ("PASAJE DE LA PAZ", "Pasaje de la Paz"),
    ("LOS LEONES", "Los Leones"),
    ("AVDA. IRARRAZAVAL", "Av. Irarrazaval"),
])
def test_titulo_de_calles(entrada, salida):
    assert cargar._titulo(entrada) == salida


def test_agrupacion_no_depende_del_orden_del_archivo(tmp_path):
    """Revisión #76: invertir el catastro cambiaba 250 intersecciones."""
    rejillas = [_rejilla("A", -70.600, calle_p="X", calle_i="Y"), _rejilla("B", -70.6003, calle_p="Y", calle_i="X"),
                _rejilla("C", -70.605, calle_p="X", calle_i="Y"), _rejilla("D", -70.6052, calle_p="X", calle_i="Y")]
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    d1 = cargar.preparar(_datos(tmp_path / "a", rejillas))
    d2 = cargar.preparar(_datos(tmp_path / "b", list(reversed(rejillas))))
    asignacion = lambda d: {sid: s.intersection_id for sid, s in d["sumideros"].items()}  # noqa: E731
    assert asignacion(d1) == asignacion(d2)
    assert set(d1["intersecciones"]) == set(d2["intersecciones"])

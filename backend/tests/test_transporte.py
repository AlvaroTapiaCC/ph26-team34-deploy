"""Paraderos expuestos (issue #91): lógica pura, endpoint con base doble y una prueba contra Supabase."""
import json
import os
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.db import DatabaseUnavailable
from app.main import app
from app.routers import transporte as router
from app.services import transporte as svc
from app.services.formula import StreetChain

client = TestClient(app)
AHORA = datetime(2026, 11, 22, 12, tzinfo=UTC)

# Tres paraderos en línea, ~200 m entre cada uno; el servicio 1 los recorre en orden
P = {
    "A": {"id": "A", "nombre": "Parada A", "lat": -33.4180, "lon": -70.6000,
          "servicios": [{"servicio": "1", "sentido": "0", "destino": "X"},
                        {"servicio": "2", "sentido": "0", "destino": "Y"}]},
    "B": {"id": "B", "nombre": "Parada B", "lat": -33.4198, "lon": -70.6000,
          "servicios": [{"servicio": "1", "sentido": "0", "destino": "X"}]},
    "C": {"id": "C", "nombre": "Parada C", "lat": -33.4216, "lon": -70.6000,
          "servicios": [{"servicio": "1", "sentido": "0", "destino": "X"}]},
}
DATOS = svc.DatosTransporte(P, {("1", "0"): ["A", "B", "C"], ("2", "0"): ["A"]},
                            {"nombre": "GTFS de DTPM", "url": None, "fecha_descarga": "2026-11-21"})
# Rejilla r1 junto a B; r2 y r3 calle abajo de r1 (r2 a 50 m, r3 a 400 m, junto a C)
COORDS = {"r1": (-33.41985, -70.6000), "r2": (-33.4203, -70.6000), "r3": (-33.4216, -70.6001),
          "rA": (-33.41805, -70.6000)}
CADENA = StreetChain("flujo:r1", ["r1", "r2", "r3"], [0.0, 50.0, 400.0])


def obs(sid, nivel, oid=None, simulada=False):
    return {"observation_id": oid or f"o-{sid}", "sumidero_id": sid, "nivel": nivel, "ts": AHORA,
            "tipo": "foto_agua", "fuente": "vecino", "is_simulated": simulada}


def calcular(ultimas, riesgo=(), chains=(CADENA,)):
    agua = svc.puntos_con_agua(ultimas, chains, COORDS, aguas_abajo_m=150)
    return svc.calcular(DATOS, agua, list(riesgo), radio_m=80)


# --- Criterio de aceptación y R1 -----------------------------------------------------------
def test_agua_observada_marca_el_paradero_y_propone_alternativo_no_expuesto():
    r = calcular([obs("r1", "hasta_vereda")])
    assert [e["id"] for e in r["expuestos"]] == ["B"]
    b = r["expuestos"][0]
    assert b["causa"]["observation_id"] == "o-r1" and b["causa"]["via"] == "observado"
    alt = b["servicios"][0]["alternativo"]
    assert alt["id"] in {"A", "C"} and alt["distancia_m"] > 0
    assert "lat" not in b["causa"]  # la causa no trae coordenadas de la observación


def test_expuesto_y_en_riesgo_no_se_mezclan_y_lo_observado_manda():
    riesgo = [{"sumidero_id": "r1", "lat": COORDS["r1"][0], "lon": COORDS["r1"][1], "prioridad": 0.2, "puesto": 1},
              {"sumidero_id": "rA", "lat": COORDS["rA"][0], "lon": COORDS["rA"][1], "prioridad": 0.1, "puesto": 2}]
    r = calcular([obs("r1", "cuneta")], riesgo=riesgo)
    assert [e["id"] for e in r["expuestos"]] == ["B"]          # agua observada gana sobre prioridad
    assert [e["id"] for e in r["en_riesgo"]] == ["A"]          # solo prioridad: otro nivel
    assert "alternativo" not in r["en_riesgo"][0]["servicios"][0]
    # El alternativo de B avisa que A está en riesgo
    alt = r["expuestos"][0]["servicios"][0]["alternativo"]
    assert alt["en_riesgo"] == (alt["id"] == "A")


def test_agua_calle_abajo_se_marca_como_inferida_y_respeta_la_distancia():
    agua = svc.puntos_con_agua([obs("r1", "sobre_vereda")], [CADENA], COORDS, aguas_abajo_m=150)
    por_id = {p["sumidero_id"]: p for p in agua}
    assert por_id["r2"]["via"] == "calle_abajo" and por_id["r2"]["calle_abajo_m"] == 50
    assert por_id["r2"]["observation_id"] == "o-r1"
    assert "r3" not in por_id                                  # 400 m: fuera del alcance


def test_una_observacion_posterior_sin_agua_apaga_la_cadena_en_esa_rejilla():
    # r2 se observó seca: no se marca por la cadena desde r1
    agua = svc.puntos_con_agua([obs("r1", "cuneta"), obs("r2", "sin_agua")], [CADENA], COORDS, 150)
    assert {p["sumidero_id"] for p in agua} == {"r1"}


# --- R3: faltante no es un valor válido ----------------------------------------------------
def test_sin_observaciones_no_hay_expuestos():
    assert calcular([])["expuestos"] == []


def test_sin_agua_no_expone():
    assert calcular([obs("r1", "sin_agua")])["expuestos"] == []


def test_servicio_sin_alternativo_lo_dice_en_vez_de_inventar_uno():
    # Agua en A (r A) y en B (r1): el servicio 2 solo tiene A en la zona; el 1 tiene C
    r = calcular([obs("rA", "cuneta"), obs("r1", "cuneta")], chains=())
    a = next(e for e in r["expuestos"] if e["id"] == "A")
    s1, s2 = a["servicios"]
    assert s1["alternativo"]["id"] == "C"                      # salta B, que también está expuesto
    assert s2["alternativo"] is None and s2["motivo"] == svc.SIN_ALTERNATIVO


def test_todos_expuestos_responde_sin_alternativo():
    lejos = svc.DatosTransporte({"A": P["A"], "B": P["B"]}, {("1", "0"): ["A", "B"]}, {})
    agua = svc.puntos_con_agua([obs("rA", "cuneta"), obs("r1", "cuneta")], [], COORDS, 150)
    r = svc.calcular(lejos, agua, [], radio_m=80)
    s = next(e for e in r["expuestos"] if e["id"] == "A")["servicios"][0]
    assert s["alternativo"] is None and s["motivo"] == svc.SIN_ALTERNATIVO


# --- R4: fallos externos -------------------------------------------------------------------
def test_sin_archivo_responde_lista_vacia_con_aviso(monkeypatch, tmp_path):
    assert svc.cargar_datos(tmp_path / "no.json", tmp_path / "no.meta.json") is None
    monkeypatch.setattr(svc, "cargar_datos", lambda: None)
    r = client.get("/transporte/expuestos")
    assert r.status_code == 200
    assert r.json()["expuestos"] == [] and "transporte_mut.json" in r.json()["aviso"]


def test_base_caida_es_503_y_no_500(monkeypatch):
    def caida(fn, plazo):
        raise DatabaseUnavailable("La base no respondió a tiempo")
    monkeypatch.setattr(router, "ejecutar_con_plazo", caida)
    r = client.get("/transporte/expuestos")
    assert r.status_code == 503


def test_archivo_real_carga():
    d = svc.cargar_datos()
    assert d is not None and "PC1329" in d.paraderos
    assert d.secuencias[("405", "0")].index("PC1329") == 1


# --- Contra Supabase: vigencia, la última manda y POST → GET -------------------------------
integracion = pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1",
                                 reason="DRENA_TEST_INTEGRACION=1 para correrlo")


@integracion
def test_integracion_observacion_vigente_marca_pc1329_y_la_vencida_no():
    from app.db import get_conn

    tag = uuid.uuid4().hex[:10]
    viva, vieja, seca = (f"test-tr-{k}-{tag}" for k in ("viva", "vieja", "seca"))
    pc = svc.cargar_datos().paraderos["PC1329"]
    lejos = svc.cargar_datos().paraderos["PC1016"]

    def insertar(conn, sid, lat, lon, niveles, horas, tipos=None):
        conn.execute("insert into sumideros (id, geom, fuente) values (%s, st_point(%s, %s, 4326), 'manual')",
                     (sid, lon, lat))
        for i, nivel in enumerate(niveles):  # en orden: la última observación es la que manda
            tipo = (tipos or {}).get(i, "foto_agua")
            o = conn.execute("insert into observations (sumidero_id, fuente, tipo, ts) values"
                             " (%s, 'vecino', %s, now() - make_interval(hours => %s, secs => %s))"
                             " returning id", (sid, tipo, horas, len(niveles) - i)).fetchone()["id"]
            conn.execute("insert into classifications (observation_id, resultado, modelo, prompt_version)"
                         " values (%s, %s, 'test', 'v0')", (o, json.dumps({"nivel_agua": nivel})))

    try:
        with get_conn() as conn:
            # La última es una foto de rejilla sin agua (como la del cierre, #42): no apaga el agua
            insertar(conn, viva, pc["lat"] + 0.0001, pc["lon"], ["cuneta", "hasta_vereda", "sin_agua"], 0,
                     tipos={2: "foto_rejilla"})
            insertar(conn, vieja, lejos["lat"], lejos["lon"] + 0.0001, ["sobre_vereda"], 7)  # vencida (6 h)
            insertar(conn, seca, lejos["lat"] + 0.0001, lejos["lon"], ["hasta_vereda", "sin_agua"], 0)
        r = client.get("/transporte/expuestos")
        assert r.status_code == 200
        exp = {e["id"]: e for e in r.json()["expuestos"]}
        assert exp["PC1329"]["causa"]["sumidero_id"] == viva
        assert exp["PC1329"]["causa"]["nivel"] == "hasta_vereda"
        assert all(s["alternativo"] or s["motivo"] for s in exp["PC1329"]["servicios"])
        causas = {e["causa"]["sumidero_id"] for e in r.json()["expuestos"]}
        assert vieja not in causas and seca not in causas
    finally:
        with get_conn() as conn:
            ids = [viva, vieja, seca]
            conn.execute("delete from observations where sumidero_id = any(%s)", (ids,))
            conn.execute("delete from sumideros where id = any(%s)", (ids,))

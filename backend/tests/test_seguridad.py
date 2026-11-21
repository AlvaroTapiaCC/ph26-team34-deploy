"""Acceso a datos: lectura anónima mínima y fotos privadas (revisión del PR #57).

- Tests unitarios: helper de Storage con un Supabase simulado y contenido de las migraciones.
- Test de integración contra el Supabase real del equipo: se corre con
  `DRENA_TEST_INTEGRACION=1` (crea filas y una foto `test-rls-*` y las borra al final).
"""
import os
import re
import uuid
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.services import storage

MIGRACIONES = Path(__file__).resolve().parent.parent / "db" / "migrations"
PUBLICAS = {"intersections", "sumideros", "street_chains", "scenarios", "scores", "cases", "missions", "routes"}
PRIVADAS = {"observations", "classifications", "case_observations", "crews", "crew_positions",
            "closures", "cleaning_history", "events", "claude_cache"}


# --- Migraciones ---------------------------------------------------------------------
def _tablas_creadas(sql):
    return set(re.findall(r"create table if not exists (\w+)", sql))


def test_0001_habilita_rls_en_cada_tabla_que_crea():
    sql = (MIGRACIONES / "0001_esquema_inicial.sql").read_text(encoding="utf-8")
    con_rls = set(re.findall(r"alter table (\w+)\s+enable row level security", sql))
    assert _tablas_creadas(sql) == con_rls


def test_0002_lectura_publica_solo_para_tablas_de_la_demo():
    sql = (MIGRACIONES / "0002_rls_realtime_storage.sql").read_text(encoding="utf-8")
    bloque = sql[sql.index("do $$"):sql.index("end $$;")]
    publicas = set(re.findall(r"'(\w+)'", bloque))
    assert publicas == PUBLICAS
    assert "values ('photos', 'photos', false)" in sql


def test_0004_quita_lectura_de_tablas_privadas_y_cierra_el_bucket():
    sql = (MIGRACIONES / "0004_lectura_anonima_minima_y_fotos_privadas.sql").read_text(encoding="utf-8")
    assert set(re.findall(r"'(\w+)'", sql[sql.index("do $$"):sql.index("end $$;")])) == PRIVADAS
    assert "update storage.buckets set public = false where id = 'photos'" in sql
    assert not (PUBLICAS & PRIVADAS)


def test_0005_grant_select_solo_en_tablas_publicas():
    sql = (MIGRACIONES / "0005_permisos_explicitos.sql").read_text(encoding="utf-8")
    assert "revoke all on all tables in schema public from anon, authenticated" in sql
    grant = sql[sql.index("grant select on"):sql.index("to anon, authenticated;")]
    assert set(re.findall(r"\w+", grant)) - {"grant", "select", "on"} == PUBLICAS
    assert "alter default privileges in schema public revoke all on tables" in sql


# --- Helper de Storage con Supabase simulado -------------------------------------------
@pytest.fixture
def supabase_falso(monkeypatch):
    llamadas = []

    def handler(req: httpx.Request):
        llamadas.append(req)
        if "/object/sign/" in req.url.path:
            return httpx.Response(200, json={"signedURL": "/object/sign/photos/a/b.jpg?token=abc"})
        return httpx.Response(200, json={"Key": "photos/a/b.jpg"})

    monkeypatch.setattr(storage, "_client", httpx.Client(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(storage, "get_settings", lambda: SimpleNamespace(
        supabase_url="https://x.supabase.co", supabase_service_key="sb_secret_x", storage_bucket="photos"))
    return llamadas


def test_subir_y_firmar(supabase_falso):
    assert storage.subir(b"img", "a/b.jpg") == "a/b.jpg"
    url = storage.url_firmada("a/b.jpg", 120)
    assert url == "https://x.supabase.co/storage/v1/object/sign/photos/a/b.jpg?token=abc"
    subida, firma = supabase_falso
    assert subida.headers["apikey"] == "sb_secret_x" and subida.url.path == "/storage/v1/object/photos/a/b.jpg"
    assert firma.read() == b'{"expiresIn":120}'


def test_storage_sin_configuracion(monkeypatch):
    monkeypatch.setattr(storage, "get_settings", lambda: SimpleNamespace(
        supabase_url="", supabase_service_key="", storage_bucket="photos"))
    with pytest.raises(storage.StorageError):
        storage.url_firmada("a.jpg")


def test_nueva_ruta():
    r = storage.nueva_ruta("observaciones", "png")
    assert re.fullmatch(r"observaciones/\d{4}-\d{2}-\d{2}/[0-9a-f]{32}\.png", r)


# --- Integración contra Supabase real -----------------------------------------------------
@pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1", reason="DRENA_TEST_INTEGRACION=1 para correrlo")
def test_integracion_anon_lee_ranking_pero_no_datos_crudos_ni_fotos():
    from app.config import get_settings
    from app.db import get_conn

    s = get_settings()
    rest = s.supabase_url.rstrip("/") + "/rest/v1"
    anon = {"apikey": s.supabase_anon_key}
    sid, scen, crew = f"test-rls-{uuid.uuid4().hex[:8]}", "test-rls", "test-rls-crew"
    ruta = f"test-rls/{uuid.uuid4().hex}.txt"
    try:
        with get_conn() as conn:
            conn.execute("insert into scenarios (id, nombre) values (%s, 'test') on conflict do nothing", (scen,))
            conn.execute("insert into sumideros (id, geom, fuente) values (%s, st_point(-70.6,-33.45,4326), 'manual')", (sid,))
            conn.execute("insert into scores (sumidero_id, scenario_id, modo, prioridad, rank) values (%s, %s, 'antes', 0.5, 1)", (sid, scen))
            obs = conn.execute("insert into observations (sumidero_id, fuente, tipo, texto) values (%s, 'vecino', 'texto', 'reporte crudo') returning id", (sid,)).fetchone()["id"]
            conn.execute("insert into crews (id, nombre, geom_actual) values (%s, 'test', st_point(-70.6,-33.45,4326)) on conflict do nothing", (crew,))
            conn.execute("insert into crew_positions (crew_id, geom) values (%s, st_point(-70.6,-33.45,4326))", (crew,))
        storage.subir(b"foto privada", ruta, "text/plain")

        # El navegador sigue leyendo el ranking público
        r = httpx.get(f"{rest}/scores", params={"sumidero_id": f"eq.{sid}", "select": "prioridad"}, headers=anon)
        assert r.status_code == 200 and r.json() == [{"prioridad": 0.5}]
        r = httpx.get(f"{rest}/sumideros", params={"id": f"eq.{sid}", "select": "id"}, headers=anon)
        assert r.json() == [{"id": sid}]

        # ...pero no los reportes crudos ni las posiciones de cuadrillas
        for tabla, filtro in [("observations", f"eq.{obs}"), ("crews", f"eq.{crew}")]:
            r = httpx.get(f"{rest}/{tabla}", params={"id": filtro}, headers=anon)
            assert r.status_code in (200, 401, 403) and (r.status_code != 200 or r.json() == []), tabla
        r = httpx.get(f"{rest}/crew_positions", params={"crew_id": f"eq.{crew}"}, headers=anon)
        assert r.status_code != 200 or r.json() == []

        # El navegador no puede escribir, ni siquiera en las tablas públicas
        r = httpx.post(f"{rest}/scores", headers={**anon, "Content-Type": "application/json"},
                       json={"sumidero_id": sid, "scenario_id": scen, "modo": "durante", "prioridad": 9})
        assert r.status_code in (401, 403)
        r = httpx.patch(f"{rest}/scores", params={"sumidero_id": f"eq.{sid}"},
                        headers={**anon, "Content-Type": "application/json", "Prefer": "return=representation"},
                        json={"prioridad": 9})
        assert r.status_code in (401, 403) or r.json() == []

        # Las fotos no se abren sin firma, ni con la URL pública ni con la publishable key
        base_st = s.supabase_url.rstrip("/") + "/storage/v1/object"
        assert httpx.get(f"{base_st}/public/photos/{ruta}").status_code >= 400
        assert httpx.get(f"{base_st}/authenticated/photos/{ruta}", headers={
            **anon, "Authorization": f"Bearer {s.supabase_anon_key}"}).status_code >= 400
        # Con el enlace firmado del backend sí
        r = httpx.get(storage.url_firmada(ruta, 60))
        assert r.status_code == 200 and r.content == b"foto privada"
    finally:
        with get_conn() as conn:
            conn.execute("delete from crews where id = %s", (crew,))
            conn.execute("delete from observations where sumidero_id = %s", (sid,))
            conn.execute("delete from sumideros where id = %s", (sid,))
            conn.execute("delete from scenarios where id = %s", (scen,))
        try:
            storage.borrar([ruta])
        except storage.StorageError:
            pass

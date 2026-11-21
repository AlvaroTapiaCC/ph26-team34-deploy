"""Acceso a datos: lectura anónima mínima, fotos privadas y casos sin GPS (revisión del PR #57).

- Tests unitarios: helper de Storage con un Supabase simulado y contenido de las migraciones.
- Test de integración contra el Supabase real del equipo: se corre con
  `DRENA_TEST_INTEGRACION=1`. Usa IDs únicos por ejecución y borra solo lo que creó.
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
# Lo que 0002/0005 dejaron público; 0006 cambia `cases` (GPS exacto) por `casos_publicos`.
PUBLICAS = {"intersections", "sumideros", "street_chains", "scenarios", "scores", "cases", "missions", "routes"}
PUBLICAS_FINAL = (PUBLICAS - {"cases"}) | {"casos_publicos"}
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


def test_0006_cases_privada_y_casos_publicos_sin_gps():
    sql = (MIGRACIONES / "0006_casos_publicos.sql").read_text(encoding="utf-8")
    assert 'drop policy if exists "lectura publica" on cases;' in sql
    assert "revoke all on cases from anon, authenticated;" in sql
    assert "alter publication supabase_realtime drop table cases" in sql
    assert "alter publication supabase_realtime add table casos_publicos" in sql
    assert "grant select on casos_publicos to anon, authenticated;" in sql
    assert "st_snaptogrid(new.geom, 0.001)" in sql  # ubicación aproximada si no hay sumidero
    assert "cases" not in PUBLICAS_FINAL and "casos_publicos" in PUBLICAS_FINAL


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
# Todos los IDs llevan un sufijo único por ejecución y la limpieza borra solo esos IDs exactos:
# dos ejecuciones en paralelo no se pisan ni borran datos ajenos.
@pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1", reason="DRENA_TEST_INTEGRACION=1 para correrlo")
def test_integracion_anon_lee_ranking_pero_no_datos_crudos_ni_fotos():
    from app.config import get_settings
    from app.db import get_conn

    s = get_settings()
    rest = s.supabase_url.rstrip("/") + "/rest/v1"
    anon = {"apikey": s.supabase_anon_key}
    run = uuid.uuid4().hex[:10]
    sid, scen, crew = f"test-rls-{run}", f"test-rls-{run}", f"test-rls-crew-{run}"
    ruta = f"test-rls/{run}.txt"
    gps = (-70.612345, -33.456789)  # "GPS exacto del vecino" (lon, lat)
    casos: list = []
    try:
        with get_conn() as conn:
            conn.execute("insert into scenarios (id, nombre) values (%s, 'test')", (scen,))
            conn.execute("insert into sumideros (id, geom, fuente) values (%s, st_point(-70.6, -33.45, 4326), 'manual')",
                         (sid,))
            conn.execute("insert into scores (sumidero_id, scenario_id, modo, prioridad, rank)"
                         " values (%s, %s, 'antes', 0.5, 1)", (sid, scen))
            obs = conn.execute("insert into observations (sumidero_id, fuente, tipo, texto)"
                               " values (%s, 'vecino', 'texto', 'reporte crudo') returning id", (sid,)).fetchone()["id"]
            conn.execute("insert into crews (id, nombre, geom_actual) values (%s, 'test', st_point(-70.6, -33.45, 4326))",
                         (crew,))
            conn.execute("insert into crew_positions (crew_id, geom) values (%s, st_point(-70.6, -33.45, 4326))", (crew,))
            # Un caso solo con GPS y otro asociado a un sumidero
            for sumidero in (None, sid):
                casos.append(conn.execute(
                    "insert into cases (geom, sumidero_id, urgente) values (st_point(%s, %s, 4326), %s, true)"
                    " returning id", (*gps, sumidero)).fetchone()["id"])
        storage.subir(b"foto privada", ruta, "text/plain")

        # El navegador sigue leyendo el ranking público
        r = httpx.get(f"{rest}/scores", params={"sumidero_id": f"eq.{sid}", "select": "prioridad"}, headers=anon)
        assert r.status_code == 200 and r.json() == [{"prioridad": 0.5}]
        r = httpx.get(f"{rest}/sumideros", params={"id": f"eq.{sid}", "select": "id"}, headers=anon)
        assert r.json() == [{"id": sid}]

        # ...pero no los reportes crudos, las cuadrillas ni los casos con GPS
        ids_casos = ",".join(str(c) for c in casos)
        for tabla, filtro in [("observations", f"eq.{obs}"), ("crews", f"eq.{crew}"), ("cases", f"in.({ids_casos})")]:
            r = httpx.get(f"{rest}/{tabla}", params={"id": filtro}, headers=anon)
            assert r.status_code in (200, 401, 403) and (r.status_code != 200 or r.json() == []), tabla
        r = httpx.get(f"{rest}/crew_positions", params={"crew_id": f"eq.{crew}"}, headers=anon)
        assert r.status_code != 200 or r.json() == []

        # Los casos sí se ven en casos_publicos, sin el GPS exacto
        r = httpx.get(f"{rest}/casos_publicos", params={"id": f"in.({ids_casos})", "select": "id,urgente"}, headers=anon)
        assert r.status_code == 200 and len(r.json()) == 2
        with get_conn() as conn:
            pub = {str(x["id"]): x for x in conn.execute(
                "select cp.id, st_x(cp.geom) as lon, st_y(cp.geom) as lat, st_equals(cp.geom, s.geom) as en_sumidero"
                "  from casos_publicos cp left join sumideros s on s.id = %s where cp.id = any(%s)", (sid, casos))}
        solo_gps, con_sumidero = pub[str(casos[0])], pub[str(casos[1])]
        assert (round(solo_gps["lon"], 6), round(solo_gps["lat"], 6)) != gps           # no es el GPS exacto
        assert abs(solo_gps["lon"] - gps[0]) <= 0.0005 and abs(solo_gps["lat"] - gps[1]) <= 0.0005  # redondeado
        assert con_sumidero["en_sumidero"]                                               # ubicación del sumidero

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
        # Solo las filas creadas por esta ejecución (IDs exactos)
        with get_conn() as conn:
            if casos:
                conn.execute("delete from cases where id = any(%s)", (casos,))
            conn.execute("delete from crews where id = %s", (crew,))
            conn.execute("delete from observations where sumidero_id = %s", (sid,))
            conn.execute("delete from scores where sumidero_id = %s and scenario_id = %s", (sid, scen))
            conn.execute("delete from sumideros where id = %s", (sid,))
            conn.execute("delete from scenarios where id = %s", (scen,))
        try:
            storage.borrar([ruta])
        except storage.StorageError:
            pass

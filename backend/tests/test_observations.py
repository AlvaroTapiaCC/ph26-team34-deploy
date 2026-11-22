"""POST /observations sin Claude ni Supabase: todo lo externo se reemplaza por dobles en memoria."""
import io
import json
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.routers import observations as router
from app.schemas.claude import ClasificacionCamara, ClasificacionRejilla, LecturaTexto
from app.services import observations as svc
from app.services.claude_common import ResultadoClaude
from app.services.claude_vision import ImagenInvalida

client = TestClient(app)

# Dos sumideros pegados (esquina) y uno solo, más lejos
S_A = {"id": "A", "intersection_id": "i1", "lat": -33.4560, "lon": -70.6000}
S_B = {"id": "B", "intersection_id": "i1", "lat": -33.45605, "lon": -70.60005}   # ~7 m de A
S_C = {"id": "C", "intersection_id": "i2", "lat": -33.4600, "lon": -70.6100}


def _dist(lat1, lon1, lat2, lon2):
    import math
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class Mundo:
    """Estado de la 'base' y registro de lo que pasó."""

    def __init__(self):
        self.sumideros = {s["id"]: s for s in (S_A, S_B, S_C)}
        self.observaciones = {}
        self.clasificaciones = []
        self.casos = {}
        self.vinculos = []
        self.eventos = []
        self.recalculos = 0
        self.rejilla = ClasificacionRejilla(
            evaluable=True, rejilla="tapada", material=["hojas"], hojas_calzada="muchas", agua_visible=True,
            nivel_agua="hasta_vereda", confianza="alta", nota="Tapada con hojas")
        self.riesgo = False
        self.claude_cae = False
        self.storage_cae = False
        self.recalculo_cae = False
        self.despachos = []
        self.despacho_cae = False


@pytest.fixture
def mundo(monkeypatch):
    m = Mundo()

    @contextmanager
    def fake_conn(*a, **k):
        yield SimpleNamespace()

    monkeypatch.setattr(router, "get_conn", fake_conn)

    def cercanos(conn, lat, lon):
        out = [{**s, "distancia_m": round(_dist(lat, lon, s["lat"], s["lon"]), 1)} for s in m.sumideros.values()]
        out = sorted((o for o in out if o["distancia_m"] <= svc.RADIO_MAX_ASOCIACION_M), key=lambda o: o["distancia_m"])
        return out

    monkeypatch.setattr(svc, "sumideros_cercanos", cercanos)
    monkeypatch.setattr(svc, "sumidero_existe", lambda conn, sid: m.sumideros.get(sid))
    monkeypatch.setattr(svc, "observacion_existente", lambda conn, oid: m.observaciones.get(oid))

    def insertar_obs(conn, **kw):
        oid = kw["obs_id"] or f"obs-{len(m.observaciones) + 1}"
        m.observaciones[oid] = {"id": oid, "sumidero_id": kw["sumidero_id"], "caso_id": None, "urgente": False,
                                "clasificacion": None, **kw}
        return oid

    monkeypatch.setattr(svc, "insertar_observacion", insertar_obs)
    monkeypatch.setattr(svc, "insertar_clasificacion",
                        lambda conn, oid, res, meta, cruda: m.clasificaciones.append((oid, res, meta)))

    def buscar_caso(conn, lat, lon, ts):
        for cid, c in m.casos.items():
            if _dist(lat, lon, c["lat"], c["lon"]) <= svc.RADIO_CASO_M and abs(ts - c["ultima"]) <= svc.VENTANA_CASO:
                return cid
        return None

    def crear_caso(conn, lat, lon, sid, urgente, ts):
        cid = f"caso-{len(m.casos) + 1}"
        m.casos[cid] = {"lat": lat, "lon": lon, "sumidero_id": sid, "urgente": urgente, "ultima": ts}
        return cid

    def actualizar_caso(conn, cid, sid, urgente):
        m.casos[cid]["urgente"] |= urgente
        m.casos[cid]["sumidero_id"] = m.casos[cid]["sumidero_id"] or sid

    def vincular(conn, cid, oid):
        m.vinculos.append((cid, oid))
        m.casos[cid]["ultima"] = m.observaciones[oid]["ts"]

    monkeypatch.setattr(svc, "buscar_caso", buscar_caso)
    monkeypatch.setattr(svc, "crear_caso", crear_caso)
    monkeypatch.setattr(svc, "actualizar_caso", actualizar_caso)
    monkeypatch.setattr(svc, "vincular_caso", vincular)
    monkeypatch.setattr(svc, "caso_urgente", lambda conn, cid: m.casos[cid]["urgente"])
    monkeypatch.setattr(svc, "registrar_evento", lambda conn, tipo, payload: m.eventos.append((tipo, payload)))
    monkeypatch.setattr(svc, "prioridad_de", lambda conn, sid, sc=None: {
        "scenario_id": "base", "rank": 1, "prioridad": 0.8, "p_ef": 0.95, "c": 0.84, "p_obs": 0.95})

    def recalcular(conn):
        if m.recalculo_cae:
            raise RuntimeError("base caída")
        m.recalculos += 1
        return {}

    monkeypatch.setattr(router, "recalcular_todo", recalcular)

    def res(valor, version):
        return ResultadoClaude(valor, "claude-test", version, "k", 10, fallo=m.claude_cae)

    def clasificar_rejilla(data):
        if data == b"basura":
            raise ImagenInvalida("x")
        return res(ClasificacionRejilla.no_evaluable("caído") if m.claude_cae else m.rejilla, "rejilla-v1")

    monkeypatch.setattr(router, "clasificar_rejilla", clasificar_rejilla)
    monkeypatch.setattr(router, "clasificar_camara", clasificar_rejilla)

    def leer(texto):
        riesgo = m.riesgo or "atrapad" in texto
        return res(LecturaTexto(tipo="anegamiento", gravedad="alta" if riesgo else "media",
                                personas_en_riesgo=riesgo, ubicacion_texto=None, desde_cuando=None,
                                nivel_agua="sobre_vereda", confianza="alta"), "texto-v2")

    monkeypatch.setattr(router, "leer_texto", leer)

    def subir(data, ruta, ct="image/jpeg"):
        if m.storage_cae:
            raise router.storage.StorageError("sin storage")
        return ruta

    monkeypatch.setattr(router.storage, "subir", subir)

    def despachar(motivo, observation_id=None, sumidero_id=None, caso_id=None):
        m.despachos.append((motivo, observation_id, sumidero_id, caso_id))
        if m.despacho_cae:
            return {"despachado": False, "motivo": "error_despacho", "error": "RuntimeError"}
        return {"despachado": True, "crew_id": "sim-c4", "en_plan": True, "ruta_version": 2,
                "siguiente_antes": {"sumidero_id": "C"}, "siguiente_despues": {"sumidero_id": sumidero_id}}

    monkeypatch.setattr(router.dispatch, "replanificar_seguro", despachar)
    return m


def _foto():
    b = io.BytesIO()
    Image.new("RGB", (40, 40), (90, 90, 90)).save(b, "JPEG")
    return b.getvalue()


def _enviar(tipo="rejilla", foto=True, **campos):
    files = {"foto": ("r.jpg", _foto(), "image/jpeg")} if foto and tipo != "texto" else None
    return client.post("/observations", data={"tipo": tipo, **{k: str(v) for k, v in campos.items()}}, files=files)


# --- asociación al sumidero más cercano ---------------------------------------------------
def test_asocia_al_sumidero_mas_cercano(mundo):
    # Cerca de C (a ~3 m): un solo sumidero a ≤15 m, queda asociado
    r = _enviar(lat=-33.46003, lon=-70.61001)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["sumidero_id"] == "C" and "candidatos" not in d
    assert d["clasificacion"]["rejilla"] == "tapada"
    assert d["caso_id"] and d["id"]
    assert mundo.recalculos == 1 and d["prioridad_nueva"]["rank"] == 1
    assert mundo.observaciones[d["id"]]["tipo"] == "foto_rejilla"
    assert mundo.observaciones[d["id"]]["media_url"].startswith("observaciones/")


def test_sin_sumidero_cerca_guarda_igual(mundo):
    d = _enviar(lat=-33.50, lon=-70.70).json()  # kilómetros de todo
    assert d["sumidero_id"] is None and d["caso_id"] and d["prioridad_nueva"] is None


def test_gps_lejos_pero_sumidero_elegido_manda(mundo):
    d = _enviar(lat=-33.50, lon=-70.70, sumidero_id="C").json()
    assert d["sumidero_id"] == "C"


def test_sumidero_inexistente_es_422(mundo):
    assert _enviar(lat=-33.456, lon=-70.6, sumidero_id="Z").status_code == 422


# --- empate entre candidatos ---------------------------------------------------------------
def test_empate_asocia_al_mas_cercano_guarda_y_devuelve_candidatos(mundo):
    r = _enviar(lat=-33.45602, lon=-70.60002)  # entre A y B
    assert r.status_code == 200
    d = r.json()
    assert {c["sumidero_id"] for c in d["candidatos"]} == {"A", "B"}
    assert d["candidatos"][0]["distancia_m"] <= d["candidatos"][1]["distancia_m"]
    assert d["id"] and d["sumidero_id"] == d["candidatos"][0]["sumidero_id"]
    assert len(mundo.observaciones) == 1 and mundo.casos and mundo.recalculos == 1


def test_empate_se_resuelve_con_sumidero_id(mundo):
    d = _enviar(lat=-33.45602, lon=-70.60002, sumidero_id="B").json()
    assert d["sumidero_id"] == "B" and d["id"] and "candidatos" not in d


def test_decidir_asociacion_pura():
    cerca = lambda i, m: {"id": i, "distancia_m": m}  # noqa: E731
    assert svc.decidir_asociacion([]) == (None, [])
    assert svc.decidir_asociacion([cerca("a", 4), cerca("b", 30)])[0] == "a"   # el segundo está a >15 m
    assert svc.decidir_asociacion([cerca("a", 4), cerca("b", 14.9)]) == ("a", [cerca("a", 4), cerca("b", 14.9)])
    assert svc.decidir_asociacion([cerca("a", 60)]) == (None, [])              # muy lejos: sin asociación


# --- agrupación en casos --------------------------------------------------------------------
def test_agrupa_en_el_mismo_caso_si_es_cerca_y_reciente(mundo):
    ahora = datetime.now(timezone.utc)
    a = _enviar(lat=-33.4600, lon=-70.6100, hora=(ahora - timedelta(minutes=20)).isoformat()).json()
    b = _enviar("texto", texto="se junta agua en la esquina", lat=-33.46030, lon=-70.61020,
                hora=(ahora - timedelta(minutes=5)).isoformat()).json()   # ~35 m, 15 min después
    assert a["caso_id"] == b["caso_id"] and len(mundo.casos) == 1
    assert len(mundo.vinculos) == 2


def test_caso_nuevo_si_pasa_la_ventana_o_la_distancia(mundo):
    ahora = datetime.now(timezone.utc)
    a = _enviar(lat=-33.4600, lon=-70.6100, hora=(ahora - timedelta(minutes=90)).isoformat()).json()
    tarde = _enviar(lat=-33.4600, lon=-70.6100, hora=ahora.isoformat()).json()           # misma esquina, 90 min
    lejos = _enviar(lat=-33.4610, lon=-70.6100, hora=ahora.isoformat()).json()           # ~110 m
    assert len({a["caso_id"], tarde["caso_id"], lejos["caso_id"]}) == 3


# --- urgente --------------------------------------------------------------------------------
def test_personas_en_riesgo_marcan_caso_urgente_y_dan_numeros(mundo):
    d = _enviar("texto", texto="hay una señora atrapada en su auto", lat=-33.46003, lon=-70.61001).json()
    assert d["urgente"] is True and d["caso_urgente"] is True
    assert [n["numero"] for n in d["numeros_emergencia"]] == ["133", "132", "131"]
    assert mundo.casos[d["caso_id"]]["urgente"] is True
    assert d["clasificacion"]["personas_en_riesgo"] is True


def test_caso_ya_urgente_no_da_numeros_al_siguiente_vecino(mundo):
    u = _enviar("texto", texto="hay gente atrapada", lat=-33.46003, lon=-70.61001).json()
    n = _enviar(lat=-33.46003, lon=-70.61001).json()
    assert n["caso_id"] == u["caso_id"] and n["urgente"] is False and n["caso_urgente"] is True
    assert n["numeros_emergencia"] == []


def test_no_urgente_sin_riesgo(mundo):
    d = _enviar("texto", texto="se junta agua", lat=-33.46003, lon=-70.61001).json()
    assert d["urgente"] is False and d["numeros_emergencia"] == []


def test_foto_con_texto_de_riesgo_es_urgente_y_la_foto_manda_en_la_clasificacion(mundo):
    d = _enviar(lat=-33.46003, lon=-70.61001, texto="hay niños atrapados atrapad").json()
    assert d["urgente"] is True
    assert d["clasificacion"]["rejilla"] == "tapada"
    assert len(mundo.clasificaciones) == 1  # una sola por observación: no pisa la de la foto


# --- degradación y validación ---------------------------------------------------------------
def test_si_claude_cae_no_hay_500(mundo):
    mundo.claude_cae = True
    r = _enviar(lat=-33.46003, lon=-70.61001)
    assert r.status_code == 200
    d = r.json()
    assert d["fallo"] is True and d["clasificacion"]["rejilla"] == "no_evaluable" and d["id"]


def test_si_storage_cae_se_guarda_igual(mundo):
    mundo.storage_cae = True
    d = _enviar(lat=-33.46003, lon=-70.61001).json()
    assert d["id"] and d["foto_guardada"] is False
    assert mundo.observaciones[d["id"]]["media_url"] is None


def test_si_el_recalculo_falla_el_reporte_queda_guardado(mundo):
    mundo.recalculo_cae = True
    r = _enviar(lat=-33.46003, lon=-70.61001)
    assert r.status_code == 200 and r.json()["recalculado"] is False and r.json()["id"] in mundo.observaciones


@pytest.mark.parametrize("campos,foto", [
    ({"tipo": "otro"}, True),                                      # tipo inválido
    ({"tipo": "rejilla"}, False),                                  # falta la foto
    ({"tipo": "texto"}, False),                                    # falta el texto
    ({"tipo": "texto", "texto": "a"}, False),                      # texto muy corto
    ({"tipo": "rejilla", "lat": "-33.4"}, True),                   # lat sin lon
    ({"tipo": "rejilla", "lat": "999", "lon": "-70"}, True),       # fuera de rango
    ({"tipo": "rejilla", "lat": "abc", "lon": "-70"}, True),       # no numérico
    ({"tipo": "rejilla", "hora": "ayer"}, True),                   # hora inválida
])
def test_entrada_invalida_es_422(mundo, campos, foto):
    files = {"foto": ("r.jpg", _foto(), "image/jpeg")} if foto else None
    r = client.post("/observations", data=campos, files=files)
    assert r.status_code == 422, r.text
    assert isinstance(r.json()["detail"], str)
    assert not mundo.observaciones


def test_imagen_ilegible_es_422(mundo):
    r = client.post("/observations", data={"tipo": "rejilla", "lat": "-33.46", "lon": "-70.61"},
                    files={"foto": ("r.jpg", b"basura", "image/jpeg")})
    assert r.status_code == 422 and not mundo.observaciones


# --- compatibilidad con /reportar (PR #82) y reintentos ------------------------------------
def test_camara_fija_clasifica_agua_y_recalcula_el_tramo(mundo, monkeypatch):
    cuadro = ClasificacionCamara(
        evaluable=True, hojas_calzada="pocas", basura_calzada="poca", agua_visible=True,
        nivel_agua="cuneta", confianza="alta", nota="Agua en la cuneta",
    )
    monkeypatch.setattr(router, "clasificar_camara",
                        lambda foto: ResultadoClaude(cuadro, "claude-test", "camara-v1", "k", 10))
    datos = {"tipo": "agua", "fuente": "camara_fija", "lat": S_C["lat"], "lon": S_C["lon"]}
    r = client.post("/observations", data={"datos": json.dumps(datos)},
                    files={"foto": ("camara.jpg", _foto(), "image/jpeg")})
    assert r.status_code == 200, r.text
    d = r.json()
    observacion = mundo.observaciones[d["id"]]
    evento = next(payload for tipo, payload in mundo.eventos if tipo == "observacion")
    assert observacion["fuente"] == evento["fuente"] == "camara"
    assert observacion["tipo"] == "foto_agua"
    assert d["sumidero_id"] == "C" and d["caso_id"]
    assert d["clasificacion"]["nivel_agua"] == "cuneta"
    assert d["recalculado"] and mundo.recalculos == 1


@pytest.mark.parametrize("tipo, ubicacion", [("rejilla", {"lat": -33.46, "lon": -70.61}), ("agua", {})])
def test_camara_fija_requiere_cuadro_de_agua_ubicado(mundo, tipo, ubicacion):
    r = _enviar(tipo, fuente="camara_fija", **ubicacion)
    assert r.status_code == 422 and not mundo.observaciones


def test_acepta_el_formato_datos_de_reportar_y_modo_campo(mundo):
    datos = {"id": "no-es-uuid-123", "tipo": "rejilla", "lat": -33.456, "lon": -70.6, "precision_m": 8,
             "sin_gps": False, "hora": datetime.now(timezone.utc).isoformat(), "clasificacion": {"x": 1},
             "archivo": "rejilla-07.jpg", "rejilla_num": 7, "id_ide": "C", "enviado": False}
    r = client.post("/observations", data={"datos": json.dumps(datos)},
                    files={"foto": ("rejilla-07.jpg", _foto(), "image/jpeg")})
    assert r.status_code == 200, r.text
    # En modo campo manda el ID del catastro elegido, aunque el GPS caiga entre A y B
    assert r.json()["sumidero_id"] == "C"
    ev = next(payload for tipo, payload in mundo.eventos if tipo == "observacion")
    assert ev["campo"] is True and ev["rejilla_n"] == 7 and ev["precision_m"] == 8


def test_sin_gps_con_sumidero_elegido_usa_la_ubicacion_del_sumidero(mundo):
    d = _enviar("texto", texto="agua en la calle", sumidero_id="C").json()
    assert d["sumidero_id"] == "C" and d["caso_id"]
    assert mundo.casos[d["caso_id"]]["lat"] == S_C["lat"]


def test_sin_gps_ni_sumidero_guarda_sin_caso(mundo):
    d = _enviar("texto", texto="agua en la calle").json()
    assert d["id"] and d["caso_id"] is None


def test_reintento_con_el_mismo_id_no_duplica(mundo):
    uid = "11111111-1111-4111-8111-111111111111"
    primero = _enviar(lat=-33.46003, lon=-70.61001, id=uid).json()
    segundo = _enviar(lat=-33.46003, lon=-70.61001, id=uid).json()
    assert primero["id"] == uid and segundo["id"] == uid and segundo["repetido"] is True
    assert len(mundo.observaciones) == 1 and mundo.recalculos == 1


def test_hora_futura_se_acota_a_ahora(mundo):
    manana = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    d = _enviar(lat=-33.46003, lon=-70.61001, hora=manana).json()
    assert mundo.observaciones[d["id"]]["ts"] <= datetime.now(timezone.utc) + timedelta(seconds=5)


# --- GET ------------------------------------------------------------------------------------
def test_get_lista_con_desde(monkeypatch):
    @contextmanager
    def fake_conn(*a, **k):
        yield SimpleNamespace()

    visto = {}
    monkeypatch.setattr(router, "get_conn", fake_conn)
    monkeypatch.setattr(svc, "listar", lambda conn, desde, limite: visto.update(desde=desde, limite=limite) or [{"id": "x"}])
    r = client.get("/observations", params={"desde": "2026-11-21T10:00:00-03:00", "limit": 5})
    assert r.status_code == 200 and r.json()["items"] == [{"id": "x"}]
    assert visto["desde"] == datetime(2026, 11, 21, 10, 0, tzinfo=timezone(timedelta(hours=-3))) and visto["limite"] == 5
    assert client.get("/observations", params={"desde": "ayer"}).status_code == 422
    assert client.get("/observations", params={"limit": 0}).status_code == 422


# --- despacho (#32) ---------------------------------------------------------------------
def test_la_foto_dispara_el_despacho_y_devuelve_la_siguiente_parada(mundo):
    r = _enviar(lat=-33.46003, lon=-70.61001)
    d = r.json()
    assert r.status_code == 200
    assert mundo.despachos == [("observacion", d["id"], "C", d["caso_id"])]
    assert d["despacho"]["despachado"] and d["despacho"]["siguiente_despues"] == {"sumidero_id": "C"}


def test_el_recalculo_registra_la_prioridad_de_la_observacion(mundo, monkeypatch):
    valores = iter([{"scenario_id": "base", "prioridad": 0}, {"scenario_id": "base", "prioridad": 0.8}])
    monkeypatch.setattr(svc, "prioridad_de", lambda conn, sid: next(valores))

    d = _enviar(lat=-33.46003, lon=-70.61001).json()
    eventos = [payload for tipo, payload in mundo.eventos if tipo == "prioridad_observacion"]

    assert eventos == [{
        "observation_id": d["id"],
        "antes": {"scenario_id": "base", "prioridad": 0},
        "despues": d["prioridad_nueva"],
    }]


def test_si_el_despacho_falla_el_reporte_queda_guardado(mundo):
    mundo.despacho_cae = True
    r = _enviar(lat=-33.46003, lon=-70.61001)
    assert r.status_code == 200 and r.json()["despacho"]["despachado"] is False
    assert r.json()["id"] in mundo.observaciones


def test_texto_sin_ubicacion_no_replanifica(mundo):
    r = _enviar(tipo="texto", texto="hay mucha basura en la calle")
    assert r.status_code == 200 and r.json()["despacho"]["motivo"] == "sin_ubicacion"
    assert mundo.despachos == []

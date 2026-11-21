"""Pool único bajo concurrencia y /health/db con la base caída (revisión del PR #56)."""
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app

client = TestClient(app)


@pytest.fixture
def pool_limpio(monkeypatch):
    """Aísla el pool global: cierra el real y lo restaura vacío al terminar."""
    db.close_pool()
    yield monkeypatch
    db.close_pool()


def _url(monkeypatch, url):
    monkeypatch.setattr(db, "get_settings", lambda: SimpleNamespace(database_url=url))


def test_health_no_toca_la_base(pool_limpio):
    _url(pool_limpio, "")
    assert client.get("/health").status_code == 200
    assert db._pool is None


def test_health_db_503_sin_database_url(pool_limpio):
    _url(pool_limpio, "")
    t = time.perf_counter()
    r = client.get("/health/db")
    assert r.status_code == 503 and "DATABASE_URL" in r.json()["detail"]
    assert time.perf_counter() - t < 1


def test_health_db_503_rapido_si_la_base_no_responde(pool_limpio):
    _url(pool_limpio, "postgresql://u:p@127.0.0.1:1/nada")  # puerto cerrado
    t = time.perf_counter()
    r = client.get("/health/db")
    assert r.status_code == 503
    assert time.perf_counter() - t < 8


def test_endpoints_con_base_responden_503(pool_limpio):
    _url(pool_limpio, "")
    assert client.get("/scenarios").status_code in (501, 503)  # stub o 503, nunca 500


class PoolLento:
    creados = []

    def __init__(self, *a, **k):
        time.sleep(0.2)  # ventana para que otro hilo entre en paralelo
        self.cerrado = False
        PoolLento.creados.append(self)

    def close(self):
        self.cerrado = True


def test_un_solo_pool_con_requests_simultaneos(pool_limpio):
    _url(pool_limpio, "postgresql://x")
    pool_limpio.setattr(db, "ConnectionPool", PoolLento)
    PoolLento.creados = []
    resultados = []
    hilos = [threading.Thread(target=lambda: resultados.append(db.get_pool())) for _ in range(8)]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join()
    assert len(PoolLento.creados) == 1
    assert all(r is resultados[0] for r in resultados)
    db.close_pool()
    assert PoolLento.creados[0].cerrado and db._pool is None


# --- La base deja de responder después de entregar la conexión ----------------------
import psycopg  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402

PLAZO = 3  # HEALTH_DB_TIMEOUT_S
MARGEN = 1.0


class ConnFalsa:
    """Conexión simulada. Cada operación puede colgarse un tiempo configurable."""

    def __init__(self, consulta_s=0.0, cancel_s=0.0, commit_s=0.0, cuelga_hasta_cancelar=False):
        self.consulta_s, self.cancel_s, self.commit_s = consulta_s, cancel_s, commit_s
        self.cuelga_hasta_cancelar = cuelga_hasta_cancelar
        self.cancelada = threading.Event()
        self.closed = False
        self.rollbacks = 0

    def execute(self, *a, **k):
        if self.cuelga_hasta_cancelar:
            self.cancelada.wait(30)
            raise psycopg.OperationalError("canceling statement due to user request")
        time.sleep(self.consulta_s)
        return self

    def fetchone(self):
        from datetime import datetime, timezone
        return {"now": datetime.now(timezone.utc), "postgis": True}

    def cancel_safe(self, timeout=None):
        time.sleep(self.cancel_s)
        self.cancelada.set()

    def commit(self):
        time.sleep(self.commit_s)

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class PoolFalso:
    def __init__(self, conn):
        self.conn, self.entregadas, self.devueltas = conn, 0, []

    def getconn(self, timeout=None):
        self.entregadas += 1
        return self.conn

    def putconn(self, conn):
        self.devueltas.append(conn)

    def close(self):
        pass


def _esperar(cond, s=5.0):
    fin = time.time() + s
    while time.time() < fin:
        if cond():
            return True
        time.sleep(0.05)
    return False


def _health_con(monkeypatch, conn):
    pool = PoolFalso(conn)
    monkeypatch.setattr(db, "get_pool", lambda: pool)
    t = time.perf_counter()
    r = client.get("/health/db")
    return r, time.perf_counter() - t, pool


def test_health_db_503_si_la_consulta_se_cuelga(pool_limpio):
    conn = ConnFalsa(cuelga_hasta_cancelar=True)
    r, dur, pool = _health_con(pool_limpio, conn)
    assert r.status_code == 503 and dur < PLAZO + MARGEN, f"tardó {dur:.1f} s"
    # La limpieza sigue en segundo plano: cancela, descarta sin rollback y devuelve al pool
    assert _esperar(lambda: pool.devueltas == [conn])
    assert conn.cancelada.is_set() and conn.closed and conn.rollbacks == 0


def test_health_db_respeta_el_plazo_aunque_cancelar_tarde(pool_limpio):
    conn = ConnFalsa(cuelga_hasta_cancelar=True, cancel_s=6)
    r, dur, pool = _health_con(pool_limpio, conn)
    assert r.status_code == 503 and dur < PLAZO + MARGEN, f"tardó {dur:.1f} s"
    assert _esperar(lambda: conn.closed, 10)


def test_health_db_respeta_el_plazo_aunque_el_commit_tarde(pool_limpio):
    conn = ConnFalsa(commit_s=6)
    r, dur, pool = _health_con(pool_limpio, conn)
    assert r.status_code == 503 and dur < PLAZO + MARGEN, f"tardó {dur:.1f} s"
    # Aunque el commit termine bien después, la conexión abandonada no se reutiliza
    assert _esperar(lambda: pool.devueltas == [conn], 10) and conn.closed


def test_health_db_ok_si_todo_responde(pool_limpio):
    conn = ConnFalsa()
    r, dur, pool = _health_con(pool_limpio, conn)
    assert r.status_code == 200 and r.json()["postgis"] is True
    assert pool.devueltas == [conn] and not conn.closed


def test_trabajo_que_vence_en_la_cola_nunca_se_ejecuta(pool_limpio):
    """Con todos los hilos ocupados, el trabajo vence esperando y se cancela antes de correr."""
    pool_limpio.setattr(db, "_executor", ThreadPoolExecutor(max_workers=1))
    conn = ConnFalsa()
    pool = PoolFalso(conn)
    pool_limpio.setattr(db, "get_pool", lambda: pool)
    liberar = threading.Event()
    db._executor.submit(liberar.wait, 10)  # ocupa el único hilo
    corrio = []
    t = time.perf_counter()
    with pytest.raises(db.DatabaseUnavailable):
        db.ejecutar_con_plazo(lambda c: corrio.append(1), 0.5)
    assert time.perf_counter() - t < 0.5 + MARGEN
    liberar.set()
    time.sleep(0.3)  # dar tiempo a que el hilo tome trabajo pendiente, si lo hubiera
    assert corrio == [] and pool.entregadas == 0


def test_conexiones_nuevas_fijan_statement_timeout():
    llamadas = []

    class C:
        def execute(self, sql):
            llamadas.append(sql)

        def commit(self):
            llamadas.append("commit")

    db._configurar(C())
    assert llamadas[0] == f"set statement_timeout = '{db.STATEMENT_TIMEOUT}'" and llamadas[1] == "commit"


def test_precalentar_no_hace_nada_sin_database_url(pool_limpio):
    _url(pool_limpio, "")
    assert db.precalentar_pool() is None and db._pool is None


def test_precalentar_no_bloquea_ni_falla_si_la_base_no_responde(pool_limpio):
    _url(pool_limpio, "postgresql://u:p@127.0.0.1:1/nada")
    t = time.perf_counter()
    hilo = db.precalentar_pool(espera_s=1)
    assert time.perf_counter() - t < 0.5  # no bloquea el arranque
    hilo.join(5)
    assert not hilo.is_alive()             # terminó sin lanzar
    assert db._pool is not None and not db._pool.closed  # el pool sigue abierto para reintentar


# --- Carrera al devolver la conexión al pool (revisión 4 del PR #56) ----------------
from concurrent.futures import Future  # noqa: E402
import random  # noqa: E402


class _EjecutorSincrono:
    """Corre el trabajo al momento; `despues` simula lo que pasa antes de que venza el plazo."""

    def __init__(self, despues=None, vence=True):
        self.despues, self.vence = despues, vence

    def submit(self, fn, *args):
        f = Future()
        try:
            f.set_result(fn(*args))
        except BaseException as e:  # noqa: BLE001
            f.set_exception(e)
        if self.despues:
            self.despues()
        return _FuturoVencido(f) if self.vence else f


class _FuturoVencido:
    def __init__(self, f):
        self.f = f

    def result(self, timeout=None):
        raise db.FuturesTimeout()

    def cancel(self):
        return False  # ya había empezado


def test_no_cancela_una_conexion_que_ya_tomo_otro_request(pool_limpio):
    """Secuencia: A termina y devuelve la conexión → B la toma → recién vence el plazo de A."""
    conn = ConnFalsa()
    pool = PoolFalso(conn)
    pool_limpio.setattr(db, "get_pool", lambda: pool)
    en_manos_de_b = []
    pool_limpio.setattr(db, "_executor", _EjecutorSincrono(despues=lambda: en_manos_de_b.append(pool.getconn())))
    pool_limpio.setattr(db, "_limpieza", _EjecutorSincrono(vence=False))  # la cancelación correría al tiro

    with pytest.raises(db.DatabaseUnavailable):
        db.ejecutar_con_plazo(lambda c: c.execute("select 1"), 3)

    assert en_manos_de_b == [conn]                 # B tiene la conexión
    assert not conn.cancelada.is_set()             # A no la canceló
    assert not conn.closed                         # ni la cerró en manos de B
    assert pool.devueltas == [conn]                # A la devolvió una sola vez, sana


def test_si_vence_mientras_la_tiene_la_cierra_antes_de_devolverla(pool_limpio):
    """Contraparte: si el plazo vence con la conexión aún en uso, nunca vuelve usable al pool."""
    conn = ConnFalsa(cuelga_hasta_cancelar=True)
    pool = PoolFalso(conn)
    pool_limpio.setattr(db, "get_pool", lambda: pool)
    with pytest.raises(db.DatabaseUnavailable):
        db.ejecutar_con_plazo(lambda c: c.execute("select 1"), 0.3)
    assert _esperar(lambda: pool.devueltas == [conn])
    assert conn.cancelada.is_set() and conn.closed and conn.rollbacks == 0


class _ConnCompartida:
    """Conexión que registra si una cancelación interrumpe la consulta de quien la tiene."""

    def __init__(self):
        self.closed = False
        self.interrumpida = False
        self.lock = threading.Lock()

    def execute(self, *a):
        time.sleep(random.uniform(0.005, 0.03))
        return self

    def cancel_safe(self, timeout=None):
        with self.lock:
            if not self.closed:
                self.interrumpida = True

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        self.closed = True


class _PoolUnaConexion:
    """Pool de una conexión: la reemplaza si la devuelven cerrada (como psycopg_pool)."""

    def __init__(self):
        self.sem = threading.Semaphore(1)
        self.conn = _ConnCompartida()

    def getconn(self, timeout=None):
        if not self.sem.acquire(timeout=timeout):
            raise db.PoolTimeout()
        if self.conn.closed:
            self.conn = _ConnCompartida()
        self.conn.interrumpida = False
        return self.conn

    def putconn(self, conn):
        self.sem.release()


def test_estres_ninguna_consulta_exitosa_es_interrumpida(pool_limpio):
    """Muchos requests con plazos al borde de la duración de la consulta, en paralelo.

    Una consulta que terminó bien nunca debe haber sido interrumpida por la cancelación
    de un request anterior que venció.
    """
    pool = _PoolUnaConexion()
    pool_limpio.setattr(db, "get_pool", lambda: pool)
    violaciones, exitos, vencidos = [], [], []

    def consulta(c):
        c.execute("select 1")
        time.sleep(0.005)  # ventana para que una cancelación tardía llegue
        return c.interrumpida

    def request():
        try:
            interrumpida = db.ejecutar_con_plazo(consulta, random.uniform(0.01, 0.05))
            exitos.append(1)
            if interrumpida:  # terminó bien pero otro request le canceló la consulta
                violaciones.append(1)
        except db.DatabaseUnavailable:
            vencidos.append(1)

    hilos = [threading.Thread(target=request) for _ in range(150)]
    for h in hilos:
        h.start()
        time.sleep(0.002)
    for h in hilos:
        h.join(10)
    time.sleep(0.3)
    assert exitos and vencidos, "el test debe ejercitar ambos caminos"
    assert violaciones == []

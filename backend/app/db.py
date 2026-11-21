"""Conexión a Postgres (Supabase) con un pool de psycopg.

Usa `DATABASE_URL` (Supabase → Connect → Session pooler). El backend escribe con
permisos completos; la seguridad hacia el navegador la dan las políticas RLS.

- El pool se crea una sola vez aunque lleguen varios requests a la vez (lock).
- Si falta `DATABASE_URL` o la base no responde, se lanza `DatabaseUnavailable`,
  que la API convierte en un 503.
- Cada conexión nueva fija `statement_timeout` del lado del servidor (el pooler de
  Supabase ignora el parámetro `options`, así que se hace con SET al abrirla).
- `ejecutar_con_plazo` acota todo el trabajo (conexión, consulta y commit) del lado del
  cliente: el llamador responde dentro del plazo aunque la base se cuelgue en cualquier
  punto; la cancelación y el descarte de la conexión siguen en segundo plano.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from contextlib import contextmanager
from typing import TypeVar

import psycopg
from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

from app.config import get_settings

CONNECT_TIMEOUT_S = 5        # tiempo máximo para abrir una conexión nueva
DEFAULT_WAIT_S = 10          # tiempo máximo esperando una conexión del pool
STATEMENT_TIMEOUT = "20s"    # tope del servidor para cualquier consulta

T = TypeVar("T")

_pool: ConnectionPool | None = None
_lock = threading.Lock()
# Hilos para correr trabajo con plazo del lado del cliente, y para limpiar lo que venció
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="db-plazo")
_limpieza = ThreadPoolExecutor(max_workers=2, thread_name_prefix="db-limpieza")


class DatabaseUnavailable(RuntimeError):
    """La base no está configurada o no responde."""


def _configurar(conn: Connection) -> None:
    conn.execute(f"set statement_timeout = '{STATEMENT_TIMEOUT}'")
    conn.commit()


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is not None:
        return _pool
    with _lock:
        if _pool is None:  # otro hilo pudo crearlo mientras esperábamos el lock
            url = get_settings().database_url
            if not url:
                raise DatabaseUnavailable("Falta DATABASE_URL")
            try:
                _pool = ConnectionPool(
                    url,
                    min_size=1,
                    max_size=5,
                    kwargs={"row_factory": dict_row, "prepare_threshold": None,
                            "connect_timeout": CONNECT_TIMEOUT_S},
                    configure=_configurar,
                    open=True,
                )
            except (psycopg.Error, ValueError) as e:  # URL mal formada, etc.
                raise DatabaseUnavailable(f"No se pudo crear el pool: {type(e).__name__}") from e
    return _pool


def _descartar(conn: Connection) -> None:
    """Marca la conexión como inservible: se cierra y el pool no la reutiliza."""
    conn._drena_descartar = True  # type: ignore[attr-defined]


@contextmanager
def get_conn(timeout: float = DEFAULT_WAIT_S) -> Iterator[Connection]:
    """Conexión del pool. Hace commit al salir sin error y rollback si hubo una excepción."""
    pool = get_pool()
    try:
        conn = pool.getconn(timeout=timeout)
    except PoolTimeout as e:
        raise DatabaseUnavailable("La base no respondió a tiempo") from e
    try:
        yield conn
        if not conn.closed:
            conn.commit()
    except BaseException:
        # Una conexión descartada puede seguir ocupada por una consulta colgada:
        # no se le hace rollback (bloquearía); se cierra y el pool la reemplaza.
        if getattr(conn, "_drena_descartar", False):
            conn.close()
        elif not conn.closed:
            conn.rollback()
        raise
    finally:
        # Una conexión abandonada por plazo vencido no se reutiliza aunque haya terminado bien.
        if getattr(conn, "_drena_descartar", False) and not conn.closed:
            conn.close()
        pool.putconn(conn)


class _Abandonado(Exception):
    """El llamador ya respondió por plazo vencido; el trabajo no debe seguir."""


def _cancelar_en_segundo_plano(conn: Connection) -> None:
    try:
        conn.cancel_safe(timeout=2)
    except Exception:  # el servidor tampoco responde a la cancelación
        pass


def ejecutar_con_plazo(fn: Callable[[Connection], T], plazo: float) -> T:
    """Pide una conexión, corre `fn(conn)` y hace commit, todo dentro de `plazo` segundos.

    El llamador recibe la respuesta (o `DatabaseUnavailable`) en a lo más `plazo` segundos,
    aunque la base se cuelgue en cualquier punto: al pedir la conexión, en la consulta, en el
    commit o al cancelar. Si vence:
    - si el trabajo aún no empezaba (todos los hilos ocupados), se cancela y nunca corre;
    - si ya empezó, la conexión se marca para descartar y la cancelación se pide en segundo
      plano, sin hacer esperar al llamador.
    """
    limite = time.monotonic() + plazo
    estado: dict = {"conn": None, "abandonado": False}
    candado = threading.Lock()

    def trabajo() -> T:
        with get_conn(timeout=max(0.01, limite - time.monotonic())) as conn:
            with candado:
                if estado["abandonado"]:
                    _descartar(conn)
                    raise _Abandonado
                estado["conn"] = conn
            try:
                return fn(conn)
            except psycopg.OperationalError:
                _descartar(conn)
                raise

    fut = _executor.submit(trabajo)
    try:
        return fut.result(timeout=max(0.0, limite - time.monotonic()))
    except FuturesTimeout:
        fut.cancel()  # si no alcanzó a empezar, nunca se ejecuta
        with candado:
            estado["abandonado"] = True
            conn = estado["conn"]
        if conn is not None:
            _descartar(conn)
            _limpieza.submit(_cancelar_en_segundo_plano, conn)
        raise DatabaseUnavailable("La base no respondió a tiempo") from None
    except psycopg.OperationalError as e:
        raise DatabaseUnavailable(f"Se perdió la conexión: {type(e).__name__}") from e


def precalentar_pool(espera_s: float = 15) -> threading.Thread | None:
    """Abre el pool y su primera conexión en segundo plano al arrancar la app.

    Abrir la primera conexión a Supabase tarda ~3 s; sin esto, el primer /health/db
    después de un arranque en frío vencería su plazo. No bloquea el arranque y no falla
    si la base no está disponible.
    """
    if not get_settings().database_url:
        return None

    def _calentar() -> None:
        try:
            # Pedir y devolver una conexión. (pool.wait() cerraría el pool si la base no responde.)
            with get_conn(timeout=espera_s):
                pass
        except Exception:
            pass  # el primer request reintentará y responderá 503 si sigue caída

    hilo = threading.Thread(target=_calentar, name="db-precalentar", daemon=True)
    hilo.start()
    return hilo


def close_pool() -> None:
    global _pool
    with _lock:
        if _pool is not None:
            _pool.close()
            _pool = None

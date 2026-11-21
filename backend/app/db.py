"""Conexión a Postgres (Supabase) con un pool de psycopg.

Usa `DATABASE_URL` (Supabase → Connect → Session pooler). El backend escribe con
permisos completos; la seguridad hacia el navegador la dan las políticas RLS.

- El pool se crea una sola vez aunque lleguen varios requests a la vez (lock).
- Si falta `DATABASE_URL` o la base no responde, se lanza `DatabaseUnavailable`,
  que la API convierte en un 503.
- Cada conexión nueva fija `statement_timeout` del lado del servidor (el pooler de
  Supabase ignora el parámetro `options`, así que se hace con SET al abrirla).
- `ejecutar_con_timeout` acota una consulta también del lado del cliente: si la base
  deja de responder después de entregar la conexión (red colgada), se cancela, la
  conexión se descarta y se lanza `DatabaseUnavailable`.
"""
from __future__ import annotations

import threading
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
# Hilos para correr consultas con tope de tiempo del lado del cliente
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="db-timeout")


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
        pool.putconn(conn)


def ejecutar_con_timeout(conn: Connection, fn: Callable[[Connection], T], timeout: float) -> T:
    """Corre `fn(conn)` con un tope de `timeout` segundos medido en el cliente.

    Si vence, pide al servidor cancelar la consulta, descarta la conexión y lanza
    `DatabaseUnavailable`. Usar dentro de `get_conn()`.
    """
    fut = _executor.submit(fn, conn)
    try:
        return fut.result(timeout=max(0.0, timeout))
    except FuturesTimeout:
        try:
            conn.cancel_safe(timeout=1)
        except Exception:  # el servidor tampoco responde a la cancelación
            pass
        _descartar(conn)
        raise DatabaseUnavailable("La base no respondió a la consulta a tiempo") from None
    except psycopg.OperationalError as e:
        _descartar(conn)
        raise DatabaseUnavailable(f"Se perdió la conexión: {type(e).__name__}") from e


def close_pool() -> None:
    global _pool
    with _lock:
        if _pool is not None:
            _pool.close()
            _pool = None

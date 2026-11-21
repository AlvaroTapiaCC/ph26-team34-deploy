"""Conexión a Postgres (Supabase) con un pool de psycopg.

Usa `DATABASE_URL` (Supabase → Connect → Session pooler). El backend escribe con
permisos completos; la seguridad hacia el navegador la dan las políticas RLS.

- El pool se crea una sola vez aunque lleguen varios requests a la vez (lock).
- Si falta `DATABASE_URL` o la base no responde, se lanza `DatabaseUnavailable`,
  que la API convierte en un 503.
"""
from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

from app.config import get_settings

CONNECT_TIMEOUT_S = 5      # tiempo máximo para abrir una conexión nueva
DEFAULT_WAIT_S = 10        # tiempo máximo esperando una conexión del pool

_pool: ConnectionPool | None = None
_lock = threading.Lock()


class DatabaseUnavailable(RuntimeError):
    """La base no está configurada o no responde."""


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
                    open=True,
                )
            except (psycopg.Error, ValueError) as e:  # URL mal formada, etc.
                raise DatabaseUnavailable(f"No se pudo crear el pool: {type(e).__name__}") from e
    return _pool


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
        if not conn.closed:
            conn.rollback()
        raise
    finally:
        pool.putconn(conn)


def close_pool() -> None:
    global _pool
    with _lock:
        if _pool is not None:
            _pool.close()
            _pool = None

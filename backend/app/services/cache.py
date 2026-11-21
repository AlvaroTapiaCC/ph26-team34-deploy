"""Caché de respuestas de Claude (plan §5.5).

Clave = sha256(contenido) + versión del prompt. Con lo mismo no se vuelve a llamar
a Claude, y la demo da siempre el mismo resultado. Vive en la tabla `claude_cache`;
si la base no está disponible, cae a un diccionario en memoria.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Any

from psycopg.types.json import Jsonb

from app.db import get_conn

log = logging.getLogger(__name__)
_memoria: dict[str, dict[str, Any]] = {}


def cache_key(contenido: bytes | str, prompt_version: str) -> str:
    data = contenido.encode("utf-8") if isinstance(contenido, str) else contenido
    return f"{prompt_version}:{hashlib.sha256(data).hexdigest()}"


def get(key: str) -> dict[str, Any] | None:
    """Devuelve {'respuesta': ..., 'modelo': ...} o None."""
    try:
        with get_conn() as conn:
            row = conn.execute("select respuesta, modelo from claude_cache where cache_key = %s", (key,)).fetchone()
        return dict(row) if row else None
    except Exception as e:  # sin base: caché en memoria
        log.warning("claude_cache no disponible (%s); uso memoria", type(e).__name__)
        return _memoria.get(key)


def put(key: str, respuesta: dict[str, Any], modelo: str) -> None:
    _memoria[key] = {"respuesta": respuesta, "modelo": modelo}
    try:
        with get_conn() as conn:
            conn.execute(
                "insert into claude_cache (cache_key, respuesta, modelo) values (%s, %s, %s)"
                " on conflict (cache_key) do update set respuesta = excluded.respuesta, modelo = excluded.modelo",
                (key, Jsonb(respuesta), modelo),
            )
    except Exception as e:
        log.warning("no se pudo guardar en claude_cache (%s)", type(e).__name__)

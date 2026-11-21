"""Fotos en Supabase Storage, en un bucket PRIVADO (revisión del PR #57).

El backend sube con la secret key y entrega enlaces firmados que vencen. En la base
se guarda solo la ruta dentro del bucket (`observations.media_url`, `closures.foto_url`),
nunca una URL pública.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import httpx

from app.config import get_settings

TIMEOUT_S = 15
EXPIRA_POR_DEFECTO_S = 60 * 60  # 1 hora

_client: httpx.Client | None = None


class StorageError(RuntimeError):
    """Supabase Storage no está configurado o respondió con error."""


def _get_client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=TIMEOUT_S)
    return _client


def _base_y_headers() -> tuple[str, dict[str, str]]:
    s = get_settings()
    if not s.supabase_url or not s.supabase_service_key:
        raise StorageError("Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY")
    key = s.supabase_service_key
    return s.supabase_url.rstrip("/") + "/storage/v1", {"apikey": key, "Authorization": f"Bearer {key}"}


def _bucket() -> str:
    return get_settings().storage_bucket


def nueva_ruta(carpeta: str, extension: str = "jpg") -> str:
    """Ruta única dentro del bucket, p. ej. 'observaciones/2026-11-21/<uuid>.jpg'."""
    dia = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"{carpeta.strip('/')}/{dia}/{uuid.uuid4().hex}.{extension.lstrip('.')}"


def subir(data: bytes, ruta: str, content_type: str = "image/jpeg") -> str:
    """Sube el archivo al bucket privado y devuelve su ruta (lo que se guarda en la base)."""
    base, headers = _base_y_headers()
    try:
        r = _get_client().post(
            f"{base}/object/{_bucket()}/{ruta}",
            headers={**headers, "Content-Type": content_type, "x-upsert": "false"},
            content=data,
        )
    except httpx.HTTPError as e:
        raise StorageError(f"No se pudo subir la foto: {type(e).__name__}") from e
    if r.status_code >= 400:
        raise StorageError(f"Storage respondió {r.status_code} al subir")
    return ruta


def url_firmada(ruta: str, expira_s: int = EXPIRA_POR_DEFECTO_S) -> str:
    """Enlace temporal para ver una foto privada."""
    base, headers = _base_y_headers()
    try:
        r = _get_client().post(f"{base}/object/sign/{_bucket()}/{ruta}", headers=headers,
                               json={"expiresIn": int(expira_s)})
    except httpx.HTTPError as e:
        raise StorageError(f"No se pudo firmar la URL: {type(e).__name__}") from e
    if r.status_code >= 400:
        raise StorageError(f"Storage respondió {r.status_code} al firmar")
    firmada = r.json().get("signedURL") or r.json().get("signedUrl")
    if not firmada:
        raise StorageError("Storage no devolvió signedURL")
    return firmada if firmada.startswith("http") else base + firmada


def borrar(rutas: list[str]) -> None:
    base, headers = _base_y_headers()
    try:
        r = _get_client().request("DELETE", f"{base}/object/{_bucket()}", headers=headers,
                                  json={"prefixes": rutas})
    except httpx.HTTPError as e:
        raise StorageError(f"No se pudo borrar: {type(e).__name__}") from e
    if r.status_code >= 400:
        raise StorageError(f"Storage respondió {r.status_code} al borrar")

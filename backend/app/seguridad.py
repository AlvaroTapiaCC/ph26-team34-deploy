"""Tokens simples para la demo (sin cuentas de usuario).

- ADMIN_TOKEN: secreto de operación (recalcular, ver posiciones de cuadrillas reales).
  Nunca va al frontend.
- CREW_TOKEN: lo usa la app de cuadrilla desde el navegador; es casi público.
Si una variable está vacía, ese control no se exige (desarrollo).
"""
import hmac

from fastapi import Header, HTTPException

from app.config import get_settings


def _coincide(recibido: str | None, esperado: str) -> bool:
    return hmac.compare_digest(recibido or "", esperado)


def es_admin(x_admin_token: str | None) -> bool:
    esperado = get_settings().admin_token
    return bool(esperado) and _coincide(x_admin_token, esperado)


def exigir_cuadrilla(x_crew_token: str | None = Header(default=None)) -> None:
    esperado = get_settings().crew_token
    if esperado and not _coincide(x_crew_token, esperado):
        raise HTTPException(401, "Falta o es inválido X-Crew-Token")

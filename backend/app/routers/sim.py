"""Línea de tiempo de la demo (issue #46)."""
import hmac
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.config import get_settings
from app.db import get_conn
from app.services import reinicio
from app.services.sim import TopeAlcanzado, get_simulador


def _exigir_admin(x_admin_token: str | None = Header(default=None)) -> None:
    """Si hay ADMIN_TOKEN configurado, los controles de la demo exigen X-Admin-Token."""
    esperado = get_settings().admin_token
    if esperado and not hmac.compare_digest(x_admin_token or "", esperado):
        raise HTTPException(401, "Falta o es inválido X-Admin-Token")


def _exigir_sim(x_admin_token: str | None = Header(default=None), x_sim_token: str | None = Header(default=None)) -> None:
    """/sim/trigger acepta SIM_TOKEN (el del navegador) o ADMIN_TOKEN. Sin SIM_TOKEN, queda abierto."""
    cfg = get_settings()
    if not cfg.sim_token:
        return
    ok_sim = hmac.compare_digest(x_sim_token or "", cfg.sim_token)
    ok_admin = bool(cfg.admin_token) and hmac.compare_digest(x_admin_token or "", cfg.admin_token)
    if not (ok_sim or ok_admin):
        raise HTTPException(401, "Falta o es inválido X-Sim-Token")


router = APIRouter(prefix="/sim", tags=["sim"])


class ReporteEnVivo(BaseModel):
    sumidero_id: str | None = Field(default=None, max_length=64)
    texto: str = Field(default="Reporte disparado en vivo durante la demo", max_length=500)
    fuente: Literal["vecino", "cuadrilla", "camara"] = "vecino"
    tipo_obs: Literal["foto_rejilla", "foto_agua", "texto", "cuadro_camara"] = "texto"
    media_url: str | None = Field(default=None, max_length=500)


@router.post("/start", dependencies=[Depends(_exigir_admin)])
def start() -> dict[str, Any]:
    """Inicia (o reanuda) la simulación; si ya terminó, la parte de cero."""
    return get_simulador().start()


@router.post("/stop", dependencies=[Depends(_exigir_admin)])
def stop() -> dict[str, Any]:
    """Pausa la simulación conservando el avance."""
    return get_simulador().stop()


@router.post("/reset", dependencies=[Depends(_exigir_admin)])
def reset(desde: datetime | None = None) -> dict[str, Any]:
    """Reinicia la demo para ensayarla de nuevo (#97).

    Borra lo que generó la demo desde el último reinicio (observaciones, casos, eventos y el plan
    de las cuadrillas simuladas), recalcula los puntajes, genera de nuevo el plan inicial y vuelve
    el reloj del simulador al inicio. No toca catastro, variables, predicción congelada, caché de
    Claude ni datos de cuadrillas reales. `desde` (ISO 8601) fija el corte a mano; sin marca previa
    y sin `desde` no borra observaciones. Si la base no responde: 503 y no se borra nada.
    """
    if desde is not None and desde.tzinfo is None:
        raise HTTPException(422, "`desde` necesita zona horaria (por ejemplo 2026-11-22T08:00:00-03:00)")
    with get_conn() as conn:
        r = reinicio.reiniciar(conn, desde)
    # Se mantiene la respuesta de antes (estado del simulador) y se agrega el reinicio de los datos
    return {**get_simulador().reset(), "datos": r}


@router.get("/status")
def status() -> dict[str, Any]:
    """Estado, tiempo simulado y eventos aplicados hasta ahora."""
    return get_simulador().status()


@router.post("/trigger", dependencies=[Depends(_exigir_sim)])
def trigger(reporte: ReporteEnVivo | None = None) -> dict[str, Any]:
    """Dispara un reporte en vivo (botón "Disparar reporte" de /central)."""
    try:
        return get_simulador().disparar((reporte or ReporteEnVivo()).model_dump(exclude_none=True))
    except TopeAlcanzado as exc:
        raise HTTPException(429, str(exc)) from exc

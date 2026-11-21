"""Línea de tiempo de la demo (issue #46)."""
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.services.sim import get_simulador

router = APIRouter(prefix="/sim", tags=["sim"])


class ReporteEnVivo(BaseModel):
    sumidero_id: str | None = None
    texto: str = "Reporte disparado en vivo durante la demo"
    fuente: str = "vecino"
    tipo_obs: str = "texto"
    media_url: str | None = None


@router.post("/start")
def start() -> dict[str, Any]:
    """Inicia (o reanuda) la simulación; si ya terminó, la parte de cero."""
    return get_simulador().start()


@router.post("/stop")
def stop() -> dict[str, Any]:
    """Pausa la simulación conservando el avance."""
    return get_simulador().stop()


@router.post("/reset")
def reset() -> dict[str, Any]:
    """Vuelve al inicio y borra los eventos aplicados."""
    return get_simulador().reset()


@router.get("/status")
def status() -> dict[str, Any]:
    """Estado, tiempo simulado y eventos aplicados hasta ahora."""
    return get_simulador().status()


@router.post("/trigger")
def trigger(reporte: ReporteEnVivo | None = None) -> dict[str, Any]:
    """Dispara un reporte en vivo (botón "Disparar reporte" de /central)."""
    return get_simulador().disparar((reporte or ReporteEnVivo()).model_dump(exclude_none=True))

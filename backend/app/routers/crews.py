"""Cuadrillas y rutas (plan §9.5, issues #33 y #39)."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/crews", tags=["crews"])


@router.get("")
def list_crews():
    """Lista de cuadrillas."""
    raise HTTPException(status_code=501, detail="No implementado todavía")


@router.post("/{crew_id}/position")
def update_position(crew_id: str):
    """Actualiza la posición de una cuadrilla."""
    raise HTTPException(status_code=501, detail="No implementado todavía")


@router.get("/{crew_id}/route")
def get_route(crew_id: str):
    """Ruta vigente de una cuadrilla."""
    raise HTTPException(status_code=501, detail="No implementado todavía")


@router.get("/{crew_id}/next/audio")
def next_audio(crew_id: str):
    """Audio de ElevenLabs con la siguiente misión."""
    raise HTTPException(status_code=501, detail="No implementado todavía")

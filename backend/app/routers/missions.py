"""Avance y cierre de misiones (plan §9.5, issues #33 y #42)."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/missions", tags=["missions"])


@router.post("/{mission_id}/status")
def update_status(mission_id: str):
    """Cambia el estado de una misión."""
    raise HTTPException(status_code=501, detail="No implementado todavía")


@router.post("/{mission_id}/close")
def close_mission(mission_id: str):
    """Cierre verificado con foto."""
    raise HTTPException(status_code=501, detail="No implementado todavía")

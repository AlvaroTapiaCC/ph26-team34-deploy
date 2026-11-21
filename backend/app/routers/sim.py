"""Línea de tiempo de la demo (issue #46)."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/sim", tags=["sim"])


@router.post("/start")
def start():
    """Inicia la simulación."""
    raise HTTPException(status_code=501, detail="No implementado todavía")


@router.post("/stop")
def stop():
    """Detiene la simulación."""
    raise HTTPException(status_code=501, detail="No implementado todavía")


@router.post("/reset")
def reset():
    """Reinicia la simulación."""
    raise HTTPException(status_code=501, detail="No implementado todavía")

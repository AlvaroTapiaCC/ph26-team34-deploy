"""Recálculo de la fórmula (plan §6, issue #21)."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/formula", tags=["formula"])


@router.post("/recompute")
def recompute():
    """Recalcula P, P_ef, C y prioridad de todos los sumideros."""
    raise HTTPException(status_code=501, detail="No implementado todavía")

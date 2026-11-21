"""Entrada de fotos y textos (plan §9.2, issue #28)."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/observations", tags=["observations"])


@router.post("")
def create_observation():
    """Foto o texto → Claude → recálculo → despacho."""
    raise HTTPException(status_code=501, detail="No implementado todavía")

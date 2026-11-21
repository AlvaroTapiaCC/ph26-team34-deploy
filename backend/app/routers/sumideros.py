"""Ficha de sumidero (plan §9.5, issue #33)."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/sumideros", tags=["sumideros"])


@router.get("/{sumidero_id}")
def get_sumidero(sumidero_id: str):
    """Variables, cadena aguas abajo, observaciones y explicación."""
    raise HTTPException(status_code=501, detail="No implementado todavía")

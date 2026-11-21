"""Escenarios de lluvia y tabla de misiones (plan §9.5, issues #17 y #21)."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/scenarios", tags=["scenarios"])


@router.get("")
def list_scenarios():
    """Lista de escenarios de lluvia."""
    raise HTTPException(status_code=501, detail="No implementado todavía")


@router.get("/{scenario_id}/ranking")
def get_ranking(scenario_id: str, modo: str = 'antes'):
    """Tabla de misiones ordenada por prioridad."""
    raise HTTPException(status_code=501, detail="No implementado todavía")

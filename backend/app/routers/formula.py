"""Recálculo de la fórmula (plan §6, issue #21)."""
from typing import Literal

from fastapi import APIRouter, HTTPException

from app.db import get_conn
from app.services.scoring import recalcular, recalcular_todo

router = APIRouter(prefix="/formula", tags=["formula"])


@router.post("/recompute")
def recompute(
    scenario_id: str | None = None,
    modo: Literal["antes", "durante"] | None = None,
    incluir_simulados: bool = True,
):
    """Recalcula P, P_ef, C y prioridad. Sin parámetros, recalcula todos los escenarios y modos."""
    with get_conn() as conn:
        if scenario_id is None:
            return {"recalculado": recalcular_todo(conn, incluir_simulados)}
        modos = [modo] if modo else ["antes", "durante"]
        try:
            return {
                "recalculado": {
                    f"{scenario_id}/{m}": len(recalcular(conn, scenario_id, m, incluir_simulados)) for m in modos
                }
            }
        except KeyError:
            raise HTTPException(404, f"Escenario {scenario_id} no existe") from None

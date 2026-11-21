"""Recálculo de la fórmula (plan §6, issue #21)."""
import hmac
from typing import Literal

from fastapi import APIRouter, Header, HTTPException

from app.config import get_settings
from app.db import get_conn
from app.services.scoring import calcular, recalcular, recalcular_todo

router = APIRouter(prefix="/formula", tags=["formula"])


def _exigir_admin(x_admin_token: str | None) -> None:
    esperado = get_settings().admin_token
    if esperado and not hmac.compare_digest(x_admin_token or "", esperado):
        raise HTTPException(401, "Falta o es inválido X-Admin-Token")


@router.post("/recompute")
def recompute(
    scenario_id: str | None = None,
    modo: Literal["antes", "durante"] | None = None,
    incluir_simulados: bool = True,
    x_admin_token: str | None = Header(default=None),
):
    """Recalcula P, P_ef, C y prioridad.

    - Con datos completos (por defecto) guarda en `scores`: es la tabla de misiones de la demo.
      Sin parámetros recalcula todos los escenarios y modos.
    - Con `incluir_simulados=false` (prueba de campo, §8.1) calcula sin datos simulados y
      devuelve el ranking SIN guardarlo, para no pisar la tabla de la demo. Requiere `scenario_id`.
      Respuesta: `resultados[modo]` con la lista ordenada; sin `modo`, ambos modos.

    Síncrono: con los ~cientos de sumideros de la demo tarda menos de un segundo.
    """
    _exigir_admin(x_admin_token)
    with get_conn() as conn:
        modos = [modo] if modo else ["antes", "durante"]
        if not incluir_simulados:
            if scenario_id is None:
                raise HTTPException(422, "incluir_simulados=false requiere scenario_id")
            try:
                resultados = {m: calcular(conn, scenario_id, m, incluir_simulados=False) for m in modos}
            except KeyError:
                raise HTTPException(404, f"Escenario {scenario_id} no existe") from None
            return {
                "guardado": False,
                "scenario_id": scenario_id,
                # Igual que el recálculo normal: sin `modo`, ambos modos
                "resultados": {
                    m: [{"rank": s.rank, "sumidero_id": s.sumidero_id, "p_pred": s.p_pred, "p_ef": s.p_ef,
                         "c": s.c, "prioridad": s.prioridad, "detalle": s.detalle} for s in scores]
                    for m, scores in resultados.items()
                },
            }
        if scenario_id is None:
            return {"guardado": True, "recalculado": recalcular_todo(conn)}
        try:
            return {"guardado": True,
                    "recalculado": {f"{scenario_id}/{m}": len(recalcular(conn, scenario_id, m)) for m in modos}}
        except KeyError:
            raise HTTPException(404, f"Escenario {scenario_id} no existe") from None

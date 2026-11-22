"""Plan de despacho (plan §7.2, issue #32)."""
import hmac

from fastapi import APIRouter, Header, HTTPException

from app.config import get_settings
from app.db import get_conn
from app.services import dispatch

router = APIRouter(prefix="/dispatch", tags=["dispatch"])


def _exigir_admin(x_admin_token: str | None) -> None:
    esperado = get_settings().admin_token
    if esperado and not hmac.compare_digest(x_admin_token or "", esperado):
        raise HTTPException(401, "Falta o es inválido X-Admin-Token")


@router.post("/plan")
def plan(x_admin_token: str | None = Header(default=None)):
    """Genera o actualiza el plan de todas las cuadrillas: la tabla y la ruta inicial de "Antes".

    Toma las rejillas de mayor prioridad de la zona MUT y los casos urgentes, las reparte por
    equipamiento, traslado por calle y carga, y guarda solo lo que cambió (misiones, una versión
    nueva de ruta y un evento `replan` por cuadrilla). Las misiones ya iniciadas no se mueven.
    Llamarlo dos veces sin datos nuevos no crea nada. Requiere `X-Admin-Token`.
    """
    _exigir_admin(x_admin_token)
    with get_conn() as conn:
        return dispatch.planificar(conn, "plan_inicial")

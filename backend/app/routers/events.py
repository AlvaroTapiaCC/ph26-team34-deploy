"""Informe Después (plan §7.3, issue #43)."""
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Header, HTTPException, Query, Response
from pydantic import AwareDatetime

from app.db import get_conn
from app.seguridad import es_admin
from app.services import report as informe

router = APIRouter(prefix="/events", tags=["events"])


@router.get("/report")
def report(
    response: Response,
    desde: AwareDatetime | None = Query(default=None),
    hasta: AwareDatetime | None = Query(default=None),
    incluir_simulados: bool = Query(default=False),
    x_admin_token: str | None = Header(default=None),
):
    """Resume la auditoría de una ventana de recepción. Por defecto, las últimas 24 horas."""
    if not x_admin_token or not x_admin_token.isascii() or not es_admin(x_admin_token):
        raise HTTPException(401, "Falta o es inválido X-Admin-Token")
    fin = hasta.astimezone(UTC) if hasta is not None else datetime.now(UTC)
    inicio = desde.astimezone(UTC) if desde is not None else fin - timedelta(hours=24)
    if inicio >= fin:
        raise HTTPException(422, "Desde debe ser anterior a hasta")
    with get_conn() as conn:
        metricas = informe.medir(conn, inicio, fin, incluir_simulados)
    response.headers["Cache-Control"] = "no-store"
    return {
        "desde": inicio, "hasta": fin, "incluye_simulados": incluir_simulados,
        "metricas": metricas, "redaccion": informe.redactar(metricas, incluir_simulados=incluir_simulados),
    }

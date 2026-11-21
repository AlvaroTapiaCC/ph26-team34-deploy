"""Informe Después (plan §7.3, issue #43)."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/events", tags=["events"])


@router.get("/report")
def report():
    """Informe del evento."""
    raise HTTPException(status_code=501, detail="No implementado todavía")

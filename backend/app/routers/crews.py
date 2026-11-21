"""Cuadrillas y rutas (plan §9.5, issue #33; la voz es #39)."""
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.db import get_conn
from app.seguridad import es_admin, exigir_cuadrilla
from app.services import cuadrillas

router = APIRouter(prefix="/crews", tags=["crews"])


@router.get("")
def list_crews(x_admin_token: str | None = Header(default=None)):
    """Cuadrillas con estado, equipamiento, carga (misiones activas) y posición.

    La posición de una cuadrilla real solo se entrega con `X-Admin-Token`; las simuladas
    (las de la demo) se muestran siempre.
    """
    with get_conn() as conn:
        return cuadrillas.listar(conn, ver_privado=es_admin(x_admin_token))


class PosicionIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


@router.post("/{crew_id}/position", dependencies=[Depends(exigir_cuadrilla)])
def update_position(crew_id: str, body: PosicionIn):
    """Actualiza la posición de una cuadrilla y la guarda en su historial (`crew_positions`)."""
    try:
        with get_conn() as conn:
            return cuadrillas.actualizar_posicion(conn, crew_id, body.lat, body.lon)
    except cuadrillas.PosicionInvalida as e:
        raise HTTPException(422, str(e)) from None
    except cuadrillas.NoEncontrado as e:
        raise HTTPException(404, str(e)) from None


@router.get("/{crew_id}/route")
def get_route(crew_id: str, x_admin_token: str | None = Header(default=None)):
    """Ruta vigente: la última guardada por el despacho o, si no hay, calculada con las misiones activas.

    `origen` indica cuál: `despacho`, `calculada` o `sin_misiones`. Para una cuadrilla real sin
    `X-Admin-Token` la ruta parte en la primera parada (nunca en su posición) y viene
    `posicion_oculta: true`; las simuladas parten siempre en su posición.

    `ultimo_cambio` es el último re-planeo del despacho (motivo, hora, siguiente parada antes y
    después, y la clasificación de la observación que lo causó, sin su texto ni su foto) o `null`.
    """
    try:
        with get_conn() as conn:
            return cuadrillas.ruta(conn, crew_id, ver_privado=es_admin(x_admin_token))
    except cuadrillas.NoEncontrado as e:
        raise HTTPException(404, str(e)) from None


@router.get("/{crew_id}/next/audio")
def next_audio(crew_id: str):
    """Audio de ElevenLabs con la siguiente misión (issue #39)."""
    raise HTTPException(status_code=501, detail="No implementado todavía (#39)")

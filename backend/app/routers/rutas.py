"""Rutas por calle (issue #31). Endpoint para probar rutas y para el frontend.

Las rutas de cada cuadrilla se arman en el despacho (#32) y se leen en GET /crews/{id}/route.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import routing

router = APIRouter(prefix="/rutas", tags=["rutas"])


class RutaIn(BaseModel):
    # [[lat, lon], ...] en el orden en que se visitan
    puntos: list[tuple[float, float]] = Field(min_length=2, max_length=routing.MAX_PUNTOS_RUTA)


@router.post("")
def calcular_ruta(body: RutaIn):
    """Ruta por calle que pasa por los puntos en orden. `fuente = linea_recta` si OSRM no respondió."""
    try:
        return routing.ruta(body.puntos).to_dict()
    except ValueError as e:
        raise HTTPException(422, str(e)) from None

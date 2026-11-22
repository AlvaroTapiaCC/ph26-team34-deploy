"""Clima en vivo de la zona MUT (issue #13): modo de la página, plazo y fuente."""
from fastapi import APIRouter

from app.services import clima

router = APIRouter(prefix="/clima", tags=["clima"])


@router.get("")
def get_clima():
    """Modo (seco, tormenta_inminente, durante, despues, sin_dato), plazo y fuente.

    Datos reales de Open-Meteo con caché de 1 hora. `vigente = False` indica que Open-Meteo
    no respondió y se muestra el último valor obtenido (o `sin_dato` si no hay ninguno).
    """
    return clima.clima_actual()

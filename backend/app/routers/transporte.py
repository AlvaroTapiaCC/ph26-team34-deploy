"""Transporte público: paraderos expuestos al agua y paradero alternativo (issue #91).

Se calcula en cada consulta; el tablero consulta cada pocos segundos (#92).
"""
from fastapi import APIRouter

from app.db import ejecutar_con_plazo
from app.services import transporte

router = APIRouter(prefix="/transporte", tags=["transporte"])

PLAZO_S = 8  # el tablero vuelve a consultar en segundos: mejor un 503 rápido que colgarse


@router.get("/expuestos")
def get_expuestos(scenario: str = "base", incluir_simulados: bool = True):
    """Paraderos `expuestos` (agua observada cerca) y `en_riesgo` (solo prioridad alta), en listas
    separadas. Cada servicio de un paradero expuesto trae su paradero alternativo o el motivo
    de que no haya. `evidencia_agua` contiene la última observación de agua vigente por rejilla
    para la capa de cadenas. Si la base no responde a tiempo con GTFS disponible: 503."""
    return transporte.expuestos(lambda fn: ejecutar_con_plazo(fn, PLAZO_S),
                                scenario_id=scenario, incluir_simulados=incluir_simulados)

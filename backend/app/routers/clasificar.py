"""Clasificación directa con Claude, sin crear observaciones.

Sirve para la prueba de campo (#30), para probar prompts y para que /reportar muestre
el resultado. El flujo completo (guardar, asociar al sumidero, recalcular) es POST /observations (#28).
"""
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.services.claude_text import NUMEROS_EMERGENCIA, leer_texto
from app.services.claude_vision import clasificar_camara, clasificar_rejilla, senal_camara

router = APIRouter(prefix="/clasificar", tags=["clasificar"])
MAX_BYTES = 15 * 1024 * 1024


async def _leer(foto: UploadFile) -> bytes:
    data = await foto.read()
    if not data:
        raise HTTPException(400, "Archivo vacío")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "La foto pesa más de 15 MB")
    return data


@router.post("/rejilla")
async def rejilla(foto: UploadFile = File(...)):
    """§5.1 Clasifica la foto de una rejilla."""
    r = clasificar_rejilla(await _leer(foto))
    return {"clasificacion": r.resultado, **r.meta()}


@router.post("/camara")
async def camara(foto: UploadFile = File(...)):
    """§5.2 Describe un cuadro de la cámara y devuelve la señal para la fórmula."""
    r = clasificar_camara(await _leer(foto))
    return {"clasificacion": r.resultado, "senal_camara": senal_camara(r.resultado), **r.meta()}


class TextoIn(BaseModel):
    texto: str = Field(min_length=3, max_length=2000)


@router.post("/texto")
def texto(body: TextoIn):
    """§5.3 Lee el texto de un vecino. Si hay personas en riesgo, devuelve los números de emergencia."""
    r = leer_texto(body.texto)
    urgente = r.resultado.personas_en_riesgo
    return {
        "lectura": r.resultado,
        "urgente": urgente,
        "numeros_emergencia": NUMEROS_EMERGENCIA if urgente else [],
        **r.meta(),
    }

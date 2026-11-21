"""Clasificación directa con Claude, sin crear observaciones.

Sirve para la prueba de campo (#30), para probar prompts y para que /reportar muestre
el resultado. El flujo completo (guardar, asociar al sumidero, recalcular) es POST /observations (#28).

Los endpoints son funciones `def` (no `async`): Pillow, la caché en Postgres y el cliente de
Claude son bloqueantes, y FastAPI corre las funciones síncronas en su pool de hilos. Así una
clasificación lenta no detiene el event loop ni las demás peticiones del worker.
"""
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.services.claude_text import NUMEROS_EMERGENCIA, leer_texto
from app.services.claude_vision import ImagenInvalida, clasificar_camara, clasificar_rejilla, senal_camara

router = APIRouter(prefix="/clasificar", tags=["clasificar"])
MAX_BYTES = 15 * 1024 * 1024


def _leer(foto: UploadFile) -> bytes:
    data = foto.file.read(MAX_BYTES + 1)  # síncrono: corre en el hilo del endpoint
    if not data:
        raise HTTPException(400, "Archivo vacío")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "La foto pesa más de 15 MB")
    return data


def _clasificar(fn, foto: UploadFile):
    try:
        return fn(_leer(foto))
    except ImagenInvalida:
        raise HTTPException(422, "No se pudo leer la imagen. Envía una foto JPEG, PNG, WebP o HEIC.") from None


@router.post("/rejilla")
def rejilla(foto: UploadFile = File(...)):
    """§5.1 Clasifica la foto de una rejilla."""
    r = _clasificar(clasificar_rejilla, foto)
    return {"clasificacion": r.resultado, **r.meta()}


@router.post("/camara")
def camara(foto: UploadFile = File(...)):
    """§5.2 Describe un cuadro de la cámara y devuelve la señal para la fórmula."""
    r = _clasificar(clasificar_camara, foto)
    return {"clasificacion": r.resultado, "senal_camara": senal_camara(r.resultado), **r.meta()}


class TextoIn(BaseModel):
    texto: str = Field(min_length=3, max_length=2000)


@router.post("/texto")
def texto(body: TextoIn):
    """§5.3 Lee el texto de un vecino. Si hay personas en riesgo, devuelve los números de emergencia.

    Si Claude no está disponible (sin clave o caído), responde igual con la heurística local de
    riesgo: `claude_disponible` / `fallo` lo indican, y los números de emergencia se muestran si
    la heurística detecta personas en riesgo.
    """
    r = leer_texto(body.texto)
    urgente = r.resultado.personas_en_riesgo
    return {
        "lectura": r.resultado,
        "urgente": urgente,
        "numeros_emergencia": NUMEROS_EMERGENCIA if urgente else [],
        **r.meta(),
    }

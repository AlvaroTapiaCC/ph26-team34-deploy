"""Avance y cierre de misiones (plan §9.5, issue #33; la verificación con Claude es #42)."""
import base64
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.db import get_conn
from app.seguridad import exigir_cuadrilla
from app.services import cuadrillas, storage
from app.services.claude_vision import ImagenInvalida, preparar_imagen

log = logging.getLogger(__name__)
router = APIRouter(prefix="/missions", tags=["missions"])
MAX_BYTES = 15 * 1024 * 1024


class EstadoIn(BaseModel):
    estado: Literal["pendiente", "en_camino", "en_sitio", "cancelada"]


@router.post("/{mission_id}/status", dependencies=[Depends(exigir_cuadrilla)])
def update_status(mission_id: UUID, body: EstadoIn):
    """Cambia el estado: pendiente ⇄ en_camino → en_sitio; cancelada desde cualquiera activa.

    Para cerrar se usa `/close` con foto. Responde 409 si la transición no corresponde al
    estado actual (por ejemplo, otra petición ya la movió).
    """
    try:
        with get_conn() as conn:
            return cuadrillas.cambiar_estado(conn, mission_id, body.estado)
    except cuadrillas.NoEncontrado as e:
        raise HTTPException(404, str(e)) from None
    except cuadrillas.TransicionInvalida as e:
        raise HTTPException(409, str(e)) from None


@router.post("/{mission_id}/close", dependencies=[Depends(exigir_cuadrilla)])
def close_mission(mission_id: UUID, foto: UploadFile = File(...)):
    """Cierra la misión con una foto de la rejilla (desde `en_camino` o `en_sitio`).

    La foto se re-codifica a JPEG (sin metadatos EXIF, incluido el GPS del celular) y se guarda
    en el bucket privado; la respuesta trae un enlace firmado. `verificado` queda en false hasta
    que #42 la clasifique con Claude.
    """
    with get_conn() as conn:
        try:
            cuadrillas.existe_mision(conn, mission_id)
        except cuadrillas.NoEncontrado as e:
            raise HTTPException(404, str(e)) from None

    data = foto.file.read(MAX_BYTES + 1)
    if not data:
        raise HTTPException(400, "Archivo vacío")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "La foto pesa más de 15 MB")
    try:
        jpeg = base64.standard_b64decode(preparar_imagen(data)[0])
    except ImagenInvalida:
        raise HTTPException(422, "No se pudo leer la imagen. Envía una foto JPEG, PNG, WebP o HEIC.") from None

    ruta = storage.nueva_ruta("cierres")
    try:
        storage.subir(jpeg, ruta, "image/jpeg")
    except storage.StorageError as e:
        raise HTTPException(503, f"No se pudo guardar la foto: {e}") from None

    try:
        with get_conn() as conn:
            r = cuadrillas.cerrar_mision(conn, mission_id, ruta)
    except (cuadrillas.TransicionInvalida, cuadrillas.NoEncontrado) as e:
        try:  # la misión no se cerró: no dejar la foto huérfana
            storage.borrar([ruta])
        except storage.StorageError:
            log.warning("No se pudo borrar la foto huérfana %s", ruta)
        status = 409 if isinstance(e, cuadrillas.TransicionInvalida) else 404
        raise HTTPException(status, str(e)) from None

    try:
        r["cierre"]["foto_url_firmada"] = storage.url_firmada(ruta)
    except storage.StorageError:
        r["cierre"]["foto_url_firmada"] = None
    return r

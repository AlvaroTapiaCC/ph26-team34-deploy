"""Avance y cierre de misiones (plan §9.5, issues #33 y #42)."""
import base64
import logging
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.db import get_conn
from app.seguridad import exigir_cuadrilla
from app.services import cuadrillas, dispatch, storage
from app.services import observations as obs_svc
from app.services.claude_vision import (
    ImagenInvalida,
    clasificar_rejilla,
    preparar_imagen,
)
from app.services.scoring import recalcular_todo

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


def _veredicto(r) -> tuple[str, str]:
    """(resultado, motivo) del cierre según la clasificación de Claude (o su ausencia)."""
    if r is None or r.fallo:
        return "sin_verificar", "No se pudo verificar la foto con Claude; la misión se cierra sin verificar."
    c = r.resultado
    if not c.evaluable or c.rejilla == "no_evaluable":
        return "sin_verificar", f"La foto no permite evaluar la rejilla: {c.nota}"
    if c.rejilla == "limpia":
        return "verificado", c.nota
    return "rechazado", f"La rejilla se ve {c.rejilla}: {c.nota}"


@router.post("/{mission_id}/close", dependencies=[Depends(exigir_cuadrilla)])
def close_mission(mission_id: UUID, foto: UploadFile = File(...)):
    """Cierra la misión con una foto de la rejilla (desde `en_camino` o `en_sitio`), verificada con Claude (#42).

    - `limpia`: se cierra con `verificado: true`; la foto entra como observación de la rejilla, se
      recalcula la prioridad y se vuelve a planificar.
    - `parcial` o `tapada`: 200 con `cerrada: false`, `verificado: false` y `motivo`; la misión sigue
      abierta. La foto también entra como observación (sube la prioridad si corresponde).
    - `no_evaluable` o Claude caído: se cierra con `verificado: false` ("sin verificar"). La
      cuadrilla no queda bloqueada.

    La foto se re-codifica a JPEG (sin EXIF, incluido el GPS del celular) y se guarda en el bucket
    privado; la respuesta trae un enlace firmado. El agua observada en el tramo no se borra con este
    cierre: sigue mandando hasta que venza su vigencia.
    """
    with get_conn() as conn:
        try:
            mision = cuadrillas.mision_cerrable(conn, mission_id)
        except cuadrillas.NoEncontrado as e:
            raise HTTPException(404, str(e)) from None
        except cuadrillas.TransicionInvalida as e:
            raise HTTPException(409, str(e)) from None

    data = foto.file.read(MAX_BYTES + 1)
    if not data:
        raise HTTPException(400, "Archivo vacío")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "La foto pesa más de 15 MB")
    try:
        jpeg = base64.standard_b64decode(preparar_imagen(data)[0])
    except ImagenInvalida:
        raise HTTPException(422, "No se pudo leer la imagen. Envía una foto JPEG, PNG, WebP o HEIC.") from None

    # Claude sin conexión de base abierta. Cualquier falla degrada a "sin verificar", nunca a 500.
    try:
        r_claude = clasificar_rejilla(jpeg)
    except Exception:
        log.exception("Falló la clasificación de la foto de cierre de %s", mission_id)
        r_claude = None
    veredicto, motivo = _veredicto(r_claude)
    clasif = r_claude.resultado.model_dump(mode="json") if r_claude is not None else None
    # Solo una clasificación válida y evaluable entra como evidencia de la rejilla
    como_observacion = veredicto != "sin_verificar" and mision["sumidero_id"] is not None

    ruta = storage.nueva_ruta("cierres")
    try:
        storage.subir(jpeg, ruta, "image/jpeg")
    except storage.StorageError as e:
        log.warning("No se guardó la foto de cierre de %s: %s", mission_id, e)
        raise HTTPException(503, "No se pudo guardar la foto en el servidor") from None

    obs_id = None
    try:
        with get_conn() as conn:
            if veredicto == "rechazado":
                r = cuadrillas.rechazar_cierre(conn, mission_id, ruta, clasif, motivo)
            else:
                r = cuadrillas.cerrar_mision(conn, mission_id, ruta, clasif, verificado=veredicto == "verificado")
            if como_observacion:
                obs_id = obs_svc.insertar_observacion(
                    conn, obs_id=None, sumidero_id=mision["sumidero_id"], lat=mision["lat"], lon=mision["lon"],
                    fuente="cuadrilla", tipo="foto_rejilla", media_url=ruta, texto=None,
                    ts=datetime.now(timezone.utc))
                obs_svc.insertar_clasificacion(conn, obs_id, r_claude.resultado, r_claude.meta(),
                                               r_claude.respuesta_cruda)
    except (cuadrillas.TransicionInvalida, cuadrillas.NoEncontrado) as e:
        try:  # la misión no se cerró: no dejar la foto huérfana
            storage.borrar([ruta])
        except storage.StorageError:
            log.warning("No se pudo borrar la foto huérfana %s", ruta)
        status = 409 if isinstance(e, cuadrillas.TransicionInvalida) else 404
        raise HTTPException(status, str(e)) from None

    r.update({"cerrada": veredicto != "rechazado", "verificado": veredicto == "verificado",
              "resultado": veredicto, "motivo": motivo, "clasificacion": clasif, "observation_id": obs_id,
              "claude_disponible": r_claude.meta()["claude_disponible"] if r_claude is not None else False})
    if r["cierre"] is not None:
        try:
            r["cierre"]["foto_url_firmada"] = storage.url_firmada(ruta)
        except storage.StorageError:
            r["cierre"]["foto_url_firmada"] = None

    # La foto ya quedó guardada: recalcular y despachar no pueden tumbar la respuesta.
    r["recalculado"] = False
    if obs_id is not None:
        try:
            with get_conn() as conn:
                recalcular_todo(conn)
            r["recalculado"] = True
        except Exception:
            log.exception("No se pudo recalcular la prioridad tras el cierre de %s", mission_id)
    # Cerrada: la rejilla sale del plan y la cuadrilla recibe su siguiente parada (#32).
    # Rechazada: la prioridad pudo subir y la misión sigue en su ruta.
    r["despacho"] = dispatch.replanificar_seguro(
        "cierre" if r["cerrada"] else "observacion", observation_id=obs_id, sumidero_id=mision["sumidero_id"],
        caso_id=str(mision["case_id"]) if mision["case_id"] else None)
    return r

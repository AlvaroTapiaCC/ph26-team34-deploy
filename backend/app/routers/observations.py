"""Entrada de fotos y textos (plan §9.2 y §9.5, issue #28).

POST /observations: foto o texto → Claude → sumidero y caso → recálculo → despacho.
GET  /observations: lista reciente (la usan /central Durante y la Validación).

"La fórmula decide; Claude ve, lee y explica": Claude solo clasifica; la prioridad la calcula
`scoring.recalcular`. Claude nunca tumba el endpoint: si falla, la clasificación queda
`no_evaluable` (o con la heurística de riesgo para texto) y el reporte se guarda igual.

Síncrono (`def`): Pillow, el cliente de Claude y psycopg son bloqueantes; FastAPI los corre
en su pool de hilos. No se mantiene una conexión de la base abierta mientras Claude responde.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from app.db import get_conn
from app.routers.clasificar import _leer, clasificar_bytes
from app.services import observations as svc
from app.services import storage
from app.services.claude_text import NUMEROS_EMERGENCIA, leer_texto
from app.services.claude_vision import clasificar_camara, clasificar_rejilla
from app.services.scoring import recalcular_todo

log = logging.getLogger(__name__)
router = APIRouter(prefix="/observations", tags=["observations"])

FUTURO_MAX = timedelta(minutes=10)  # relojes de celular desfasados: más allá se usa la hora del servidor
_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heic"}


class ObservacionIn(BaseModel):
    """Campos del multipart. Todo llega como texto de formulario; Pydantic los convierte y valida."""

    model_config = ConfigDict(extra="ignore")

    tipo: Literal["rejilla", "agua", "texto"]
    texto: str | None = Field(default=None, max_length=2000)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    precision_m: float | None = Field(default=None, ge=0, le=100_000)
    hora: datetime | None = None
    sumidero_id: str | None = Field(default=None, max_length=64)
    fuente: Literal["vecino", "cuadrilla"] = "vecino"
    # Modo prueba de campo (§8.1). `id_ide` es el ID del catastro que elige /reportar.
    campo: bool = False
    rejilla_n: int | None = Field(default=None, ge=0, le=10_000)
    id_ide: str | None = Field(default=None, max_length=64)
    # Id generado por el celular: un reintento desde la cola local no duplica el reporte
    id: uuid.UUID | None = None

    @field_validator("texto", "sumidero_id", "id_ide", mode="before")
    @classmethod
    def _vacio_es_none(cls, v: Any) -> Any:
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("lat", "lon", "precision_m", "hora", "rejilla_n", mode="before")
    @classmethod
    def _vacio_es_none_num(cls, v: Any) -> Any:
        return None if v == "" else v

    @field_validator("id", mode="before")
    @classmethod
    def _id_opcional(cls, v: Any) -> Any:
        """Un id que no es UUID (el celular sin crypto.randomUUID genera otro formato) se ignora."""
        try:
            return uuid.UUID(str(v)) if v not in (None, "") else None
        except ValueError:
            return None

    @model_validator(mode="after")
    def _coherente(self) -> "ObservacionIn":
        if (self.lat is None) != (self.lon is None):
            raise ValueError("lat y lon van juntos")
        if self.tipo == "texto" and (self.texto is None or len(self.texto.strip()) < 3):
            raise ValueError("tipo=texto requiere `texto` de al menos 3 caracteres")
        return self

    @property
    def hay_gps(self) -> bool:
        return self.lat is not None and self.lon is not None


def _parsear(campos: dict[str, Any], datos: str | None) -> ObservacionIn:
    """Combina los campos sueltos con `datos` (JSON) y valida. Los campos sueltos mandan.

    /reportar (PR #82) manda todo en `datos` + `foto`; los campos sueltos son el contrato
    documentado. Se aceptan ambos para que el front funcione sin cambios.
    """
    base: dict[str, Any] = {}
    if datos:
        try:
            base = json.loads(datos)
        except json.JSONDecodeError:
            raise HTTPException(422, "`datos` no es un JSON válido") from None
        if not isinstance(base, dict):
            raise HTTPException(422, "`datos` debe ser un objeto JSON")
        # Alias del front: precision_m ya coincide; rejilla_num → rejilla_n
        if "rejilla_n" not in base and "rejilla_num" in base:
            base["rejilla_n"] = base["rejilla_num"]
        # En /reportar, `id_ide` indica el sumidero elegido solo en modo campo
        base.setdefault("campo", "id_ide" in base or "rejilla_num" in base)
        # `archivo` y `clasificacion` del cliente no se usan: la clasificación la hace el servidor
    base.update({k: v for k, v in campos.items() if v is not None})
    base = {k: v for k, v in base.items() if v is not None}
    try:
        return ObservacionIn.model_validate(base)
    except ValidationError as e:
        msgs = []
        for err in e.errors():
            donde = ".".join(str(x) for x in err["loc"]) or "entrada"
            msgs.append(f"{donde}: {err['msg'].removeprefix('Value error, ')}")
        raise HTTPException(422, "; ".join(msgs)) from None


def _hora(h: datetime | None) -> datetime:
    ahora = datetime.now(timezone.utc)
    if h is None:
        return ahora
    if h.tzinfo is None:
        h = h.replace(tzinfo=timezone.utc)
    return ahora if h - ahora > FUTURO_MAX else h


def _candidatos(filas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"sumidero_id": c["id"], "distancia_m": c["distancia_m"], "intersection_id": c["intersection_id"],
             "lat": c["lat"], "lon": c["lon"]} for c in filas]


def solicitar_despacho(caso_id: str | None, sumidero_id: str | None, urgente: bool) -> dict[str, Any]:
    """Punto de enganche del despacho (§7.2 paso 4, issue #32).

    TODO(#32, PR #80): `services/dispatch.py` sigue vacío y el PR #80 (endpoints de cuadrillas,
    misiones y rutas) aún no está en main. Cuando exista, llamar aquí a la asignación de la
    misión del caso/sumidero y a la re-planificación de rutas (nueva versión por Realtime).
    No debe lanzar: un fallo del despacho no puede perder el reporte.
    """
    return {"despachado": False, "motivo": "pendiente_dispatch_32"}


def _respuesta_existente(fila: dict[str, Any]) -> dict[str, Any]:
    """Respuesta de un reporte ya guardado (reintento con el mismo id)."""
    return {
        "id": str(fila["id"]),
        "repetido": True,
        "sumidero_id": fila["sumidero_id"],
        "caso_id": str(fila["caso_id"]) if fila["caso_id"] else None,
        "clasificacion": fila["clasificacion"],
        "prioridad_nueva": None,
        "urgente": bool(fila["urgente"]),
        "numeros_emergencia": NUMEROS_EMERGENCIA if fila["urgente"] else [],
    }


@router.post("")
def create_observation(
    foto: UploadFile | None = File(default=None),
    tipo: str | None = Form(default=None),
    texto: str | None = Form(default=None),
    lat: str | None = Form(default=None),
    lon: str | None = Form(default=None),
    precision_m: str | None = Form(default=None),
    precision: str | None = Form(default=None),
    hora: str | None = Form(default=None),
    sumidero_id: str | None = Form(default=None),
    fuente: str | None = Form(default=None),
    campo: str | None = Form(default=None),
    rejilla_n: str | None = Form(default=None),
    id_ide: str | None = Form(default=None),
    id: str | None = Form(default=None),
    datos: str | None = Form(default=None),
):
    """Foto o texto → Claude → asociación al sumidero → caso → recálculo → despacho.

    Multipart. Con `tipo` = `rejilla` o `agua` la `foto` es obligatoria; con `texto`, el `texto`.
    Respuestas:
    - 200 con el reporte guardado: id, sumidero_id, caso_id, clasificacion, prioridad_nueva,
      urgente, numeros_emergencia.
    - Si hay dos o más sumideros a ≤15 m y no vino `sumidero_id`, se asocia al más cercano, se
      guarda igual y la respuesta agrega `candidatos` para que el front pueda corregir.
    - 422 si la entrada es inválida; 413 si la foto pesa más de 15 MB; 503 si no hay base.
    """
    entrada = _parsear(
        {"tipo": tipo, "texto": texto, "lat": lat, "lon": lon, "precision_m": precision_m or precision,
         "hora": hora, "sumidero_id": sumidero_id, "fuente": fuente, "campo": campo,
         "rejilla_n": rejilla_n, "id_ide": id_ide, "id": id},
        datos,
    )
    if entrada.tipo != "texto" and foto is None:
        raise HTTPException(422, f"tipo={entrada.tipo} requiere `foto`")
    bytes_foto = _leer(foto) if (foto is not None and entrada.tipo != "texto") else None
    ts = _hora(entrada.hora)
    obs_id = str(entrada.id) if entrada.id else None

    # 1) Asociación al sumidero, antes de gastar una llamada a Claude
    sumidero_id_final: str | None = None
    candidatos: list[dict] = []
    ubic = (entrada.lat, entrada.lon)  # ubicación del reporte; sin GPS usa la del sumidero
    with get_conn() as conn:
        if obs_id and (previa := svc.observacion_existente(conn, obs_id)):
            return _respuesta_existente(previa)
        elegido = entrada.sumidero_id
        if elegido is None and entrada.campo and entrada.id_ide:
            # Modo campo: el ID del catastro que eligió el usuario; si no existe, se ignora
            elegido = entrada.id_ide if svc.sumidero_existe(conn, entrada.id_ide) else None
        if elegido is not None:
            s = svc.sumidero_existe(conn, elegido)
            if s is None:
                raise HTTPException(422, f"sumidero_id {elegido!r} no existe")
            sumidero_id_final = s["id"]
            if not entrada.hay_gps:
                ubic = (s["lat"], s["lon"])
        elif entrada.hay_gps:
            sumidero_id_final, cercanos = svc.decidir_asociacion(svc.sumideros_cercanos(conn, entrada.lat, entrada.lon))
            candidatos = _candidatos(cercanos)  # empate: se asocia al más cercano y se informan las opciones

    # 2) Claude (sin conexión de base abierta). Nunca lanza por fallas de Claude: degrada.
    lectura = None
    r_texto = None
    r_foto = None
    if bytes_foto is not None:
        fn = clasificar_rejilla if entrada.tipo == "rejilla" else clasificar_camara
        r_foto = clasificar_bytes(fn, bytes_foto)  # imagen ilegible → 422
    if entrada.texto:
        r_texto = leer_texto(entrada.texto)
        lectura = r_texto.resultado
    principal = r_foto or r_texto
    urgente = bool(lectura and lectura.personas_en_riesgo)

    # 3) Foto a Storage. Si falla, el reporte se guarda igual (sin enlace a la foto).
    media_url = None
    if bytes_foto is not None:
        ct = (foto.content_type or "image/jpeg").lower()
        try:
            media_url = storage.subir(bytes_foto, storage.nueva_ruta("observaciones", _EXT.get(ct, "jpg")), ct)
        except storage.StorageError as e:
            log.warning("No se guardó la foto en Storage: %s", e)

    # 4) Guardar observación, clasificación y caso en una transacción
    with get_conn() as conn:
        obs = svc.insertar_observacion(
            conn, obs_id=obs_id, sumidero_id=sumidero_id_final, lat=entrada.lat, lon=entrada.lon,
            fuente=entrada.fuente, tipo=svc.TIPO_OBS[entrada.tipo], media_url=media_url, texto=entrada.texto, ts=ts,
        )
        if r_foto is not None or r_texto is not None:
            # Una sola clasificación por observación: la fórmula usa la última de cada una. Con foto y
            # texto, manda la foto; el texto solo aporta la urgencia (y queda en el evento).
            svc.insertar_clasificacion(conn, obs, principal.resultado, principal.meta(), principal.respuesta_cruda)
        caso_id = None
        if ubic[0] is not None:
            caso_id = svc.buscar_caso(conn, ubic[0], ubic[1], ts)
            if caso_id:
                svc.actualizar_caso(conn, caso_id, sumidero_id_final, urgente)
            else:
                caso_id = svc.crear_caso(conn, ubic[0], ubic[1], sumidero_id_final, urgente, ts)
            svc.vincular_caso(conn, caso_id, obs)
        svc.registrar_evento(conn, "observacion", {
            "observation_id": obs, "tipo": entrada.tipo, "fuente": entrada.fuente, "caso_id": caso_id,
            "sumidero_id": sumidero_id_final, "precision_m": entrada.precision_m, "urgente": urgente,
            "campo": entrada.campo, "rejilla_n": entrada.rejilla_n, "id_ide": entrada.id_ide,
            "con_foto": media_url is not None, "hora_reporte": ts.isoformat(),
            "lectura_texto": lectura.model_dump(mode="json") if (lectura and r_foto) else None,
        })
        caso_es_urgente = svc.caso_urgente(conn, caso_id) if caso_id else False

    # 5) Recalcular y despachar. Ya está guardado: un fallo aquí no pierde el reporte.
    prioridad = None
    recalculado = False
    try:
        with get_conn() as conn:
            recalcular_todo(conn)
            if sumidero_id_final:
                prioridad = svc.prioridad_de(conn, sumidero_id_final)
        recalculado = True
    except Exception:
        log.exception("No se pudo recalcular la prioridad tras la observación %s", obs)
    despacho = solicitar_despacho(caso_id, sumidero_id_final, urgente or caso_es_urgente)

    meta = principal.meta() if principal else {}
    respuesta = {
        "id": obs,
        "sumidero_id": sumidero_id_final,
        "caso_id": caso_id,
        "clasificacion": principal.resultado.model_dump(mode="json") if principal else None,
        "lectura": lectura.model_dump(mode="json") if lectura else None,
        "prioridad_nueva": prioridad,
        "urgente": urgente,
        "caso_urgente": caso_es_urgente,
        "numeros_emergencia": NUMEROS_EMERGENCIA if urgente else [],
        "recalculado": recalculado,
        "despacho": despacho,
        "foto_guardada": media_url is not None if bytes_foto is not None else None,
        "claude_disponible": meta.get("claude_disponible", True),
        "fallo": meta.get("fallo", False),
    }
    if candidatos:
        respuesta["candidatos"] = candidatos
    return respuesta


@router.get("")
def list_observations(
    desde: datetime | None = Query(default=None, description="ISO 8601; solo observaciones desde esa hora"),
    limit: int = Query(200, ge=1, le=1000),
):
    """Observaciones recientes, de la más nueva a la más antigua (sin GPS exacto ni texto original)."""
    with get_conn() as conn:
        items = svc.listar(conn, desde, limit)
    return {"desde": desde, "items": items}

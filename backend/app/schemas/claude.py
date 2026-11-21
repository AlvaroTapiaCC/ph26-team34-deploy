"""Modelos Pydantic de las respuestas de Claude (plan §5).

Claude siempre responde con estas opciones fijas. Si una respuesta no valida,
se reintenta una vez y, si vuelve a fallar, el resultado queda `no_evaluable`.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

EstadoRejilla = Literal["limpia", "parcial", "tapada", "no_evaluable"]
NivelAgua = Literal["sin_agua", "cuneta", "hasta_vereda", "sobre_vereda", "no_evaluable"]
Material = Literal["hojas", "basura", "sedimento"]
Confianza = Literal["alta", "media", "baja"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("nota", check_fields=False)
    @classmethod
    def _nota_corta(cls, v: str) -> str:
        return v if len(v) <= 300 else v[:297] + "..."


class ClasificacionRejilla(_Strict):
    """§5.1 Foto de una rejilla, tomada desde arriba a un metro."""

    evaluable: bool
    rejilla: EstadoRejilla
    material: list[Material] = Field(default_factory=list)
    hojas_calzada: Literal["pocas", "muchas"]
    agua_visible: bool
    nivel_agua: NivelAgua
    confianza: Confianza
    nota: str

    @classmethod
    def no_evaluable(cls, nota: str = "No se pudo clasificar la imagen") -> "ClasificacionRejilla":
        return cls(evaluable=False, rejilla="no_evaluable", material=[], hojas_calzada="pocas",
                   agua_visible=False, nivel_agua="no_evaluable", confianza="baja", nota=nota)


class ClasificacionCamara(_Strict):
    """§5.2 Cuadro de la cámara: mismo esquema sin `rejilla`, más `basura_calzada`."""

    evaluable: bool
    material: list[Material] = Field(default_factory=list)
    hojas_calzada: Literal["pocas", "muchas"]
    basura_calzada: Literal["poca", "mucha"]
    agua_visible: bool
    nivel_agua: NivelAgua
    confianza: Confianza
    nota: str

    @classmethod
    def no_evaluable(cls, nota: str = "No se pudo clasificar la imagen") -> "ClasificacionCamara":
        return cls(evaluable=False, material=[], hojas_calzada="pocas", basura_calzada="poca",
                   agua_visible=False, nivel_agua="no_evaluable", confianza="baja", nota=nota)


class LecturaTexto(_Strict):
    """§5.3 Texto de un vecino."""

    tipo: Literal["anegamiento", "rejilla_tapada", "basura", "arbol_caido", "otro"]
    gravedad: Literal["baja", "media", "alta"]
    personas_en_riesgo: bool
    ubicacion_texto: str | None
    desde_cuando: str | None
    nivel_agua: NivelAgua

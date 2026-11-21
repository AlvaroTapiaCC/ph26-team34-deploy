"""Clasificación de fotos de rejillas y cuadros de cámara con Claude (plan §5.1-5.2, issues #24 y #25).

Claude ve: convierte la imagen en valores con opciones fijas. No decide prioridades.
"""
from __future__ import annotations

import base64
import io

from PIL import Image, ImageOps, UnidentifiedImageError

try:  # fotos HEIC de iPhone
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover
    pass

from app.schemas.claude import ClasificacionCamara, ClasificacionRejilla
from app.services import cache
from app.services.claude_common import ResultadoClaude, llamar_estructurado

PROMPT_VERSION_REJILLA = "rejilla-v1"
PROMPT_VERSION_CAMARA = "camara-v1"
MAX_LADO_PX = 1568  # lado máximo recomendado para imágenes en la API

_NIVELES_AGUA = """Nivel de agua (elige el que mejor describe lo visible):
- sin_agua: no hay agua acumulada.
- cuneta: el agua corre o se acumula solo en la cuneta, junto a la solera.
- hasta_vereda: el agua cubre la calzada y llega hasta el borde de la vereda.
- sobre_vereda: el agua sube por sobre la vereda.
- no_evaluable: no se puede saber desde la imagen."""

SYSTEM_REJILLA = f"""Eres el sistema de inspección visual de Drena, que ayuda a un municipio chileno a priorizar \
la limpieza de sumideros (rejillas de aguas lluvia) antes y durante la lluvia.

Recibes una foto de UNA rejilla de sumidero, tomada idealmente desde arriba, a un metro, con la rejilla completa \
en el cuadro. Describe solo lo que se ve; no inventes ni supongas.

Estado de la rejilla:
- limpia: las ranuras están libres; el agua podría entrar sin problema.
- parcial: algo de material cubre o tapa parte de las ranuras (aprox. entre un cuarto y tres cuartos).
- tapada: la mayor parte de las ranuras está cubierta o tapada; el agua casi no podría entrar.
- no_evaluable: no se ve una rejilla de sumidero, la foto está muy borrosa, oscura o la rejilla no se ve completa \
como para juzgar.

Material: lista los que veas sobre o dentro de la rejilla (hojas, basura, sedimento = tierra, barro o arena). \
Lista vacía si no hay.
hojas_calzada: "muchas" si hay una capa visible de hojas en la calzada alrededor; si no, "pocas".
agua_visible: true si se ve agua acumulada o corriendo.

{_NIVELES_AGUA}

Si la rejilla no es evaluable, usa evaluable=false y rejilla="no_evaluable", y completa el resto con lo que sí se vea.
confianza: alta si la foto es clara y el estado es evidente; media si hay algo de duda; baja si es difícil de juzgar.
nota: una frase breve en español que justifique la clasificación (máximo 200 caracteres)."""

SYSTEM_CAMARA = f"""Eres el sistema de inspección visual de Drena, que ayuda a un municipio chileno a priorizar \
la limpieza de sumideros (rejillas de aguas lluvia).

Recibes un cuadro de una cámara fija que mira una calle. No necesitas ver la rejilla: describe lo que cambia entre \
un evento y otro. Describe solo lo que se ve; no inventes.

Material: lista lo que veas acumulado en la calzada o la cuneta (hojas, basura, sedimento). Lista vacía si no hay.
hojas_calzada: "muchas" si hay una capa visible de hojas en la calzada o la cuneta; si no, "pocas".
basura_calzada: "mucha" si hay basura acumulada visible (por ejemplo, después de una feria); si no, "poca".
agua_visible: true si se ve agua acumulada o corriendo.

{_NIVELES_AGUA}

evaluable=false si el cuadro está oscuro, borroso o no muestra una calle; en ese caso nivel_agua="no_evaluable".
confianza: alta, media o baja según qué tan claro es el cuadro.
nota: una frase breve en español que resuma lo visto (máximo 200 caracteres)."""

_MATERIAL = {"type": "array", "items": {"type": "string", "enum": ["hojas", "basura", "sedimento"]}}
_NIVEL = {"type": "string", "enum": ["sin_agua", "cuneta", "hasta_vereda", "sobre_vereda", "no_evaluable"]}
_CONF = {"type": "string", "enum": ["alta", "media", "baja"]}

SCHEMA_REJILLA = {
    "type": "object",
    "properties": {
        "evaluable": {"type": "boolean"},
        "rejilla": {"type": "string", "enum": ["limpia", "parcial", "tapada", "no_evaluable"]},
        "material": _MATERIAL,
        "hojas_calzada": {"type": "string", "enum": ["pocas", "muchas"]},
        "agua_visible": {"type": "boolean"},
        "nivel_agua": _NIVEL,
        "confianza": _CONF,
        "nota": {"type": "string"},
    },
    "required": ["evaluable", "rejilla", "material", "hojas_calzada", "agua_visible", "nivel_agua", "confianza", "nota"],
    "additionalProperties": False,
}

SCHEMA_CAMARA = {
    "type": "object",
    "properties": {
        "evaluable": {"type": "boolean"},
        "material": _MATERIAL,
        "hojas_calzada": {"type": "string", "enum": ["pocas", "muchas"]},
        "basura_calzada": {"type": "string", "enum": ["poca", "mucha"]},
        "agua_visible": {"type": "boolean"},
        "nivel_agua": _NIVEL,
        "confianza": _CONF,
        "nota": {"type": "string"},
    },
    "required": ["evaluable", "material", "hojas_calzada", "basura_calzada", "agua_visible", "nivel_agua",
                 "confianza", "nota"],
    "additionalProperties": False,
}


class ImagenInvalida(ValueError):
    """Los bytes no son una imagen que se pueda leer."""


def preparar_imagen(data: bytes) -> tuple[str, str]:
    """Corrige la orientación EXIF, achica a MAX_LADO_PX y devuelve (base64 JPEG, media_type).

    Lanza `ImagenInvalida` si los bytes no son una imagen legible (la API responde 422).
    """
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as e:
        raise ImagenInvalida("No se pudo leer la imagen") from e
    img.thumbnail((MAX_LADO_PX, MAX_LADO_PX))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=88)
    return base64.standard_b64encode(out.getvalue()).decode("ascii"), "image/jpeg"


def _contenido(data: bytes, instruccion: str) -> list[dict]:
    b64, media_type = preparar_imagen(data)
    return [
        {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
        {"type": "text", "text": instruccion},
    ]


def clasificar_rejilla(data: bytes) -> ResultadoClaude[ClasificacionRejilla]:
    """§5.1. `data` son los bytes de la foto (JPEG, PNG, WebP o HEIC)."""
    key = cache.cache_key(data, PROMPT_VERSION_REJILLA)
    return llamar_estructurado(
        system=SYSTEM_REJILLA, content=lambda: _contenido(data, "Clasifica esta rejilla."),
        schema=SCHEMA_REJILLA, modelo_pydantic=ClasificacionRejilla,
        key=key, prompt_version=PROMPT_VERSION_REJILLA,
        no_evaluable=ClasificacionRejilla.no_evaluable("No se pudo clasificar la foto"),
    )


def clasificar_camara(data: bytes) -> ResultadoClaude[ClasificacionCamara]:
    """§5.2. Cuadro de la cámara fija."""
    key = cache.cache_key(data, PROMPT_VERSION_CAMARA)
    return llamar_estructurado(
        system=SYSTEM_CAMARA, content=lambda: _contenido(data, "Describe este cuadro de la cámara."),
        schema=SCHEMA_CAMARA, modelo_pydantic=ClasificacionCamara,
        key=key, prompt_version=PROMPT_VERSION_CAMARA,
        no_evaluable=ClasificacionCamara.no_evaluable("No se pudo describir el cuadro"),
    )


def senal_camara(c: ClasificacionCamara) -> float:
    """Convierte un cuadro de cámara en `señal_camara` (0-1) para la fórmula (§6.1)."""
    if not c.evaluable:
        return 0.0
    s = 0.0
    s += 0.5 if c.hojas_calzada == "muchas" else 0.0
    s += 0.4 if c.basura_calzada == "mucha" else 0.0
    s += 0.1 * len(set(c.material))
    return min(1.0, s)

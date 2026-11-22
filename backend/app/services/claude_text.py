"""Lectura de textos de vecinos con Claude (plan §5.3, issue #26).

Claude lee: extrae qué pasa, dónde, qué tan grave y desde cuándo.
Si `personas_en_riesgo = true`, la app muestra 133 / 132 / 131 y el reporte queda urgente.
"""
from __future__ import annotations

import re
import unicodedata

from app.schemas.claude import LecturaTexto
from app.services import cache
from app.services.claude_common import ResultadoClaude, llamar_estructurado

# v2 (#124): agrega `confianza`. Cambia la clave de caché, así no se reusan lecturas v1 sin ese campo.
PROMPT_VERSION_TEXTO = "texto-v2"
NUMEROS_EMERGENCIA = [
    {"numero": "133", "nombre": "Carabineros"},
    {"numero": "132", "nombre": "Bomberos"},
    {"numero": "131", "nombre": "Ambulancia (SAMU)"},
]

SYSTEM_TEXTO = """Eres el sistema de recepción de reportes de Drena, que ayuda a un municipio chileno a responder \
a anegamientos por lluvia. Un vecino escribió un reporte en texto libre (puede tener faltas, modismos chilenos o \
abreviaturas). Extrae los datos; no inventes nada que el texto no diga.

tipo:
- anegamiento: agua acumulada o calle inundada.
- rejilla_tapada: un sumidero o rejilla tapada, aunque no haya agua todavía.
- basura: basura acumulada en la calle o la cuneta.
- arbol_caido: árbol o ramas caídas.
- otro: cualquier otra cosa.

gravedad:
- alta: hay riesgo para personas, agua dentro de viviendas o locales, autos o personas atrapadas, o agua sobre la \
vereda en una zona amplia.
- media: agua que cubre la calzada o una rejilla tapada que ya acumula agua.
- baja: el resto.

personas_en_riesgo: true SOLO si el texto dice o implica claramente que hay personas en peligro (atrapadas, \
arrastradas, heridas, adultos mayores o niños aislados por el agua, agua entrando a una casa con gente adentro). \
Si hay duda razonable de que alguien esté en peligro, usa true.

ubicacion_texto: la esquina, dirección o lugar tal como lo menciona el texto (por ejemplo "Irarrázaval con \
Pedro de Valdivia"). null si no menciona ninguno.
desde_cuando: el momento que menciona el texto ("hace una hora", "desde anoche"). null si no lo dice.

nivel_agua:
- sin_agua: no menciona agua acumulada.
- cuneta: agua solo en la cuneta.
- hasta_vereda: agua en la calzada hasta el borde de la vereda.
- sobre_vereda: agua por sobre la vereda o entrando a casas.
- no_evaluable: menciona agua pero no se puede saber cuánta.

confianza: qué tan claro es el texto para decidir tipo y nivel_agua.
- alta: el texto dice de forma directa qué pasa (por ejemplo "la rejilla está tapada con hojas" o "el agua \
pasa sobre la vereda").
- media: se entiende qué pasa, pero hay algo de ambigüedad o falta un detalle (por ejemplo "hay harta agua" sin \
decir hasta dónde llega).
- baja: el texto es confuso, contradictorio, de segunda mano o no permite saber con seguridad qué pasa.
La confianza no cambia personas_en_riesgo: ante la duda, ese campo sigue siendo true."""

SCHEMA_TEXTO = {
    "type": "object",
    "properties": {
        "tipo": {"type": "string", "enum": ["anegamiento", "rejilla_tapada", "basura", "arbol_caido", "otro"]},
        "gravedad": {"type": "string", "enum": ["baja", "media", "alta"]},
        "personas_en_riesgo": {"type": "boolean"},
        "ubicacion_texto": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "desde_cuando": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "nivel_agua": {"type": "string", "enum": ["sin_agua", "cuneta", "hasta_vereda", "sobre_vereda", "no_evaluable"]},
        "confianza": {"type": "string", "enum": ["alta", "media", "baja"]},
    },
    "required": ["tipo", "gravedad", "personas_en_riesgo", "ubicacion_texto", "desde_cuando", "nivel_agua",
                 "confianza"],
    "additionalProperties": False,
}

# Red de seguridad SOLO para cuando Claude no responde: preferimos un falso urgente
# a perder a alguien en riesgo.
_RIESGO = re.compile(
    r"atrapad|arrastr|herid|ahog|auxilio|socorro|emergencia|rescat|nino|ninos|guagua|"
    r"adulto mayor|abuelit|silla de ruedas|no puede salir|no pueden salir|entrando a la casa|dentro de la casa"
)


def _normalizar(t: str) -> str:
    t = unicodedata.normalize("NFKD", t.lower())
    return "".join(c for c in t if not unicodedata.combining(c))


def heuristica_riesgo(texto: str) -> bool:
    return bool(_RIESGO.search(_normalizar(texto)))


def leer_texto(texto: str) -> ResultadoClaude[LecturaTexto]:
    texto = texto.strip()
    key = cache.cache_key(texto, PROMPT_VERSION_TEXTO)
    riesgo = heuristica_riesgo(texto)
    fallback = LecturaTexto(
        tipo="otro",
        gravedad="alta" if riesgo else "media",
        personas_en_riesgo=riesgo,
        ubicacion_texto=None,
        desde_cuando=None,
        nivel_agua="no_evaluable",
        confianza="baja",  # sin lectura de Claude: tipo "otro", no sube P ni el nivel de agua
    )
    return llamar_estructurado(
        system=SYSTEM_TEXTO,
        content=[{"type": "text", "text": f"Reporte del vecino:\n<reporte>\n{texto}\n</reporte>"}],
        schema=SCHEMA_TEXTO,
        modelo_pydantic=LecturaTexto,
        key=key,
        prompt_version=PROMPT_VERSION_TEXTO,
        no_evaluable=fallback,
        max_tokens=1024,
    )

"""Llamada común a Claude con respuesta JSON validada (plan §5.5).

- Salida estructurada (`output_config.format`) con un JSON Schema fijo.
- Se valida con Pydantic. Si no valida, se reintenta una vez; si vuelve a fallar,
  se devuelve el valor `no_evaluable` que entrega quien llama.
- Caché por contenido + versión del prompt.
- Se guarda modelo, latencia y respuesta cruda para auditoría.
- Fallback del lado del servidor si el modelo declina (`fallbacks: "default"`).
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Generic, TypeVar

import anthropic
from pydantic import BaseModel, ValidationError

from app.config import get_settings
from app.services import cache

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)


@dataclass
class ResultadoClaude(Generic[T]):
    resultado: T
    modelo: str
    prompt_version: str
    cache_key: str
    latencia_ms: int | None = None
    desde_cache: bool = False
    fallo: bool = False                       # True si se usó el valor no_evaluable
    respuesta_cruda: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def meta(self) -> dict[str, Any]:
        return {
            "modelo": self.modelo,
            "prompt_version": self.prompt_version,
            "cache_key": self.cache_key,
            "latencia_ms": self.latencia_ms,
            "desde_cache": self.desde_cache,
            "fallo": self.fallo,
        }


@lru_cache
def get_client() -> anthropic.Anthropic:
    key = get_settings().anthropic_api_key
    if not key:
        raise RuntimeError("Falta ANTHROPIC_API_KEY")
    return anthropic.Anthropic(api_key=key, timeout=60, max_retries=2)


def _texto(response: Any) -> str:
    return "".join(b.text for b in response.content if getattr(b, "type", None) == "text")


def llamar_estructurado(
    *,
    system: str,
    content: list[dict[str, Any]],
    schema: dict[str, Any],
    modelo_pydantic: type[T],
    key: str,
    prompt_version: str,
    no_evaluable: T,
    max_tokens: int = 2048,
) -> ResultadoClaude[T]:
    """Llama a Claude (o usa la caché) y devuelve un resultado siempre válido."""
    settings = get_settings()
    hit = cache.get(key)
    if hit is not None:
        try:
            return ResultadoClaude(
                modelo_pydantic.model_validate(hit["respuesta"]), hit["modelo"], prompt_version, key, desde_cache=True
            )
        except ValidationError:
            log.warning("entrada de caché inválida para %s; se vuelve a llamar", key)

    modelo = settings.claude_model
    crudo: str | None = None
    t0 = time.perf_counter()
    for intento in (1, 2):
        try:
            response = get_client().beta.messages.create(
                model=modelo,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": content}],
                output_config={
                    "effort": settings.claude_effort,
                    "format": {"type": "json_schema", "schema": schema},
                },
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except (anthropic.BadRequestError, anthropic.AuthenticationError, anthropic.PermissionDeniedError,
                anthropic.NotFoundError) as e:
            log.error("Claude rechazó la solicitud (%s): %s", type(e).__name__, getattr(e, "message", e))
            break
        except (anthropic.RateLimitError, anthropic.APIStatusError, anthropic.APIConnectionError) as e:
            log.warning("Claude falló en el intento %s (%s)", intento, type(e).__name__)
            continue

        if response.stop_reason == "refusal":
            log.warning("Claude declinó la solicitud (%s)", getattr(response.stop_details, "category", None))
            break
        crudo = _texto(response)
        modelo = response.model or modelo
        try:
            resultado = modelo_pydantic.model_validate(json.loads(crudo))
        except (json.JSONDecodeError, ValidationError) as e:
            log.warning("respuesta inválida en el intento %s: %s", intento, str(e)[:200])
            continue
        latencia = int((time.perf_counter() - t0) * 1000)
        cache.put(key, resultado.model_dump(mode="json"), modelo)
        return ResultadoClaude(resultado, modelo, prompt_version, key, latencia, respuesta_cruda=crudo)

    # Dos intentos fallidos (o error no recuperable): no_evaluable. No se guarda en caché
    # para que un fallo transitorio no quede fijo.
    latencia = int((time.perf_counter() - t0) * 1000)
    return ResultadoClaude(no_evaluable, modelo, prompt_version, key, latencia, fallo=True, respuesta_cruda=crudo)

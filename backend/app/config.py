"""Configuración del backend: variables de entorno y pesos de la fórmula.

Las variables se leen de `backend/.env` en local y de las variables de entorno en Render.
Ver `.env.example` para la lista completa.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent
CONFIG_DIR = BACKEND_DIR / "config"
FORMULA_PATH = CONFIG_DIR / "formula.yaml"
# formula.yaml: la completa, para la demo.
# formula_validacion.yaml: sin variables simuladas, para la predicción congelada (§8.1).
FORMULA_CONFIGS = {"formula", "formula_validacion"}

load_dotenv(BACKEND_DIR / ".env")


def _csv(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass(frozen=True)
class Settings:
    supabase_url: str = field(default_factory=lambda: os.getenv("SUPABASE_URL", ""))
    supabase_anon_key: str = field(default_factory=lambda: os.getenv("SUPABASE_ANON_KEY", ""))
    supabase_service_key: str = field(default_factory=lambda: os.getenv("SUPABASE_SERVICE_KEY", ""))
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", ""))
    anthropic_api_key: str = field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", ""))
    elevenlabs_api_key: str = field(default_factory=lambda: os.getenv("ELEVENLABS_API_KEY", ""))
    osrm_url: str = field(default_factory=lambda: os.getenv("OSRM_URL", "https://router.project-osrm.org"))
    claude_model: str = field(default_factory=lambda: os.getenv("CLAUDE_MODEL", "claude-opus-5-5"))
    # Clasificar y extraer son tareas acotadas: 'low' basta y responde más rápido.
    claude_effort: str = field(default_factory=lambda: os.getenv("CLAUDE_EFFORT", "low"))
    storage_bucket: str = field(default_factory=lambda: os.getenv("SUPABASE_STORAGE_BUCKET", "photos"))
    # Si se define, los endpoints administrativos (p. ej. /formula/recompute) exigen el
    # header X-Admin-Token. Vacío = abiertos (desarrollo / demo).
    admin_token: str = field(default_factory=lambda: os.getenv("ADMIN_TOKEN", ""))
    sim_token: str = field(default_factory=lambda: os.getenv("SIM_TOKEN", ""))  # solo /sim/trigger; casi público
    cors_origins: list[str] = field(default_factory=lambda: _csv(os.getenv("CORS_ORIGINS", "*")))


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_formula_config(nombre: str = "formula") -> dict[str, Any]:
    """Pesos y parámetros de la fórmula (`config/<nombre>.yaml`).

    Por defecto la completa (`formula.yaml`). La predicción congelada de validación usa
    `get_formula_config("formula_validacion")`.
    """
    if nombre not in FORMULA_CONFIGS:
        raise ValueError(f"Configuración de fórmula desconocida: {nombre!r}")
    with (CONFIG_DIR / f"{nombre}.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)

"""Lluvia y viento horarios → feature `clima` (0-1) y modo de la página.

Módulo puro: recibe una serie horaria ordenada y la configuración de `config/clima.yaml`.
En cada hora usa solo lo observado hasta esa hora y el pronóstico ya emitido en ese
momento, así que sirve para reproducir un evento sin mirar el futuro (issue #17, #86).

Cada elemento de la serie es un dict con:
    hora_utc               datetime con zona UTC, horas consecutivas
    lluvia_mm              lluvia observada en la hora que termina en hora_utc (o None)
    racha_kmh              racha máxima de viento a 10 m (o None)
    lluvia_pronosticada_mm lluvia pronosticada para esa hora, emitida antes (o None)
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

CONFIG_CLIMA = Path(__file__).resolve().parents[2] / "config" / "clima.yaml"

MODOS = ("durante", "tormenta_inminente", "despues", "seco", "sin_dato")


def cargar_config(ruta: str | Path = CONFIG_CLIMA) -> dict[str, Any]:
    return yaml.safe_load(Path(ruta).read_text(encoding="utf-8"))


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def _suma(valores: Sequence[float | None]) -> float | None:
    if not valores or any(v is None for v in valores):
        return None
    return sum(valores)  # type: ignore[arg-type]


def _maximo(valores: Sequence[float | None]) -> float | None:
    if not valores or any(v is None for v in valores):
        return None
    return max(valores)  # type: ignore[type-var]


def clima_normalizado(lluvia_acum_mm: float | None, racha_max_kmh: float | None,
                      cfg: Mapping[str, Any]) -> float | None:
    """Combina lluvia acumulada y racha máxima recientes en un valor 0-1."""
    if lluvia_acum_mm is None or racha_max_kmh is None:
        return None
    n = cfg["normalizacion"]
    lluvia_n = _clamp(lluvia_acum_mm / n["lluvia_satura_mm"])
    viento_n = _clamp((racha_max_kmh - n["racha_min_kmh"]) / (n["racha_satura_kmh"] - n["racha_min_kmh"]))
    return round(_clamp(n["peso_lluvia"] * lluvia_n + n["peso_viento"] * viento_n), 4)


def evaluar_serie(serie: Sequence[Mapping[str, Any]], cfg: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Devuelve, por cada hora, clima, modo y el inicio pronosticado de la próxima lluvia.

    Las horas sin historia suficiente (al principio) o sin pronóstico hacia adelante (al final)
    quedan con `None` / `sin_dato`: conviene pasar un día de margen a cada lado.
    """
    n, m = cfg["normalizacion"], cfg["modos"]
    lluvia = [h.get("lluvia_mm") for h in serie]
    racha = [h.get("racha_kmh") for h in serie]
    pron = [h.get("lluvia_pronosticada_mm") for h in serie]

    def atras(valores, i, horas):  # horas (i-horas, i], incluye la actual
        return valores[i - horas + 1: i + 1] if i - horas + 1 >= 0 else []

    def adelante(valores, i, horas):  # horas (i, i+horas]
        return valores[i + 1: i + horas + 1] if i + horas < len(valores) else []

    salida = []
    for i, h in enumerate(serie):
        lluvia_acum = _suma(atras(lluvia, i, n["ventana_lluvia_h"]))
        racha_max = _maximo(atras(racha, i, n["ventana_viento_h"]))
        lluvia_durante = _suma(atras(lluvia, i, m["durante_ventana_h"]))
        lluvia_despues = _suma(atras(lluvia, i, m["despues_ventana_h"]))
        futuro = adelante(pron, i, m["pronostico_ventana_h"])
        pron_acum = _suma(futuro)

        if lluvia_durante is not None and lluvia_durante >= m["durante_mm"]:
            modo = "durante"
        elif pron_acum is not None and pron_acum >= m["inminente_mm"]:
            modo = "tormenta_inminente"
        elif lluvia_despues is not None and lluvia_despues >= m["despues_mm"]:
            modo = "despues"
        elif None in (lluvia_durante, pron_acum, lluvia_despues):
            modo = "sin_dato"
        else:
            modo = "seco"

        inicio: datetime | None = None
        if modo == "tormenta_inminente":
            for k, v in enumerate(futuro, start=i + 1):
                if v is not None and v >= m["inicio_lluvia_mm"]:
                    inicio = serie[k]["hora_utc"]
                    break

        salida.append({
            "hora_utc": h["hora_utc"],
            "lluvia_acum_mm": None if lluvia_acum is None else round(lluvia_acum, 2),
            "racha_max_kmh": racha_max,
            "lluvia_pronosticada_prox_mm": None if pron_acum is None else round(pron_acum, 2),
            "clima": clima_normalizado(lluvia_acum, racha_max, cfg),
            "modo": modo,
            "inicio_lluvia_pronosticado_utc": inicio,
        })
    return salida

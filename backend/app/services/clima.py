"""Clima en vivo de Open-Meteo para la zona MUT: modo de la página y plazo (issue #13).

Pide a la Forecast API de Open-Meteo las últimas 48 h y las próximas 48 h (lluvia y racha
horaria) y las evalúa con los mismos umbrales del replay (`config/clima.yaml`, issue #17):
las horas ya transcurridas cuentan como observadas y las siguientes como pronóstico.

Caché en memoria de 1 hora. Si Open-Meteo falla, devuelve el último valor obtenido con su
hora y `vigente = False`; si nunca se obtuvo, devuelve modo `sin_dato` con valores nulos.
Nunca lanza un error ni rellena con 0 un dato que falta.

La predicción congelada (#81) no usa este valor, y tampoco entra a la fórmula.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.services.clima_serie import cargar_config, evaluar_serie

log = logging.getLogger(__name__)

URL_FORECAST = "https://api.open-meteo.com/v1/forecast"
# Centro de la zona MUT, el mismo de pipeline/11_clima_historico.py
CENTRO_MUT = (-33.417741, -70.601433)
HORAS_PASADAS = 48
HORAS_FUTURAS = 48
TTL = timedelta(hours=1)
TIMEOUT_S = 8
SANTIAGO = ZoneInfo("America/Santiago")
LICENCIA = "CC BY 4.0, https://open-meteo.com/en/license"
DIAS = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")

_lock = threading.Lock()
_ultimo: dict[str, Any] | None = None   # última respuesta buena
_ultimo_en: datetime | None = None       # cuándo se obtuvo (UTC)


def _iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _pedir_open_meteo(lat: float, lon: float) -> dict[str, Any]:
    params = {
        "latitude": lat, "longitude": lon, "timezone": "GMT",
        "hourly": "precipitation,wind_gusts_10m",
        "past_hours": HORAS_PASADAS, "forecast_hours": HORAS_FUTURAS + 2,
    }
    r = httpx.get(URL_FORECAST, params=params, timeout=TIMEOUT_S)
    r.raise_for_status()
    datos = r.json()
    if datos.get("error"):
        raise RuntimeError(f"Open-Meteo: {datos.get('reason')}")
    return datos


def plazo_texto(inicio_utc: datetime, ahora_utc: datetime) -> str:
    """'antes de hoy a las 18:00' / 'antes de mañana a las 14:00' / 'antes del jueves 27 a las 09:00'."""
    ini, hoy = inicio_utc.astimezone(SANTIAGO), ahora_utc.astimezone(SANTIAGO).date()
    dias = (ini.date() - hoy).days
    hora = ini.strftime("%H:%M")
    if dias <= 0:
        return f"antes de hoy a las {hora}"
    if dias == 1:
        return f"antes de mañana a las {hora}"
    return f"antes del {DIAS[ini.weekday()]} {ini.day} a las {hora}"


def evaluar_respuesta(datos: dict[str, Any], ahora_utc: datetime, cfg: dict[str, Any]) -> dict[str, Any]:
    """Convierte la respuesta horaria de Open-Meteo en modo, plazo y valores de la hora actual."""
    h = datos["hourly"]
    horas = [datetime.fromisoformat(t).replace(tzinfo=timezone.utc) for t in h["time"]]
    lluvia, racha = h["precipitation"], h["wind_gusts_10m"]
    # La lluvia de la hora T es la acumulada en (T-1, T]: es observada si T ya pasó.
    serie = [{"hora_utc": t,
              "lluvia_mm": lluvia[i] if t <= ahora_utc else None,
              "racha_kmh": racha[i] if t <= ahora_utc else None,
              "lluvia_pronosticada_mm": lluvia[i] if t > ahora_utc else None}
             for i, t in enumerate(horas)]
    pasadas = [i for i, t in enumerate(horas) if t <= ahora_utc]
    if not pasadas:
        raise ValueError("Open-Meteo no devolvió horas pasadas")
    i = pasadas[-1]
    e = evaluar_serie(serie, cfg)[i]

    futuras = [k for k, t in enumerate(horas) if ahora_utc < t <= ahora_utc + timedelta(hours=HORAS_FUTURAS)]
    lluvia_48 = [lluvia[k] for k in futuras]
    racha_48 = [racha[k] for k in futuras]
    completo = len(futuras) >= HORAS_FUTURAS
    lluvia_48h = round(sum(lluvia_48), 2) if completo and None not in lluvia_48 else None
    racha_48h = max(racha_48) if completo and None not in racha_48 else None

    inicio = e["inicio_lluvia_pronosticado_utc"]
    if e["modo"] == "durante":
        plazo = "lloviendo ahora"
    elif inicio is not None:
        plazo = plazo_texto(inicio, ahora_utc)
    else:
        plazo = None

    return {
        "modo": e["modo"],
        "plazo": plazo,
        "inicio_lluvia_pronosticado_utc": _iso(inicio),
        "clima": e["clima"],
        "lluvia_acum_24h_mm": e["lluvia_acum_mm"],
        "racha_max_6h_kmh": e["racha_max_kmh"],
        "lluvia_pronosticada_prox_24h_mm": e["lluvia_pronosticada_prox_mm"],
        "lluvia_pronosticada_48h_mm": lluvia_48h,
        "racha_max_pronosticada_48h_kmh": racha_48h,
        "hora_dato_utc": _iso(horas[i]),
        "fuente": {
            "nombre": "Open-Meteo Forecast API (datos reales, no simulados)",
            "url": URL_FORECAST,
            "celda_latlon": [datos.get("latitude"), datos.get("longitude")],
            "licencia": LICENCIA,
        },
        "config_clima_version": cfg.get("version"),
        "unidades": {"lluvia": "mm", "racha": "km/h", "clima": "0-1"},
    }


def _sin_dato(motivo: str) -> dict[str, Any]:
    return {
        "modo": "sin_dato", "plazo": None, "inicio_lluvia_pronosticado_utc": None, "clima": None,
        "lluvia_acum_24h_mm": None, "racha_max_6h_kmh": None, "lluvia_pronosticada_prox_24h_mm": None,
        "lluvia_pronosticada_48h_mm": None, "racha_max_pronosticada_48h_kmh": None, "hora_dato_utc": None,
        "fuente": {"nombre": "Open-Meteo Forecast API", "url": URL_FORECAST, "celda_latlon": None,
                   "licencia": LICENCIA},
        "config_clima_version": None,
        "unidades": {"lluvia": "mm", "racha": "km/h", "clima": "0-1"},
        "detalle": motivo,
    }


def clima_actual(ahora_utc: datetime | None = None,
                 pedir: Callable[[float, float], dict[str, Any]] | None = None) -> dict[str, Any]:
    """Modo y plazo en la zona MUT, con caché de 1 hora y respaldo al último valor bueno."""
    global _ultimo, _ultimo_en
    pedir = pedir or _pedir_open_meteo
    ahora = ahora_utc or datetime.now(timezone.utc)
    with _lock:  # una sola consulta a la vez: evita pedir N veces al vencer la caché
        if _ultimo is not None and _ultimo_en is not None and ahora - _ultimo_en < TTL:
            return {**_ultimo, "vigente": True, "consultado_utc": _iso(_ultimo_en)}
        try:
            resultado = evaluar_respuesta(pedir(*CENTRO_MUT), ahora, cargar_config())
        except Exception as e:  # red, HTTP, formato: nunca un 500
            log.warning("Open-Meteo no disponible (%s: %s)", type(e).__name__, e)
            if _ultimo is not None:
                return {**_ultimo, "vigente": False, "consultado_utc": _iso(_ultimo_en),
                        "detalle": "Open-Meteo no respondió; se muestra el último valor obtenido"}
            return {**_sin_dato("Open-Meteo no respondió y no hay un valor anterior"),
                    "vigente": False, "consultado_utc": None}
        _ultimo, _ultimo_en = resultado, ahora
        return {**resultado, "vigente": True, "consultado_utc": _iso(ahora)}


def _reiniciar_cache() -> None:
    """Solo para pruebas."""
    global _ultimo, _ultimo_en
    with _lock:
        _ultimo, _ultimo_en = None, None

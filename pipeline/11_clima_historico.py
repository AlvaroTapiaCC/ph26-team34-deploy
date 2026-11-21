"""
Lluvia y viento históricos hora a hora para el replay (issue #17, consumido por #86).

Uso (desde la raíz del repo):
    pip install -r pipeline/requirements.txt
    python pipeline/11_clima_historico.py                       # los dos eventos candidatos
    python pipeline/11_clima_historico.py --evento 2026-10-13   # uno solo
    python pipeline/11_clima_historico.py --lat -33.43 --lon -70.60   # otro centro de sector

Salidas (en data/escenarios/):
    <evento>.json       serie horaria desde un día antes hasta un día después del evento
    <evento>.meta.json  fuente, URLs de consulta, fecha de descarga, centro y sha256

Fuentes (Open-Meteo, sin clave):
  - Observado: Historical Forecast API, modelo best_match. Se usa en vez del Archive API (ERA5,
    ~25 km) porque tiene mejor resolución para lluvia en Santiago.
  - Pronóstico ya emitido: Previous Runs API, `precipitation_previous_day1`, es decir, el
    pronóstico para cada hora emitido al menos un día antes. Así el modo "tormenta inminente"
    de la hora t solo usa información que existía en t.
Open-Meteo responde con la celda de su grilla más cercana; la meta guarda la celda usada.
Las horas van en UTC (la lluvia de una hora es la acumulada en la hora anterior) y se agrega la
hora de Santiago para mostrar. `clima` y `modo` se calculan con backend/config/clima.yaml.
"""

import argparse
import hashlib
import json
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
from zoneinfo import ZoneInfo

SCRIPT_VERSION = "1.0.0"
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.services.clima_serie import CONFIG_CLIMA, cargar_config, evaluar_serie  # noqa: E402

SANTIAGO = ZoneInfo("America/Santiago")
URL_OBSERVADO = "https://historical-forecast-api.open-meteo.com/v1/forecast"
URL_PRONOSTICO = "https://previous-runs-api.open-meteo.com/v1/forecast"

# Centro de la zona MUT (data/validacion/prediccion_congelada.meta.json). Si #86 elige otro
# sector, se vuelve a correr con --lat/--lon. Dentro de 1,5 km suele caer en la misma celda.
CENTRO_MUT = (-33.417741, -70.601433)

# Eventos candidatos de #86: días del evento en hora de Santiago.
EVENTOS = {
    "2026-10-13": {"desde": date(2026, 10, 13), "hasta": date(2026, 10, 13),
                   "nota": "Evento principal si #73 entrega verdad de terreno suficiente."},
    "2026-07-16_17": {"desde": date(2026, 7, 16), "hasta": date(2026, 7, 17),
                      "nota": "Plan B en Las Condes con los puntos críticos de invierno 2026 (#74)."},
}


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def pedir(url, params):
    completa = f"{url}?{urlencode(params)}"
    with urlopen(completa, timeout=60) as r:
        datos = json.loads(r.read())
    if datos.get("error"):
        raise RuntimeError(f"Open-Meteo: {datos.get('reason')}")
    return completa, datos


def hora_utc(texto):
    return datetime.fromisoformat(texto).replace(tzinfo=timezone.utc)


def iso(dt):
    return None if dt is None else dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def descargar(nombre, evento, lat, lon, cfg):
    # Ventana: desde las 00:00 del día anterior hasta las 24:00 del día siguiente, hora de Santiago.
    ini = datetime.combine(evento["desde"] - timedelta(days=1), time(0), SANTIAGO).astimezone(timezone.utc)
    fin = datetime.combine(evento["hasta"] + timedelta(days=2), time(0), SANTIAGO).astimezone(timezone.utc)
    # Un día de margen a cada lado para tener 24 h de historia y de pronóstico en los bordes.
    base = {"latitude": lat, "longitude": lon, "timezone": "GMT",
            "start_date": (ini - timedelta(days=1)).date().isoformat(),
            "end_date": (fin + timedelta(days=1)).date().isoformat()}

    url_obs, obs = pedir(URL_OBSERVADO, {**base, "models": "best_match",
                                         "hourly": "precipitation,wind_gusts_10m,wind_speed_10m"})
    url_pron, pron = pedir(URL_PRONOSTICO, {**base, "hourly": "precipitation_previous_day1"})

    if obs["hourly"]["time"] != pron["hourly"]["time"]:
        raise RuntimeError("Las horas del observado y del pronóstico no coinciden")

    ho, hp = obs["hourly"], pron["hourly"]
    serie = [{"hora_utc": hora_utc(t),
              "lluvia_mm": ho["precipitation"][i],
              "racha_kmh": ho["wind_gusts_10m"][i],
              "viento_kmh": ho["wind_speed_10m"][i],
              "lluvia_pronosticada_mm": hp["precipitation_previous_day1"][i]}
             for i, t in enumerate(ho["time"])]
    evaluado = evaluar_serie(serie, cfg)

    horas = []
    for h, e in zip(serie, evaluado):
        if not (ini < h["hora_utc"] <= fin):
            continue
        horas.append({
            "hora_utc": iso(h["hora_utc"]),
            "hora_santiago": h["hora_utc"].astimezone(SANTIAGO).isoformat(timespec="minutes"),
            "lluvia_mm": h["lluvia_mm"],
            "racha_kmh": h["racha_kmh"],
            "viento_kmh": h["viento_kmh"],
            "lluvia_pronosticada_mm": h["lluvia_pronosticada_mm"],
            "lluvia_acum_24h_mm": e["lluvia_acum_mm"],
            "racha_max_6h_kmh": e["racha_max_kmh"],
            "lluvia_pronosticada_prox_24h_mm": e["lluvia_pronosticada_prox_mm"],
            "clima": e["clima"],
            "modo": e["modo"],
            "inicio_lluvia_pronosticado_utc": iso(e["inicio_lluvia_pronosticado_utc"]),
        })

    lluvias = [h["lluvia_mm"] for h in horas if h["lluvia_mm"] is not None]
    rachas = [h["racha_kmh"] for h in horas if h["racha_kmh"] is not None]
    resumen = {
        "horas": len(horas),
        "horas_sin_dato": sum(h["modo"] == "sin_dato" for h in horas),
        "lluvia_total_mm": round(sum(lluvias), 1),
        "lluvia_max_horaria_mm": max(lluvias, default=None),
        "racha_max_kmh": max(rachas, default=None),
        "primera_hora_por_modo_utc": {
            modo: next((h["hora_utc"] for h in horas if h["modo"] == modo), None)
            for modo in ("tormenta_inminente", "durante", "despues")},
    }

    salida_dir = REPO / "data" / "escenarios"
    salida_dir.mkdir(parents=True, exist_ok=True)
    salida = salida_dir / f"{nombre}.json"
    salida.write_text(json.dumps({
        "evento": nombre,
        "fuente": "Open-Meteo (datos reales, no simulados)",
        "unidades": {"lluvia": "mm/h", "racha": "km/h", "viento": "km/h", "clima": "0-1"},
        "resumen": resumen,
        "horas": horas,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    meta = {
        "generado_utc": iso(datetime.now(timezone.utc)),
        "evento": {"nombre": nombre, "desde_santiago": evento["desde"].isoformat(),
                   "hasta_santiago": evento["hasta"].isoformat(), "nota": evento["nota"]},
        "ventana_utc": {"desde_exclusivo": iso(ini), "hasta_inclusivo": iso(fin)},
        "centro_pedido_latlon": [lat, lon],
        "celda_open_meteo_latlon": [obs["latitude"], obs["longitude"]],
        "elevacion_celda_m": obs.get("elevation"),
        "fuentes": {
            "observado": {"api": "Open-Meteo Historical Forecast API", "modelo": "best_match",
                          "url": url_obs, "variables": ["precipitation", "wind_gusts_10m", "wind_speed_10m"]},
            "pronostico_emitido_antes": {"api": "Open-Meteo Previous Runs API", "url": url_pron,
                                         "variables": ["precipitation_previous_day1"]},
            "licencia": "CC BY 4.0, https://open-meteo.com/en/license",
        },
        "config_clima": {"ruta": str(CONFIG_CLIMA.relative_to(REPO)), "sha256": sha256(CONFIG_CLIMA),
                         "version": cfg.get("version")},
        "salida": {"archivo": salida.name, "sha256": sha256(salida)},
        "script": {"ruta": "pipeline/11_clima_historico.py", "version": SCRIPT_VERSION,
                   "sha256": sha256(__file__)},
    }
    salida.with_suffix(".meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{nombre}: {resumen['horas']} horas, {resumen['lluvia_total_mm']} mm, "
          f"racha máx {resumen['racha_max_kmh']} km/h → {salida.relative_to(REPO)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--evento", choices=sorted(EVENTOS), action="append",
                    help="por defecto, todos los candidatos")
    ap.add_argument("--lat", type=float, default=CENTRO_MUT[0])
    ap.add_argument("--lon", type=float, default=CENTRO_MUT[1])
    a = ap.parse_args()
    cfg = cargar_config()
    for nombre in a.evento or sorted(EVENTOS):
        descargar(nombre, EVENTOS[nombre], a.lat, a.lon, cfg)


if __name__ == "__main__":
    main()

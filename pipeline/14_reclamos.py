"""
Contraste de reclamos de Atención Vecino de Las Condes con el ranking congelado (issue #72).

Uso (desde la raíz del repo):
    python pipeline/14_reclamos.py \
        --crudo /ruta/fuera/del/repo/atencion_vecino.csv \
        --descargado-utc 2026-11-22T01:21:28Z \
        --clima-meta data/escenarios/2026-07-16_17.meta.json \
        --prediccion data/validacion/prediccion_replay_julio.csv \
        --nota "Evento reproducido por #86 (plan B de julio)"

Entrada: el CSV de la capa «Atención Vecino» (id 6) del portal oficial
https://datos.lascondes.cl/datos, descargado de https://datos.lascondes.cl/download/capa/6/csv.
Ese archivo trae la dirección y las coordenadas del domicilio de cada solicitud, así que
**se guarda fuera del repo**. El script solo usa esas columnas en memoria.

Qué hace:
  - Filtra los tipos de solicitud de sumideros y de anegamiento (TIPOS) en la ventana del
    evento que viene en la metadata del clima del replay. La fecha del ticket solo trae el día.
  - Agrupa los tickets por cuadra: calle normalizada y tramo de numeración de 100.
    No se guarda el número de casa, ni las coordenadas, ni los identificadores.
  - Cruza cada cuadra del sector del ranking (por defecto el del replay de julio, #87) con las rejillas (ID_IDE) que están
    a menos de 100 m y de 50 m de alguno de sus tickets.
  - Calcula la cobertura de #86 con el ranking A congelado (sin clima), con «solo área de
    aporte» y con el promedio de 1.000 permutaciones con semilla 86. Si el sector no tiene
    tickets, no se calcula ninguna cifra y el resultado lo dice.

Salidas en data/validacion/reclamos/: <evento>_<sector>.json y <evento>_<sector>.meta.json.
No modifica la configuración ni los pesos. Verifica el sha256 de la configuración contra el
congelamiento del MUT y el del ranking del sector contra su metadata.
"""

import argparse
import csv
import hashlib
import io
import json
import math
import random
import re
import subprocess
import unicodedata
from collections import Counter, defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

SCRIPT_VERSION = "1.1.0"
REPO = Path(__file__).resolve().parents[1]
PREDICCION = REPO / "data/validacion/prediccion_replay_julio.csv"
CONGELAMIENTO = REPO / "data/validacion/prediccion_congelada.meta.json"
CONFIG = REPO / "backend/config/formula_validacion.yaml"
SALIDA = REPO / "data/validacion/reclamos"

FUENTE = {
    "nombre": "Atención Vecino (capa 6), Portal de Datos Abiertos de la Municipalidad de Las Condes",
    "portal": "https://datos.lascondes.cl/datos",
    "descarga": "https://datos.lascondes.cl/download/capa/6/csv",
    "ficha": "https://datos.lascondes.cl/capas/6/details",
    "licencia": (
        "No declarada en la ficha de la capa. El portal publica un «Decreto Portal de Datos "
        "Abiertos» (https://datos.lascondes.cl/recursos) que no se pudo leer de forma automática "
        "porque está escaneado. Pendiente de confirmar."
    ),
}
# Tipos de solicitud del catálogo municipal relacionados con drenaje (revisados a mano).
TIPOS = {
    "Sumideros de Aguas Lluvias": "sumideros",
    "Anegamiento por aguas lluvias o desbordamiento de canales": "anegamiento",
}
COLUMNAS = ("tipo_solicitud", "motivo", "ubicacion_solicitud", "lat_solicitud", "long_solicitud", "fc_creacion")
# Mismos cortes, semilla y permutaciones que el replay de #86 (pipeline/10_replay.py, PR #122).
CORTES = ((20, 100), (10, 100), (20, 50), (10, 50))
SEMILLA = 86
PERMUTACIONES = 1000
DIAS_SERIE = 7
DIRECCION = re.compile(r"^(?P<calle>.*\D)\s+(?P<numero>\d+)\s*$")


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def relativa(ruta):
    ruta = Path(ruta).resolve()
    return str(ruta.relative_to(REPO)) if ruta.is_relative_to(REPO) else None


def git_head():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    except Exception:  # noqa: BLE001
        return None


def distancia_m(a, b):
    lon_a, lat_a, lon_b, lat_b = map(math.radians, (*a, *b))
    h = math.sin((lat_b - lat_a) / 2) ** 2
    h += math.cos(lat_a) * math.cos(lat_b) * math.sin((lon_b - lon_a) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(min(1.0, h)))


def numero_decimal(texto):
    return float(texto.strip().replace(",", "."))


def calle_normalizada(texto):
    sin_tildes = "".join(
        c for c in unicodedata.normalize("NFD", texto.upper()) if unicodedata.category(c) != "Mn"
    )
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9Ñ ]", " ", sin_tildes)).strip()


def cuadra(ubicacion):
    """«APOQUINDO 3721» -> «APOQUINDO 3700-3799». None si no hay calle y número."""
    m = DIRECCION.match(ubicacion.strip())
    if not m:
        return None
    calle = calle_normalizada(m["calle"])
    if not calle:
        return None
    inicio = int(m["numero"]) // 100 * 100
    return f"{calle} {inicio}-{inicio + 99}"


def leer_tickets(ruta):
    """Lee solo los tickets de drenaje. Las coordenadas quedan en memoria."""
    with open(ruta, encoding="utf-8-sig", newline="") as archivo:
        texto = archivo.read().lstrip("﻿")
    lector = csv.DictReader(io.StringIO(texto), delimiter=";")
    faltan = [c for c in COLUMNAS if c not in (lector.fieldnames or [])]
    if faltan:
        raise ValueError(f"Al CSV le faltan columnas: {faltan}")
    total, tickets, descartes = 0, [], Counter()
    for fila in lector:
        total += 1
        tipo = TIPOS.get(fila["tipo_solicitud"].strip())
        if tipo is None:
            continue
        try:
            dia = date.fromisoformat(fila["fc_creacion"].strip()[:10])
        except ValueError:
            descartes["sin_fecha"] += 1
            continue
        try:
            lonlat = (numero_decimal(fila["long_solicitud"]), numero_decimal(fila["lat_solicitud"]))
            if not (-180 <= lonlat[0] <= 180 and -90 <= lonlat[1] <= 90):
                raise ValueError
        except ValueError:
            lonlat = None
        tickets.append({
            "tipo": tipo, "motivo": fila["motivo"].strip(), "dia": dia,
            "lonlat": lonlat, "cuadra": cuadra(fila["ubicacion_solicitud"]),
        })
    return total, tickets, descartes


def leer_ranking(ruta):
    with open(ruta, newline="", encoding="utf-8") as archivo:
        filas = sorted(csv.DictReader(archivo), key=lambda f: int(f["rank"]))
    if [int(f["rank"]) for f in filas] != list(range(1, len(filas) + 1)):
        raise ValueError("El ranking debe ser completo y consecutivo.")
    orden = [f["ID_IDE"] for f in filas]
    coords = {f["ID_IDE"]: (float(f["lon"]), float(f["lat"])) for f in filas}
    area = [f["ID_IDE"] for f in sorted(filas, key=lambda f: (-float(f["area_aporte_m2"]), f["ID_IDE"]))]
    return orden, coords, area


def cobertura(aciertos, total):
    if not total:
        return None
    return {"aciertos": round(aciertos, 6), "total": total, "porcentaje": round(100 * aciertos / total, 4)}


def evaluar(grupos, orden, coords, area):
    """grupos: {cuadra: [lonlat, ...]}. Una cuadra acierta si alguno de sus tickets tiene
    una rejilla del top a menos del radio."""
    cercanas = {
        nombre: {radio: {sid for sid, c in coords.items() for p in puntos if distancia_m(p, c) < radio}
                 for radio in {r for _, r in CORTES}}
        for nombre, puntos in grupos.items()
    }
    azar = random.Random(SEMILLA)
    largo = math.ceil(len(orden) * 0.2)
    permutaciones = [azar.sample(orden, largo) for _ in range(PERMUTACIONES)]
    resumen = []
    for porcentaje, radio in CORTES:
        n = math.ceil(len(orden) * porcentaje / 100)

        def aciertos(ranking):
            top = set(ranking[:n])
            return sum(bool(top & c[radio]) for c in cercanas.values())

        resumen.append({
            "top_porcentaje": porcentaje, "distancia_m_menor_que": radio,
            "formula_sin_clima": cobertura(aciertos(orden), len(grupos)),
            "solo_area_aporte": cobertura(aciertos(area), len(grupos)),
            "azar": cobertura(sum(map(aciertos, permutaciones)) / PERMUTACIONES, len(grupos)),
        })
    return resumen, cercanas


def ventana_resultado(tickets, desde, hasta, centro, radio_sector, orden, coords, area):
    en_ventana = [t for t in tickets if desde <= t["dia"] <= hasta]
    sin_coord = sum(t["lonlat"] is None for t in en_ventana)
    en_sector = [t for t in en_ventana if t["lonlat"] and distancia_m(centro, t["lonlat"]) <= radio_sector]
    sin_cuadra = sum(t["cuadra"] is None for t in en_sector)
    grupos, detalle = defaultdict(list), defaultdict(list)
    for t in en_sector:
        if t["cuadra"]:
            grupos[t["cuadra"]].append(t["lonlat"])
            detalle[t["cuadra"]].append(t)
    base = {
        "desde_santiago": desde.isoformat(), "hasta_santiago": hasta.isoformat(),
        "tickets_comuna": len(en_ventana),
        "tickets_comuna_por_tipo": dict(sorted(Counter(t["tipo"] for t in en_ventana).items())),
        "tickets_sin_coordenadas": sin_coord,
        "tickets_en_sector": len(en_sector),
        "tickets_en_sector_sin_cuadra": sin_cuadra,
        "cuadras_en_sector": len(grupos),
    }
    if not grupos:
        return {**base, "cuadras": [], "cobertura": None,
                "nota": "No hay tickets de drenaje dentro del sector en esta ventana. No se calcula cobertura."}
    resumen, cercanas = evaluar(grupos, orden, coords, area)
    rank = {sid: i for i, sid in enumerate(orden, 1)}
    top20 = set(orden[:math.ceil(len(orden) * 0.2)])
    cuadras = []
    for nombre in sorted(grupos):
        ts = detalle[nombre]
        cuadras.append({
            "cuadra": nombre,
            "tickets": len(ts),
            "por_tipo": dict(sorted(Counter(t["tipo"] for t in ts).items())),
            "por_motivo": dict(sorted(Counter(t["motivo"] for t in ts).items())),
            "dias": sorted({t["dia"].isoformat() for t in ts}),
            "rejillas_menos_100m": [{"ID_IDE": s, "rank": rank[s]} for s in sorted(cercanas[nombre][100], key=rank.get)],
            "rejillas_menos_50m": [{"ID_IDE": s, "rank": rank[s]} for s in sorted(cercanas[nombre][50], key=rank.get)],
            "cubierta_top20_100m": bool(top20 & cercanas[nombre][100]),
        })
    return {**base, "cuadras": cuadras, "cobertura": resumen}


def serie_diaria(tickets, desde, hasta):
    conteo = Counter((t["dia"], t["tipo"]) for t in tickets)
    dias = [desde + timedelta(days=i) for i in range((hasta - desde).days + 1)]
    return [{"dia": d.isoformat(), **{tipo: conteo[(d, tipo)] for tipo in sorted(TIPOS.values())}} for d in dias]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crudo", type=Path, required=True, help="CSV de Atención Vecino, fuera del repo")
    ap.add_argument("--descargado-utc", required=True, help="hora de la descarga, ISO 8601 en UTC")
    ap.add_argument("--clima-meta", type=Path, required=True, help="metadata del clima del evento (data/escenarios)")
    ap.add_argument("--prediccion", type=Path, default=PREDICCION)
    ap.add_argument("--config", type=Path, default=CONFIG)
    ap.add_argument("--nota", required=True, help="por qué se contrasta este evento")
    ap.add_argument("--salida", type=Path, default=SALIDA)
    a = ap.parse_args()

    crudo = a.crudo.resolve()
    if crudo.is_relative_to(REPO):
        ap.exit(1, "El CSV crudo trae domicilios: guárdalo fuera del repositorio.\n")
    descargado = datetime.fromisoformat(a.descargado_utc.replace("Z", "+00:00"))
    if descargado.utcoffset() is None:
        ap.exit(1, "--descargado-utc debe incluir zona horaria.\n")

    meta_pred = json.loads(a.prediccion.with_suffix(".meta.json").read_text(encoding="utf-8"))
    congelado = json.loads(CONGELAMIENTO.read_text(encoding="utf-8"))["formula"]["sha256_config"]
    if not sha256(a.config) == meta_pred["formula"]["sha256_config"] == congelado:
        ap.exit(1, "El sha256 de la configuración no coincide con el del congelamiento.\n")
    if meta_pred["formula"]["modo"] != "antes" or meta_pred["formula"]["pesos_efectivos"]["w_clima"] != 0:
        ap.exit(1, "El ranking del sector debe ser la predicción A, sin clima ni observaciones.\n")
    if sha256(a.prediccion) != meta_pred["salida"]["sha256"]:
        ap.exit(1, "El sha256 del ranking no coincide con su metadata.\n")
    (clave_zona, zona), = ((k, v) for k, v in meta_pred.items() if k.startswith("zona_"))
    sector = clave_zona.removeprefix("zona_")
    centro, radio_sector = tuple(zona["centro_lonlat"]), float(zona["radio_m"])

    meta_clima = json.loads(a.clima_meta.read_text(encoding="utf-8"))
    evento = meta_clima["evento"]
    desde, hasta = date.fromisoformat(evento["desde_santiago"]), date.fromisoformat(evento["hasta_santiago"])

    total, tickets, descartes = leer_tickets(crudo)
    orden, coords, area = leer_ranking(a.prediccion)
    args = (centro, radio_sector, orden, coords, area)
    resultado = {
        "rotulo": "Datos reales del portal municipal, agregados por cuadra. Sin domicilios ni identificadores.",
        "evento": evento["nombre"],
        "nota": a.nota,
        "sector": {"nombre": sector, "centro_lonlat": list(centro), "radio_m": radio_sector, "rejillas": len(orden)},
        "resolucion_temporal": "día (fc_creacion), sin hora",
        "ventanas": {
            "principal": ventana_resultado(tickets, desde, hasta, *args),
            "sensibilidad_dia_siguiente": ventana_resultado(tickets, desde, hasta + timedelta(days=1), *args),
        },
        "serie_diaria_comuna": serie_diaria(
            tickets, desde - timedelta(days=DIAS_SERIE), hasta + timedelta(days=DIAS_SERIE)),
        "ranking_horario_b": "No aplica: los tickets solo traen el día de creación.",
    }

    a.salida.mkdir(parents=True, exist_ok=True)
    ruta = a.salida / f"{evento['nombre']}_{sector}.json"
    ruta.write_text(json.dumps(resultado, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    meta = {
        "generado_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "git_head_al_generar": git_head(),
        "fuente": {
            **FUENTE,
            "descargado_utc": descargado.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sha256_crudo": sha256(crudo),
            "filas_crudo": total,
            "columnas_usadas": list(COLUMNAS),
            "privacidad": (
                "El CSV crudo no se versiona. ubicacion_solicitud, lat_solicitud y long_solicitud "
                "se usan solo en memoria para la cuadra, el sector y las distancias."
            ),
        },
        "filtro": {
            "tipos_solicitud": TIPOS,
            "motivos": "todos (Solicitud, Reclamo, Denuncia, etc.)",
            "tickets_drenaje_totales": len(tickets),
            "descartados": dict(descartes),
        },
        "evento": evento,
        "clima_meta": {"ruta": relativa(a.clima_meta), "sha256": sha256(a.clima_meta)},
        "agrupacion": "cuadra = calle normalizada (mayúsculas, sin tildes) + tramo de numeración de 100",
        "metodo": {
            "cortes": [{"top_porcentaje": p, "distancia_m_menor_que": r} for p, r in CORTES],
            "unidad": "cuadra con al menos un ticket dentro del sector",
            "semilla": SEMILLA, "permutaciones_azar": PERMUTACIONES, "distancia": "Haversine",
            "ventanas": "principal: días del evento; sensibilidad: agrega el día siguiente",
        },
        "formula": {
            "config": {"ruta": relativa(a.config), "sha256": sha256(a.config)},
            "sha256_config_al_congelar": congelado,
            "prediccion": {"ruta": relativa(a.prediccion), "sha256": sha256(a.prediccion)},
            "git_head_al_generar_prediccion": meta_pred.get("git_head_al_generar"),
        },
        "script": {"ruta": "pipeline/14_reclamos.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
        "salida": {"archivo": ruta.name, "sha256": sha256(ruta)},
    }
    ruta.with_suffix(".meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    p = resultado["ventanas"]["principal"]
    # Solo ASCII en consola: la codificación predeterminada de Windows (cp1252) no tiene flechas.
    print(f"{evento['nombre']} ({sector}): {p['tickets_comuna']} tickets en la comuna, "
          f"{p['tickets_en_sector']} en el sector ({p['cuadras_en_sector']} cuadras) -> {relativa(ruta) or ruta}")


if __name__ == "__main__":
    main()

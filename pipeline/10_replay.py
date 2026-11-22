"""Reproduce un evento hora a hora con la fórmula congelada (issue #86)."""

import argparse
import csv
import hashlib
import json
import math
import random
import sys
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import yaml

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.services.clima_serie import MODOS  # noqa: E402
from app.services.formula import PESO_A_FEATURE, SumideroInput, calcular_ranking  # noqa: E402
from validacion_ranking import cadenas_del_sector  # noqa: E402

SANTIAGO = ZoneInfo("America/Santiago")
PREDICCION_MUT = REPO / "data/validacion/prediccion_congelada.csv"
CONFIG = REPO / "backend/config/formula_validacion.yaml"
SEMILLA = 86
PERMUTACIONES = 1000
CORTES = ((20, 100), (10, 100), (20, 50), (10, 50))
MODOS_ALERTA = {"tormenta_inminente", "durante"}


@dataclass(frozen=True)
class Punto:
    lonlat: tuple[float, float]
    hora: datetime | None
    tipo_hora: str


def leer_json(ruta):
    return json.loads(ruta.read_text(encoding="utf-8"))


def archivo(ruta):
    absoluta = ruta.resolve()
    relativa = absoluta.relative_to(REPO) if absoluta.is_relative_to(REPO) else ruta
    return {"ruta": str(relativa), "sha256": hashlib.sha256(ruta.read_bytes()).hexdigest()}


def verificar_hash(ruta, esperado):
    entrada = archivo(ruta)
    if entrada["sha256"] != esperado:
        raise ValueError(f"El SHA-256 de {ruta} no coincide con sus metadatos.")
    return entrada


def hora_utc(texto):
    hora = datetime.fromisoformat(texto)
    if hora.utcoffset() is None:
        raise ValueError(f"Hora sin zona: {texto}")
    return hora.astimezone(UTC)


def lonlat(lon, lat):
    lon, lat = float(lon), float(lat)
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise ValueError(f"Coordenadas fuera de rango: {(lon, lat)}")
    return lon, lat


def distancia_m(a, b):
    lon_a, lat_a, lon_b, lat_b = map(math.radians, (*a, *b))
    h = math.sin((lat_b - lat_a) / 2) ** 2
    h += math.cos(lat_a) * math.cos(lat_b) * math.sin((lon_b - lon_a) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(min(1.0, h)))


def cargar_puntos(ruta, tipo, centro, radio, desde, hasta):
    coleccion = leer_json(ruta)
    if coleccion["type"] != "FeatureCollection":
        raise ValueError("Los lugares deben venir como FeatureCollection GeoJSON.")
    puntos = {}
    for feature in coleccion["features"]:
        geo, p = feature["geometry"], feature["properties"]
        if geo["type"] != "Point":
            raise ValueError("Cada lugar debe ser un Point con coordenadas WGS84.")
        coord = lonlat(*geo["coordinates"][:2])
        fuente = urlparse(p["fuente_url"])
        if not p["lugar"].strip() or fuente.scheme not in ("http", "https") or not fuente.netloc:
            raise ValueError("Cada lugar debe tener nombre y una URL de evidencia.")
        if distancia_m(centro, coord) > radio:
            continue
        if tipo == "evento":
            if p["precision"] not in ("cruce exacto", "cruce_exacto", "cruce", "tramo") or p.get("hora") is None:
                continue
            hora = hora_utc(p["hora"])
            if not desde <= hora.astimezone(SANTIAGO).date() <= hasta:
                continue
            tipo_hora = p.get("tipo_hora", "sin_especificar")
            if tipo_hora not in ("observacion", "aviso", "publicacion", "sin_especificar"):
                raise ValueError(f"Tipo de hora desconocido: {tipo_hora}")
        else:
            hora, tipo_hora = None, "punto_critico"
        anterior = puntos.get(coord)
        # Se cuenta cada ubicación una vez; se prefiere observación/aviso a publicación.
        if anterior is not None:
            marca = (tipo_hora not in ("observacion", "aviso"), hora)
            previa = (anterior.tipo_hora not in ("observacion", "aviso"), anterior.hora)
            if marca >= previa:
                continue
        puntos[coord] = Punto(coord, hora, tipo_hora)
    minimo = 8 if tipo == "evento" else 1
    if len(puntos) < minimo:
        raise ValueError(f"Hay {len(puntos)} lugares elegibles en el sector y se requieren {minimo}.")
    return list(puntos.values())


def cargar_ranking(ruta, config):
    with ruta.open(newline="", encoding="utf-8") as csvfile:
        filas = sorted(csv.DictReader(csvfile), key=lambda f: int(f["rank"]))
    if not filas or [int(f["rank"]) for f in filas] != list(range(1, len(filas) + 1)):
        raise ValueError("La predicción debe contener un ranking completo y consecutivo.")
    ids = [f["ID_IDE"] for f in filas]
    if "" in ids or len(set(ids)) != len(ids):
        raise ValueError("La predicción tiene ID_IDE vacíos o duplicados.")
    features = [
        variable for peso, variable in PESO_A_FEATURE.items()
        if variable != "clima" and config["p_pred"].get(peso, 0) > 0
    ]
    entradas = []
    for fila in filas:
        valores = {var: float(fila[var]) for var in (*features, "criticidad")}
        valores["area_aporte"] = float(fila["area_aporte_m2"])
        if not all(math.isfinite(valor) for valor in valores.values()):
            raise ValueError(f"Faltan variables de validación para {fila['ID_IDE']}.")
        entradas.append(SumideroInput(fila["ID_IDE"], valores))
    coords = {f["ID_IDE"]: lonlat(f["lon"], f["lat"]) for f in filas}
    return entradas, coords


def cargar_horas(ruta, metadatos):
    serie = leer_json(ruta)
    horas = serie["horas"]
    if not horas or serie["evento"] != metadatos["evento"]["nombre"]:
        raise ValueError("La serie horaria no contiene el evento de sus metadatos.")
    ventana = metadatos["ventana_utc"]
    previa = hora_utc(ventana["desde_exclusivo"])
    for hora in horas:
        sello = hora_utc(hora["hora_utc"])
        if sello - previa != timedelta(hours=1) or hora["modo"] not in MODOS:
            raise ValueError("La serie debe tener horas consecutivas y modos válidos.")
        clima = hora["clima"]
        if clima is not None and (type(clima) not in (int, float) or not 0 <= clima <= 1):
            raise ValueError("El clima horario debe estar entre 0 y 1 o ser nulo.")
        previa = sello
    if previa != hora_utc(ventana["hasta_inclusivo"]):
        raise ValueError("La serie no completa la ventana climática documentada.")
    return horas


def cobertura(aciertos, total):
    if not total:
        return None
    return {
        "aciertos": round(aciertos, 6),
        "total": total,
        "porcentaje": round(100 * aciertos / total, 4),
    }


def comparar(puntos, coords, area, horas, rankings):
    ids = list(coords)
    indices = [hora_utc(h["hora_utc"]) for h in horas]
    por_punto = [bisect_right(indices, p.hora) - 1 if p.hora is not None else -1 for p in puntos]
    azar = random.Random(SEMILLA)
    largo_azar = math.ceil(len(ids) * 0.2)
    permutaciones = [azar.sample(ids, largo_azar) for _ in range(PERMUTACIONES)]
    distancias = [{sid: distancia_m(p.lonlat, coord) for sid, coord in coords.items()} for p in puntos]
    resumen, serie = [], [{"hora_utc": h["hora_utc"], "cobertura": []} for h in horas]
    for porcentaje, radio in CORTES:
        n = math.ceil(len(ids) * porcentaje / 100)
        cercanas = [{sid for sid, d in dist.items() if d < radio} for dist in distancias]

        def aciertos(orden):
            top = set(orden[:n])
            return sum(bool(top & cercanas_punto) for cercanas_punto in cercanas)

        tops = [set(r[:n]) if r is not None else None for r in rankings]
        aciertos_en_registro = [
            bool(tops[i] & cercanas_punto)
            for i, cercanas_punto in zip(por_punto, cercanas)
            if i >= 0 and tops[i] is not None
        ]
        base = {"top_porcentaje": porcentaje, "distancia_m_menor_que": radio}
        resumen.append({
            **base,
            "formula_sin_clima": cobertura(aciertos(ids), len(puntos)),
            "formula_horaria_al_registro": cobertura(sum(aciertos_en_registro), len(aciertos_en_registro)),
            "solo_area_aporte": cobertura(aciertos(area), len(puntos)),
            "azar": cobertura(sum(map(aciertos, permutaciones)) / PERMUTACIONES, len(puntos)),
        })
        for hora, top in zip(serie, tops):
            valor = cobertura(sum(bool(top & cercanas_punto) for cercanas_punto in cercanas), len(puntos)) if top is not None else None
            hora["cobertura"].append({**base, "formula_horaria": valor})
    return resumen, serie


def medir_tiempo(puntos, horas):
    registros = sorted(p.hora for p in puntos if p.tipo_hora in ("observacion", "aviso"))
    primera_alerta = next((hora_utc(h["hora_utc"]) for h in horas if h["modo"] in MODOS_ALERTA), None)
    primer_registro = registros[0] if registros else None
    return {
        "primera_alerta_utc": primera_alerta.isoformat() if primera_alerta else None,
        "primer_registro_utc": primer_registro.isoformat() if primer_registro else None,
        "horas_entre_alerta_y_registro": (
            round((primer_registro - primera_alerta).total_seconds() / 3600, 4)
            if primera_alerta and primer_registro else None
        ),
    }


def ranking_por_hora(entradas, cadenas, config, horas):
    for hora in horas:
        clima = hora["clima"]
        if clima is None:
            yield None
            continue
        con_clima = [SumideroInput(s.id, {**s.features, "clima": clima}) for s in entradas]
        modo_formula = "durante" if hora["modo"] == "durante" else "antes"
        yield calcular_ranking(con_clima, cadenas, config, modo_formula)


def guardar_tabla(ruta, horas, scores, entradas):
    campos = (
        "hora_utc", "modo", "clima", "ID_IDE", "rank",
        "p_pred", "p_ef", "prioridad", "rank_sin_clima",
    )
    ranks = {s.id: rank for rank, s in enumerate(entradas, 1)}
    with ruta.open("w", newline="", encoding="utf-8") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=campos)
        writer.writeheader()
        for hora, ranking in zip(horas, scores):
            base = {k: hora[k] for k in ("hora_utc", "modo", "clima")}
            if ranking is None:
                writer.writerows({**base, "ID_IDE": sid, "rank_sin_clima": rank} for sid, rank in ranks.items())
                continue
            writer.writerows({
                **base, "ID_IDE": s.sumidero_id, "rank": s.rank, "p_pred": round(s.p_pred, 6),
                "p_ef": round(s.p_ef, 6), "prioridad": round(s.prioridad, 6),
                "rank_sin_clima": ranks[s.sumidero_id],
            } for s in ranking)


def reproducir(args):
    meta_congelada = leer_json(PREDICCION_MUT.with_suffix(".meta.json"))
    hash_config = meta_congelada["formula"]["sha256_config"]
    config_info = verificar_hash(args.config, hash_config)
    config = yaml.safe_load(args.config.read_text(encoding="utf-8"))

    ruta_pred_meta = args.prediccion.with_suffix(".meta.json")
    pred = leer_json(ruta_pred_meta)
    formula_pred = pred["formula"]
    if (
        formula_pred["sha256_config"] != hash_config
        or formula_pred["modo"] != "antes"
        or formula_pred["pesos_efectivos"]["w_clima"] != 0
    ):
        raise ValueError("La predicción del sector debe usar la fórmula congelada sin observaciones.")
    insumos = {
        "prediccion": verificar_hash(args.prediccion, pred["salida"]["sha256"]),
        "meta_prediccion": archivo(ruta_pred_meta),
        "cadenas": verificar_hash(args.cadenas, pred["entradas"]["cadenas"]["sha256"]),
        "lugares": archivo(args.anegados),
    }
    zona, = (v for k, v in pred.items() if k.startswith("zona_"))
    centro, radio = lonlat(*zona["centro_lonlat"]), float(zona["radio_m"])
    if not 0 < radio <= 1500:
        raise ValueError("El radio del sector debe ser mayor que 0 y de hasta 1500 m.")

    ruta_clima_meta = args.clima.with_suffix(".meta.json")
    meta_clima = leer_json(ruta_clima_meta)
    insumos["clima"] = verificar_hash(args.clima, meta_clima["salida"]["sha256"])
    insumos["meta_clima"] = archivo(ruta_clima_meta)
    lat, lon = meta_clima["centro_pedido_latlon"]
    if distancia_m(centro, lonlat(lon, lat)) > 1:
        raise ValueError("Descarga el clima en el mismo centro que la predicción del sector.")
    evento = meta_clima["evento"]
    desde, hasta = (date.fromisoformat(evento[f"{limite}_santiago"]) for limite in ("desde", "hasta"))
    horas = cargar_horas(args.clima, meta_clima)
    puntos = cargar_puntos(args.anegados, args.tipo_evidencia, centro, radio, desde, hasta)
    entradas, coords = cargar_ranking(args.prediccion, config)
    cadenas = cadenas_del_sector(leer_json(args.cadenas), set(coords))
    area = [s.id for s in sorted(entradas, key=lambda s: (-s.features["area_aporte"], s.id))]
    scores = list(ranking_por_hora(entradas, cadenas, config, horas))
    ordenes = [[s.sumidero_id for s in r] if r is not None else None for r in scores]
    comparacion, serie = comparar(puntos, coords, area, horas, ordenes)

    resultado = {
        "evento": evento["nombre"], "tipo_evidencia": args.tipo_evidencia,
        "sector": {"centro_lonlat": centro, "radio_m": radio, "rejillas": len(entradas)},
        "lugares_evaluados": len(puntos),
        "lugares_por_tipo_hora": dict(sorted(Counter(p.tipo_hora for p in puntos).items())),
        "horas_sin_clima": sum(s is None for s in scores),
        "cobertura": comparacion, "cobertura_por_hora": serie,
        "tiempo": medir_tiempo(puntos, horas),
    }
    args.salida.mkdir(parents=True, exist_ok=True)
    ruta_tabla = args.salida / "ranking_horario.csv"
    ruta_resultado = args.salida / "resultado.json"
    ruta_meta = args.salida / "resultado.meta.json"
    guardar_tabla(ruta_tabla, horas, scores, entradas)
    ruta_resultado.write_text(json.dumps(resultado, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    metadata = {
        "evento": evento, "motivo_evento_y_sector": args.motivo, "sector": zona,
        "tipo_evidencia": args.tipo_evidencia, "insumos": insumos,
        "formula": {
            "config": config_info,
            "codigo": archivo(REPO / "backend/app/services/formula.py"),
            "sha256_codigo_al_congelar": meta_congelada["formula"]["sha256_codigo"],
            "git_head_al_congelar": meta_congelada["git_head_al_generar"],
        },
        "metodo": {"semilla": SEMILLA, "permutaciones_azar": PERMUTACIONES, "distancia": "Haversine"},
        "scripts": [archivo(Path(__file__)), archivo(Path(__file__).with_name("validacion_ranking.py"))],
        "salidas": [archivo(ruta_resultado), archivo(ruta_tabla)],
    }
    ruta_meta.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{evento['nombre']}: {len(puntos)} lugares, {len(entradas)} rejillas, {len(horas)} horas → {ruta_resultado}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prediccion", type=Path, default=PREDICCION_MUT)
    parser.add_argument("--cadenas", type=Path, default=REPO / "data/street_chains_mut.json")
    parser.add_argument("--config", type=Path, default=CONFIG)
    parser.add_argument("--clima", type=Path, required=True)
    parser.add_argument("--anegados", type=Path, required=True)
    parser.add_argument("--tipo-evidencia", choices=("evento", "puntos-criticos"), required=True)
    parser.add_argument("--motivo", required=True, help="fundamento de la elección del evento y el sector")
    parser.add_argument("--salida", type=Path, default=REPO / "data/validacion/replay")
    args = parser.parse_args()
    try:
        reproducir(args)
    except (OSError, TypeError, ValueError, KeyError) as exc:
        parser.exit(1, f"No se pudo reproducir el evento. {exc}\n")


if __name__ == "__main__":
    main()

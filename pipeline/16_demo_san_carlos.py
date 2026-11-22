"""Exporta cortes reproducibles del caso de octubre para la demo local, sin API."""
import csv
import hashlib
import importlib
import json
from dataclasses import replace
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
replay = importlib.import_module("10_replay")
from app.services.formula import calcular_ranking


def main():
    source = REPO / "data/validacion/san_carlos/caso.json"
    caso = json.loads(source.read_text())
    meta = json.loads(source.with_suffix(".meta.json").read_text())
    replay.verificar_hash(source, meta["salida"]["sha256"])
    config = yaml.safe_load(replay.CONFIG.read_text())
    prediccion = REPO / "data/validacion/prediccion_replay_julio.csv"
    entradas, coords = replay.cargar_ranking(prediccion, config)
    with prediccion.open() as archivo:
        nombres = {f["ID_IDE"]: f["calle"] for f in csv.DictReader(archivo)}
    cadenas = replay.cadenas_del_sector(replay.leer_json(REPO / "data/street_chains_replay_julio.json"), set(coords))
    cortes = []
    for hora, foto, agua in [("2026-10-07T21:00:00Z", False, False), ("2026-10-08T20:00:00Z", False, False),
                             ("2026-10-08T20:00:00Z", True, False), ("2026-10-08T20:00:00Z", True, True)]:
        h = next(h for h in caso["horas"] if h["hora_utc"] == hora)
        insumos = [replace(p, features={**p.features, "clima": h["clima"]},
                    rejilla_observada="tapada" if foto and p.id == "AL13SU012988" else None,
                    confianza_foto="alta" if foto and p.id == "AL13SU012988" else None,
                    nivel_agua="hasta_vereda" if agua and p.id == "AL13SU012988" else None,
                    confianza_agua="alta" if agua and p.id == "AL13SU012988" else None) for p in entradas]
        ranking = calcular_ranking(insumos, cadenas, config, "durante" if h["modo"] == "durante" else "antes")
        cortes.append({"hora": h, "ranking": [{"sumidero_id": p.sumidero_id, "rank": p.rank,
            "p_pred": p.p_pred, "p_obs": p.p_obs, "p_ef": p.p_ef, "c": p.c,
            "prioridad": p.prioridad, "detalle": p.detalle} for p in ranking]})
    resultado = {"etiqueta": caso["etiqueta"], "evento": caso["evento"], "horas": caso["horas"],
        "puntos": {id: {"intersection_nombre": nombres[id], "lon": coord[0], "lat": coord[1]} for id, coord in coords.items()},
        "cortes": cortes, "fuente": {"caso_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "config_sha256": hashlib.sha256(replay.CONFIG.read_bytes()).hexdigest(),
        "nota": "Fórmula congelada aplicada retrospectivamente. Foto y agua añadidas son simuladas; no predicción emitida antes del evento."}}
    (REPO / "frontend/lib/demo-san-carlos.json").write_text(json.dumps(resultado, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"{len(coords)} rejillas, {len(cortes)} cortes; foto y agua simuladas separadas de la lluvia histórica")


if __name__ == "__main__":
    main()

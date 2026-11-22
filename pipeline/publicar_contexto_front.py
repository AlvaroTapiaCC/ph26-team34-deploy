"""Capas de contexto del mapa de la central (zona MUT) para el frontend.

Junta en un solo archivo liviano, sin pasar por la fórmula:
  - infraestructura crítica y otros puntos de OSM de la zona (data/osm_mut.geojson): metro, paso bajo nivel,
    hospital, colegio, feria, obra. Polígonos y líneas se reducen a su centroide.
  - colectores de aguas lluvia del catastro SIALL de la DOH (data/las_condes/colectores_siall.geojson),
    recortados a una caja alrededor del MUT.
  - puntos críticos de invierno 2026 de Las Condes (data/las_condes/puntos_criticos_invierno_2026.geojson).

Salida: frontend/public/data/contexto_mut.geojson, con `capa`, `tipo`, `nombre` y `fuente` en cada elemento.
Uso (desde la raíz):  python pipeline/publicar_contexto_front.py
"""

from __future__ import annotations

import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
SALIDA = RAIZ / "frontend" / "public" / "data" / "contexto_mut.geojson"
# Caja alrededor del MUT (Av. Apoquindo 2730), con margen para ver los colectores que llegan a la zona
CAJA = (-70.625, -33.435, -70.578, -33.400)


def leer(ruta: str) -> list[dict]:
    with open(RAIZ / ruta, encoding="utf-8") as f:
        return json.load(f)["features"]


def puntos_de(geom: dict) -> list[list[float]]:
    t, c = geom["type"], geom["coordinates"]
    if t == "Point":
        return [c]
    if t == "LineString":
        return c
    if t == "Polygon":
        return c[0]
    if t == "MultiLineString":
        return [p for linea in c for p in linea]
    if t == "MultiPolygon":
        return [p for poli in c for p in poli[0]]
    return []


def centroide(geom: dict) -> list[float]:
    pts = puntos_de(geom)
    return [round(sum(p[0] for p in pts) / len(pts), 6), round(sum(p[1] for p in pts) / len(pts), 6)]


def en_caja(p: list[float]) -> bool:
    return CAJA[0] <= p[0] <= CAJA[2] and CAJA[1] <= p[1] <= CAJA[3]


def main() -> None:
    out: list[dict] = []
    for f in leer("data/osm_mut.geojson"):
        pr = f["properties"]
        out.append({
            "type": "Feature",
            "properties": {"capa": "infra", "tipo": pr.get("tipo"), "nombre": pr.get("name") or None, "fuente": "OpenStreetMap"},
            "geometry": {"type": "Point", "coordinates": centroide(f["geometry"])},
        })
    for f in leer("data/las_condes/colectores_siall.geojson"):
        pts = puntos_de(f["geometry"])
        if not any(en_caja(p) for p in pts):
            continue
        lineas = f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiLineString" else [f["geometry"]["coordinates"]]
        for linea in lineas:
            out.append({
                "type": "Feature",
                "properties": {"capa": "colector", "tipo": f["properties"].get("TIPO_CONDU"), "nombre": f["properties"].get("ID_IDE"), "fuente": "Catastro SIALL, DOH"},
                "geometry": {"type": "LineString", "coordinates": [[round(x, 6), round(y, 6)] for x, y in linea]},
            })
    for f in leer("data/las_condes/puntos_criticos_invierno_2026.geojson"):
        pr = f["properties"]
        out.append({
            "type": "Feature",
            "properties": {"capa": "critico", "tipo": pr.get("nivel_riesgo"), "nombre": pr.get("lugar"), "causa": pr.get("causa"), "fuente": "Puntos críticos invierno 2026, Las Condes"},
            "geometry": {"type": "Point", "coordinates": centroide(f["geometry"])},
        })
    SALIDA.write_text(json.dumps({"type": "FeatureCollection", "features": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    conteo: dict[str, int] = {}
    for f in out:
        conteo[f["properties"]["capa"]] = conteo.get(f["properties"]["capa"], 0) + 1
    print(f"{SALIDA.relative_to(RAIZ)}: {conteo}, {SALIDA.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

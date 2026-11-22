"""
Plan B de la red de calles para 04_flujo.py: la baja de la API 0.6 de OpenStreetMap por teselas cuando Overpass
no responde (el servicio público se cae seguido).

Deja el mismo archivo que 03_terreno.py y 04_flujo.py usan como caché:
    cache/osm/red_drive_mut_2500m.graphml

Cómo se arma (equivale a ox.graph_from_point(..., network_type="drive", simplify=True)):
  - Baja las teselas de ~550 m de la caja de 2,5 km alrededor del MUT (/api/0.6/map devuelve todo lo de la caja,
    así que se descartan los edificios y demás; solo quedan las calles).
  - Filtra los tramos para autos con las mismas reglas de osmnx (excluye peatonales, ciclovías, servicios, etc.).
  - ox.graph_from_xml arma y simplifica el grafo; ox.save_graphml lo guarda.

Uso (desde la raíz del repo):
    python pipeline/04a_red_osm_api.py
    python pipeline/04_flujo.py

La API tiene una política de uso: se baja una tesela a la vez, con pausa, y se identifica con User-Agent.
Diferencias con Overpass: la caja es la misma, pero no hay recorte por distancia; 04_flujo.py ya ignora lo que
queda fuera de su radio.
"""

import argparse
import math
import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

CENTRO = (-70.6010, -33.4178)  # igual que 03_terreno.py (lon, lat)
API = "https://api.openstreetmap.org/api/0.6/map"
UA = "drena-pipeline/0.1 (Platanus Hack 26, equipo 34)"

# Reglas de osmnx para network_type="drive"
HIGHWAY_EXCLUIDOS = set(
    "abandoned bridleway bus_guideway construction corridor cycleway elevator escalator footway no path pedestrian "
    "planned platform proposed raceway razed service steps track".split()
)
SERVICE_EXCLUIDOS = {"alley", "driveway", "emergency_access", "parking", "parking_aisle", "private"}


def es_calle_de_auto(tags):
    h = tags.get("highway")
    if not h or h in HIGHWAY_EXCLUIDOS or tags.get("area") == "yes":
        return False
    if tags.get("motor_vehicle") == "no" or tags.get("motorcar") == "no":
        return False
    return tags.get("service") not in SERVICE_EXCLUIDOS


def caja(radio_m):
    dlat = radio_m / 110_540
    dlon = radio_m / (111_320 * math.cos(math.radians(CENTRO[1])))
    return CENTRO[0] - dlon, CENTRO[1] - dlat, CENTRO[0] + dlon, CENTRO[1] + dlat


def bajar_tesela(w, s, e, n, intentos=5):
    for i in range(intentos):
        r = requests.get(API, params={"bbox": f"{w:.6f},{s:.6f},{e:.6f},{n:.6f}"}, headers={"User-Agent": UA}, timeout=(20, 120))
        if r.status_code == 200:
            return r.content
        if r.status_code == 400 and "50000" in r.text:
            return None  # demasiados nodos: hay que partir la tesela
        print(f"  tesela {r.status_code}, reintento {i + 1}")
        time.sleep(5 * (i + 1))
    raise RuntimeError("La API de OSM no respondió")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--radio", type=float, default=2500.0)
    ap.add_argument("--tesela", type=float, default=0.005, help="lado de la tesela en grados")
    ap.add_argument("--salida", default=None)
    a = ap.parse_args()
    salida = Path(a.salida or f"cache/osm/red_drive_mut_{a.radio:.0f}m.graphml")
    salida.parent.mkdir(parents=True, exist_ok=True)

    import osmnx as ox

    w0, s0, e0, n0 = caja(a.radio)
    nodos, vias = {}, {}
    cola = []
    x = w0
    while x < e0:
        y = s0
        while y < n0:
            cola.append((x, y, min(x + a.tesela, e0), min(y + a.tesela, n0)))
            y += a.tesela
        x += a.tesela
    print(f"{len(cola)} teselas")

    hechas = 0
    while cola:
        w, s, e, n = cola.pop(0)
        xml = bajar_tesela(w, s, e, n)
        if xml is None:  # tesela demasiado densa: se parte en 4
            mx, my = (w + e) / 2, (s + n) / 2
            cola = [(w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)] + cola
            continue
        raiz = ET.fromstring(xml)
        for el in raiz:
            if el.tag == "node":
                nodos[el.get("id")] = (el.get("lat"), el.get("lon"))
            elif el.tag == "way":
                tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
                if es_calle_de_auto(tags) and el.get("id") not in vias:
                    vias[el.get("id")] = ([nd.get("ref") for nd in el.findall("nd")], tags)
        hechas += 1
        if hechas % 10 == 0:
            print(f"  {hechas} teselas, {len(vias)} calles")
        time.sleep(0.6)

    usados = {r for nds, _ in vias.values() for r in nds}
    faltan = usados - nodos.keys()
    if faltan:
        print(f"OJO: {len(faltan)} nodos sin coordenadas; se descartan las calles que los usan")
        vias = {k: v for k, v in vias.items() if not (set(v[0]) & faltan)}
        usados = {r for nds, _ in vias.values() for r in nds}

    osm = ET.Element("osm", version="0.6")
    for nid in sorted(usados, key=int):
        lat, lon = nodos[nid]
        ET.SubElement(osm, "node", id=nid, lat=lat, lon=lon, version="1")
    for wid, (nds, tags) in vias.items():
        way = ET.SubElement(osm, "way", id=wid, version="1")
        for r in nds:
            ET.SubElement(way, "nd", ref=r)
        for k, v in tags.items():
            if re.match(r"^(highway|name|oneway|junction|lanes|maxspeed|ref|bridge|tunnel|service)$", k):
                ET.SubElement(way, "tag", k=k, v=v)
    xml_unido = salida.with_suffix(".osm")
    ET.ElementTree(osm).write(xml_unido, encoding="utf-8", xml_declaration=True)
    print(f"{len(usados)} nodos, {len(vias)} calles -> {xml_unido}")

    G = ox.graph_from_xml(xml_unido, bidirectional=False, simplify=True, retain_all=False)
    ox.save_graphml(G, salida)
    print(f"Grafo: {G.number_of_nodes()} nodos, {G.number_of_edges()} tramos -> {salida}")


if __name__ == "__main__":
    main()

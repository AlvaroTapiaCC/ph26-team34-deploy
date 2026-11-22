"""
Terreno con el plan B: elevación por nodo de la red de calles (OSMnx) y flujo por el grafo.

Uso (desde la raíz del repo, con data/rejillas.geojson ya generado por 02_rejillas.py):
    pip install -r pipeline/requirements.txt
    python pipeline/03_terreno.py                 # zona de terreno: 700 m alrededor del MUT
    python pipeline/03_terreno.py --buffer 3000   # red de calles más amplia aguas arriba
    # Otro sector (replay, issue #87): centro lon,lat, radio de la zona y sufijo de las salidas
    python pipeline/03_terreno.py --centro=-70.6,-33.45 --radio 700 --sufijo replay --nota "..."

Salidas (en data/, <sufijo> = mut por defecto):
    terreno_<sufijo>.csv          una fila por rejilla de la red: elevación, pendiente, área de aporte
    street_chains_<sufijo>.json   cadenas de rejillas calle abajo (formato de la tabla street_chains)
    terreno_<sufijo>.meta.json    fuentes, parámetros, conteos y sha256 de entradas, salidas y script

Sin argumentos calcula la zona MUT y sus salidas no cambian. En otro sector, la columna que marca
la zona se llama en_zona_<sufijo>: 07_cargar.py solo etiqueta como zona_mut la columna en_zona_mut.
La tesela del DEM se elige según el centro; si la red cruza el borde de la tesela, los nodos de
fuera quedan sin elevación y el script lo avisa.

Qué hace (issue #10, plan B de docs/plan-desarrollo.md):
  1. Baja la red de calles "drive" de OSM en un radio --buffer alrededor del centro. Es más
     grande que la zona para que el agua que llega desde aguas arriba quede contada.
  2. Asigna a cada nodo la elevación del DEM Copernicus GLO-30 (tile público de AWS). El GLO-30
     es un modelo de superficie, que incluye edificios y árboles; para acercarse al suelo de la
     calle se toma el MÍNIMO de la ventana de 3×3 píxeles (~90 m) alrededor del nodo.
  3. Rellena las depresiones del grafo (priority-flood desde el borde de la red) y define la
     dirección del flujo, como un D8 sobre el grafo: cada nodo desagua al vecino con mayor bajada
     sobre la elevación rellenada. Así el agua siempre sale por el borde de la red. La pendiente
     usa la elevación real; relleno_max_m deja registrado dónde había una depresión.
  4. Área de aporte: cada tramo aporta longitud × ANCHO_APORTE_M a su nodo bajo, y se acumula
     siguiendo el flujo. A una rejilla le llega lo acumulado en el nodo alto de su tramo (solo si
     ese nodo desagua por ese tramo) más la parte del tramo que queda aguas arriba de ella.
     Es un proxy: sirve para ordenar, no es un área hidrológica real.
  5. Pendiente: la del tramo donde está la rejilla, normalizada a 0-1 dividiendo por el
     percentil 90 de las pendientes de las rejillas de la zona MUT (queda en la metadata).
  6. Cadenas: desde cada rejilla que no tiene otra aguas arriba, se sigue el flujo y se listan
     las rejillas que va encontrando, con la distancia acumulada. Es la entrada del paso 2 de la
     fórmula (efecto en cadena); la fórmula toma el mayor aporte si una rejilla está en varias.

Limitaciones (para el pitch y la validación):
  - DEM de 30 m: en tramos cortos y planos la pendiente es ruido. El mínimo 3×3 baja el efecto
    de los edificios, pero no lo elimina.
  - Solo calles "drive": el agua de pasajes y patios no se cuenta.
  - Lo que está aguas arriba fuera de --buffer no se cuenta (el área queda corta en los bordes).
"""

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import requests

SCRIPT_VERSION = "0.5.0"

# MUT, Av. Apoquindo 2730, Las Condes (lon, lat). Confirmado con el pin el 21-11-2026.
CENTRO = (-70.601433, -33.417741)
CENTRO_NOTA = "confirmado con el pin (Av. Apoquindo 2730, Las Condes) el 21-11-2026"
RADIO_ZONA_M = 700
UTM = 32719



def dem_tile(lon, lat):
    """Tesela Copernicus GLO-30 de 1°×1° que contiene el punto (se nombra por su esquina SO)."""
    la, lo = math.floor(lat), math.floor(lon)
    return (f"Copernicus_DSM_COG_10_{'S' if la < 0 else 'N'}{abs(la):02d}_00_"
            f"{'W' if lo < 0 else 'E'}{abs(lo):03d}_00_DEM")


def dem_url(tile):
    return f"https://copernicus-dem-30m.s3.amazonaws.com/{tile}/{tile}.tif"


ANCHO_APORTE_M = 20.0     # ancho de calle + veredas que escurre hacia la calzada (proxy)
PENDIENTE_PERCENTIL = 90  # pendiente >= p90 de la zona = 1 en la variable "pendiente"
SNAP_MAX_M = 30.0         # rejillas más lejos que esto de una calle "drive" quedan fuera
CADENA_MAX_M = 3000.0     # largo máximo de una cadena calle abajo


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def bajar_dem(destino, tile):
    destino = Path(destino)
    if destino.exists():
        return destino
    destino.parent.mkdir(parents=True, exist_ok=True)
    print(f"Descargando DEM {tile} (~40 MB)...")
    tmp = destino.with_suffix(".part")
    with requests.get(dem_url(tile), stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(tmp, "wb") as fh:
            for trozo in r.iter_content(1 << 20):
                fh.write(trozo)
    tmp.rename(destino)
    return destino


def elevaciones_nodos(G, ruta_dem):
    """Mínimo 3×3 del DEM alrededor de cada nodo (G en WGS84)."""
    import numpy as np
    import rasterio
    from rasterio.windows import from_bounds

    xs = [d["x"] for _, d in G.nodes(data=True)]
    ys = [d["y"] for _, d in G.nodes(data=True)]
    margen = 0.002
    with rasterio.open(ruta_dem) as src:
        win = from_bounds(min(xs) - margen, min(ys) - margen, max(xs) + margen, max(ys) + margen, src.transform)
        win = win.round_offsets().round_lengths()
        arr = src.read(1, window=win).astype("float64")
        tr = src.window_transform(win)
        nodata = src.nodata
    if nodata is not None:
        arr[arr == nodata] = np.nan
    inv = ~tr
    z = {}
    for n, d in G.nodes(data=True):
        col, fila = inv * (d["x"], d["y"])
        fila, col = int(math.floor(fila)), int(math.floor(col))
        ventana = arr[max(fila - 1, 0) : fila + 2, max(col - 1, 0) : col + 2]
        z[n] = float(np.nanmin(ventana)) if ventana.size and not np.all(np.isnan(ventana)) else float("nan")
    return z


def parse_centro(texto):
    try:
        lon, lat = (float(v) for v in texto.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("se espera lon,lat (por ejemplo -70.6,-33.45)")
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise argparse.ArgumentTypeError("lon,lat fuera de rango (¿invertidos?)")
    return (lon, lat)


def red_desde_xml(ox, ruta, centro, radio):
    """Carga las mismas vías drive desde un extracto OSM con sus nodos completos."""
    import bz2
    import re
    from tempfile import TemporaryDirectory
    from xml.etree import ElementTree

    vias_excluidas = re.compile(
        "abandoned|bridleway|bus_guideway|construction|corridor|cycleway|elevator|"
        "escalator|footway|no|path|pedestrian|planned|platform|proposed|raceway|"
        "razed|rest_area|service|services|steps|track"
    )
    servicios_excluidos = re.compile("alley|driveway|emergency_access|parking|parking_aisle|private")
    abrir = bz2.open if Path(ruta).suffix == ".bz2" else open
    with abrir(ruta, "rb") as archivo:
        xml = ElementTree.parse(archivo)
    raiz = xml.getroot()
    for elemento in list(raiz):
        if elemento.tag == "node":
            continue
        if elemento.tag == "way":
            tags = {etiqueta.get("k"): etiqueta.get("v", "") for etiqueta in elemento.findall("tag")}
            if (
                "highway" in tags
                and "yes" not in tags.get("area", "")
                and "private" not in tags.get("access", "")
                and not vias_excluidas.search(tags["highway"])
                and "no" not in tags.get("motor_vehicle", "")
                and "no" not in tags.get("motorcar", "")
                and not servicios_excluidos.search(tags.get("service", ""))
            ):
                continue
        raiz.remove(elemento)

    with TemporaryDirectory() as carpeta:
        filtrado = Path(carpeta) / "drive.osm"
        xml.write(filtrado, encoding="utf-8", xml_declaration=True)
        grafo = ox.graph_from_xml(filtrado, simplify=False, retain_all=True)

    posicion = (centro[1], centro[0])
    borde = ox.utils_geo.bbox_from_point(posicion, dist=radio)
    borde_ampliado = ox.utils_geo.bbox_from_point(posicion, dist=radio + 500)
    grafo = ox.truncate.truncate_graph_bbox(grafo, borde_ampliado)
    grafo = ox.truncate.largest_component(grafo, strongly=False)
    grafo = ox.simplification.simplify_graph(grafo)
    grafo = ox.truncate.truncate_graph_bbox(grafo, borde)
    return ox.truncate.largest_component(grafo, strongly=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rejillas", default="data/rejillas.geojson")
    ap.add_argument("--centro", type=parse_centro, default=CENTRO,
                    help="centro de la zona como lon,lat (por defecto el MUT); con '=' si empieza con '-'")
    ap.add_argument("--radio", type=float, default=RADIO_ZONA_M, help="radio de la zona (m)")
    ap.add_argument("--sufijo", default="mut", help="sufijo de las salidas y de la columna en_zona_<sufijo>")
    ap.add_argument("--nota", default=None, help="de dónde sale el centro (queda en la metadata)")
    ap.add_argument("--buffer", type=float, default=2500.0, help="radio de la red de calles (m)")
    ap.add_argument("--dem", default=None, help="GeoTIFF del DEM (por defecto la tesela del centro en cache/dem/)")
    ap.add_argument("--salida", default=None, help="CSV de salida (por defecto data/terreno_<sufijo>.csv)")
    ap.add_argument("--refrescar-red", action="store_true", help="vuelve a bajar la red de OSM")
    ap.add_argument("--overpass", default="https://maps.mail.ru/osm/tools/overpass/api",
                    help="servidor Overpass (overpass-api.de a veces rechaza conexiones)")
    ap.add_argument("--osm-xml", help="extracto OSM XML local (.osm o .osm.bz2) con cobertura de --buffer + 500 m")
    a = ap.parse_args()
    if not a.sufijo.isidentifier():
        ap.error("--sufijo debe ser letras, números o _ (se usa en nombres de archivo y de columna)")
    if a.buffer - 200 < a.radio:
        ap.error("--buffer debe ser al menos --radio + 200 m para que la zona no quede en el borde de la red")
    CENTRO_Z = tuple(a.centro)
    es_mut = CENTRO_Z == CENTRO and a.radio == RADIO_ZONA_M
    nota = a.nota or (CENTRO_NOTA if CENTRO_Z == CENTRO else None)
    col_zona = f"en_zona_{a.sufijo}"
    radio_meta = int(a.radio) if float(a.radio).is_integer() else a.radio
    tile = dem_tile(*CENTRO_Z)
    a.dem = a.dem or f"cache/dem/{tile}.tif"
    a.salida = a.salida or f"data/terreno_{a.sufijo}.csv"
    if a.sufijo == "mut" and not es_mut:
        ap.error("el sufijo 'mut' es de la zona MUT: usa otro --sufijo para otro centro o radio")

    import geopandas as gpd
    import networkx as nx
    import osmnx as ox
    import pandas as pd
    from shapely.geometry import LineString, Point

    salida = Path(a.salida)
    salida.parent.mkdir(parents=True, exist_ok=True)

    # 1. Red de calles
    # La red se guarda en cache/ la primera vez y después se reutiliza: OSM cambia con el tiempo,
    # así que la metadata registra el sha256 y la fecha de descarga de la red usada.
    ruta_red = Path(f"cache/osm/red_drive_{CENTRO_Z[1]:.6f}_{CENTRO_Z[0]:.6f}_{a.buffer:.0f}m.graphml")
    fuente_xml = None
    if a.osm_xml:
        fuente_xml = {"ruta": a.osm_xml, "sha256": sha256(a.osm_xml)}
        ruta_red = ruta_red.with_name(f"{ruta_red.stem}_{fuente_xml['sha256'][:12]}.graphml")
    if ruta_red.exists() and not a.refrescar_red:
        print(f"Usando la red guardada {ruta_red}")
        G = ox.load_graphml(ruta_red)
    else:
        if fuente_xml:
            print(f"Leyendo red de calles 'drive' de {a.osm_xml}...")
            G = red_desde_xml(ox, a.osm_xml, CENTRO_Z, a.buffer)
        else:
            ox.settings.overpass_url = a.overpass
            print(f"Bajando red de calles 'drive' a {a.buffer:.0f} m del centro desde {a.overpass}...")
            G = ox.graph_from_point((CENTRO_Z[1], CENTRO_Z[0]), dist=a.buffer, network_type="drive", simplify=True)
        ruta_red.parent.mkdir(parents=True, exist_ok=True)
        ox.save_graphml(G, ruta_red)
    red_descargada = datetime.fromtimestamp(ruta_red.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    Gu = ox.convert.to_undirected(G)
    print(f"  nodos: {Gu.number_of_nodes()}, tramos: {Gu.number_of_edges()}")

    # 2. Elevación por nodo
    ruta_dem = bajar_dem(a.dem, tile)
    z = elevaciones_nodos(Gu, ruta_dem)
    sin_z = [n for n, v in z.items() if math.isnan(v)]
    if sin_z:
        print(f"  OJO: {len(sin_z)} nodos sin elevación; se dejan fuera del flujo.")

    # Tramos únicos (u, v) con el largo mínimo entre aristas paralelas y su geometría en UTM
    Gp = ox.project_graph(Gu, to_crs=UTM)
    tramos = {}
    for u, v, d in Gp.edges(data=True):
        if u == v:
            continue
        k = (u, v) if u < v else (v, u)
        L = float(d.get("length", 0.0))
        if k not in tramos or L < tramos[k]["L"]:
            geom = d.get("geometry") or LineString([(Gp.nodes[u]["x"], Gp.nodes[u]["y"]), (Gp.nodes[v]["x"], Gp.nodes[v]["y"])])
            # Orientar la geometría de k[0] a k[1]
            p0 = Point(Gp.nodes[k[0]]["x"], Gp.nodes[k[0]]["y"])
            if Point(geom.coords[0]).distance(p0) > Point(geom.coords[-1]).distance(p0):
                geom = LineString(list(geom.coords)[::-1])
            tramos[k] = {"L": max(L, 1e-6), "geom": geom, "nombre": d.get("name")}

    # 3a. Relleno de depresiones sobre el grafo (priority-flood desde el borde de la red).
    # Con DEM de 30 m muchos nodos quedan como pozos falsos (calles planas, restos de edificios).
    # El relleno sube cada pozo hasta su punto de rebalse (+ EPS), así todo nodo desagua hacia el
    # borde. El flujo usa la elevación rellenada; la pendiente sigue usando la elevación real.
    import heapq

    EPS = 0.001
    cx, cy = gpd.GeoSeries([Point(CENTRO_Z)], crs=4326).to_crs(UTM).iloc[0].coords[0]
    d_centro = {n: math.hypot(Gp.nodes[n]["x"] - cx, Gp.nodes[n]["y"] - cy) for n in Gp.nodes}
    validos = [n for n in Gu.nodes if not math.isnan(z[n])]
    borde = [n for n in validos if d_centro[n] >= a.buffer - 150]
    zf = {n: z[n] for n in validos}
    cola = [(z[n], n) for n in borde]
    heapq.heapify(cola)
    visto = set(borde)
    while cola:
        zc, n = heapq.heappop(cola)
        for m in Gu.neighbors(n):
            if m in visto or m not in zf:
                continue
            visto.add(m)
            zf[m] = max(z[m], zc + EPS)
            heapq.heappush(cola, (zf[m], m))
    relleno = {n: zf[n] - z[n] for n in zf}

    # 3b. Dirección del flujo: vecino con mayor bajada sobre la elevación rellenada
    def pozos_con(elev):
        return sum(
            1 for n in elev
            if not any(elev.get(m, math.inf) < elev[n] for m in Gu.neighbors(n) if m != n)
        )

    pozos_dem = pozos_con({n: z[n] for n in validos})
    receptor = {}
    for n in validos:
        mejor, pend = None, 0.0
        for m in Gu.neighbors(n):
            if m == n or m not in zf:
                continue
            k = (n, m) if n < m else (m, n)
            s = (zf[n] - zf[m]) / tramos[k]["L"]
            if s > pend:
                mejor, pend = m, s
        receptor[n] = mejor
    pozos = sum(1 for r in receptor.values() if r is None)
    pozos_interiores = sum(1 for n, r in receptor.items() if r is None and d_centro[n] < a.buffer - 150)
    print(f"  pozos: {pozos_dem} con el DEM; tras el relleno quedan {pozos} salidas, "
          f"{pozos_interiores} en el interior (red desconectada del borde)")

    # 4. Área de aporte por nodo, acumulada de más alto a más bajo
    propio = {n: 0.0 for n in receptor}
    for (u, v), t in tramos.items():
        if u not in receptor or v not in receptor:
            continue
        bajo = v if zf[u] >= zf[v] else u
        propio[bajo] += t["L"] * ANCHO_APORTE_M
    acc = dict(propio)
    for n in sorted(receptor, key=lambda n: -zf[n]):
        r = receptor[n]
        if r is not None:
            acc[r] += acc[n]

    # Rejillas: las que caen dentro del radio de la red, proyectadas a UTM
    rej = gpd.read_file(a.rejillas).to_crs(UTM)
    centro_utm = gpd.GeoSeries([Point(CENTRO_Z)], crs=4326).to_crs(UTM).iloc[0]
    dist_centro = rej.distance(centro_utm)
    rej = rej[dist_centro <= a.buffer - 200].copy()  # margen para no quedar en el borde de la red
    rej["dist_centro_m"] = rej.distance(centro_utm).round(1)
    print(f"Rejillas dentro de la red: {len(rej)} (zona {a.sufijo}: {(rej['dist_centro_m'] <= a.radio).sum()})")

    # Tramo más cercano a cada rejilla
    ids_tramos = list(tramos)
    gtr = gpd.GeoDataFrame({"k": range(len(ids_tramos))}, geometry=[tramos[k]["geom"] for k in ids_tramos], crs=UTM)
    cerca = gpd.sjoin_nearest(rej[["ID_IDE", "geometry"]], gtr, how="left", distance_col="snap_m")
    cerca = cerca.sort_values("snap_m").drop_duplicates("ID_IDE")
    geom_rej = dict(zip(rej["ID_IDE"], rej.geometry))

    filas, en_tramo = [], {}
    for _, r in cerca.iterrows():
        sid = r["ID_IDE"]
        k = ids_tramos[int(r["k"])]
        t = tramos[k]
        u, v = k
        if r["snap_m"] > SNAP_MAX_M or u not in receptor or v not in receptor:
            filas.append({"ID_IDE": sid, "snap_m": round(float(r["snap_m"]), 1), "fuera_de_red": True})
            continue
        frac = t["geom"].project(geom_rej[sid]) / max(t["geom"].length, 1e-6)  # 0 en u, 1 en v
        alto, bajo, pos = (u, v, frac) if zf[u] >= zf[v] else (v, u, 1 - frac)
        grade = abs(z[u] - z[v]) / t["L"]
        llega = (acc[alto] if receptor.get(alto) == bajo else 0.0) + pos * t["L"] * ANCHO_APORTE_M
        z_rej = z[alto] + (z[bajo] - z[alto]) * pos
        en_tramo.setdefault((alto, bajo), []).append((pos, sid))
        filas.append(
            {
                "ID_IDE": sid,
                "snap_m": round(float(r["snap_m"]), 1),
                "fuera_de_red": False,
                "calle": t["nombre"] if isinstance(t["nombre"], str) else (", ".join(t["nombre"]) if t["nombre"] else None),
                "nodo_alto": alto,
                "nodo_bajo": bajo,
                "elevacion_m": round(z_rej, 2),
                "pendiente_tramo": round(grade, 4),
                "area_aporte_m2": round(llega, 1),
                # Cuánto hubo que rellenar los nodos del tramo: > 0 indica una depresión en el DEM
                "relleno_max_m": round(max(relleno[alto], relleno[bajo]), 2),
                "nodo_bajo_es_salida": receptor.get(bajo) is None,
            }
        )
    for lista in en_tramo.values():
        lista.sort()

    # 6. Cadenas calle abajo
    def camino(sid, alto, bajo, pos):
        """Rejillas aguas abajo de sid (incluida), con distancia acumulada desde sid."""
        L0 = tramos[(alto, bajo) if alto < bajo else (bajo, alto)]["L"]
        ids, dist = [sid], [0.0]
        for p, otro in en_tramo[(alto, bajo)]:
            if p > pos:
                ids.append(otro)
                dist.append((p - pos) * L0)
        recorrido = (1 - pos) * L0
        n, vistos = bajo, {alto, bajo}
        while receptor.get(n) is not None and recorrido < CADENA_MAX_M:
            m = receptor[n]
            if m in vistos:
                break
            vistos.add(m)
            L = tramos[(n, m) if n < m else (m, n)]["L"]
            for p, otro in en_tramo.get((n, m), []):
                ids.append(otro)
                dist.append(recorrido + p * L)
            recorrido += L
            n = m
        return ids, dist

    info = {f["ID_IDE"]: f for f in filas if not f["fuera_de_red"]}
    caminos = {}
    for sid, f in info.items():
        pos = next(p for p, o in en_tramo[(f["nodo_alto"], f["nodo_bajo"])] if o == sid)
        caminos[sid] = camino(sid, f["nodo_alto"], f["nodo_bajo"], pos)
    tiene_arriba = {o for ids, _ in caminos.values() for o in ids[1:]}
    cadenas = []
    for sid in sorted(caminos):
        ids, dist = caminos[sid]
        if sid in tiene_arriba or len(ids) < 2:
            continue
        cadenas.append(
            {
                "street_id": f"flujo:{sid}",
                "nombre": info[sid].get("calle"),
                "sumidero_ids": ids,
                "distancias_m": [round(d, 1) for d in dist],
            }
        )
    # Cadena principal de cada rejilla: la más larga que la contiene (para sumideros.street_id)
    principal = {}
    for c in sorted(cadenas, key=lambda c: -len(c["sumidero_ids"])):
        for i, sid in enumerate(c["sumidero_ids"]):
            principal.setdefault(sid, (c["street_id"], i))

    df = pd.DataFrame(filas).merge(rej[["ID_IDE", "dist_centro_m", "comuna"]], on="ID_IDE", how="left")
    df[col_zona] = df["dist_centro_m"] <= a.radio
    df["street_id"] = df["ID_IDE"].map(lambda s: principal.get(s, (None, None))[0])
    df["orden_en_calle"] = df["ID_IDE"].map(lambda s: principal.get(s, (None, None))[1])
    for col in ("nodo_alto", "nodo_bajo", "orden_en_calle"):
        df[col] = df[col].astype("Int64")
    import numpy as np

    pend_zona = df.loc[df[col_zona] & ~df["fuera_de_red"], "pendiente_tramo"].astype(float)
    pendiente_ref = float(np.percentile(pend_zona, PENDIENTE_PERCENTIL))
    df["pendiente"] = (df["pendiente_tramo"].astype(float) / pendiente_ref).clip(0, 1).round(4)
    print(f"Pendiente de referencia (p{PENDIENTE_PERCENTIL} de {len(pend_zona)} rejillas de la zona {a.sufijo}): {pendiente_ref:.4f}")
    df = df.sort_values([col_zona, "ID_IDE"], ascending=[False, True])
    df.to_csv(salida, index=False)
    ruta_cad = salida.with_name(f"street_chains_{a.sufijo}.json")
    ruta_cad.write_text(json.dumps(cadenas, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    zona = df[df[col_zona]]
    conteos = {
        "nodos": Gu.number_of_nodes(),
        "tramos": len(tramos),
        "nodos_pozo_dem": pozos_dem,
        "nodos_salida_tras_relleno": pozos,
        "salidas_interiores": pozos_interiores,
        "nodos_sin_elevacion": len(sin_z),
        "rejillas_en_red": int((~df["fuera_de_red"]).sum()),
        "rejillas_fuera_de_red": int(df["fuera_de_red"].sum()),
        f"zona_{a.sufijo}": {
            "rejillas": len(zona),
            "fuera_de_red": int(zona["fuera_de_red"].sum()),
            "en_alguna_cadena": int(zona["street_id"].notna().sum()),
        },
        "cadenas": len(cadenas),
    }
    print("\n== Resumen ==")
    print(json.dumps(conteos, ensure_ascii=False, indent=1))

    meta = {
        "generado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "metodo": "plan B: elevación por nodo (OSMnx) y flujo por el grafo de calles",
        "zona": {"sufijo": a.sufijo, "centro_lonlat": list(CENTRO_Z), "radio_m": radio_meta,
                 "centro_confirmado": CENTRO_Z == CENTRO, "nota": nota, "columna": col_zona},
        "red_calles": {"fuente": "OpenStreetMap vía OSMnx", "network_type": "drive", "radio_m": a.buffer,
                       "osmnx": ox.__version__, "overpass": a.overpass, "graphml": str(ruta_red), "sha256": sha256(ruta_red),
                       "descargada_utc": red_descargada},
        "dem": {"fuente": dem_url(tile), "tesela": tile, "sha256": sha256(ruta_dem), "muestreo": "mínimo de 3×3 píxeles por nodo"},
        "parametros": {"ancho_aporte_m": ANCHO_APORTE_M, "pendiente_ref": round(pendiente_ref, 6),
                       "pendiente_ref_regla": f"percentil {PENDIENTE_PERCENTIL} de pendiente_tramo de las rejillas {col_zona}",
                       "snap_max_m": SNAP_MAX_M, "cadena_max_m": CADENA_MAX_M},
        "entradas": {"rejillas": {"ruta": a.rejillas, "sha256": sha256(a.rejillas)}},
        "salidas": {salida.name: sha256(salida), ruta_cad.name: sha256(ruta_cad)},
        "conteos": conteos,
        "script": {"ruta": "pipeline/03_terreno.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
    }
    if fuente_xml:
        meta["red_calles"].pop("overpass")
        meta["red_calles"].pop("descargada_utc")
        meta["red_calles"]["fuente"] = "OpenStreetMap XML vía OSMnx"
        meta["red_calles"]["extracto_xml"] = fuente_xml
    ruta_meta = salida.with_name(f"terreno_{a.sufijo}.meta.json")
    ruta_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nGuardado {salida}, {ruta_cad} y {ruta_meta}")


if __name__ == "__main__":
    main()

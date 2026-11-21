"""
Exporta la red de escurrimiento para animar el flujo de agua en el mapa (frontend/public/data/flujo.geojson).

Usa el MISMO método de pipeline/03_terreno.py (plan B): red de calles "drive" de OSMnx, elevación por nodo
del DEM Copernicus GLO-30 (mínimo 3x3), relleno de depresiones y dirección de flujo D8 sobre el grafo. Aquí
solo se escribe el grafo dirigido, que 03_terreno.py usa por dentro pero no guarda. Si cambia el método de
03_terreno.py, hay que cambiarlo aquí también: el script compara sus resultados con data/terreno_mut.csv
(nodo_bajo de cada rejilla) y avisa si no calzan.

Uso (desde la raíz del repo; reutiliza cache/ de 03_terreno.py si existe):
    pip install -r pipeline/requirements.txt
    python pipeline/04_flujo.py

Salidas:
    frontend/public/data/flujo.geojson   tramos dirigidos y sumideros (ver abajo)
    data/flujo.meta.json                 fuentes, parámetros, conteos y sha256

Contenido de flujo.geojson (coordenadas [lon, lat] con 5 decimales):
  Features LineString (kind = "tramo"): un tramo por nodo con salida, dibujado de aguas arriba a aguas abajo.
      id      número del tramo
      a, b    nodos OSM de origen y destino
      L       largo (m)
      s       pendiente real del DEM (m/m, puede ser 0 donde el flujo sale de rellenar una depresión)
      r       1 si la dirección sale del relleno de una depresión (el DEM no baja en ese tramo)
      ap      área propia que aporta el nodo "a" (m², largo x ancho de aporte de las calles que bajan a él)
      acc     área acumulada que pasa por el tramo (m², suma de todo lo de aguas arriba)
      sig     id del tramo siguiente aguas abajo (null en la salida de la red)
  Features Point (kind = "sumidero"): las rejillas del catastro que están dentro de la red.
      id      ID_IDE de la DOH (el mismo id que usa el backend)
      tramo   tramo por el que pasa el agua que le llega (null si el flujo no pasa por su tramo)
      pos     posición en el tramo, 0 (aguas arriba) a 1 (aguas abajo)
      ap      área local que le llega (m²), la misma regla de 03_terreno.py
      s       pendiente del tramo donde está
      drena   id del siguiente sumidero aguas abajo (null si no hay otro antes de salir de la red)
      comuna  comuna según los límites de 00_comunas.py

Los tramos sin dirección (nodos sin vecino más bajo tras el relleno: las salidas de la red) no se exportan,
así que el front no los anima. No se inventa ningún dato: todo sale de OpenStreetMap, el DEM y el catastro.
"""

import argparse
import hashlib
import heapq
import importlib.util
import json
import math
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_VERSION = "0.1.0"
RADIO_EXPORT_M = 2300.0  # tramos con el nodo de origen a menos de esto del centro del MUT


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def cargar_terreno():
    """Importa pipeline/03_terreno.py (su nombre empieza con un número) para reusar sus constantes y funciones."""
    ruta = Path(__file__).with_name("03_terreno.py")
    spec = importlib.util.spec_from_file_location("terreno", ruta)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rejillas", default="data/rejillas.geojson")
    ap.add_argument("--terreno", default="data/terreno_mut.csv", help="salida de 03_terreno.py, para comprobar")
    ap.add_argument("--buffer", type=float, default=2500.0)
    ap.add_argument("--dem", default=None)
    ap.add_argument("--salida", default="frontend/public/data/flujo.geojson")
    ap.add_argument("--meta", default="data/flujo.meta.json")
    a = ap.parse_args()

    import geopandas as gpd
    import osmnx as ox
    import pandas as pd
    from shapely.geometry import LineString, Point

    T = cargar_terreno()
    UTM, CENTRO, ANCHO = T.UTM, T.CENTRO, T.ANCHO_APORTE_M
    dem = a.dem or "cache/dem/" + T.DEM_TILE + ".tif"

    ruta_red = Path(f"cache/osm/red_drive_mut_{a.buffer:.0f}m.graphml")
    if ruta_red.exists():
        G = ox.load_graphml(ruta_red)
    else:
        print("Bajando la red de calles (OSM)...")
        G = ox.graph_from_point((CENTRO[1], CENTRO[0]), dist=a.buffer, network_type="drive", simplify=True)
        ruta_red.parent.mkdir(parents=True, exist_ok=True)
        ox.save_graphml(G, ruta_red)
    Gu = ox.convert.to_undirected(G)
    z = T.elevaciones_nodos(Gu, T.bajar_dem(dem))
    Gp = ox.project_graph(Gu, to_crs=UTM)

    tramos = {}
    for u, v, d in Gp.edges(data=True):
        if u == v:
            continue
        k = (u, v) if u < v else (v, u)
        L = float(d.get("length", 0.0))
        if k not in tramos or L < tramos[k]["L"]:
            geom = d.get("geometry") or LineString([(Gp.nodes[u]["x"], Gp.nodes[u]["y"]), (Gp.nodes[v]["x"], Gp.nodes[v]["y"])])
            p0 = Point(Gp.nodes[k[0]]["x"], Gp.nodes[k[0]]["y"])
            if Point(geom.coords[0]).distance(p0) > Point(geom.coords[-1]).distance(p0):
                geom = LineString(list(geom.coords)[::-1])
            tramos[k] = {"L": max(L, 1e-6), "geom": geom, "nombre": d.get("name")}

    # --- Relleno de depresiones y dirección D8 (igual que 03_terreno.py, pasos 3a y 3b) ---
    EPS = 0.001
    cx, cy = gpd.GeoSeries([Point(CENTRO)], crs=4326).to_crs(UTM).iloc[0].coords[0]
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

    propio = {n: 0.0 for n in receptor}
    for (u, v), t in tramos.items():
        if u in receptor and v in receptor:
            propio[v if zf[u] >= zf[v] else u] += t["L"] * ANCHO
    acc = dict(propio)
    for n in sorted(receptor, key=lambda n: -zf[n]):
        if receptor[n] is not None:
            acc[receptor[n]] += acc[n]

    # --- Tramos dirigidos: uno por nodo con receptor, dentro del radio de exportación ---
    def coords_wgs(geom_utm):
        s = gpd.GeoSeries([geom_utm], crs=UTM).to_crs(4326).iloc[0]
        return [[round(x, 5), round(y, 5)] for x, y in s.coords]

    ids = {}
    for n, r in receptor.items():
        if r is not None and d_centro[n] <= RADIO_EXPORT_M:
            ids[n] = len(ids)
    feats = []
    for n, i in ids.items():
        r = receptor[n]
        k = (n, r) if n < r else (r, n)
        geom = tramos[k]["geom"]
        p0 = Point(Gp.nodes[n]["x"], Gp.nodes[n]["y"])
        if Point(geom.coords[0]).distance(p0) > Point(geom.coords[-1]).distance(p0):
            geom = LineString(list(geom.coords)[::-1])  # de aguas arriba a aguas abajo
        L = tramos[k]["L"]
        feats.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "tramo", "id": i, "a": n, "b": r, "L": round(L), "s": round(abs(z[n] - z[r]) / L, 4),
                    "r": int(z[n] <= z[r]), "ap": round(propio[n]), "acc": round(acc[n]), "sig": ids.get(r),
                },
                "geometry": {"type": "LineString", "coordinates": coords_wgs(geom)},
            }
        )

    # --- Sumideros del catastro dentro de la red ---
    rej = gpd.read_file(a.rejillas).to_crs(UTM)
    centro_utm = gpd.GeoSeries([Point(CENTRO)], crs=4326).to_crs(UTM).iloc[0]
    rej = rej[rej.distance(centro_utm) <= a.buffer - 200].copy()
    ks = list(tramos)
    gtr = gpd.GeoDataFrame({"k": range(len(ks))}, geometry=[tramos[k]["geom"] for k in ks], crs=UTM)
    cerca = gpd.sjoin_nearest(rej[["ID_IDE", "comuna", "geometry"]], gtr, how="left", distance_col="snap_m")
    cerca = cerca.sort_values("snap_m").drop_duplicates("ID_IDE")
    geom_rej = dict(zip(rej["ID_IDE"], rej.geometry))
    wgs = gpd.GeoSeries(rej.geometry, crs=UTM).to_crs(4326)
    pos_wgs = dict(zip(rej["ID_IDE"], wgs))

    sums, en_tramo = {}, {}
    for _, r in cerca.iterrows():
        sid, k = r["ID_IDE"], ks[int(r["k"])]
        u, v = k
        if r["snap_m"] > T.SNAP_MAX_M or u not in receptor or v not in receptor:
            continue
        t = tramos[k]
        frac = t["geom"].project(geom_rej[sid]) / max(t["geom"].length, 1e-6)  # 0 en u, 1 en v
        alto, bajo, pos = (u, v, frac) if zf[u] >= zf[v] else (v, u, 1 - frac)
        en_flujo = receptor.get(alto) == bajo
        llega = (acc[alto] if en_flujo else 0.0) + pos * t["L"] * ANCHO
        sums[sid] = {"alto": alto, "bajo": bajo, "pos": pos, "en_flujo": en_flujo, "ap": llega,
                     "s": abs(z[u] - z[v]) / t["L"], "comuna": r["comuna"], "k": k}
        if en_flujo:
            en_tramo.setdefault((alto, bajo), []).append((pos, sid))
    for lista in en_tramo.values():
        lista.sort()

    def siguiente(sid):
        """Siguiente sumidero aguas abajo de `sid` (misma regla que las cadenas de 03_terreno.py)."""
        f = sums[sid]
        for p, otro in en_tramo[(f["alto"], f["bajo"])]:
            if p > f["pos"]:
                return otro
        n, vistos, recorrido = f["bajo"], {f["alto"], f["bajo"]}, (1 - f["pos"]) * tramos[tuple(sorted((f["alto"], f["bajo"])))]["L"]
        while receptor.get(n) is not None and recorrido < T.CADENA_MAX_M:
            m = receptor[n]
            if m in vistos:
                return None
            vistos.add(m)
            if en_tramo.get((n, m)):
                return en_tramo[(n, m)][0][1]
            recorrido += tramos[(n, m) if n < m else (m, n)]["L"]
            n = m
        return None

    for sid, f in sorted(sums.items()):
        p = pos_wgs[sid]
        i_tramo = ids.get(f["alto"]) if f["en_flujo"] else None
        feats.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "sumidero", "id": sid, "tramo": i_tramo, "pos": round(f["pos"], 3), "ap": round(f["ap"]),
                    "s": round(f["s"], 4), "drena": siguiente(sid) if f["en_flujo"] else None, "comuna": f["comuna"],
                },
                "geometry": {"type": "Point", "coordinates": [round(p.x, 5), round(p.y, 5)]},
            }
        )

    # --- Comprobación contra data/terreno_mut.csv: mismas rejillas aguas abajo ---
    ok = tot = 0
    if Path(a.terreno).exists():
        df = pd.read_csv(a.terreno)
        df = df[~df["fuera_de_red"].astype(bool)]
        for _, r in df.iterrows():
            f = sums.get(r["ID_IDE"])
            if f is None:
                continue
            tot += 1
            ok += int(f["bajo"] == int(r["nodo_bajo"]))
        print(f"Comprobación con {a.terreno}: {ok} de {tot} rejillas con el mismo nodo_bajo")
        if tot and ok / tot < 0.98:
            print("OJO: el flujo no calza con 03_terreno.py (¿otra versión de la red de OSM?). Revisar antes de publicar.")

    salida = Path(a.salida)
    salida.parent.mkdir(parents=True, exist_ok=True)
    texto = json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":"))
    salida.write_text(texto, encoding="utf-8")
    n_t = sum(1 for f in feats if f["properties"]["kind"] == "tramo")
    n_s = len(feats) - n_t
    print(f"{n_t} tramos y {n_s} sumideros, {salida.stat().st_size / 1024:.0f} KB -> {salida}")

    meta = {
        "generado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "metodo": "mismo que 03_terreno.py: elevación por nodo, relleno de depresiones y D8 sobre el grafo de calles",
        "red_calles": {"graphml": str(ruta_red), "sha256": sha256(ruta_red), "radio_m": a.buffer, "osmnx": ox.__version__},
        "dem": {"sha256": sha256(dem)},
        "parametros": {"ancho_aporte_m": ANCHO, "radio_export_m": RADIO_EXPORT_M, "snap_max_m": T.SNAP_MAX_M},
        "conteos": {"tramos": n_t, "sumideros": n_s, "comprobacion_terreno": {"calzan": ok, "de": tot}},
        "salida": {"archivo": str(salida), "sha256": sha256(salida), "bytes": salida.stat().st_size},
        "script": {"ruta": "pipeline/04_flujo.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
    }
    Path(a.meta).write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Metadata en {a.meta}")


if __name__ == "__main__":
    main()

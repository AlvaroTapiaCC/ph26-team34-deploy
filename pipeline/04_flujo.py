"""
Exporta la red de escurrimiento de Providencia, Ñuñoa y Las Condes para animar el flujo estimado en el mapa
(frontend/public/data/flujo/). Es flujo estimado por la pendiente, no una simulación hidráulica.

Usa el MISMO método de pipeline/03_terreno.py (plan B): red de calles "drive" de OSMnx, elevación por nodo
del DEM Copernicus GLO-30 (mínimo 3x3), relleno de depresiones y dirección de flujo D8 sobre el grafo. Aquí
solo se escribe el grafo dirigido, que 03_terreno.py usa por dentro pero no guarda. Si cambia el método de
03_terreno.py, hay que cambiarlo aquí también: el script compara sus resultados con data/terreno_mut.csv
(nodo_bajo de cada rejilla) y avisa si no calzan. El ranking y la predicción congelada de la zona MUT
(03_terreno.py, 700 m) no usan estas salidas.

Red de calles: el polígono de las 3 comunas (data/comunas.geojson) con un margen de --margen m (1 km por
defecto), para contar el agua que llega desde aguas arriba. El relleno de depresiones parte del borde de ese
polígono. Se exportan los tramos cuyo nodo de origen queda dentro de las comunas; el área de los tramos del
margen que les entregan agua se suma a su "ap", así el caudal de régimen no se corta en el borde.

Uso (desde la raíz del repo; reutiliza cache/ si existe):
    pip install -r pipeline/requirements.txt
    python pipeline/04_flujo.py
    # Si Overpass no responde: python pipeline/04a_red_osm_api.py --comunas, y después este script

Salidas:
    frontend/public/data/flujo/indice.json     teselas, conteos, caja inicial y dependencias aguas arriba
    frontend/public/data/flujo/t_<i>_<j>.json  tramos y sumideros de cada tesela (formato compacto, abajo)
    data/flujo.meta.json                       fuentes, parámetros, conteos y sha256

Teselas: cuadrícula de --tesela grados (0,02° ≈ 1,9 × 2,2 km) desde la esquina SO de las comunas. Un tramo va en
la tesela de su punto medio; un sumidero, en la de su tramo (o en la de su posición si no tiene tramo). En el
índice, "arriba" lista las teselas de las que depende cada una (todas las que tienen algún tramo aguas arriba de
alguno de los suyos): el mapa carga lo visible más eso, y el caudal calculado no queda corto.

Formato de cada tesela (JSON; coordenadas en enteros de 1e-5 grados, cada vértice como diferencia con el anterior):
  "t": tramos, un arreglo por tramo, dibujado de aguas arriba a aguas abajo:
      [id, L, sp, ap, acc, sig, calle, coords]
      id      número global del tramo
      L       largo (m)
      sp      pendiente que usa la simulación (m/m): la del DEM, suavizada donde no sirve (pipeline/flujo/pendientes.py)
      ap      área propia que aporta el nodo de origen (m², largo x ancho de aporte de las calles que bajan a él),
              más el área de los tramos del margen que le entregan agua
      acc     área acumulada que pasa por el tramo (m², redondeada a 100 m²): el mapa la usa para elegir los troncales
      sig     id del tramo siguiente aguas abajo (null en la salida de la red)
      calle   índice en "calles" (null si OSM no tiene nombre)
      coords  [x0, y0, dx1, dy1, ...] tras Douglas-Peucker de --simplificar m
  "s": sumideros del catastro: [n, id, x, y, tramo, pos, ap, s, comuna]
      n       número global del sumidero
      id      ID_IDE de la DOH (el mismo id que usa el backend)
      x, y    posición (enteros de 1e-5 grados, absolutos)
      tramo   tramo por el que pasa el agua que le llega (null si el flujo no pasa por su tramo)
      pos     posición en el tramo, 0 (aguas arriba) a 1 (aguas abajo)
      ap      área local que le llega (m²), la misma regla de 03_terreno.py
      s       pendiente del tramo donde está (m/m)
      comuna  índice en "comunas"
  "calles", "comunas": textos referidos por índice.

Los tramos sin dirección (nodos sin vecino más bajo tras el relleno: las salidas de la red) no se exportan,
así que el front no los anima. No se inventa ningún dato: todo sale de OpenStreetMap, el DEM y el catastro.
"""

import argparse
import hashlib
import heapq
import importlib.util
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_VERSION = "0.2.0"
RADIO_ZONA_INICIAL_M = 2300.0  # caja con la que abre el mapa (la red que cubría la versión 0.1.0)


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def cargar_modulo(nombre, ruta):
    """Importa un script del pipeline cuyo nombre no sirve para import (empieza con un número)."""
    spec = importlib.util.spec_from_file_location(nombre, ruta)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rejillas", default="data/rejillas.geojson")
    ap.add_argument("--comunas", default="data/comunas.geojson")
    ap.add_argument("--terreno", default="data/terreno_mut.csv", help="salida de 03_terreno.py, para comprobar")
    ap.add_argument("--margen", type=float, default=1000.0, help="margen aguas arriba alrededor de las comunas (m)")
    ap.add_argument("--tesela", type=float, default=0.02, help="lado de la tesela (grados)")
    ap.add_argument("--simplificar", type=float, default=2.0, help="tolerancia de Douglas-Peucker (m)")
    ap.add_argument("--overpass", default="https://maps.mail.ru/osm/tools/overpass/api")
    ap.add_argument("--refrescar-red", action="store_true", help="vuelve a bajar la red de OSM")
    ap.add_argument("--dem", default=None)
    ap.add_argument("--salida", default="frontend/public/data/flujo")
    ap.add_argument("--meta", default="data/flujo.meta.json")
    a = ap.parse_args()

    import geopandas as gpd
    import osmnx as ox
    import pandas as pd
    import shapely
    from shapely.geometry import LineString, Point

    T = cargar_modulo("terreno", Path(__file__).with_name("03_terreno.py"))
    P = cargar_modulo("pendientes", Path(__file__).parent / "flujo" / "pendientes.py")
    UTM, CENTRO, ANCHO = T.UTM, T.CENTRO, T.ANCHO_APORTE_M
    tile = T.dem_tile(*CENTRO)  # Copernicus GLO-30 S34 W071: cubre las 3 comunas
    dem = T.bajar_dem(a.dem or f"cache/dem/{tile}.tif", tile)

    # --- 1. Red de calles: polígono de las comunas + margen ---
    comunas = gpd.read_file(a.comunas).to_crs(UTM)
    zona = comunas.union_all()
    descarga = zona.buffer(a.margen)
    descarga_wgs = gpd.GeoSeries([descarga], crs=UTM).to_crs(4326).iloc[0]
    ruta_red = Path(f"cache/osm/red_drive_comunas_{a.margen:.0f}m.graphml")
    ruta_fuente = ruta_red.with_suffix(".fuente.json")  # de dónde salió la red guardada (Overpass o API 0.6)
    if ruta_red.exists() and not a.refrescar_red:
        print(f"Usando la red guardada {ruta_red}")
        G = ox.load_graphml(ruta_red)
    else:
        ox.settings.overpass_url = os.environ.get("OVERPASS_URL", a.overpass)
        print(f"Bajando la red de calles 'drive' de las comunas + {a.margen:.0f} m desde {ox.settings.overpass_url}...")
        G = ox.graph_from_polygon(descarga_wgs, network_type="drive", simplify=True)
        ruta_red.parent.mkdir(parents=True, exist_ok=True)
        ox.save_graphml(G, ruta_red)
        ruta_fuente.write_text(json.dumps({"fuente": "Overpass", "url": ox.settings.overpass_url}), encoding="utf-8")
    fuente_red = json.loads(ruta_fuente.read_text(encoding="utf-8")) if ruta_fuente.exists() else {"fuente": "desconocida"}
    red_descargada = datetime.fromtimestamp(ruta_red.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    # La red de 04a_red_osm_api.py --comunas es una caja: se recorta al polígono, como la de Overpass
    G = ox.truncate.truncate_graph_polygon(G, descarga_wgs, truncate_by_edge=False)
    G = ox.truncate.largest_component(G, strongly=False)
    Gu = ox.convert.to_undirected(G)
    print(f"  nodos: {Gu.number_of_nodes()}, tramos: {Gu.number_of_edges()}")
    z = T.elevaciones_nodos(Gu, dem)
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

    # --- 2. Relleno de depresiones y dirección D8 (igual que 03_terreno.py, pasos 3a y 3b) ---
    # El borde de la red es el del polígono de descarga: el agua sale por ahí.
    EPS = 0.001
    nodos = list(Gp.nodes)
    pts = shapely.points([Gp.nodes[n]["x"] for n in nodos], [Gp.nodes[n]["y"] for n in nodos])
    d_borde = dict(zip(nodos, shapely.distance(descarga.boundary, pts)))
    dentro = dict(zip(nodos, shapely.contains_xy(zona, [Gp.nodes[n]["x"] for n in nodos], [Gp.nodes[n]["y"] for n in nodos])))
    validos = [n for n in Gu.nodes if not math.isnan(z[n])]
    if len(validos) < len(nodos):
        print(f"  OJO: {len(nodos) - len(validos)} nodos sin elevación; se dejan fuera del flujo.")
    borde = [n for n in validos if d_borde[n] <= 150]
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
    salidas_interiores = sum(1 for n, r in receptor.items() if r is None and d_borde[n] > 150)

    propio = {n: 0.0 for n in receptor}
    for (u, v), t in tramos.items():
        if u in receptor and v in receptor:
            propio[v if zf[u] >= zf[v] else u] += t["L"] * ANCHO
    acc = dict(propio)
    for n in sorted(receptor, key=lambda n: -zf[n]):
        if receptor[n] is not None:
            acc[receptor[n]] += acc[n]

    # --- 3. Tramos dirigidos: uno por nodo con receptor y origen dentro de las comunas ---
    exportados = sorted((n for n, r in receptor.items() if r is not None and dentro[n]), key=lambda n: -zf[n])
    ids = {n: i for i, n in enumerate(exportados)}
    # Agua que entra desde el margen: área acumulada de los nodos no exportados que desaguan en uno exportado
    externo = defaultdict(float)
    for n, r in receptor.items():
        if r is not None and r in ids and n not in ids:
            externo[r] += acc[n]

    a_wgs = lambda geoms: gpd.GeoSeries(geoms, crs=UTM).to_crs(4326)  # noqa: E731
    geoms, info = [], []
    for n in exportados:
        r = receptor[n]
        k = (n, r) if n < r else (r, n)
        geom = tramos[k]["geom"]
        p0 = Point(Gp.nodes[n]["x"], Gp.nodes[n]["y"])
        if Point(geom.coords[0]).distance(p0) > Point(geom.coords[-1]).distance(p0):
            geom = LineString(list(geom.coords)[::-1])  # de aguas arriba a aguas abajo
        geoms.append(geom.simplify(a.simplificar))  # Douglas-Peucker en metros; conserva los extremos
        L = tramos[k]["L"]
        nombre = tramos[k]["nombre"]
        if isinstance(nombre, list):
            nombre = nombre[0] if nombre else None
        info.append({"id": ids[n], "L": L, "s": abs(z[n] - z[r]) / L, "r": int(z[n] <= z[r]), "ap": propio[n] + externo[n],
                     "acc": acc[n], "sig": ids.get(r), "nombre": nombre if isinstance(nombre, str) else None, "nodo": n})
    vert_antes = sum(len(tramos[(n, receptor[n]) if n < receptor[n] else (receptor[n], n)]["geom"].coords) for n in exportados)
    vert_despues = sum(len(g.coords) for g in geoms)
    sp = P.suavizar(info)
    wgs = a_wgs(geoms)
    for t, g in zip(info, wgs):
        t["sp"] = sp[t["id"]]
        t["coords"] = [(round(x * 1e5), round(y * 1e5)) for x, y in g.coords]
        mx, my = g.interpolate(0.5, normalized=True).coords[0]
        t["mid"] = (mx, my)

    # --- 4. Sumideros del catastro dentro de las comunas ---
    rej = gpd.read_file(a.rejillas).to_crs(UTM)
    rej = rej[rej.within(zona.buffer(1))].copy()
    ks = list(tramos)
    gtr = gpd.GeoDataFrame({"k": range(len(ks))}, geometry=[tramos[k]["geom"] for k in ks], crs=UTM)
    cerca = gpd.sjoin_nearest(rej[["ID_IDE", "comuna", "geometry"]], gtr, how="left", distance_col="snap_m")
    cerca = cerca.sort_values("snap_m").drop_duplicates("ID_IDE")
    geom_rej = dict(zip(rej["ID_IDE"], rej.geometry))
    pos_wgs = dict(zip(rej["ID_IDE"], gpd.GeoSeries(rej.geometry, crs=UTM).to_crs(4326)))

    sums = {}
    for _, r in cerca.iterrows():
        sid, k = r["ID_IDE"], ks[int(r["k"])]
        u, v = k
        if r["snap_m"] > T.SNAP_MAX_M or u not in receptor or v not in receptor:
            continue
        t = tramos[k]
        frac = t["geom"].project(geom_rej[sid]) / max(t["geom"].length, 1e-6)  # 0 en u, 1 en v
        alto, bajo, pos = (u, v, frac) if zf[u] >= zf[v] else (v, u, 1 - frac)
        en_flujo = receptor.get(alto) == bajo and alto in ids
        llega = (acc[alto] if receptor.get(alto) == bajo else 0.0) + pos * t["L"] * ANCHO
        sums[sid] = {"alto": alto, "bajo": bajo, "pos": pos, "tramo": ids[alto] if en_flujo else None, "ap": llega,
                     "s": abs(z[u] - z[v]) / t["L"], "comuna": r["comuna"]}
    fuera_de_red = len(rej) - len(sums)

    # --- 5. Comprobación contra data/terreno_mut.csv: mismas rejillas aguas abajo ---
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

    # --- 6. Teselas ---
    x0, y0, x1, y1 = gpd.GeoSeries([zona], crs=UTM).to_crs(4326).total_bounds
    G_ = a.tesela
    clave = lambda x, y: f"{math.floor((x - x0) / G_)}_{math.floor((y - y0) / G_)}"  # noqa: E731
    tesela_tramo = {t["id"]: clave(*t["mid"]) for t in info}
    por_tesela = defaultdict(lambda: {"t": [], "s": []})
    for t in info:
        por_tesela[tesela_tramo[t["id"]]]["t"].append(t)
    nombres_comuna = sorted(comunas["comuna"])
    orden_sums = sorted(sums)
    for n_s, sid in enumerate(orden_sums):
        f = sums[sid]
        p = pos_wgs[sid]
        f["n"], f["x"], f["y"] = n_s, round(p.x * 1e5), round(p.y * 1e5)
        por_tesela[tesela_tramo[f["tramo"]] if f["tramo"] is not None else clave(p.x, p.y)]["s"].append(sid)

    # Dependencias: tesela -> teselas con algún tramo aguas arriba de los suyos. Se recorre tramo por tramo: un cierre
    # entre teselas exageraría (el flujo cruza los bordes en los dos sentidos y todas terminarían dependiendo de todas).
    entrantes = defaultdict(list)
    for t in info:
        if t["sig"] is not None:
            entrantes[t["sig"]].append(t["id"])

    def arriba(k):
        pila = [t["id"] for t in por_tesela[k]["t"]]
        vistos, teselas = set(pila), set()
        while pila:
            for m in entrantes[pila.pop()]:
                if m not in vistos:
                    vistos.add(m)
                    teselas.add(tesela_tramo[m])
                    pila.append(m)
        teselas.discard(k)
        return sorted(teselas)

    salida = Path(a.salida)
    salida.mkdir(parents=True, exist_ok=True)
    for viejo in salida.glob("t_*.json"):
        viejo.unlink()
    indice_teselas, total_bytes = {}, 0
    for k in sorted(por_tesela):
        contenido = por_tesela[k]
        calles = sorted({t["nombre"] for t in contenido["t"] if t["nombre"]})
        i_calle = {c: i for i, c in enumerate(calles)}
        filas_t = []
        for t in sorted(contenido["t"], key=lambda t: t["id"]):
            c = t["coords"]
            plano = [c[0][0], c[0][1]]
            for (xa, ya), (xb, yb) in zip(c, c[1:]):
                plano += [xb - xa, yb - ya]
            filas_t.append([t["id"], round(t["L"]), round(t["sp"], 4), round(t["ap"]), int(round(t["acc"], -2)), t["sig"],
                            i_calle.get(t["nombre"]), plano])
        filas_s = []
        for sid in sorted(contenido["s"], key=lambda s: sums[s]["n"]):
            f = sums[sid]
            filas_s.append([f["n"], sid, f["x"], f["y"], f["tramo"], round(f["pos"], 3), round(f["ap"]), round(f["s"], 4),
                            nombres_comuna.index(f["comuna"]) if f["comuna"] in nombres_comuna else None])
        texto = json.dumps({"t": filas_t, "s": filas_s, "calles": calles, "comunas": nombres_comuna}, ensure_ascii=False, separators=(",", ":"))
        ruta = salida / f"t_{k}.json"
        ruta.write_text(texto, encoding="utf-8")
        total_bytes += ruta.stat().st_size
        xs = [x for t in contenido["t"] for x, _ in t["coords"]] + [sums[s]["x"] for s in contenido["s"]]
        ys = [y for t in contenido["t"] for _, y in t["coords"]] + [sums[s]["y"] for s in contenido["s"]]
        indice_teselas[k] = {"archivo": ruta.name, "caja": [[min(xs) / 1e5, min(ys) / 1e5], [max(xs) / 1e5, max(ys) / 1e5]],
                             "tramos": len(filas_t), "sumideros": len(filas_s), "bytes": ruta.stat().st_size, "arriba": arriba(k)}

    # Caja con la que abre el mapa: la zona que cubría la versión anterior (2,3 km alrededor del MUT)
    cx, cy = gpd.GeoSeries([Point(CENTRO)], crs=4326).to_crs(UTM).iloc[0].coords[0]
    cerca_mut = [t for n, t in zip(exportados, info) if math.hypot(Gp.nodes[n]["x"] - cx, Gp.nodes[n]["y"] - cy) <= RADIO_ZONA_INICIAL_M]
    caja_inicial = [[min(x for t in cerca_mut for x, _ in t["coords"]) / 1e5, min(y for t in cerca_mut for _, y in t["coords"]) / 1e5],
                    [max(x for t in cerca_mut for x, _ in t["coords"]) / 1e5, max(y for t in cerca_mut for _, y in t["coords"]) / 1e5]]
    accs = sorted(t["acc"] for t in info)
    pct = lambda p: int(round(accs[min(len(accs) - 1, int(len(accs) * p))], -2))  # noqa: E731
    indice = {
        "version": 2,
        "aviso": "Flujo estimado por la pendiente (OSM y DEM Copernicus GLO-30); no es una simulación hidráulica ni una medición.",
        "generado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "comunas": nombres_comuna,
        "tesela_grados": G_,
        "origen": [round(x0, 6), round(y0, 6)],
        "tramos": len(info),
        "sumideros": len(sums),
        "caja": [[round(x0, 5), round(y0, 5)], [round(x1, 5), round(y1, 5)]],
        "caja_inicial": caja_inicial,
        "acc_percentiles": {"p50": pct(0.5), "p80": pct(0.8), "p90": pct(0.9), "p95": pct(0.95), "p99": pct(0.99)},
        "teselas": indice_teselas,
    }
    ruta_indice = salida / "indice.json"
    ruta_indice.write_text(json.dumps(indice, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    viejo = Path("frontend/public/data/flujo.geojson")
    if viejo.exists() and salida == Path("frontend/public/data/flujo"):
        viejo.unlink()  # formato 0.1.0: lo reemplazan las teselas
    print(f"{len(info)} tramos y {len(sums)} sumideros en {len(indice_teselas)} teselas, {total_bytes / 1024:.0f} KB -> {salida}")
    print(f"Vértices: {vert_antes} -> {vert_despues} (Douglas-Peucker {a.simplificar} m)")

    meta = {
        "generado_utc": indice["generado_utc"],
        "metodo": "mismo que 03_terreno.py: elevación por nodo, relleno de depresiones y D8 sobre el grafo de calles",
        "aviso": indice["aviso"],
        "zona": {"comunas": nombres_comuna, "fuente": {"ruta": a.comunas, "sha256": sha256(a.comunas)}, "margen_m": a.margen},
        "red_calles": {"fuente": "OpenStreetMap vía OSMnx", "network_type": "drive", "graphml": ruta_red.as_posix(), "sha256": sha256(ruta_red),
                       "descargada_utc": red_descargada, "osmnx": ox.__version__, "descarga": fuente_red},
        "dem": {"fuente": T.dem_url(tile), "sha256": sha256(dem), "muestreo": "mínimo de 3×3 píxeles por nodo"},
        "entradas": {"rejillas": {"ruta": a.rejillas, "sha256": sha256(a.rejillas)}},
        "parametros": {"ancho_aporte_m": ANCHO, "snap_max_m": T.SNAP_MAX_M, "borde_relleno_m": 150, "simplificar_m": a.simplificar,
                       "tesela_grados": G_, "pendiente_min": P.PENDIENTE_MIN, "pendiente_max": P.PENDIENTE_MAX,
                       "suavizado": "mediana de la pendiente de los tramos vecinos que bajan (entrantes y siguiente), con piso y tope"},
        "conteos": {
            "nodos": Gu.number_of_nodes(), "tramos_red": len(tramos), "tramos": len(info), "sumideros": len(sums),
            "rejillas_fuera_de_red": fuera_de_red, "salidas_interiores": salidas_interiores,
            "tramos_suavizados": sum(1 for t in info if P.necesita_suavizado(t)), "tramos_con_nombre": sum(1 for t in info if t["nombre"]),
            "vertices": {"antes": vert_antes, "despues": vert_despues}, "teselas": len(indice_teselas),
            "comprobacion_terreno": {"calzan": ok, "de": tot},
        },
        "salida": {"carpeta": salida.as_posix(), "bytes": total_bytes + ruta_indice.stat().st_size,
                   "indice": {"archivo": ruta_indice.as_posix(), "sha256": sha256(ruta_indice)},
                   "teselas_sha256": {v["archivo"]: sha256(salida / v["archivo"]) for v in indice_teselas.values()}},
        "script": {"ruta": "pipeline/04_flujo.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
        "pendientes": {"ruta": "pipeline/flujo/pendientes.py", "version": P.SCRIPT_VERSION, "sha256": sha256(P.__file__)},
    }
    Path(a.meta).write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Metadata en {a.meta}")


if __name__ == "__main__":
    main()

"""Versiona las fuentes públicas complementarias de Las Condes, fuera del ranking congelado."""
import csv
from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from shapely.geometry import Polygon, mapping, shape
from shapely.geometry.polygon import orient


DATA = Path(__file__).resolve().parents[1] / "data"
SALIDA = DATA / "las_condes"
SIALL = "https://rest-sit.mop.gob.cl/arcgis/rest/services/DOH/SIALL/MapServer"
INVIERNO = (
    "https://services5.arcgis.com/i7S5PSnIJAUcWvSE/arcgis/rest/services/"
    "compilado_INV_2026/FeatureServer/0"
)
OPEN_METEO = "https://single-runs-api.open-meteo.com/v1/forecast"
# Edificio residencial o visualización vinculada a un número de domicilio.
PUNTOS_OMITIDOS = {11856, 11866, 11876, 11879}


def descargar(base, parametros):
    url = f"{base}?{urlencode(parametros)}"
    with urlopen(Request(url, headers={"User-Agent": "Drena-source-check/1.0"}), timeout=45) as res:
        datos = json.load(res)
    if datos.get("error") or datos.get("exceededTransferLimit"):
        raise ValueError(f"Fuente incompleta {base}: {datos.get('error', 'límite de transferencia')}")
    return datos, url


def guardar_json(ruta, datos):
    ruta.write_text(json.dumps(datos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def metadata(ruta, url, fuente, **datos):
    guardar_json(ruta.with_suffix(".meta.json"), {
        "fuente": fuente,
        "fuente_url": url,
        "descargado_utc": datetime.now(UTC).isoformat(timespec="seconds"),
        "cobertura": "Las Condes, Región Metropolitana, Chile",
        "salida": {"archivo": ruta.name, "sha256": sha256(ruta.read_bytes()).hexdigest()},
        **datos,
    })


def siall(capa, campos, **filtro):
    return descargar(f"{SIALL}/{capa}/query", {
        "where": "1=1", "outFields": campos, "outSR": 4326, "f": "json",
        "orderByFields": "OBJECTID", "returnGeometry": "true", **filtro,
    })


def geojson(nombre, elementos):
    if not elementos:
        raise ValueError(f"{nombre}: sin elementos")
    ruta = SALIDA / f"{nombre}.geojson"
    features = [
        {"type": "Feature", "geometry": geometria, "properties": atributos}
        for geometria, atributos in elementos
    ]
    filas = (json.dumps(f, ensure_ascii=False, separators=(",", ":")) for f in features)
    ruta.write_text('{"type":"FeatureCollection","features":[\n' + ",\n".join(filas) + "\n]}\n",
                    encoding="utf-8")
    return ruta


def colectores():
    datos, url = siall(
        6, "OBJECTID,ID_IDE,COMUNA,ESTADO,TIPO_CONDU,TIPO_RED,FORMA_SEC,LONG,PENDIENTE,CAPACIDAD,DIAM_O_ANC,ALTURA",
        where="COMUNA = 'Las Condes'",
    )
    elementos = []
    for f in datos["features"]:
        lineas = f["geometry"]["paths"]
        geometria = {"type": "MultiLineString", "coordinates": lineas}
        if len(lineas) == 1:
            geometria = {"type": "LineString", "coordinates": lineas[0]}
        elementos.append((geometria, f["attributes"]))
    ruta = geojson("colectores_siall", elementos)
    metadata(ruta, url, "DOH/MOP, SIALL capa 6", registros=len(elementos),
             seleccion="COMUNA = Las Condes; geometría de referencia de la capa",
             unidades={"coordenadas": "grados WGS84", "LONG": "m", "PENDIENTE": "%",
                       "CAPACIDAD": "m³/s", "DIAM_O_ANC": "mm", "ALTURA": "mm"})


def subareas():
    limites = json.loads((DATA / "comunas.geojson").read_text(encoding="utf-8"))
    comuna = shape(next(f["geometry"] for f in limites["features"] if f["properties"]["comuna"] == "Las Condes"))
    datos, url = siall(
        12, "OBJECTID,ID_IDE,COMUNA2,PENDIENTE,N_IMPERME,N_PERMEA,SUPER_KM2,CO_AREA_TRI",
        inSR=4326, geometryType="esriGeometryEnvelope",
        geometry=",".join(map(str, comuna.bounds)), spatialRel="esriSpatialRelIntersects",
    )
    elementos = []
    for f in datos["features"]:
        anillos = f["geometry"]["rings"]
        if len(anillos) != 1:
            raise ValueError("Cambió la estructura de anillos de las subáreas en el SIALL")
        poligono = Polygon(anillos[0])
        if comuna.intersects(poligono):
            elementos.append((mapping(orient(poligono)), f["attributes"]))
    ruta = geojson("subareas_tributarias_siall", elementos)
    metadata(ruta, url, "DOH/MOP, SIALL capa 12", registros=len(elementos),
             seleccion="intersecta el límite Las Condes de data/comunas.geojson; conserva el polígono completo",
             unidades={"coordenadas": "grados WGS84", "PENDIENTE": "grados", "N_IMPERME": "%",
                       "N_PERMEA": "%", "SUPER_KM2": "km²"})


def puntos_criticos():
    datos, url = descargar(INVIERNO + "/query", {
        "where": "UPPER(Comuna) = 'LAS CONDES'",
        "outFields": "FID,Comuna,Sector,Causa_del_,Nivel_de_R,Temporada_,Punto_Crí",
        "orderByFields": "FID", "outSR": 4326, "f": "geojson",
    })
    elementos = []
    omitidos = []
    for f in datos["features"]:
        p = f["properties"]
        if p["FID"] in PUNTOS_OMITIDOS or any(char.isdigit() for char in p["Sector"]):
            omitidos.append(p["FID"])
            continue
        elementos.append((f["geometry"], {
            "fid": p["FID"], "lugar": p["Sector"].strip(), "comuna": p["Comuna"],
            "causa": p["Causa_del_"], "nivel_riesgo": p["Nivel_de_R"],
            "temporada": p["Temporada_"], "hora": None, "precision": "punto_crítico",
            "fuente_url": f"{INVIERNO}/{p['FID']}",
        }))
    ruta = geojson("puntos_criticos_invierno_2026", elementos)
    metadata(ruta, url, "SENAPRED, Programa Invierno 2026", registros=len(elementos),
             registros_fuente=len(datos["features"]), omitidos_por_privacidad=omitidos,
             unidades={"coordenadas": "grados WGS84"},
             nota="Antecedentes de riesgo por recurrencia. La fuente no fecha anegamientos de julio.")


def pronostico_archivado():
    inicio = "2026-07-16T06:00"
    variables = {"precipitation": "precipitacion_mm", "rain": "lluvia_mm",
                 "wind_speed_10m": "viento_10m_kmh", "wind_gusts_10m": "racha_10m_kmh"}
    datos, url = descargar(OPEN_METEO, {
        "latitude": -33.41797, "longitude": -70.55209, "hourly": ",".join(variables),
        "timezone": "GMT", "forecast_hours": 48, "run": inicio, "models": "ecmwf_ifs025",
    })
    horas = datos["hourly"]
    inicio_utc = datetime.fromisoformat(inicio).replace(tzinfo=UTC)
    fechas = [datetime.fromisoformat(t).replace(tzinfo=UTC) for t in horas["time"]]
    if fechas != [inicio_utc + timedelta(hours=i) for i in range(48)]:
        raise ValueError("La corrida archivada no contiene las 48 horas esperadas")
    ruta = SALIDA / "pronostico_rotonda_atenas_2026-07-16.csv"
    with ruta.open("w", encoding="utf-8", newline="") as archivo:
        writer = csv.writer(archivo, lineterminator="\n")
        writer.writerow(["hora_validez_utc", *variables.values()])
        for i, fecha in enumerate(fechas):
            writer.writerow([fecha.isoformat(), *(horas[campo][i] for campo in variables)])
    metadata(ruta, url, "Open-Meteo Single Runs API, ECMWF IFS", registros=len(fechas),
             unidades={columna: datos["hourly_units"][campo] for campo, columna in variables.items()},
             corrida_utc=inicio_utc.isoformat(), modelo="ecmwf_ifs025", punto="Rotonda Atenas",
             punto_url="https://www.openstreetmap.org/node/1175343322",
             latlon_solicitado=[-33.41797, -70.55209],
             latlon_celda=[datos["latitude"], datos["longitude"]],
             licencia="CC BY 4.0, https://open-meteo.com/en/license",
             nota="Pronóstico original de una sola corrida. Su disponibilidad es posterior a la inicialización.")


if __name__ == "__main__":
    SALIDA.mkdir(parents=True, exist_ok=True)
    colectores()
    subareas()
    puntos_criticos()
    pronostico_archivado()

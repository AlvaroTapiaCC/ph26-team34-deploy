"""Descarga los sumideros existentes de Ñuñoa publicados por la DOH."""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen


MAPSERVER = "https://rest-sit.mop.gob.cl/arcgis/rest/services/DOH/SIALL/MapServer"
CAPA = f"{MAPSERVER}/3"
FILTRO = "CODCOMU = '13120' AND ESTADO = 'EXISTENTE'"
# Ventana de búsqueda con margen. La comuna se selecciona por el código de la DOH.
BBOX = (-70.650, -33.485, -70.560, -33.405)
SALIDA = Path(__file__).resolve().parents[1] / "data/sumideros_nunoa.geojson"


def pedir(url, **params):
    url = f"{url}?{urlencode({'f': 'json', **params})}"
    for intento in range(3):
        try:
            with urlopen(url, timeout=45) as respuesta:
                datos = json.load(respuesta)
            break
        except (URLError, TimeoutError) as error:
            if intento == 2 or (
                isinstance(error, HTTPError)
                and error.code < 500
                and error.code != 429
            ):
                raise
            time.sleep(2 ** intento)

    if "error" in datos:
        raise ValueError(datos["error"].get("message", "Error del servicio ArcGIS"))
    if datos.get("exceededTransferLimit"):
        raise ValueError("La respuesta de la DOH excedió el límite de registros.")
    return datos


def geometria_wgs84(geometria):
    lon, lat = geometria["x"], geometria["y"]
    xmin, ymin, xmax, ymax = BBOX
    if geometria["spatialReference"]["wkid"] != 4326 or not (
        xmin <= lon <= xmax and ymin <= lat <= ymax
    ):
        raise ValueError(f"Posición fuera de la ventana de búsqueda WGS84 ({lon}, {lat}).")
    return {"type": "Point", "coordinates": [lon, lat]}


def descargar():
    consulta = f"{CAPA}/query"
    cantidad = pedir(consulta, where=FILTRO, returnCountOnly="true")["count"]
    registros = pedir(consulta, where=FILTRO, outFields="*", returnGeometry="false")
    atributos = {
        fila["attributes"]["OBJECTID"]: fila["attributes"] for fila in registros["features"]
    }
    if not cantidad or cantidad != len(registros["features"]) or cantidad != len(atributos):
        raise ValueError(f"La DOH contó {cantidad} filas y entregó {len(atributos)} OBJECTID únicos.")

    # La capa devuelve atributos en /query y geometría en /identify. El tamaño
    # del mapa mantiene visible la capa a la escala de toda la ventana.
    extent = ",".join(map(str, BBOX))
    ubicaciones = pedir(
        f"{MAPSERVER}/identify",
        geometry=extent,
        geometryType="esriGeometryEnvelope",
        sr=4326,
        layers="all:3",
        layerDefs=json.dumps({"3": FILTRO}),
        tolerance=0,
        mapExtent=extent,
        imageDisplay="6000,6000,96",
        returnGeometry="true",
        returnFieldName="true",
    )["results"]
    puntos = {int(fila["attributes"]["OBJECTID"]): fila for fila in ubicaciones}
    if atributos.keys() != puntos.keys() or len(ubicaciones) != len(puntos):
        faltantes = len(atributos.keys() - puntos.keys())
        sobrantes = len(puntos.keys() - atributos.keys())
        raise ValueError(
            f"Los OBJECTID de /query y /identify no coinciden "
            f"({faltantes} faltantes, {sobrantes} extra, "
            f"{len(ubicaciones) - len(puntos)} repetidos)."
        )

    sumideros = {}
    duplicados = []
    for objectid, propiedades in sorted(atributos.items()):
        identificador = propiedades["ID_IDE"]
        punto = puntos[objectid]
        # /identify puede publicar el alias «ID» en lugar del nombre del campo.
        datos_punto = punto["attributes"]
        if (
            propiedades["CODCOMU"] != "13120"
            or propiedades["ESTADO"] != "EXISTENTE"
            or not identificador
            or datos_punto.get("ID_IDE", datos_punto.get("ID")) != identificador
        ):
            raise ValueError(f"Identidad o filtro inconsistente para OBJECTID {objectid}.")

        # El catastro usa -99 como dato numérico desconocido.
        propiedades = {campo: None if valor == -99 else valor for campo, valor in propiedades.items()}
        feature = {
            "type": "Feature",
            "id": identificador,
            "geometry": geometria_wgs84(punto["geometry"]),
            "properties": propiedades,
        }
        previo = sumideros.get(identificador)
        if previo is None:
            sumideros[identificador] = feature
            continue
        atributos_previos = previo["properties"]
        if (
            previo["geometry"] != feature["geometry"]
            or atributos_previos != dict(propiedades, OBJECTID=atributos_previos["OBJECTID"])
        ):
            raise ValueError(f"El ID_IDE {identificador} tiene registros distintos en el catastro.")
        duplicados.append(objectid)

    return {
        "type": "FeatureCollection",
        "metadata": {
            "servicio": CAPA,
            "descargado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "filtro": FILTRO,
            "registros_doh": cantidad,
            "objectid_duplicados_descartados": duplicados,
        },
        "features": list(sumideros.values()),
    }


def guardar(salida, catastro):
    salida.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=salida.parent, suffix=".tmp", delete=False
    ) as archivo:
        temporal = Path(archivo.name)
        try:
            json.dump(catastro, archivo, ensure_ascii=False, allow_nan=False, indent=2)
            archivo.write("\n")
            archivo.close()
            temporal.replace(salida)
        finally:
            temporal.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--salida", type=Path, default=SALIDA, help="Ruta del GeoJSON generado")
    args = parser.parse_args()
    try:
        catastro = descargar()
        guardar(args.salida, catastro)
    except (OSError, KeyError, TypeError, ValueError) as error:
        parser.exit(1, f"No se pudo exportar el catastro DOH ({error}).\n")

    print(f"{len(catastro['features'])} sumideros guardados en {args.salida}")


if __name__ == "__main__":
    main()

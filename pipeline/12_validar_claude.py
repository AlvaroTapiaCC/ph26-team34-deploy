"""Prepara una revisión ciega y compara dos etiquetas humanas con Claude (issue #30)."""

import argparse
import csv
import hashlib
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from shutil import copyfile
from tempfile import TemporaryDirectory
from typing import get_args
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.schemas.claude import EstadoRejilla, NivelAgua  # noqa: E402
from app.services.claude_vision import clasificar_camara, clasificar_rejilla  # noqa: E402

DATOS = REPO / "data/validacion/claude"
CLASES = {"rejilla": get_args(EstadoRejilla), "camara": get_args(NivelAgua)}
NO_EVALUABLE = "no_evaluable"
EXTENSIONES = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
LICENCIAS_LIBRES = re.compile(
    r"(?:CC BY(?:-SA)? (?:1\.0|2\.[05]|3\.0|4\.0)(?: [a-z]{2})?|CC0(?: 1\.0)?|Public domain)"
)
CAMPOS_MANIFIESTO = {
    "id", "tipo", "archivo", "sha256", "fuente_url", "archivo_url", "autor", "licencia", "licencia_url",
}


def sha256(datos):
    return hashlib.sha256(datos).hexdigest()


def url_https(url):
    partes = urlsplit(url)
    return partes.scheme == "https" and partes.hostname is not None


def leer_csv(ruta, campos):
    with ruta.open(newline="", encoding="utf-8-sig") as archivo:
        reader = csv.DictReader(archivo)
        if not campos.issubset(reader.fieldnames or ()):
            raise ValueError(f"Revisa las columnas de {ruta.name}.")
        return list(reader)


def manifiesto(ruta, ejemplos):
    filas = leer_csv(ruta, CAMPOS_MANIFIESTO)
    if not filas:
        raise ValueError("El manifiesto de evaluación está vacío.")
    archivos_demo = [p for p in (REPO / "frontend/public/img").glob("*") if p.is_file()]
    excluidas = {sha256(p.read_bytes()) for p in [*archivos_demo, *ejemplos]}
    imagenes, hashes = {}, set()
    for fila in filas:
        id_imagen, nombre, contenido = fila["id"], Path(fila["archivo"]), fila["sha256"]
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", id_imagen) or id_imagen in imagenes:
            raise ValueError(f"ID vacío, duplicado o inválido en el manifiesto: {id_imagen}")
        if nombre.name != fila["archivo"] or nombre.stem != id_imagen or nombre.suffix not in EXTENSIONES:
            raise ValueError(f"El archivo de {id_imagen} debe llevar su ID como nombre.")
        if fila["tipo"] not in CLASES:
            raise ValueError(f"Tipo inválido para {id_imagen}.")
        if not re.fullmatch(r"[0-9a-f]{64}", contenido) or contenido in hashes or contenido in excluidas:
            raise ValueError(f"El SHA-256 de {id_imagen} es inválido, se repite o pertenece a un ejemplo.")
        if not fila["autor"].strip() or not LICENCIAS_LIBRES.fullmatch(fila["licencia"]):
            raise ValueError(f"Falta la atribución o licencia libre de {id_imagen}.")
        if not all(url_https(fila[k]) for k in ("fuente_url", "archivo_url", "licencia_url")):
            raise ValueError(f"Falta una URL HTTPS de procedencia, archivo o licencia para {id_imagen}.")
        imagenes[id_imagen] = fila
        hashes.add(contenido)
    return imagenes


def verificar_imagen(ruta, imagen):
    datos = ruta.read_bytes()
    if sha256(datos) != imagen["sha256"]:
        raise ValueError(f"Los bytes de {ruta.name} difieren del manifiesto.")
    return datos


def preparar_paquete(imagenes, destino, origen):
    if destino.exists():
        raise ValueError(f"{destino} ya existe.")
    destino.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=destino.parent) as temporal:
        preparado = Path(temporal) / "paquete"
        directorio = preparado / "imagenes"
        directorio.mkdir(parents=True)
        for imagen in imagenes.values():
            ruta = directorio / imagen["archivo"]
            if origen is None:
                solicitud = Request(imagen["archivo_url"], headers={
                    "User-Agent": "DrenaValidacion/1.0 (https://github.com/platanus-hack/platanus-hack-26-cl-team-34)",
                })
                with urlopen(solicitud, timeout=60) as respuesta:
                    ruta.write_bytes(respuesta.read())
            else:
                copyfile(origen / imagen["archivo"], ruta)
            verificar_imagen(ruta, imagen)
        with (preparado / "etiquetas.csv").open("w", encoding="utf-8", newline="") as archivo:
            plantilla = csv.writer(archivo)
            plantilla.writerow(("id", "tipo", "etiqueta"))
            plantilla.writerows((i["id"], i["tipo"], "") for i in imagenes.values())
        preparado.rename(destino)


def leer_etiquetas(ruta, imagenes):
    etiquetas = {}
    for fila in leer_csv(ruta, {"id", "tipo", "etiqueta"}):
        id_imagen = fila["id"]
        if id_imagen not in imagenes or id_imagen in etiquetas:
            raise ValueError(f"ID desconocido o duplicado en {ruta.name}: {id_imagen}")
        tipo = imagenes[id_imagen]["tipo"]
        etiqueta = (fila["etiqueta"] or "").strip()
        if fila["tipo"] != tipo or etiqueta not in CLASES[tipo]:
            raise ValueError(f"Etiqueta inválida para {id_imagen} en {ruta.name}.")
        etiquetas[id_imagen] = etiqueta
    if etiquetas.keys() != imagenes.keys():
        raise ValueError(f"Faltan imágenes por etiquetar en {ruta.name}.")
    return etiquetas


def clasificar(imagenes, directorio):
    # Verifica el set completo antes de hacer la primera llamada a Claude.
    for imagen in imagenes.values():
        verificar_imagen(directorio / imagen["archivo"], imagen)
    predicciones = {}
    for id_imagen, imagen in imagenes.items():
        datos = verificar_imagen(directorio / imagen["archivo"], imagen)
        tipo = imagen["tipo"]
        respuesta = clasificar_rejilla(datos) if tipo == "rejilla" else clasificar_camara(datos)
        if respuesta.fallo:
            if respuesta.extra.get("motivo") == "claude_no_configurado":
                raise RuntimeError("Configura ANTHROPIC_API_KEY en el backend y vuelve a ejecutar.")
            raise RuntimeError(f"Falló la consulta a Claude para {id_imagen}. Reintenta la validación.")
        etiqueta = respuesta.resultado.rejilla if tipo == "rejilla" else respuesta.resultado.nivel_agua
        predicciones[id_imagen] = {
            "etiqueta": etiqueta if respuesta.resultado.evaluable else NO_EVALUABLE,
            "modelo": respuesta.modelo,
            "prompt_version": respuesta.prompt_version,
            "desde_cache": respuesta.desde_cache,
        }
    return predicciones


def calcular_metricas(imagenes, a, b, predicciones):
    matriz = {tipo: {x: {y: 0 for y in clases} for x in clases} for tipo, clases in CLASES.items()}
    aciertos = comparables = consenso_no_evaluable = 0
    detalle = []
    for id_imagen, imagen in imagenes.items():
        tipo, prediccion = imagen["tipo"], predicciones[id_imagen]
        etiqueta = prediccion["etiqueta"]
        consenso = a[id_imagen] if a[id_imagen] == b[id_imagen] else None
        if consenso is not None:
            matriz[tipo][consenso][etiqueta] += 1
            if consenso == NO_EVALUABLE:
                consenso_no_evaluable += 1
            else:
                comparables += 1
                aciertos += consenso == etiqueta
        detalle.append({"id": id_imagen, "tipo": tipo, "consenso_humano": consenso, "claude": prediccion})
    total = len(imagenes)
    acuerdos = sum(a[id_imagen] == b[id_imagen] for id_imagen in imagenes)
    return {
        "imagenes_total": total,
        "coincidencias": aciertos,
        "comparables": comparables,
        "no_evaluables": sum(p["etiqueta"] == NO_EVALUABLE for p in predicciones.values()),
        "no_evaluables_segun_consenso_humano": consenso_no_evaluable,
        "acuerdo_humano": {"coincidencias": acuerdos, "total": total, "porcentaje": round(100 * acuerdos / total, 4)},
        "matriz_confusion": matriz,
        "imagenes": detalle,
    }


def evaluar(args, imagenes):
    if (
        not args.revisor_a.strip() or not args.revisor_b.strip()
        or args.revisor_a.strip().casefold() == args.revisor_b.strip().casefold()
        or args.etiquetas_a.samefile(args.etiquetas_b)
    ):
        raise ValueError("Indica dos revisores distintos y dos archivos de etiquetas.")
    a, b = (leer_etiquetas(ruta, imagenes) for ruta in (args.etiquetas_a, args.etiquetas_b))
    predicciones = clasificar(imagenes, args.paquete / "imagenes")
    resultado = calcular_metricas(imagenes, a, b, predicciones)
    resultado["generado_utc"] = datetime.now(UTC).isoformat(timespec="seconds")
    resultado["procedencia"] = {
        "manifiesto_sha256": sha256(args.manifiesto.read_bytes()),
        "etiquetas_sha256": [sha256(p.read_bytes()) for p in (args.etiquetas_a, args.etiquetas_b)],
        "script_sha256": sha256(Path(__file__).read_bytes()),
        "modelos": sorted({p["modelo"] for p in predicciones.values()}),
    }
    args.salida.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=args.salida.parent) as temporal:
        escrito = Path(temporal) / args.salida.name
        escrito.write_text(json.dumps(resultado, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        escrito.replace(args.salida)
    print(f"Validación de {len(imagenes)} imágenes guardada en {args.salida}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifiesto", type=Path, default=DATOS / "manifiesto.csv")
    parser.add_argument("--ejemplo", type=Path, action="append", default=[], help="foto de ejemplo que se debe excluir")
    acciones = parser.add_subparsers(dest="accion", required=True)
    preparar = acciones.add_parser("preparar", help="crear el paquete sin etiquetas ni procedencia visible")
    preparar.add_argument("--paquete", type=Path, required=True)
    preparar.add_argument("--origen", type=Path, help="usar archivos locales con IDs del manifiesto")
    medir = acciones.add_parser("evaluar", help="comparar las etiquetas entregadas por dos personas con Claude")
    medir.add_argument("--paquete", type=Path, required=True)
    medir.add_argument("--etiquetas-a", type=Path, required=True)
    medir.add_argument("--etiquetas-b", type=Path, required=True)
    medir.add_argument("--revisor-a", required=True, help="ID pseudónimo del primer revisor")
    medir.add_argument("--revisor-b", required=True, help="ID pseudónimo del segundo revisor")
    medir.add_argument("--salida", type=Path, default=DATOS / "resultado.json")
    args = parser.parse_args()
    try:
        imagenes = manifiesto(args.manifiesto, args.ejemplo)
        if args.accion == "preparar":
            preparar_paquete(imagenes, args.paquete, args.origen)
            print(f"Paquete de {len(imagenes)} imágenes preparado en {args.paquete}")
        else:
            evaluar(args, imagenes)
    except (OSError, ValueError, RuntimeError) as exc:
        parser.exit(1, f"No se pudo completar la validación. {exc}\n")


if __name__ == "__main__":
    main()

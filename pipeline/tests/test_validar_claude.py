import csv
import io
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace

from PIL import Image
import pytest


RUTA = Path(__file__).resolve().parents[1] / "12_validar_claude.py"
SPEC = spec_from_file_location("validar_claude", RUTA)
validacion = module_from_spec(SPEC)
SPEC.loader.exec_module(validacion)


@pytest.fixture
def corpus(tmp_path):
    origen = tmp_path / "originales"
    origen.mkdir()
    entradas = []
    for id_imagen, tipo, tono in [("img-001", "rejilla", 25), ("img-002", "camara", 60)]:
        buf = io.BytesIO()
        Image.new("RGB", (8, 8), (tono, tono, tono)).save(buf, format="PNG")
        foto = buf.getvalue()
        nombre = f"{id_imagen}.png"
        (origen / nombre).write_bytes(foto)
        entradas.append({
            "id": id_imagen, "tipo": tipo, "archivo": nombre, "sha256": validacion.sha256(foto),
            "fuente_url": "https://example.invalid/prueba", "archivo_url": f"https://example.invalid/{nombre}",
            "autor": "Fixture de prueba", "licencia": "CC0",
            "licencia_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        })
    ruta = tmp_path / "manifiesto.csv"
    with ruta.open("w", newline="") as archivo:
        writer = csv.DictWriter(archivo, fieldnames=entradas[0].keys())
        writer.writeheader()
        writer.writerows(entradas)
    return ruta, origen


def test_paquete_con_ids_y_las_mismas_imagenes(corpus, tmp_path):
    ruta, origen = corpus
    manifiesto = validacion.manifiesto(ruta, [])
    paquete = tmp_path / "paquete"
    validacion.preparar_paquete(manifiesto, paquete, origen)
    assert sorted(p.name for p in paquete.iterdir()) == ["etiquetas.csv", "imagenes"]
    assert (paquete / "etiquetas.csv").read_text().splitlines() == [
        "id,tipo,etiqueta", "img-001,rejilla,", "img-002,camara,",
    ]
    assert (paquete / "imagenes/img-001.png").read_bytes() == (origen / "img-001.png").read_bytes()
    with pytest.raises(ValueError, match="pertenece a un ejemplo"):
        validacion.manifiesto(ruta, [origen / "img-002.png"])


def test_etiquetado_completo_antes_de_usar_el_modelo(corpus, tmp_path, monkeypatch):
    ruta, origen = corpus
    manifiesto = validacion.manifiesto(ruta, [])
    paquete = tmp_path / "paquete"
    validacion.preparar_paquete(manifiesto, paquete, origen)
    a, b = tmp_path / "a.csv", tmp_path / "b.csv"
    a.write_text("id,tipo,etiqueta\nimg-001,rejilla,limpia\nimg-002,camara,cuneta\n")
    b.write_text("id,tipo,etiqueta\nimg-001,rejilla,limpia\n")
    args = SimpleNamespace(
        revisor_a="a", revisor_b="b", etiquetas_a=a, etiquetas_b=b, paquete=paquete,
        salida=tmp_path / "resultado.json", manifiesto=ruta,
    )

    def prohibido(*args):
        pytest.fail("No se puede llamar al modelo mientras falte una etiqueta")

    monkeypatch.setattr(validacion, "clasificar", prohibido)
    with pytest.raises(ValueError, match="Faltan imágenes"):
        validacion.evaluar(args, manifiesto)
    assert not args.salida.exists()
    args.revisor_b = " a "
    with pytest.raises(ValueError, match="revisores distintos"):
        validacion.evaluar(args, manifiesto)


def test_clasificar_distingue_respuesta_no_evaluable_y_fallo_api(corpus, monkeypatch):
    ruta, origen = corpus
    manifiesto = validacion.manifiesto(ruta, [])

    def respuesta(resultado, fallo=False):
        return SimpleNamespace(
            resultado=resultado, fallo=fallo, extra={}, modelo="claude-prueba",
            prompt_version="v-prueba", desde_cache=False,
        )

    monkeypatch.setattr(validacion, "clasificar_rejilla", lambda data: respuesta(
        SimpleNamespace(rejilla="limpia", evaluable=True),
    ))
    monkeypatch.setattr(validacion, "clasificar_camara", lambda data: respuesta(
        SimpleNamespace(nivel_agua="no_evaluable", evaluable=False),
    ))
    predichas = validacion.clasificar(manifiesto, origen)
    assert predichas["img-002"]["etiqueta"] == "no_evaluable"
    monkeypatch.setattr(validacion, "clasificar_camara", lambda data: respuesta(None, fallo=True))
    with pytest.raises(RuntimeError, match="Falló la consulta a Claude para img-002"):
        validacion.clasificar(manifiesto, origen)


def test_metricas_distinguen_consenso_confusion_y_abstencion():
    imagenes = {
        "a": {"tipo": "rejilla"}, "b": {"tipo": "rejilla"},
        "c": {"tipo": "camara"}, "d": {"tipo": "camara"},
    }
    a = {"a": "tapada", "b": "limpia", "c": "cuneta", "d": "no_evaluable"}
    b = {**a, "c": "sobre_vereda"}
    predichas = {k: {"etiqueta": v} for k, v in {**a, "b": "no_evaluable"}.items()}
    resultado = validacion.calcular_metricas(imagenes, a, b, predichas)
    assert resultado["coincidencias"] == 1
    assert resultado["comparables"] == 2
    assert resultado["no_evaluables"] == 2
    assert resultado["acuerdo_humano"] == {"coincidencias": 3, "total": 4, "porcentaje": 75}
    assert resultado["matriz_confusion"]["rejilla"]["limpia"]["no_evaluable"] == 1
    assert resultado["matriz_confusion"]["camara"]["cuneta"]["cuneta"] == 0
    assert resultado["matriz_confusion"]["camara"]["no_evaluable"]["no_evaluable"] == 1

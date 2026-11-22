"""Explicaciones para las primeras filas del ranking (plan §5.4, issue #27)."""
import json
import logging
from functools import lru_cache
from threading import Lock
from time import monotonic

from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field

from app.config import get_settings
from app.db import get_conn
from app.services import cache
from app.services.claude_common import llamar_estructurado

log = logging.getLogger(__name__)
TOP = 5
PROMPT_VERSION = "explicacion-v1"
_worker = Lock()
FACTORES = {
    "arboles": "cobertura de árboles",
    "feria": "ferias cercanas",
    "obras": "obras cercanas",
    "suelo": "suelo desnudo aguas arriba",
    "pendiente": "pendiente",
    "clima": "lluvia y viento",
    "dias_sin_limpieza": "tiempo sin limpieza (simulado)",
    "camara": "señal de cámara",
}
AGUA = {"cuneta": "agua en la cuneta", "hasta_vereda": "agua hasta la vereda",
        "sobre_vereda": "agua sobre la vereda"}


class Explicacion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    texto: str = Field(min_length=1, max_length=320, pattern=r"\S")


PROMPT = """Explica en hasta dos frases en español chileno por qué se prioriza revisar un sumidero.
Usa solo las señales del JSON. Prioridad es un puntaje, nunca una probabilidad de inundación.
Los aportes son unidades del puntaje de obstrucción; área normalizada y criticidad son índices sin unidades.
Una foto evaluable influye en la obstrucción y agua observada influye en la consecuencia.
Si falta el área, indícalo. No inventes medidas, lugares, una posición en la tabla ni consejos de emergencia.
Devuelve solo el campo texto."""


def contexto(row: dict) -> dict:
    detalle = row["detalle"] or {}
    aportes = detalle.get("aportes") or {}
    return {
        "prioridad": row["prioridad"],
        "obstruccion_efectiva": row["p_ef"],
        "consecuencia": row["c"],
        "aportes_prediccion": {
            nombre: aportes[k] for k, nombre in FACTORES.items()
            if isinstance(aportes.get(k), (int, float)) and aportes[k] > 0
        },
        "foto_evaluable": detalle.get("fuente_p") == "foto",
        "area_normalizada": detalle.get("area_norm"),
        "area_faltante": detalle.get("area_faltante") is True,
        "criticidad": detalle.get("criticidad"),
        "agua_observada": AGUA.get(detalle.get("nivel_agua")),
        "caso_urgente": detalle.get("urgente") is True,
    }


def respaldo(datos: dict) -> str:
    razones = []
    if datos["caso_urgente"]:
        razones.append("hay un caso urgente asociado")
    if datos["agua_observada"]:
        razones.append(f"se observó {datos['agua_observada']}")
    if datos["foto_evaluable"]:
        razones.append("una foto evaluable ajustó el puntaje de obstrucción")
    else:
        aportes = sorted(datos["aportes_prediccion"].items(), key=lambda item: -item[1])
        if aportes:
            nombre, aporte = aportes[0]
            razones.append(f"{nombre} aporta {aporte:.3f} al puntaje de obstrucción".replace(".", ","))
    if datos["area_faltante"]:
        razones.append("falta el dato de área de aporte")
    if razones:
        return " · ".join(razones).capitalize() + "."
    return "La prioridad combina la obstrucción estimada y la consecuencia del anegamiento."


@lru_cache(maxsize=128)
def _explicar(serializado: str, intervalo: int) -> str | None:
    # Un fallo se reintenta en un intervalo posterior. Los aciertos quedan en claude_cache.
    resultado = llamar_estructurado(
        system=PROMPT,
        content=[{"type": "text", "text": serializado}],
        schema={
            "type": "object",
            "properties": {"texto": {"type": "string"}},
            "required": ["texto"],
            "additionalProperties": False,
        },
        modelo_pydantic=Explicacion,
        key=cache.cache_key(serializado, PROMPT_VERSION),
        prompt_version=PROMPT_VERSION,
        no_evaluable=Explicacion(texto="Explicación pendiente."),
        max_tokens=250,
        timeout_s=4,
    )
    return None if resultado.fallo else resultado.resultado.texto.strip()


def completar(scenario_id: str, modo: str, pendientes: list[dict]) -> None:
    """Persiste el texto si el cálculo que lo originó sigue vigente."""
    if not get_settings().anthropic_api_key or not _worker.acquire(blocking=False):
        return
    try:
        for row in pendientes:
            try:
                serializado = json.dumps(contexto(row), ensure_ascii=False, sort_keys=True)
                texto = _explicar(serializado, int(monotonic() // 60))
                if texto:
                    with get_conn() as conn:
                        conn.execute(
                            """
                            update scores set explicacion = %s
                             where scenario_id = %s and modo = %s and sumidero_id = %s
                               and rank <= %s and explicacion is null
                               and prioridad is not distinct from %s
                               and p_ef is not distinct from %s
                               and c is not distinct from %s and detalle = %s
                            """,
                            (texto, scenario_id, modo, row["sumidero_id"], TOP,
                             row["prioridad"], row["p_ef"], row["c"], Jsonb(row["detalle"])),
                        )
            except Exception:
                log.exception("No se pudo completar la explicación de prioridad")
    finally:
        _worker.release()

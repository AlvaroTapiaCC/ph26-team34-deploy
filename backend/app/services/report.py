"""Métricas históricas del evento a partir de su auditoría (plan §7.3, issue #43)."""

import csv
import hashlib
import io
import json
import logging
from collections import Counter, defaultdict
from datetime import UTC, datetime
from math import ceil
from statistics import median

from psycopg import Connection
from pydantic import BaseModel, ConfigDict, Field

from app.config import REPO_DIR, get_settings
from app.services import cache
from app.services.claude_common import llamar_estructurado

log = logging.getLogger(__name__)
UUID_RE = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
PREDICCION = REPO_DIR / "data/validacion/prediccion_congelada.csv"
TOP_PORCENTAJE = 20
PROMPT_VERSION = "informe-evento-v1"

_EVENTOS = """
    with ventana as (
        select id, ts, tipo,
               case when (payload->>'observation_id') ~* %(uuid)s then (payload->>'observation_id')::uuid end as obs_id,
               case when (payload->>'caso_id') ~* %(uuid)s then (payload->>'caso_id')::uuid end as caso_id,
               case when (payload->>'mission_id') ~* %(uuid)s then (payload->>'mission_id')::uuid end as mision_id,
               payload->>'crew_id' as crew_id,
               payload->>'estado' as estado,
               payload->'verificado' = 'true'::jsonb as verificado,
               payload->>'motivo' as motivo
          from events
         where ts >= %(desde)s and ts < %(hasta)s
           and tipo in ('observacion', 'mision_estado', 'mision_cerrada', 'replan')
    )
    select e.id, e.ts, e.tipo, e.obs_id, o.id is not null as observacion_existe,
           coalesce(ca.id, m.case_id) as caso_id, s.comuna,
           coalesce(o.sumidero_id, m.sumidero_id) as sumidero_id,
           o.fuente, o.ts as capturada,
           case when cl.resultado->'evaluable' = 'true'::jsonb then cl.resultado->>'rejilla' end as rejilla,
           e.estado, e.verificado, e.motivo,
           (coalesce(o.is_simulated, false) or coalesce(cr.is_simulated, false)
             or coalesce(s.is_simulated, false)) as simulado
      from ventana e
      left join observations o on o.id = e.obs_id
      left join cases ca on ca.id = e.caso_id
      left join missions m on m.id = e.mision_id
      left join crews cr on cr.id = coalesce(e.crew_id, m.crew_id)
      left join sumideros s on s.id = coalesce(o.sumidero_id, ca.sumidero_id, m.sumidero_id)
      left join lateral (
          select c.resultado from classifications c
           where e.tipo = 'observacion' and o.tipo = 'foto_rejilla'
             and c.observation_id = o.id and c.created_at < %(hasta)s
           order by c.created_at desc, c.id desc limit 1
      ) cl on true
     order by e.ts, e.id
"""

_SCORES = """
    select sumidero_id, rank, computed_at, detalle->'incluye_simulados' = 'false'::jsonb as sin_simulados
      from scores
     where scenario_id = 'base' and modo = 'antes'
     order by rank, sumidero_id
"""


def _ranking(conn: Connection, desde: datetime, incluir_simulados: bool) -> dict | None:
    filas = conn.execute(_SCORES).fetchall()
    fechas = {r["computed_at"] for r in filas}
    if (
        len(fechas) == 1 and filas[0]["computed_at"] < desde
        and [r["rank"] for r in filas] == list(range(1, len(filas) + 1))
        and (incluir_simulados or all(r["sin_simulados"] for r in filas))
    ):
        return {
            "ids": [r["sumidero_id"] for r in filas], "fuente": "scores_base_antes",
            "calculado_utc": filas[0]["computed_at"].astimezone(UTC),
            "incluye_simulados": not all(r["sin_simulados"] for r in filas),
        }
    try:
        metadata = json.loads(PREDICCION.with_suffix(".meta.json").read_text(encoding="utf-8"))
        momento = datetime.fromisoformat(metadata["generado_utc"]).astimezone(UTC)
        datos = PREDICCION.read_bytes()
        if momento >= desde or hashlib.sha256(datos).hexdigest() != metadata["salida"]["sha256"]:
            return None
        congelada = sorted(csv.DictReader(io.StringIO(datos.decode("utf-8"))), key=lambda r: int(r["rank"]))
        return {
            "ids": [r["ID_IDE"] for r in congelada], "fuente": "prediccion_congelada_mut",
            "calculado_utc": momento, "incluye_simulados": False,
        }
    except (OSError, ValueError, KeyError):
        return None


def _tiempos(valores: list[float], total: int) -> dict:
    return {
        "medidos": len(valores), "sin_medicion": total - len(valores),
        "mediana_s": round(median(valores), 1) if valores else None,
    }


def _contrastar(ranking: dict | None, primeras_fotos: dict[str, str]) -> dict:
    if ranking is None:
        return {"estado": "sin_ranking_anterior"}
    ids = ranking["ids"]
    corte = ceil(len(ids) * TOP_PORCENTAJE / 100)
    comparadas = [
        (posicion <= corte, primeras_fotos[sid] == "tapada")
        for posicion, sid in enumerate(ids, 1) if primeras_fotos.get(sid) in ("limpia", "tapada")
    ]
    datos = {
        "fuente": ranking["fuente"], "calculado_utc": ranking["calculado_utc"],
        "incluye_simulados": ranking["incluye_simulados"],
        "top_porcentaje": TOP_PORCENTAJE, "rejillas_rankeadas": len(ids), "comparables": len(comparadas),
    }
    if not comparadas:
        return {**datos, "estado": "sin_fotos_comparables"}
    return {
        **datos, "estado": "evaluado",
        "aciertos_tapadas": sum(alta and tapada for alta, tapada in comparadas),
        "aciertos_limpias": sum(not alta and not tapada for alta, tapada in comparadas),
        "falsas_alertas": sum(alta and not tapada for alta, tapada in comparadas),
        "tapadas_fuera_del_top": sum(not alta and tapada for alta, tapada in comparadas),
    }


def calcular(eventos: list[dict], ranking: dict | None, desde: datetime, hasta: datetime,
             incluir_simulados: bool) -> dict:
    """Resume las filas de auditoría ordenadas por recepción e ID."""
    casos, recepciones, respuestas, replans = {}, {}, {}, {}
    fotos, primeras_fotos = [], {}
    simulados = 0
    for e in eventos:
        if e["simulado"]:
            simulados += 1
            if not incluir_simulados:
                continue
        tipo, caso_id, sid, ts = e["tipo"], e["caso_id"], e["sumidero_id"], e["ts"]
        if tipo == "observacion" and e["observacion_existe"]:
            recepciones.setdefault(e["obs_id"], ts)
            if caso_id is not None:
                casos.setdefault(caso_id, (ts, e["comuna"] or "sin_sector"))
            if sid and e["rejilla"] in ("limpia", "parcial", "tapada") and desde <= e["capturada"] < hasta:
                fotos.append((e["capturada"], e["id"], sid, e["rejilla"], e["fuente"], e["simulado"]))
        elif tipo == "mision_estado" and caso_id in casos and e["estado"] == "en_sitio":
            respuestas.setdefault(caso_id, (ts - casos[caso_id][0]).total_seconds())
        elif tipo == "mision_cerrada" and e["verificado"] and sid:
            fotos.append((ts, e["id"], sid, "limpia", "cierre_verificado", e["simulado"]))
        elif tipo == "replan" and e["motivo"] == "observacion" and e["obs_id"] in recepciones:
            replans.setdefault(e["obs_id"], (ts - recepciones[e["obs_id"]]).total_seconds())

    episodios, tapadas, intervenidas = Counter(), set(), set()
    for _, _, sid, estado, fuente, simulado in sorted(fotos):
        if fuente == "cierre_verificado":
            intervenidas.add(sid)
        elif fuente != "cuadrilla" and sid not in intervenidas and (not simulado or (ranking and ranking["incluye_simulados"])):
            primeras_fotos.setdefault(sid, estado)
        if estado == "limpia":
            tapadas.discard(sid)
        elif estado == "tapada" and sid not in tapadas:
            episodios[sid] += 1
            tapadas.add(sid)
    reincidencias = [
        {"sumidero_id": sid, "episodios_tapada": n}
        for sid, n in sorted(episodios.items()) if n > 1
    ]

    sectores = Counter(sector for _, sector in casos.values())
    tiempos_sector = defaultdict(list)
    for caso_id, segundos in respuestas.items():
        tiempos_sector[casos[caso_id][1]].append(segundos)
    return {
        "observaciones_registradas": len(recepciones), "casos": len(casos),
        "eventos_marcados_simulados": simulados,
        "casos_por_sector": [
            {"sector": sector, "casos": total, "llegada_en_sitio": _tiempos(tiempos_sector[sector], total)}
            for sector, total in sorted(sectores.items())
        ],
        "llegada_en_sitio": _tiempos(list(respuestas.values()), len(casos)),
        "replan_propuesto": _tiempos(list(replans.values()), len(recepciones)),
        "reincidencias": reincidencias,
        "ranking_antes": _contrastar(ranking, primeras_fotos),
    }


def medir(conn: Connection, desde: datetime, hasta: datetime, incluir_simulados: bool) -> dict:
    conn.execute("set transaction isolation level repeatable read read only")
    eventos = conn.execute(_EVENTOS, {"uuid": UUID_RE, "desde": desde, "hasta": hasta}).fetchall()
    ranking = _ranking(conn, desde, incluir_simulados)
    return calcular(eventos, ranking, desde, hasta, incluir_simulados)


class Redaccion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resumen: str = Field(min_length=1, max_length=500)
    recomendaciones: list[str] = Field(max_length=3)


_ESQUEMA = {
    "type": "object",
    "properties": {"resumen": {"type": "string"}, "recomendaciones": {"type": "array", "items": {"type": "string"}}},
    "required": ["resumen", "recomendaciones"],
    "additionalProperties": False,
}


def redactar(metricas: dict, *, incluir_simulados: bool = False) -> dict:
    n_casos = metricas["casos"]
    casos = "caso" if n_casos == 1 else "casos"
    simulados = incluir_simulados and metricas["eventos_marcados_simulados"] > 0
    resumen = f"La ventana consultada registra {n_casos} {casos}."
    if simulados:
        resumen += " El informe incluye actividad simulada."
    recomendaciones = []
    if metricas["reincidencias"]:
        recomendaciones.append("Revisar las rejillas que volvieron a taparse y registrar su próxima limpieza preventiva.")
    if metricas["llegada_en_sitio"]["sin_medicion"]:
        recomendaciones.append("Registrar la llegada de las cuadrillas en las misiones vinculadas a casos.")
    alternativa = Redaccion(resumen=resumen, recomendaciones=recomendaciones)
    if metricas["observaciones_registradas"] and get_settings().anthropic_api_key:
        # Claude recibe solo agregados. Los identificadores y los textos de origen quedan fuera.
        agregados = {
            "casos": metricas["casos"], "casos_por_sector": metricas["casos_por_sector"],
            "llegada_en_sitio": metricas["llegada_en_sitio"],
            "replan_propuesto": metricas["replan_propuesto"],
            "rejillas_con_reincidencia": len(metricas["reincidencias"]),
            "ranking_antes": metricas["ranking_antes"],
            "incluye_actividad_simulada": simulados,
        }
        texto = json.dumps(agregados, ensure_ascii=False, sort_keys=True, default=str)
        try:
            r = llamar_estructurado(
                system=(
                    "Redacta un resumen cualitativo y hasta tres recomendaciones breves de limpieza preventiva "
                    "para la central, usando solo las métricas de Drena. Deja las cifras al informe tabular. "
                    "Distingue una propuesta de ruta de una llegada en sitio. Evita atribuir causas y omite "
                    "inferencias cuando falte evidencia. Indica si el informe incluye actividad simulada. "
                    "Escribe en español."
                ),
                content=[{"type": "text", "text": texto}], schema=_ESQUEMA, modelo_pydantic=Redaccion,
                key=cache.cache_key(texto, PROMPT_VERSION), prompt_version=PROMPT_VERSION,
                no_evaluable=alternativa, max_tokens=450, timeout_s=6,
            )
            if not r.fallo:
                return {**r.resultado.model_dump(), "fuente": "claude", "modelo": r.modelo}
        except Exception:
            log.exception("No se pudo redactar el informe con Claude")
    return {**alternativa.model_dump(), "fuente": "drena"}

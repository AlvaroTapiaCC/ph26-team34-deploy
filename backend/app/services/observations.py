"""Reportes en vivo: asociar al sumidero, agrupar en casos y guardar (plan §7.2, issue #28).

"La fórmula decide; Claude ve, lee y explica": aquí Claude solo entrega la clasificación
(services/claude_vision y claude_text). El orden lo calcula `scoring.recalcular`.

Las funciones de acceso a la base reciben la conexión, así los tests las reemplazan sin base.
Distancias con PostGIS (`::geography`, en metros).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

log = logging.getLogger(__name__)

# Si hay dos o más sumideros a menos de esta distancia del GPS y el usuario no eligió, se le pregunta
RADIO_AMBIGUO_M = 15.0
# Más lejos que esto, el reporte no se asocia a ningún sumidero (queda solo en el caso)
RADIO_MAX_ASOCIACION_M = 50.0
# Casos (§7.2): menos de 75 m y menos de 60 minutos cuentan como el mismo caso
RADIO_CASO_M = 75.0
VENTANA_CASO = timedelta(minutes=60)
MAX_CANDIDATOS = 5

TIPO_OBS = {"rejilla": "foto_rejilla", "agua": "foto_agua", "texto": "texto"}


# ---------------------------------------------------------------------------
# Asociación al sumidero (lógica pura)
# ---------------------------------------------------------------------------
def decidir_asociacion(cercanos: list[dict[str, Any]]) -> tuple[str | None, list[dict[str, Any]]]:
    """A partir de los sumideros cercanos (ordenados por distancia) decide a cuál asociar.

    Devuelve (sumidero_id, candidatos). Si hay ambigüedad (dos o más a menos de
    RADIO_AMBIGUO_M), se asocia al más cercano y `candidatos` trae las opciones para que un
    front pueda corregir después: el reporte nunca se descarta por un empate. Si el más
    cercano está fuera de RADIO_MAX_ASOCIACION_M, no hay asociación.
    """
    if not cercanos:
        return None, []
    ambiguos = [c for c in cercanos if c["distancia_m"] <= RADIO_AMBIGUO_M]
    if len(ambiguos) >= 2:
        return ambiguos[0]["id"], ambiguos[:MAX_CANDIDATOS]
    primero = cercanos[0]
    if primero["distancia_m"] > RADIO_MAX_ASOCIACION_M:
        return None, []
    return primero["id"], []


# ---------------------------------------------------------------------------
# Base de datos
# ---------------------------------------------------------------------------
def sumideros_cercanos(conn: Connection, lat: float, lon: float) -> list[dict[str, Any]]:
    """Sumideros a menos de RADIO_MAX_ASOCIACION_M del punto, del más cercano al más lejano."""
    filas = conn.execute(
        """
        with p as (select st_setsrid(st_makepoint(%(lon)s, %(lat)s), 4326)::geography as g)
        select s.id, s.intersection_id, st_distance(s.geom::geography, p.g) as distancia_m,
               st_y(s.geom) as lat, st_x(s.geom) as lon
          from sumideros s, p
         where st_dwithin(s.geom::geography, p.g, %(radio)s)
         order by distancia_m, s.id
         limit 20
        """,
        {"lat": lat, "lon": lon, "radio": RADIO_MAX_ASOCIACION_M},
    ).fetchall()
    return [{**f, "distancia_m": round(float(f["distancia_m"]), 1)} for f in filas]


def sumidero_existe(conn: Connection, sumidero_id: str) -> dict[str, Any] | None:
    return conn.execute(
        "select id, st_y(geom) as lat, st_x(geom) as lon from sumideros where id = %s", (sumidero_id,)
    ).fetchone()


def observacion_existente(conn: Connection, obs_id: str) -> dict[str, Any] | None:
    """Reintentos de la cola local de /reportar: el mismo `id` no se guarda dos veces."""
    return conn.execute(
        """
        select o.id, o.sumidero_id, o.tipo, o.ts, co.case_id as caso_id, ca.urgente,
               (select cl.resultado from classifications cl where cl.observation_id = o.id
                 order by cl.created_at desc, cl.id desc limit 1) as clasificacion
          from observations o
          left join case_observations co on co.observation_id = o.id
          left join cases ca on ca.id = co.case_id
         where o.id = %s
        """,
        (obs_id,),
    ).fetchone()


def insertar_observacion(
    conn: Connection, *, obs_id: str | None, sumidero_id: str | None, lat: float | None, lon: float | None,
    fuente: str, tipo: str, media_url: str | None, texto: str | None, ts: datetime,
) -> str:
    fila = conn.execute(
        """
        insert into observations (id, sumidero_id, geom, fuente, tipo, media_url, texto, ts)
        values (coalesce(%(id)s::uuid, gen_random_uuid()), %(sid)s,
                case when %(lat)s::float8 is null then null
                     else st_setsrid(st_makepoint(%(lon)s::float8, %(lat)s::float8), 4326) end,
                %(fuente)s, %(tipo)s, %(media)s, %(texto)s, %(ts)s)
        returning id
        """,
        {"id": obs_id, "sid": sumidero_id, "lat": lat, "lon": lon, "fuente": fuente, "tipo": tipo,
         "media": media_url, "texto": texto, "ts": ts},
    ).fetchone()
    return str(fila["id"])


def insertar_clasificacion(conn: Connection, obs_id: str, resultado: Any, meta: dict[str, Any],
                           respuesta_cruda: str | None) -> None:
    conn.execute(
        """
        insert into classifications (observation_id, resultado, modelo, prompt_version, cache_key,
                                     latencia_ms, respuesta_cruda)
        values (%s, %s, %s, %s, %s, %s, %s)
        """,
        (obs_id, Jsonb(resultado.model_dump(mode="json")), meta["modelo"], meta["prompt_version"],
         meta["cache_key"], meta["latencia_ms"], respuesta_cruda),
    )


def buscar_caso(conn: Connection, lat: float, lon: float, ts: datetime) -> str | None:
    """Caso abierto a menos de RADIO_CASO_M cuya última observación esté dentro de VENTANA_CASO de `ts`."""
    fila = conn.execute(
        """
        select ca.id
          from cases ca
         where ca.estado not in ('resuelto', 'descartado')
           and st_dwithin(ca.geom::geography,
                          st_setsrid(st_makepoint(%(lon)s, %(lat)s), 4326)::geography, %(radio)s)
           and (select max(o.ts) from case_observations co join observations o on o.id = co.observation_id
                 where co.case_id = ca.id) between %(desde)s and %(hasta)s
         order by st_distance(ca.geom::geography,
                              st_setsrid(st_makepoint(%(lon)s, %(lat)s), 4326)::geography)
         limit 1
        """,
        {"lat": lat, "lon": lon, "radio": RADIO_CASO_M, "desde": ts - VENTANA_CASO, "hasta": ts + VENTANA_CASO},
    ).fetchone()
    return str(fila["id"]) if fila else None


def crear_caso(conn: Connection, lat: float, lon: float, sumidero_id: str | None, urgente: bool,
               ts: datetime) -> str:
    fila = conn.execute(
        """
        insert into cases (geom, sumidero_id, urgente, abierto_at)
        values (st_setsrid(st_makepoint(%s, %s), 4326), %s, %s, %s) returning id
        """,
        (lon, lat, sumidero_id, urgente, ts),
    ).fetchone()
    return str(fila["id"])


def actualizar_caso(conn: Connection, caso_id: str, sumidero_id: str | None, urgente: bool) -> None:
    """Un caso urgente sigue urgente; si no tenía sumidero y ahora hay uno, se le asigna."""
    conn.execute(
        "update cases set urgente = urgente or %s, sumidero_id = coalesce(sumidero_id, %s) where id = %s",
        (urgente, sumidero_id, caso_id),
    )


def vincular_caso(conn: Connection, caso_id: str, obs_id: str) -> None:
    conn.execute(
        "insert into case_observations (case_id, observation_id) values (%s, %s) on conflict do nothing",
        (caso_id, obs_id),
    )


def caso_urgente(conn: Connection, caso_id: str) -> bool:
    fila = conn.execute("select urgente from cases where id = %s", (caso_id,)).fetchone()
    return bool(fila and fila["urgente"])


def registrar_evento(conn: Connection, tipo: str, payload: dict[str, Any]) -> None:
    conn.execute("insert into events (tipo, payload) values (%s, %s)", (tipo, Jsonb(payload)))


def prioridad_de(conn: Connection, sumidero_id: str, scenario_id: str | None = None) -> dict[str, Any] | None:
    """Prioridad vigente del sumidero en modo Durante (escenario `base` si no se indica)."""
    fila = conn.execute(
        """
        select sc.scenario_id, sc.rank, sc.prioridad, sc.p_ef, sc.c, sc.p_obs
          from scores sc
         where sc.sumidero_id = %s and sc.modo = 'durante'
         order by (sc.scenario_id = coalesce(%s, 'base')) desc, sc.scenario_id
         limit 1
        """,
        (sumidero_id, scenario_id),
    ).fetchone()
    return dict(fila) if fila else None


def listar(conn: Connection, desde: datetime | None, limite: int) -> list[dict[str, Any]]:
    """Observaciones recientes con clasificación, caso y cambios de despacho.

    La ubicación se toma de casos_publicos. La clasificación expone categorías, sin los
    campos libres que pueden incluir datos personales (#104).
    """
    return conn.execute(
        """
        with recientes as (
            select id, sumidero_id, fuente, tipo, ts, is_simulated, media_url
              from observations
             where (%(desde)s::timestamptz is null or ts >= %(desde)s)
             order by ts desc, id
             limit %(limite)s
        ), eventos_recientes as (
            select r.id as obs_id, e.id, e.tipo, e.ts, e.payload
              from events e
              join recientes r on r.id::text = e.payload->>'observation_id'
             where e.tipo in ('prioridad_observacion', 'replan')
        ), cambios_despacho as (
            select distinct on (obs_id, payload->>'crew_id')
                   obs_id, payload->>'crew_id' as crew_id, ts as hora,
                   payload#>>'{siguiente_antes,nombre}' as siguiente_antes,
                   payload#>>'{siguiente_despues,nombre}' as siguiente_despues
              from eventos_recientes
             where tipo = 'replan' and payload->>'crew_id' is not null
             order by obs_id, payload->>'crew_id', id desc
        )
        select o.id, o.sumidero_id, o.fuente, o.tipo, o.ts, o.is_simulated,
               o.media_url is not null as tiene_foto,
               co.case_id as caso_id, ca.urgente,
               case when ca.id is not null then jsonb_build_object(
                   'estado', ca.estado, 'lat', st_y(ca.geom), 'lon', st_x(ca.geom)
               ) end as caso_publico,
               (select cl.resultado - 'ubicacion_texto' - 'desde_cuando' - 'nota'
                  from classifications cl where cl.observation_id = o.id
                 order by cl.created_at desc, cl.id desc limit 1) as clasificacion,
               p.prioridad, coalesce(d.despachos, '[]'::jsonb) as despachos
          from recientes o
          left join case_observations co on co.observation_id = o.id
          left join casos_publicos ca on ca.id = co.case_id
          left join (
            select distinct on (e.obs_id) e.obs_id,
                   jsonb_build_object('antes', e.payload->'antes', 'despues', e.payload->'despues') as prioridad
              from eventos_recientes e
             where e.tipo = 'prioridad_observacion'
             order by e.obs_id, e.id desc
          ) p on p.obs_id = o.id
          left join (
            select c.obs_id, jsonb_agg(jsonb_build_object(
                'crew_id', c.crew_id, 'cuadrilla', coalesce(eq.nombre, c.crew_id),
                'is_simulated', eq.is_simulated, 'hora', c.hora,
                'siguiente_antes', c.siguiente_antes, 'siguiente_despues', c.siguiente_despues
            ) order by c.crew_id) as despachos
              from cambios_despacho c
              left join crews eq on eq.id = c.crew_id
             group by c.obs_id
          ) d on d.obs_id = o.id
         order by o.ts desc, o.id
        """,
        {"desde": desde, "limite": limite},
    ).fetchall()

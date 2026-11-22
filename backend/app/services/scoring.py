"""Une la fórmula con la base: carga entradas, calcula y guarda en `scores`.

La fórmula (services/formula.py) es pura; aquí solo se arma su entrada desde
Supabase y se persiste la salida. Ver docs/plan-desarrollo.md §6 y §9.4.

Reglas de datos (revisión del PR #58):
- De cada observación cuenta solo su ÚLTIMA clasificación (una reclasificación no duplica).
- Los reportes de texto suben P solo si apuntan a obstrucción (`reportes_texto.tipos_que_suben_p`);
  un anegamiento no implica rejilla tapada: entra a la consecuencia como nivel de agua (Durante).
- `incluir_simulados=False` (prueba de campo) excluye todo dato simulado: sumideros, observaciones,
  historial de limpieza, features simuladas (`features_simuladas`) y casos sin observaciones reales.
  Ese cálculo NO se guarda en `scores`: el ranking de la demo no se pisa.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from psycopg import Connection
from psycopg.types.json import Jsonb

from app.config import get_formula_config
from app.services.formula import Score, StreetChain, SumideroInput, calcular_ranking

ZONA = ZoneInfo("America/Santiago")
# Peor nivel de agua primero
_ORDEN_AGUA = ["sobre_vereda", "hasta_vereda", "cuneta", "sin_agua"]

# Última clasificación de cada observación
_ULTIMA_CLASIFICACION = """
    join lateral (
        select resultado from classifications cl
         where cl.observation_id = o.id
         order by cl.created_at desc, cl.id desc
         limit 1
    ) c on true
"""


def hoy_santiago() -> date:
    return datetime.now(ZONA).date()


def _dias_norm(ultima: date | None, hoy: date, dias_max: float) -> float | None:
    if ultima is None:
        return None
    return min(1.0, max(0, (hoy - ultima).days) / dias_max)


def cargar_entradas(
    conn: Connection,
    scenario_id: str,
    modo: str,
    incluir_simulados: bool = True,
    cfg: Mapping[str, Any] | None = None,
) -> tuple[list[SumideroInput], list[StreetChain]]:
    """Arma la entrada de la fórmula desde la base."""
    cfg = cfg or get_formula_config()
    norm = cfg.get("normalizacion", {})
    vig_foto = cfg["observado"]["vigencia_horas"]
    vig_agua = cfg["durante"].get("vigencia_agua_horas", 6)
    vig_urgente = cfg["durante"].get("vigencia_urgente_horas", 6)
    tipos_p = list(cfg["reportes_texto"].get("tipos_que_suben_p", ["rejilla_tapada", "basura"]))
    feats_sim = set(cfg.get("features_simuladas", ["dias_sin_limpieza"]))
    sim = {"sim": incluir_simulados}

    scen = conn.execute("select parametros from scenarios where id = %s", (scenario_id,)).fetchone()
    if scen is None:
        raise KeyError(scenario_id)
    params = scen["parametros"] or {}

    rows = conn.execute(
        """
        select s.id, s.features, s.is_simulated,
               (select max(fecha) from cleaning_history ch
                 where ch.sumidero_id = s.id and (%(sim)s or not ch.is_simulated)) as ultima_limpieza
          from sumideros s
         where %(sim)s or not s.is_simulated
        """,
        sim,
    ).fetchall()

    # Última foto de rejilla evaluable y vigente (lo confirmado manda)
    fotos = {
        r["sumidero_id"]: r
        for r in conn.execute(
            f"""
            select distinct on (o.sumidero_id) o.sumidero_id, c.resultado->>'rejilla' as rejilla,
                   c.resultado->>'confianza' as confianza
              from observations o {_ULTIMA_CLASIFICACION}
             where o.tipo = 'foto_rejilla' and o.sumidero_id is not null
               and (c.resultado->>'evaluable')::boolean
               and c.resultado->>'rejilla' in ('limpia', 'parcial', 'tapada')
               and o.ts > now() - make_interval(hours => %(h)s)
               and (%(sim)s or not o.is_simulated)
             order by o.sumidero_id, o.ts desc, o.id desc
            """,
            {"h": vig_foto, **sim},
        )
    }

    # Reportes de texto que apuntan a obstrucción (una fila por observación)
    textos = {
        r["sumidero_id"]: r["n"]
        for r in conn.execute(
            f"""
            select o.sumidero_id, count(*) as n
              from observations o {_ULTIMA_CLASIFICACION}
             where o.tipo = 'texto' and o.sumidero_id is not null
               and c.resultado->>'tipo' = any(%(tipos)s)
               and o.ts > now() - make_interval(hours => %(h)s)
               and (%(sim)s or not o.is_simulated)
             group by o.sumidero_id
            """,
            {"h": vig_foto, "tipos": tipos_p, **sim},
        )
    }

    agua: dict[str, str] = {}
    urgentes: set[str] = set()
    if modo == "durante":
        for r in conn.execute(
            f"""
            select o.sumidero_id, c.resultado->>'nivel_agua' as nivel
              from observations o {_ULTIMA_CLASIFICACION}
             where o.sumidero_id is not null
               and c.resultado->>'nivel_agua' in ('sobre_vereda', 'hasta_vereda', 'cuneta', 'sin_agua')
               and o.ts > now() - make_interval(hours => %(h)s)
               and (%(sim)s or not o.is_simulated)
            """,
            {"h": vig_agua, **sim},
        ):
            prev = agua.get(r["sumidero_id"])
            if prev is None or _ORDEN_AGUA.index(r["nivel"]) < _ORDEN_AGUA.index(prev):
                agua[r["sumidero_id"]] = r["nivel"]
        urgentes = {
            r["sumidero_id"]
            for r in conn.execute(
                """
                select ca.sumidero_id from cases ca
                 where ca.urgente and ca.sumidero_id is not null
                   and ca.estado not in ('resuelto', 'descartado')
                   and ca.abierto_at > now() - make_interval(hours => %(h)s)
                   and (%(sim)s or exists (
                         select 1 from case_observations co join observations o on o.id = co.observation_id
                          where co.case_id = ca.id and not o.is_simulated))
                """,
                {"h": vig_urgente, **sim},
            )
        }

    hoy = hoy_santiago()
    entradas = []
    for r in rows:
        f = dict(r["features"] or {})
        if not incluir_simulados:
            for k in feats_sim:
                f.pop(k, None)
        if "clima" in params:  # el escenario fija la lluvia reciente/pronosticada para toda la zona
            f["clima"] = params["clima"]
        if f.get("dias_sin_limpieza") is None and (incluir_simulados or "dias_sin_limpieza" not in feats_sim):
            d = _dias_norm(r["ultima_limpieza"], hoy, norm.get("dias_sin_limpieza_max", 90))
            if d is not None:
                f["dias_sin_limpieza"] = d
        foto = fotos.get(r["id"]) or {}
        entradas.append(
            SumideroInput(
                id=r["id"],
                features=f,
                rejilla_observada=foto.get("rejilla"),
                confianza_foto=foto.get("confianza"),
                reportes_texto=textos.get(r["id"], 0),
                nivel_agua=agua.get(r["id"]),
                urgente=r["id"] in urgentes,
            )
        )

    ids = {e.id for e in entradas}
    chains = [
        StreetChain(r["street_id"], r["sumidero_ids"], r["distancias_m"])
        for r in conn.execute("select street_id, sumidero_ids, distancias_m from street_chains")
        if ids.intersection(r["sumidero_ids"])
    ]
    return entradas, chains


def guardar_scores(conn: Connection, scenario_id: str, modo: str, scores: list[Score]) -> None:
    """Reemplaza los scores del escenario y modo.

    La explicación se conserva mientras sean iguales sus datos de entrada.
    El rank no cuenta: si otro sumidero sube, los que adelanta no cambian sus propias
    razones (la explicación no menciona la posición).
    """
    with conn.transaction():
        conn.execute(
            "delete from scores where scenario_id = %s and modo = %s and not (sumidero_id = any(%s))",
            (scenario_id, modo, [s.sumidero_id for s in scores]),
        )
        with conn.cursor() as cur:
            cur.executemany(
                """
                insert into scores (sumidero_id, scenario_id, modo, p_pred, p_obs, p_ef, c,
                                    prioridad, rank, detalle, computed_at)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                on conflict (sumidero_id, scenario_id, modo) do update set
                  p_pred = excluded.p_pred, p_obs = excluded.p_obs, p_ef = excluded.p_ef,
                  c = excluded.c, prioridad = excluded.prioridad, rank = excluded.rank,
                  detalle = excluded.detalle, computed_at = excluded.computed_at,
                  explicacion = case
                    when scores.prioridad is not distinct from excluded.prioridad
                     and scores.p_ef is not distinct from excluded.p_ef
                     and scores.c is not distinct from excluded.c
                     and scores.detalle = excluded.detalle
                    then scores.explicacion
                    else null
                  end
                """,
                [
                    (s.sumidero_id, scenario_id, modo, s.p_pred, s.p_obs, s.p_ef, s.c, s.prioridad,
                     s.rank, Jsonb({**s.detalle, "p": s.p, "urgente": s.urgente, "incluye_simulados": True}))
                    for s in scores
                ],
            )


def calcular(conn: Connection, scenario_id: str, modo: str, incluir_simulados: bool = True) -> list[Score]:
    """Carga y calcula sin guardar. Cada score registra con qué datos se calculó.

    Sin simulados (prueba de campo, §8.1) usa `formula_validacion.yaml`: mismos parámetros
    con w_dias = w_cam = 0 y los demás pesos reescalados para sumar 1.
    """
    nombre_cfg = "formula" if incluir_simulados else "formula_validacion"
    cfg = get_formula_config(nombre_cfg)
    entradas, chains = cargar_entradas(conn, scenario_id, modo, incluir_simulados, cfg)
    scores = calcular_ranking(entradas, chains, cfg, modo)
    for s in scores:
        s.detalle["incluye_simulados"] = incluir_simulados
        s.detalle["config"] = nombre_cfg
    return scores


def recalcular(conn: Connection, scenario_id: str, modo: str) -> list[Score]:
    """Calcula con todos los datos y guarda en `scores`. Lo llaman /formula/recompute y POST /observations.

    Para la prueba de campo (sin simulados) usar `calcular(..., incluir_simulados=False)`,
    que no toca la tabla de la demo.
    """
    scores = calcular(conn, scenario_id, modo, incluir_simulados=True)
    guardar_scores(conn, scenario_id, modo, scores)
    return scores


def recalcular_todo(conn: Connection) -> dict[str, int]:
    """Recalcula todos los escenarios en ambos modos."""
    out = {}
    for r in conn.execute("select id from scenarios order by id").fetchall():
        for modo in ("antes", "durante"):
            out[f"{r['id']}/{modo}"] = len(recalcular(conn, r["id"], modo))
    return out

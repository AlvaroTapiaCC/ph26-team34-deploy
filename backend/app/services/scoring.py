"""Une la fórmula con la base: carga entradas, calcula y guarda en `scores`.

La fórmula (services/formula.py) es pura; aquí solo se arma su entrada desde
Supabase y se persiste la salida. Ver docs/plan-desarrollo.md §6 y §9.4.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from app.config import get_formula_config
from app.services.formula import Score, StreetChain, SumideroInput, calcular_ranking

# Peor nivel de agua primero
_ORDEN_AGUA = ["sobre_vereda", "hasta_vereda", "cuneta", "sin_agua"]


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
    """Arma la entrada de la fórmula desde la base.

    incluir_simulados=False deja fuera los datos simulados (p. ej. días sin limpieza),
    como pide la prueba de campo (§8.1).
    """
    cfg = cfg or get_formula_config()
    norm = cfg.get("normalizacion", {})
    vig_foto = cfg["observado"]["vigencia_horas"]
    vig_agua = cfg["durante"].get("vigencia_agua_horas", 6)

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
        {"sim": incluir_simulados},
    ).fetchall()

    # Última foto de rejilla evaluable y vigente (lo confirmado manda)
    fotos = {
        r["sumidero_id"]: r["rejilla"]
        for r in conn.execute(
            """
            select distinct on (o.sumidero_id) o.sumidero_id, c.resultado->>'rejilla' as rejilla
              from observations o join classifications c on c.observation_id = o.id
             where o.tipo = 'foto_rejilla' and o.sumidero_id is not null
               and (c.resultado->>'evaluable')::boolean
               and c.resultado->>'rejilla' in ('limpia', 'parcial', 'tapada')
               and o.ts > now() - make_interval(hours => %(h)s)
               and (%(sim)s or not o.is_simulated)
             order by o.sumidero_id, o.ts desc
            """,
            {"h": vig_foto, "sim": incluir_simulados},
        )
    }

    # Reportes de texto que apuntan a rejilla tapada, basura o anegamiento
    textos = {
        r["sumidero_id"]: r["n"]
        for r in conn.execute(
            """
            select o.sumidero_id, count(*) as n
              from observations o join classifications c on c.observation_id = o.id
             where o.tipo = 'texto' and o.sumidero_id is not null
               and c.resultado->>'tipo' in ('rejilla_tapada', 'basura', 'anegamiento')
               and o.ts > now() - make_interval(hours => %(h)s)
               and (%(sim)s or not o.is_simulated)
             group by o.sumidero_id
            """,
            {"h": vig_foto, "sim": incluir_simulados},
        )
    }

    agua: dict[str, str] = {}
    urgentes: set[str] = set()
    if modo == "durante":
        for r in conn.execute(
            """
            select o.sumidero_id, c.resultado->>'nivel_agua' as nivel
              from observations o join classifications c on c.observation_id = o.id
             where o.sumidero_id is not null
               and c.resultado->>'nivel_agua' in ('sobre_vereda', 'hasta_vereda', 'cuneta', 'sin_agua')
               and o.ts > now() - make_interval(hours => %(h)s)
               and (%(sim)s or not o.is_simulated)
            """,
            {"h": vig_agua, "sim": incluir_simulados},
        ):
            prev = agua.get(r["sumidero_id"])
            if prev is None or _ORDEN_AGUA.index(r["nivel"]) < _ORDEN_AGUA.index(prev):
                agua[r["sumidero_id"]] = r["nivel"]
        urgentes = {
            r["sumidero_id"]
            for r in conn.execute(
                "select sumidero_id from cases where urgente and sumidero_id is not null"
                " and estado not in ('resuelto', 'descartado')"
            )
        }

    hoy = date.today()
    entradas = []
    for r in rows:
        f = dict(r["features"] or {})
        if "clima" in params:  # el escenario fija la lluvia reciente/pronosticada para toda la zona
            f["clima"] = params["clima"]
        if f.get("dias_sin_limpieza") is None:
            d = _dias_norm(r["ultima_limpieza"], hoy, norm.get("dias_sin_limpieza_max", 90))
            if d is not None:
                f["dias_sin_limpieza"] = d
        entradas.append(
            SumideroInput(
                id=r["id"],
                features=f,
                rejilla_observada=fotos.get(r["id"]),
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
    """Reemplaza los scores del escenario y modo. Mantiene la explicación si el sumidero sigue."""
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
                  detalle = excluded.detalle, computed_at = excluded.computed_at
                """,
                [
                    (s.sumidero_id, scenario_id, modo, s.p_pred, s.p_obs, s.p_ef, s.c, s.prioridad,
                     s.rank, Jsonb({**s.detalle, "p": s.p, "urgente": s.urgente}))
                    for s in scores
                ],
            )


def recalcular(conn: Connection, scenario_id: str, modo: str, incluir_simulados: bool = True) -> list[Score]:
    """Carga, calcula y guarda. Es lo que llaman /formula/recompute y POST /observations."""
    cfg = get_formula_config()
    entradas, chains = cargar_entradas(conn, scenario_id, modo, incluir_simulados, cfg)
    scores = calcular_ranking(entradas, chains, cfg, modo)
    guardar_scores(conn, scenario_id, modo, scores)
    return scores


def recalcular_todo(conn: Connection, incluir_simulados: bool = True) -> dict[str, int]:
    """Recalcula todos los escenarios en ambos modos."""
    out = {}
    for r in conn.execute("select id from scenarios order by id").fetchall():
        for modo in ("antes", "durante"):
            out[f"{r['id']}/{modo}"] = len(recalcular(conn, r["id"], modo, incluir_simulados))
    return out

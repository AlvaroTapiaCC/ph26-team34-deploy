"""Escenarios de lluvia y tabla de misiones (plan §9.5, issues #17 y #21)."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from app.db import get_conn

router = APIRouter(prefix="/scenarios", tags=["scenarios"])


@router.get("")
def list_scenarios():
    """Lista de escenarios de lluvia."""
    with get_conn() as conn:
        return conn.execute("select id, nombre, descripcion, parametros from scenarios order by id").fetchall()


@router.get("/{scenario_id}/ranking")
def get_ranking(
    scenario_id: str,
    modo: Literal["antes", "durante"] = "antes",
    limit: int = Query(500, ge=1, le=5000),
):
    """Tabla de misiones: sumideros ordenados por prioridad, con su ubicación y desglose."""
    with get_conn() as conn:
        if not conn.execute("select 1 from scenarios where id = %s", (scenario_id,)).fetchone():
            raise HTTPException(404, f"Escenario {scenario_id} no existe")
        rows = conn.execute(
            """
            select sc.rank, sc.sumidero_id, sc.p_pred, sc.p_obs, sc.p_ef, sc.c, sc.prioridad,
                   sc.explicacion, sc.detalle, sc.computed_at,
                   s.intersection_id, i.nombre as intersection_nombre, s.street_id,
                   s.is_simulated, st_y(s.geom) as lat, st_x(s.geom) as lon
              from scores sc
              join sumideros s on s.id = sc.sumidero_id
              left join intersections i on i.id = s.intersection_id
             where sc.scenario_id = %s and sc.modo = %s
             order by sc.rank
             limit %s
            """,
            (scenario_id, modo, limit),
        ).fetchall()
    return {"scenario_id": scenario_id, "modo": modo, "items": rows}

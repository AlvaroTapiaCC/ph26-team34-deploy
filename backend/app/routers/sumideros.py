"""Ficha de sumidero (plan §9.5, issue #33)."""
from fastapi import APIRouter, HTTPException

from app.db import get_conn

router = APIRouter(prefix="/sumideros", tags=["sumideros"])


@router.get("/{sumidero_id}")
def get_sumidero(sumidero_id: str, scenario_id: str = "base"):
    """Variables, cadena aguas abajo, observaciones recientes, scores y explicación."""
    with get_conn() as conn:
        s = conn.execute(
            """
            select s.id, s.fuente, s.features, s.elevacion, s.street_id, s.orden_en_calle,
                   s.intersection_id, i.nombre as intersection_nombre, s.is_simulated,
                   st_y(s.geom) as lat, st_x(s.geom) as lon
              from sumideros s left join intersections i on i.id = s.intersection_id
             where s.id = %s
            """,
            (sumidero_id,),
        ).fetchone()
        if s is None:
            raise HTTPException(404, "Sumidero no existe")

        cadena = None
        if s["street_id"]:
            ch = conn.execute(
                "select street_id, nombre, sumidero_ids, distancias_m from street_chains where street_id = %s",
                (s["street_id"],),
            ).fetchone()
            if ch and sumidero_id in ch["sumidero_ids"]:
                i = ch["sumidero_ids"].index(sumidero_id)
                cadena = {
                    "street_id": ch["street_id"],
                    "nombre": ch["nombre"],
                    "posicion": i,
                    "aguas_arriba": ch["sumidero_ids"][:i],
                    "aguas_abajo": ch["sumidero_ids"][i + 1:],
                }

        scores = conn.execute(
            "select modo, rank, p_pred, p_obs, p_ef, c, prioridad, explicacion, detalle, computed_at"
            " from scores where sumidero_id = %s and scenario_id = %s",
            (sumidero_id, scenario_id),
        ).fetchall()

        observaciones = conn.execute(
            """
            select o.id, o.fuente, o.tipo, o.ts, o.is_simulated,
                   o.media_url is not null as tiene_foto,
                   o.texto is not null as tiene_texto,
                   c.clasificacion
              from observations o
              left join lateral (
                select resultado - 'ubicacion_texto' - 'desde_cuando' as clasificacion
                  from classifications where observation_id = o.id
                 order by created_at desc limit 1
              ) c on true
             where o.sumidero_id = %s
             order by o.ts desc limit 20
            """,
            (sumidero_id,),
        ).fetchall()

        ultima_limpieza = conn.execute(
            "select fecha, is_simulated from cleaning_history where sumidero_id = %s order by fecha desc limit 1",
            (sumidero_id,),
        ).fetchone()

    return {
        **s,
        "cadena": cadena,
        "scores": {r["modo"]: r for r in scores},
        "observaciones": observaciones,
        "ultima_limpieza": ultima_limpieza,
    }

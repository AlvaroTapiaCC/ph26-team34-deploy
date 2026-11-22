"""Reinicio de la demo (issue #97): volver al estado inicial para poder ensayar varias veces.

Borra lo que generó la demo desde el último reinicio y regenera el plan inicial:

- **Observaciones** registradas desde la marca (por su evento `observacion` o por su hora), con
  sus clasificaciones (en cascada) y los casos que quedan sin observaciones.
- **Plan de las cuadrillas simuladas:** todas sus misiones, cierres (en cascada) y versiones de
  ruta, y la limpieza que registró cada cierre verificado en `cleaning_history` (#42). Es dato derivado: se vuelve a generar con el despacho (#32). Las cuadrillas simuladas
  vuelven a la posición que tenían en el reinicio anterior y quedan `disponible`.
- **Eventos** desde la marca (`observacion`, `replan`), para que el panel "qué cambió" parta limpio.

No toca: catastro, variables, cadenas, historial de limpieza, la predicción congelada, la caché
de Claude (así la segunda pasada responde al instante) ni nada de cuadrillas reales.

La marca es un evento `reinicio_demo` con la hora y la posición de las cuadrillas simuladas.
Sin marca previa (primer reinicio) solo se borra lo de antes si se pasa `desde` explícito.
Todo corre en UNA transacción con el candado del despacho: si algo falla, no queda a medias.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from app.services import dispatch
from app.services.scoring import recalcular_todo

MARCA = "reinicio_demo"


def ultima_marca(conn: Connection) -> dict[str, Any] | None:
    return conn.execute(
        "select ts, payload from events where tipo = %s order by ts desc, id desc limit 1", (MARCA,)
    ).fetchone()


def _posiciones_simuladas(conn: Connection) -> dict[str, list[float]]:
    return {
        r["id"]: [r["lon"], r["lat"]]
        for r in conn.execute(
            "select id, st_x(geom_actual) as lon, st_y(geom_actual) as lat from crews"
            " where is_simulated and geom_actual is not null"
        )
    }


def reiniciar(conn: Connection, desde: datetime | None = None,
              params_despacho: dict[str, Any] | None = None) -> dict[str, Any]:
    """Borra lo generado por la demo y regenera puntajes y plan. No hace commit (lo hace el llamador)."""
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(hashtext(%s))", (dispatch.LOCK,))
        marca = ultima_marca(conn)
        corte = desde or (marca["ts"] if marca else None)
        borrado: dict[str, int] = {"observaciones": 0, "casos": 0, "eventos": 0}

        # 1) Plan de las cuadrillas simuladas (dato derivado, se regenera abajo). Va primero: las
        #    misiones apuntan a casos. Los cierres se borran en cascada.
        sim = "select id from crews where is_simulated"
        # La limpieza que registró un cierre verificado de una cuadrilla simulada (#42) es de la demo:
        # si quedara, la rejilla bajaría en el ranking y la segunda pasada no sería igual.
        borrado["limpiezas"] = conn.execute(
            f"""
            delete from cleaning_history ch
             using closures cl join missions m on m.id = cl.mission_id
             where cl.verificado and m.crew_id in ({sim}) and ch.is_simulated
               and ch.sumidero_id = m.sumidero_id
               and ch.fecha = (cl.created_at at time zone 'America/Santiago')::date
            """
        ).rowcount
        borrado["misiones"] = conn.execute(f"delete from missions where crew_id in ({sim})").rowcount
        borrado["rutas"] = conn.execute(f"delete from routes where crew_id in ({sim})").rowcount

        if corte is not None:
            # 2) Observaciones desde la marca: por su hora o por cuándo se registró (su evento)
            obs = [r["id"] for r in conn.execute(
                """
                select o.id from observations o
                 where o.ts >= %(c)s
                    or exists (select 1 from events e where e.tipo = 'observacion' and e.ts >= %(c)s
                                and e.payload->>'observation_id' = o.id::text)
                """,
                {"c": corte},
            )]
            casos = [r["case_id"] for r in conn.execute(
                "select distinct case_id from case_observations where observation_id = any(%s)", (obs,))]
            borrado["observaciones"] = conn.execute(
                "delete from observations where id = any(%s)", (obs,)).rowcount
            # 3) Casos que quedaron sin observaciones y sin misiones (las de cuadrillas reales se respetan)
            borrado["casos"] = conn.execute(
                """
                delete from cases ca
                 where (ca.id = any(%(casos)s) or ca.abierto_at >= %(c)s)
                   and not exists (select 1 from case_observations co where co.case_id = ca.id)
                   and not exists (select 1 from missions m where m.case_id = ca.id)
                """,
                {"casos": casos, "c": corte},
            ).rowcount
            # 4) Eventos de la pasada anterior (las marcas de reinicio se conservan)
            borrado["eventos"] = conn.execute(
                "delete from events where ts >= %s and tipo <> %s", (corte, MARCA)).rowcount

        # Cuadrillas simuladas: disponibles y en la posición del reinicio anterior
        restauradas = 0
        for cid, (lon, lat) in ((marca["payload"] if marca else {}).get("posiciones") or {}).items():
            restauradas += conn.execute(
                "update crews set geom_actual = st_setsrid(st_point(%s, %s), 4326) where id = %s and is_simulated",
                (lon, lat, cid)).rowcount
        conn.execute("update crews set estado = 'disponible' where is_simulated")

        puntajes = recalcular_todo(conn)
        plan = dispatch.planificar(conn, "reinicio", params=params_despacho)

        posiciones = _posiciones_simuladas(conn)
        nueva = conn.execute(
            "insert into events (tipo, ts, payload) values (%s, clock_timestamp(), %s) returning ts",
            (MARCA, Jsonb({"posiciones": posiciones, "corte": corte.isoformat() if corte else None,
                           "borrado": borrado})),
        ).fetchone()

    aviso = None
    if corte is None:
        aviso = ("Primer reinicio: no había marca anterior, así que no se borraron observaciones ni casos. "
                 "Desde ahora queda marcado; para limpiar lo anterior, pasar `desde`.")
    return {"reiniciado": True, "corte": corte, "marca": nueva["ts"], "borrado": borrado,
            "cuadrillas_restauradas": restauradas, "puntajes": puntajes,
            "plan": {cid: [p["sumidero_id"] or p["case_id"] for p in r["paradas"]]
                     for cid, r in plan["cuadrillas"].items()},
            "aviso": aviso}
